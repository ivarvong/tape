// bench/suite/trace-js.ts: apps/trace/trace.tape written by hand in plain TypeScript, for the benchmark that sets
// the Tape program (compiled to Wasm) against JavaScript doing the same work. OTLP/JSON in, the same SVG bytes out.
//
// It is the same algorithm as trace.tape: the same reading rules, tree, axis, gap compression and markup. Where the
// Tape program reads JSON by hand, this uses JSON.parse, with three additions so the answer stays the same:
// - the bytes are decoded strictly (invalid UTF-8 is not JSON) and a lone surrogate escape (which JSON.parse
//   accepts) is refused, as trace.tape refuses both;
// - trace.tape reads a number by its source text ("2.0" is not kind 2; an intValue of 12345678901234567890 is
//   shown as written). JSON.parse keeps the text of a number only through a reviver, which is several times
//   slower, so it is used only when the text may hold a number that String(Number(text)) would not give back
//   (a fraction, an exponent, -0, or 16 or more digits); otherwise the plain parse is exact;
// - when the input is not JSON, a small scanner (the rules of trace.tape's `checked`) finds the byte offset.
// Times are nanoseconds, up to 2^63 - 1, so they are BigInt; positions on the track are basis points (Number).
// Known divergence: a document that both holds such a number and nests deeper than the reviver can follow (it
// overflows the stack near a few thousand levels) is read with the plain parse, so such a number there may be
// read as its value rather than as its text.

const MAX63 = 9223372036854775807n;
const MAX53 = 9007199254740991n;
const NONE = -1n;

type Attr = { key: string; value: string };
type Ev = { time: bigint; name: string; attrs: Attr[] };
type Span = {
  idx: number;
  trace: string;
  id: string;
  parent: string;
  name: string;
  kind: number;
  start: bigint;
  end: bigint;
  service: string;
  color: number;
  code: number;
  message: string;
  attrs: Attr[];
  events: Ev[];
  b: bigint; // where it is drawn from (begin)
  e: bigint; // and to (finish)
};
type Frame = { span: Span; depth: number; mark: number; above: string; prow: number; pair: Span | null };
type Gap = { a: bigint; b: bigint };
type Axis = { t0: bigint; t1: bigint; d: bigint; gaps: Gap[]; u: bigint; w: bigint; step: bigint; unit: bigint };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export function handle(bytes: Uint8Array): Uint8Array {
  return encoder.encode(render(bytes));
}

function render(bytes: Uint8Array): string {
  const doc = parse(bytes);
  if (doc === BROKEN) {
    const at = brokenAt(bytes);
    return problem('This is not JSON.', `It stops being JSON at byte ${at} of ${bytes.length}.`, bytes, at);
  }
  if (!isObject(doc)) return problem('This is not an OTLP trace.', 'Its JSON is not an object.', null, -1);
  const resources = doc['resourceSpans'];
  if (!Array.isArray(resources))
    return problem('This is not an OTLP trace.', 'It has no resourceSpans array.', null, -1);
  const colors = new Map<string, number>();
  const spans = readSpans(resources, colors);
  if (spans.length === 0)
    return problem('This trace has no spans.', 'Its resourceSpans hold no span objects.', null, -1);
  return draw(spans, colors);
}

// ---------- JSON ----------

const BROKEN = Symbol('not JSON');

// A number's source text, kept by the reviver when the plain value might not give it back.
class Num {
  readonly src: string;
  constructor(src: string) {
    this.src = src;
  }
}

const ODD_NUMBER = /[:,[][ \t\n\r]*(?:-?\d+[.eE]|-?\d{16}|-0)/;
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F]/;

function parse(bytes: Uint8Array): unknown {
  let source: string, value: unknown;
  try {
    source = utf8.decode(bytes);
    value = JSON.parse(source);
  } catch {
    return BROKEN;
  }
  if (SURROGATE_ESCAPE.test(source) && hasLoneSurrogate(value)) return BROKEN;
  if (ODD_NUMBER.test(source)) {
    try {
      value = JSON.parse(source, (_k: string, v: unknown, ctx?: { source?: string }) =>
        typeof v === 'number' && ctx?.source !== undefined ? new Num(ctx.source) : v,
      );
    } catch {
      // nested deeper than the reviver can follow: keep the plain parse
    }
  }
  return value;
}

function hasLoneSurrogate(value: unknown): boolean {
  const stack = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (!v.isWellFormed()) return true;
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (!k.isWellFormed()) return true;
        stack.push(x);
      }
    }
  }
  return false;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Num);
}

// A string value, or "" for any other.
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// A value as text: a string is itself; a number, true, false or null as written; an array or object […] or {…}.
function scalar(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Num) return v.src;
  if (Array.isArray(v)) return '[…]';
  if (v !== null && typeof v === 'object') return '{…}';
  return String(v);
}

// A time: a string of 1 to 19 digits up to 2^63 - 1, or a JSON integer up to 2^53 - 1; else unreadable (-1).
function nanos(v: unknown): bigint {
  if (typeof v === 'string') return digits(v, MAX63);
  if (typeof v === 'number' || v instanceof Num) {
    const src = scalar(v);
    const c = src.codePointAt(0) ?? 0;
    return c >= 48 && c <= 57 ? digits(src, MAX53) : NONE;
  }
  return NONE;
}

const DIGITS = /^[0-9]{1,19}$/;
function digits(t: string, most: bigint): bigint {
  if (!DIGITS.test(t)) return NONE;
  const n = BigInt(t);
  return n > most ? NONE : n;
}

// Where a document that JSON.parse refused stops being JSON (RFC 8259, as trace.tape checks it): a byte offset.
function brokenAt(v: Uint8Array): number {
  const n = v.length;
  const ws = (at: number): number => {
    while (at < n && (v[at] === 32 || v[at] === 10 || v[at] === 13 || v[at] === 9)) at++;
    return at;
  };
  const has = (at: number, word: string): boolean => {
    if (at + word.length > n) return false;
    for (let i = 0; i < word.length; i++) if (v[at + i] !== word.codePointAt(i)) return false;
    return true;
  };
  const open: boolean[] = []; // true: an object
  let at = ws(0);
  let expect: 'value' | 'key' | 'after' = 'value';
  for (;;) {
    if (expect === 'value') {
      if (at >= n) return at;
      const c = v[at];
      if (c === 123) {
        at = ws(at + 1);
        if (at < n && v[at] === 125) {
          at++;
          expect = 'after';
        } else {
          open.push(true);
          expect = 'key';
        }
      } else if (c === 91) {
        at = ws(at + 1);
        if (at < n && v[at] === 93) {
          at++;
          expect = 'after';
        } else open.push(false);
      } else if (c === 34) {
        const end = stringEnd(v, at + 1);
        if (end < 0) return at;
        at = end;
        expect = 'after';
      } else if (has(at, 'true') || has(at, 'null')) {
        at += 4;
        expect = 'after';
      } else if (has(at, 'false')) {
        at += 5;
        expect = 'after';
      } else {
        const end = numberEnd(v, at);
        if (end < 0) return at;
        at = end;
        expect = 'after';
      }
    } else if (expect === 'key') {
      if (at >= n || v[at] !== 34) return at;
      const end = stringEnd(v, at + 1);
      if (end < 0) return at;
      at = ws(end);
      if (at >= n || v[at] !== 58) return at;
      at = ws(at + 1);
      expect = 'value';
    } else {
      at = ws(at);
      if (open.length === 0) return at === n ? -1 : at;
      if (at >= n) return at;
      const inObject = open.at(-1);
      if (v[at] === 44) {
        at = ws(at + 1);
        expect = inObject ? 'key' : 'value';
      } else if (v[at] === (inObject ? 125 : 93)) {
        open.pop();
        at++;
      } else return at;
    }
  }
}

// After the closing quote of the string whose body starts at `at`, or -1 when it is not a JSON string.
function stringEnd(v: Uint8Array, at: number): number {
  const n = v.length;
  const hex4 = (i: number): number => {
    if (i + 4 > n) return -1;
    let x = 0;
    for (let k = i; k < i + 4; k++) {
      const c = v[k] ?? 0;
      const d = c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1;
      if (d < 0) return -1;
      x = x * 16 + d;
    }
    return x;
  };
  while (at < n) {
    const c = v[at] ?? 0;
    if (c === 34) return at + 1;
    if (c === 92) {
      if (at + 1 >= n) return -1;
      const e = v[at + 1];
      if (e === 117) {
        const unit = hex4(at + 2);
        if (unit < 0 || (unit >= 0xdc00 && unit < 0xe000)) return -1;
        if (unit >= 0xd800 && unit < 0xdc00) {
          const low = v[at + 6] === 92 && v[at + 7] === 117 ? hex4(at + 8) : -1;
          if (low < 0xdc00 || low >= 0xe000) return -1;
          at += 12;
        } else at += 6;
      } else if (e === 34 || e === 92 || e === 47 || e === 98 || e === 102 || e === 110 || e === 114 || e === 116)
        at += 2;
      else return -1;
    } else if (c < 32) return -1;
    else if (c < 128) at++;
    else {
      const next = utf8At(v, at);
      if (next < 0) return -1;
      at = next;
    }
  }
  return -1;
}

// -? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)? from `at`: where it ends, or -1.
function numberEnd(v: Uint8Array, at: number): number {
  const n = v.length;
  const isDigit = (i: number): boolean => (v[i] ?? 0) >= 48 && (v[i] ?? 0) <= 57;
  const digitsEnd = (i: number): number => {
    while (isDigit(i)) i++;
    return i;
  };
  const i = at < n && v[at] === 45 ? at + 1 : at;
  let d = digitsEnd(i);
  if (d === i || (v[i] === 48 && d > i + 1)) return -1;
  if (d < n && v[d] === 46) {
    const f = digitsEnd(d + 1);
    if (f === d + 1) return -1;
    d = f;
  }
  if (d >= n || (v[d] !== 101 && v[d] !== 69)) return d;
  let e = d + 1;
  if (e < n && v[e] === 43) e++;
  if (e < n && v[e] === 45) e++;
  const end = digitsEnd(e);
  return e > d + 2 || end === e ? -1 : end;
}

// After the UTF-8 sequence that starts at a byte >= 128 (RFC 3629), or -1.
function utf8At(v: Uint8Array, at: number): number {
  const n = v.length;
  const cont = (i: number): boolean => i < n && ((v[i] ?? 0) & 192) === 128;
  const b = v[at] ?? 0;
  const c = v[at + 1] ?? 0;
  if (b >= 194 && b < 224 && cont(at + 1)) return at + 2;
  if (b >= 224 && b < 240 && cont(at + 1) && cont(at + 2) && (b !== 224 || c >= 160) && (b !== 237 || c <= 159))
    return at + 3;
  if (
    b >= 240 &&
    b <= 244 &&
    cont(at + 1) &&
    cont(at + 2) &&
    cont(at + 3) &&
    (b !== 240 || c >= 144) &&
    (b !== 244 || c <= 143)
  )
    return at + 4;
  return -1;
}

// ---------- OTLP ----------

// Every span object, in order, numbered, with its service ("(unknown service)" when its resource names none) and
// that service's colour: its place in the order services are first seen.
function readSpans(resources: unknown[], colors: Map<string, number>): Span[] {
  const spans: Span[] = [];
  for (const rs of resources) {
    if (!isObject(rs)) continue;
    const service = serviceName(rs['resource']) || '(unknown service)';
    const scopes = rs['scopeSpans'];
    if (!Array.isArray(scopes)) continue;
    for (const scope of scopes) {
      if (!isObject(scope)) continue;
      const list = scope['spans'];
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        if (!isObject(raw)) continue;
        let color = colors.get(service);
        if (color === undefined) {
          color = colors.size;
          colors.set(service, color);
        }
        spans.push(readSpan(raw, spans.length, service, color));
      }
    }
  }
  return spans;
}

// The value of the last attribute named service.name in the resource's attributes, or "".
function serviceName(resource: unknown): string {
  if (!isObject(resource)) return '';
  const attrs = resource['attributes'];
  let name = '';
  if (Array.isArray(attrs))
    for (const a of attrs) {
      if (!isObject(a)) continue;
      const attr = readAttr(a);
      if (attr.key === 'service.name') name = attr.value;
    }
  return name;
}

function readSpan(o: Record<string, unknown>, idx: number, service: string, color: number): Span {
  const status = o['status'];
  let code = 0,
    message = '';
  if (isObject(status)) {
    if (status['code'] !== undefined) code = codeNamed(scalar(status['code']));
    message = str(status['message']);
  }
  const events = o['events'];
  return {
    idx,
    trace: str(o['traceId']),
    id: str(o['spanId']),
    parent: str(o['parentSpanId']),
    name: str(o['name']),
    kind: o['kind'] === undefined ? 0 : kindNamed(scalar(o['kind'])),
    start: nanos(o['startTimeUnixNano']),
    end: nanos(o['endTimeUnixNano']),
    service,
    color,
    code,
    message,
    attrs: readAttrs(o['attributes']),
    events: Array.isArray(events)
      ? events.filter(isObject).map(ev => ({
          time: nanos(ev['timeUnixNano']),
          name: str(ev['name']),
          attrs: readAttrs(ev['attributes']),
        }))
      : [],
    b: 0n,
    e: 0n,
  };
}

function readAttrs(v: unknown): Attr[] {
  return Array.isArray(v) ? v.filter(isObject).map(readAttr) : [];
}

function readAttr(a: Record<string, unknown>): Attr {
  const value = a['value'];
  return { key: str(a['key']), value: isObject(value) ? anyValue(value) : '' };
}

// An AnyValue as text: of the kinds it has, the first in this order.
const VALUE_KINDS = ['stringValue', 'intValue', 'boolValue', 'doubleValue', 'bytesValue', 'arrayValue', 'kvlistValue'];
function anyValue(o: Record<string, unknown>): string {
  for (const k of VALUE_KINDS) if (o[k] !== undefined) return scalar(o[k]);
  return '';
}

// SpanKind: 1 internal, 2 server, 3 client, 4 producer, 5 consumer; 0 for anything else. A number or its name.
function kindNamed(name: string): number {
  switch (name) {
    case '1':
    case 'SPAN_KIND_INTERNAL':
      return 1;
    case '2':
    case 'SPAN_KIND_SERVER':
      return 2;
    case '3':
    case 'SPAN_KIND_CLIENT':
      return 3;
    case '4':
    case 'SPAN_KIND_PRODUCER':
      return 4;
    case '5':
    case 'SPAN_KIND_CONSUMER':
      return 5;
    default:
      return 0;
  }
}

function codeNamed(name: string): number {
  if (name === '1' || name === 'STATUS_CODE_OK') return 1;
  if (name === '2' || name === 'STATUS_CODE_ERROR') return 2;
  return 0;
}

// ---------- the trace ----------

const big = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const small = (a: bigint, b: bigint): bigint => (a < b ? a : b);
// The smaller of two times, where -1 is no time.
const lower = (a: bigint, b: bigint): bigint => (a < 0n ? b : b < 0n ? a : small(a, b));

function draw(spans: Span[], colors: Map<string, number>): string {
  let lo = NONE;
  for (const s of spans) lo = lower(lower(lo, s.start), s.end);
  const first = big(lo, 0n);
  // A span with no readable start starts at its end; with neither, at the first time of the trace. An end that is
  // unreadable or before the start is the start.
  let t0 = NONE,
    t1 = 0n;
  for (const s of spans) {
    s.b = s.start >= 0n ? s.start : s.end >= 0n ? s.end : first;
    s.e = big(s.end, s.b);
    t0 = lower(t0, s.b);
    t1 = big(t1, s.e);
  }
  const byStart = sortedByStart(spans);
  const { rows } = trees(spans, byStart);
  const axis = axisFor(t0, t1, byStart);
  return svg(rows, axis, colors, summary(spans, colors));
}

// Stable, by where each span is drawn from.
function sortedByStart(list: Span[]): Span[] {
  return list.length < 2 ? list : list.toSorted((x, y) => (x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
}

// Every span once, in the order shown: the trees under the roots (spans with no parent, or whose parent is not in
// the trace), then those under spans no root reaches (their parents form a cycle). A call (a client span) whose
// only child is a server span is one row with it.
function trees(spans: Span[], byStart: Span[]): { rows: Frame[] } {
  const byId = new Map<string, Span>(); // the first span with each id holds its children
  for (const s of spans) if (s.id !== '' && !byId.has(s.id)) byId.set(s.id, s);
  const held = (id: string): boolean => id !== '' && byId.has(id);
  const kids = new Map<string, Span[]>();
  for (const s of spans)
    if (held(s.parent)) {
      const list = kids.get(s.parent);
      if (list) list.push(s);
      else kids.set(s.parent, [s]);
    }
  const heldKids = (s: Span): Span[] => (byId.get(s.id) === s ? (kids.get(s.id) ?? []) : []);

  const rows: Frame[] = [];
  const seen = new Set<number>();
  let count = 0;
  const push = (stack: Frame[], list: Span[], depth: number, above: string, prow: number): void => {
    for (const s of list.toReversed())
      stack.push({ span: s, depth, mark: depth === 0 && s.parent !== '' ? 1 : 0, above, prow, pair: null });
  };
  const walk = (stack: Frame[], check: boolean): void => {
    for (let f = stack.pop(); f !== undefined; f = stack.pop()) {
      if (check && seen.has(f.span.idx)) continue;
      const mine = sortedByStart(heldKids(f.span));
      const k = mine.length === 1 ? mine[0] : undefined;
      const prow = rows.length;
      if (k && f.span.kind === 3 && k.kind === 2 && !(check && seen.has(k.idx))) {
        rows.push({ ...f, pair: k });
        push(stack, sortedByStart(heldKids(k)), f.depth + 1, k.service, prow);
        seen.add(f.span.idx).add(k.idx);
        count += 2;
      } else {
        rows.push(f);
        push(stack, mine, f.depth + 1, f.span.service, prow);
        seen.add(f.span.idx);
        count += 1;
      }
    }
  };
  const roots: Frame[] = [];
  push(roots, sortedByStart(spans.filter(s => !held(s.parent))), 0, '', -1);
  walk(roots, false);
  if (count < spans.length)
    for (const s of byStart)
      if (!seen.has(s.idx)) walk([{ span: s, depth: 0, mark: 2, above: '', prow: -1, pair: null }], true);
  return { rows };
}

// ---------- the axis ----------

// Idle gaps (no span running) of a fifth of the trace or more are compressed to 800 basis points each, when some
// time is left; the rest of the track, w, is shared by u, the time that is left. The tick step is 1, 2 or 5 times
// a power of ten, at least u / (w / 1100): ticks at least 11% of the track apart.
function axisFor(t0: bigint, t1: bigint, byStart: Span[]): Axis {
  const d = t1 - t0 <= 0n ? 1000000n : t1 - t0;
  const need = d / 5n + small(d % 5n, 1n);
  const found: Gap[] = [];
  let end = 0n;
  for (const s of byStart) {
    const b = s.b - t0,
      e = s.e - t0;
    if (b - end >= need) {
      found.push({ a: end, b });
      end = e;
    } else end = big(end, e);
  }
  let idle = 0n;
  for (const g of found) idle += g.b - g.a;
  const gaps = idle < d ? found : [];
  const u = idle < d ? d - idle : d;
  const w = 10000n - 800n * BigInt(gaps.length);
  const q = w / 1100n;
  const want = u / q + small(u % q, 1n);
  let step = 1n;
  for (let pow = 1n; ; pow *= 10n) {
    const m = [1n, 2n, 5n].find(x => x * pow >= want);
    if (m !== undefined) {
      step = m * pow;
      break;
    }
  }
  const unit = step >= 200000000n ? 1000000000n : step >= 200000n ? 1000000n : step >= 200n ? 1000n : 1n;
  return { t0, t1, d, gaps, u, w, step, unit };
}

// Where time t (ns after t0) is on the track, in basis points: linear outside the gaps, each gap 800 wide.
function xOf(t: bigint, axis: Axis): number {
  let removed = 0n;
  let k = 0;
  for (const { a, b } of axis.gaps) {
    if (t > b) {
      removed += b - a;
      k++;
    } else if (t > a) return scale(a - removed, axis.u, axis.w) + 800 * k + scale(t - a, b - a, 800n);
    else break;
  }
  return scale(t - removed, axis.u, axis.w) + 800 * k;
}

// a * w / d, rounded, halved together until the product cannot overflow an i64 (as trace.tape does).
function scale(a: bigint, d: bigint, w: bigint): number {
  while (d > 900000000000000n) {
    a /= 2n;
    d /= 2n;
  }
  return Number((a * w + d / 2n) / d);
}

function unitName(unit: bigint): string {
  return unit === 1000000000n ? 's' : unit === 1000000n ? 'ms' : unit === 1000n ? 'µs' : 'ns';
}

// ---------- counting ----------

type Summary = { spans: number; services: number; errors: number; traces: number; trace: string; cut: number };

function summary(spans: Span[], colors: Map<string, number>): Summary {
  const traces = new Set<string>();
  let errors = 0;
  for (const s of spans) {
    if (s.trace !== '') traces.add(s.trace);
    if (s.code === 2) errors++;
  }
  const [only = ''] = traces;
  return {
    spans: spans.length,
    services: colors.size,
    errors,
    traces: traces.size,
    trace: traces.size === 1 ? only : '',
    cut: serviceCut([...colors.keys()]),
  };
}

// How much to leave off the front of every service name: the prefix they all share, up to and with its last "/",
// when every name has something after it; else 0.
function serviceCut(names: string[]): number {
  const [first = ''] = names;
  let n = first.length;
  for (const name of names) {
    let i = 0;
    while (i < n && i < name.length && first.codePointAt(i) === name.codePointAt(i)) i++;
    n = i;
  }
  const cut = n > 0 ? first.lastIndexOf('/', n - 1) + 1 : 0;
  return names.every(name => name.length > cut) ? cut : 0;
}

// What kinds of event: 1 SQL, 2 a timer, 4 an error, 8 any other.
function kindBit(name: string): number {
  switch (name) {
    case 'tape.span.missing':
    case 'tape.run.rolled_back':
    case 'tape.check.problem':
    case 'db.prepare.failed':
    case 'exception':
      return 4;
  }
  if (name.startsWith('db.')) return 1;
  return name === 'tape.timer.set' ? 2 : 8;
}

// ---------- the picture ----------

const DARK =
  '{--_bg:var(--tr-bg,#111114);--_fg:var(--tr-fg,#ececef);--_mut:var(--tr-muted,#a1a1aa);--_grid:var(--tr-grid,#26262b);--_hover:var(--tr-row-hover,#1d1d22);--_err:var(--tr-error,#f97066);--_s1:var(--tr-s1,#60a5fa);--_s2:var(--tr-s2,#fbbf24);--_s3:var(--tr-s3,#2dd4bf);--_s4:var(--tr-s4,#c4b5fd);--_s5:var(--tr-s5,#f472b6);--_s6:var(--tr-s6,#67e8f9);--_s7:var(--tr-s7,#a3e635);--_s8:var(--tr-s8,#a1a1aa);--_ink:#111114}';
const STYLE =
  '<style>' +
  ".otlp-waterfall{--_bg:var(--tr-bg,#fff);--_fg:var(--tr-fg,#18181b);--_mut:var(--tr-muted,#696972);--_grid:var(--tr-grid,#ededf0);--_hover:var(--tr-row-hover,#f4f4f6);--_err:var(--tr-error,#d92d20);--_s1:var(--tr-s1,#2563eb);--_s2:var(--tr-s2,#b45309);--_s3:var(--tr-s3,#0f766e);--_s4:var(--tr-s4,#7c3aed);--_s5:var(--tr-s5,#be185d);--_s6:var(--tr-s6,#0e7490);--_s7:var(--tr-s7,#4d7c0f);--_s8:var(--tr-s8,#71717a);--_ink:#fff;font-family:var(--tr-font,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);font-variant-numeric:tabular-nums}" +
  '@media (prefers-color-scheme:dark){.otlp-waterfall:not([data-theme=light] *):not([data-theme=light])' +
  DARK +
  '}[data-theme=dark] .otlp-waterfall,.otlp-waterfall[data-theme=dark]' +
  DARK +
  ".otlp-waterfall text{fill:var(--_fg);font-size:12.5px}.otlp-waterfall .page{fill:var(--_bg)}.otlp-waterfall .h1{font-size:15px;font-weight:600}.otlp-waterfall .st{font-size:12px;font-weight:600}.otlp-waterfall .ok{fill:var(--_mut)}.otlp-waterfall .bad,.otlp-waterfall .errs{fill:var(--_err)}.otlp-waterfall .meta,.otlp-waterfall .lg{font-size:12px;fill:var(--_mut)}.otlp-waterfall .meta .v{fill:var(--_fg);font-weight:600}.otlp-waterfall .mono{font-family:var(--tr-mono,ui-monospace,'SF Mono',Menlo,Consolas,monospace);font-size:11.5px}.otlp-waterfall .tk,.otlp-waterfall .dur,.otlp-waterfall .gapl{font-size:11px;fill:var(--_mut)}.otlp-waterfall .svc,.otlp-waterfall .tag{font-size:11.5px;fill:var(--_mut)}.otlp-waterfall .tag{font-style:italic}.otlp-waterfall .anon{fill:var(--_mut);font-style:italic}" +
  '.otlp-waterfall .gl{stroke:var(--_grid);stroke-width:1}.otlp-waterfall .ax{stroke:var(--_grid);stroke-width:1}.otlp-waterfall .gap{fill:var(--_hover)}.otlp-waterfall .brk{fill:none;stroke:var(--_mut);stroke-width:1.25}.otlp-waterfall .gd,.otlp-waterfall .over{pointer-events:none}.otlp-waterfall .gd path{fill:none;stroke:var(--_grid);stroke-width:1}.otlp-waterfall .bg{fill:transparent}.otlp-waterfall .row{outline:none}.otlp-waterfall .row:hover .bg,.otlp-waterfall .row:focus-visible .bg{fill:var(--_hover)}.otlp-waterfall .row:focus-visible .bg{stroke:var(--_s1);stroke-width:2}.otlp-waterfall .acc{fill:var(--_err)}' +
  '.otlp-waterfall .c0{fill:var(--_s1);color:var(--_s1)}.otlp-waterfall .c1{fill:var(--_s2);color:var(--_s2)}.otlp-waterfall .c2{fill:var(--_s3);color:var(--_s3)}.otlp-waterfall .c3{fill:var(--_s4);color:var(--_s4)}.otlp-waterfall .c4{fill:var(--_s5);color:var(--_s5)}.otlp-waterfall .c5{fill:var(--_s6);color:var(--_s6)}.otlp-waterfall .c6{fill:var(--_s7);color:var(--_s7)}.otlp-waterfall .c7{fill:var(--_s8);color:var(--_s8)}.otlp-waterfall .bar.e{fill:var(--_err);color:var(--_err)}.otlp-waterfall .env{fill-opacity:.2;stroke:currentColor;stroke-opacity:.55;stroke-width:1}.otlp-waterfall .orphan .bar,.otlp-waterfall .cycle .bar{stroke:var(--_fg);stroke-width:1;stroke-dasharray:3 2}.otlp-waterfall .err .dur,.otlp-waterfall .err .nm{fill:var(--_err)}.otlp-waterfall .dur.in{fill:var(--_ink);font-weight:600}.otlp-waterfall .err .dur.in{fill:var(--_ink)}' +
  '.otlp-waterfall .ev{stroke:var(--_bg);stroke-width:1}.otlp-waterfall .ev.q{stroke:var(--_fg);stroke-width:1.5}.otlp-waterfall .ev.t{fill:var(--_bg);stroke:var(--_fg);stroke-width:1.5}.otlp-waterfall .ev.o{fill:var(--_fg)}.otlp-waterfall .ev.x{fill:var(--_err)}.otlp-waterfall .ev.out{opacity:.45}.otlp-waterfall .k-q{fill:var(--_fg);font-weight:700}.otlp-waterfall .k-x{fill:var(--_err)}.otlp-waterfall .k-t,.otlp-waterfall .k-o{fill:var(--_fg)}.otlp-waterfall .why{font-size:15px;font-weight:600}.otlp-waterfall .warn{fill:var(--_s2)}@media (max-width:560px){.otlp-waterfall .odd,.otlp-waterfall .tid,.otlp-waterfall .gapl,.otlp-waterfall .ek,.otlp-waterfall .lg .v{display:none}}</style>';

const TOP = 100;

function svg(rows: Frame[], axis: Axis, colors: Map<string, number>, sum: Summary): string {
  const bottom = TOP + 26 * rows.length;
  let out =
    `<svg xmlns="http://www.w3.org/2000/svg" class="otlp-waterfall" width="100%" height="${bottom + 12}" role="img" aria-label="Trace waterfall: ${sum.spans} spans">` +
    STYLE +
    `<rect class="page" x="0" y="0" width="100%" height="${bottom + 12}"/>` +
    header(rows, axis, colors, sum) +
    `<svg class="tc" x="33%" width="65.5%" height="${bottom}" overflow="visible">`;
  for (const g of axis.gaps)
    out += `<rect class="gap" x="${bp(xOf(g.a, axis))}" y="${TOP}" width="8%" height="${bottom - TOP}"/>`;
  out += ticks(axis, bottom);
  out += `<line class="ax" x1="0" x2="100%" y1="${TOP - 1}.5" y2="${TOP - 1}.5"/></svg>`;
  const gapX = axis.gaps.map(g => ({ a: xOf(g.a, axis), b: xOf(g.b, axis) }));
  rows.forEach((f, i) => {
    out += row(f, TOP + 26 * i, axis, gapX, sum.cut);
  });
  out += `<svg class="over" x="33%" width="65.5%" height="${bottom}" overflow="visible">`;
  for (const g of axis.gaps)
    out +=
      `<svg x="${bp(xOf(g.a, axis) + 400)}" overflow="visible"><path class="brk" d="M-6 ${TOP + 4}l4 -9M2 ${TOP + 4}l4 -9"/>` +
      `<text class="gapl" transform="rotate(-90)" x="-${TOP + 10}" y="4" text-anchor="end">${dur(g.b - g.a)} idle</text></svg>`;
  out += `</svg><svg class="lc gd" y="${TOP}" width="32%" height="${bottom - TOP}">`;
  // the elbows of the tree: from under the parent's swatch down to this row and across
  rows.forEach((f, i) => {
    if (f.prow < 0 || f.depth > 12) return;
    const px = 16 + 14 * (f.depth - 1);
    out += `<path d="M${px}.5 ${26 * f.prow + 19}V${26 * i + 13}.5H${px + 10}"/>`;
  });
  return out + '</svg></svg>\n';
}

// What happened, first: the first row's name and how it answered; then how long the trace took, its spans,
// services and errors, and its id; then the services, by colour, and the kinds of event shown.
function header(rows: Frame[], axis: Axis, colors: Map<string, number>, sum: Summary): string {
  const first = rows[0]?.span;
  if (!first) return '';
  let out = `<text class="h1" x="12" y="24">${nonempty(first.name, 80, '(unnamed)')}${outcome(first)}</text>`;
  out += `<text class="meta" x="12" y="46"><tspan class="v">${dur(axis.t1 - axis.t0)}</tspan> · ${sum.spans} ${sum.spans === 1 ? 'span' : 'spans'} · ${sum.services} ${sum.services === 1 ? 'service' : 'services'}`;
  if (sum.errors === 1) out += ' · <tspan class="errs">1 error</tspan>';
  else if (sum.errors > 1) out += ` · <tspan class="errs">${sum.errors} errors</tspan>`;
  if (sum.traces === 1)
    out += `<tspan class="tid"> · trace <tspan class="mono">${short(sum.trace, 9)}</tspan><title>${short(sum.trace, 64)}</title></tspan>`;
  else if (sum.traces > 1) out += ` · ${sum.traces} traces`;
  out += '</text>';

  // The services in the order first seen: a swatch, the name, how many spans the rows show (a call's row shows
  // two). Past seven, the rest share the last colour and are counted together. Then a key to the event marks.
  const perColor = Array.from({ length: colors.size }, () => 0);
  let kinds = 0;
  for (const f of rows)
    for (const s of f.pair ? [f.span, f.pair] : [f.span]) {
      perColor[s.color] = (perColor[s.color] ?? 0) + 1;
      kinds |= eventKinds(s.events);
    }
  out += '<text class="lg" x="12" y="68">';
  for (const [c, name] of [...colors.keys()].entries()) {
    if (c === 7 && colors.size > 8) {
      out += `<tspan class="c7" dx="14">■</tspan> ${colors.size - 7} more`;
      break;
    }
    out += `<tspan class="c${c}"${c > 0 ? ' dx="14"' : ''}>■</tspan> ${serviceShort(name, sum.cut, 32)} <tspan class="v">${perColor[c]}</tspan>`;
  }
  out += '<tspan class="ek" dx="18">';
  if (kinds & 1) out += '<tspan class="k-q">│</tspan> sql ';
  if (kinds & 2) out += '<tspan class="k-t">○</tspan> timer ';
  if (kinds & 4) out += '<tspan class="k-x">◆</tspan> error ';
  if (kinds & 8) out += '<tspan class="k-o">•</tspan> event ';
  return out + '</tspan></text>';
}

function eventKinds(events: Ev[]): number {
  let kinds = 0;
  for (const ev of events.slice(0, 100)) kinds |= kindBit(ev.name);
  return kinds;
}

// How the first row answered: its HTTP status when it has one, else OK or Error.
function outcome(s: Span): string {
  const code = s.attrs.find(a => a.key === 'http.response.status_code')?.value ?? '';
  const cls = s.code === 2 || code.startsWith('5') ? 'bad' : code.startsWith('4') ? 'warn' : 'ok';
  const what = code !== '' ? short(code, 12) : s.code === 2 ? 'Error' : 'OK';
  return `<tspan class="st ${cls}" dx="10">${what}</tspan>`;
}

// Ticks in each stretch between gaps: in the first, at multiples of the step from 0, labelled with the time; in
// each one after a gap, at multiples of the step from its start (not the start itself), labelled "+" the time
// since it. Hidden on a narrow screen: every other one when a stretch has four or more, and all after a gap.
function ticks(axis: Axis, bottom: number): string {
  const segs: Gap[] = [];
  let from = 0n;
  for (const g of axis.gaps) {
    segs.push({ a: from, b: g.a });
    from = g.b;
  }
  segs.push({ a: from, b: axis.d });
  let out = '';
  segs.forEach((seg, j) => {
    const n = (seg.b - seg.a) / axis.step;
    for (let m = j > 0 ? 1n : 0n; m <= n; m++) {
      const x = xOf(seg.a + m * axis.step, axis);
      const hide = j > 0 || (n >= 4n && m % 2n === 1n);
      const anchor = m === 0n ? 'start' : x >= 9000 ? 'end' : 'middle';
      out +=
        `<g class="tick${hide ? ' odd' : ''}"><line class="gl" x1="${bp(x)}" x2="${bp(x)}" y1="${TOP}" y2="${bottom}" shape-rendering="crispEdges"/>` +
        `<text class="tk" x="${bp(x)}" text-anchor="${anchor}" y="${TOP - 10}">${j > 0 ? '+' : ''}${tickLabel(m * axis.step, axis.unit)}</text></g>`;
    }
  });
  return out;
}

// A tick's time in the axis unit: whole, or with one decimal (a step is at least a fifth of the unit).
function tickLabel(value: bigint, unit: bigint): string {
  if (value === 0n) return '0';
  const name = unitName(unit);
  if (value % unit === 0n) return `${value / unit} ${name}`;
  return `${value / unit}.${(value % unit) / (unit / 10n)} ${name}`;
}

// A position on the track, as a percentage with two decimals.
function bp(x: number): string {
  const frac = x % 100;
  return `${Math.trunc(x / 100)}.${frac < 10 ? '0' : ''}${frac}%`;
}

// A duration, to three significant digits with no trailing zeros: 812 ns, 4.2 µs, 13.5 ms, 2 s, 1234 s.
function dur(d: bigint): string {
  if (d < 1000n) return `${d} ns`;
  let unit = d < 1000000n ? 1000n : d < 1000000000n ? 1000000n : 1000000000n;
  for (;;) {
    const name = unitName(unit);
    const hundredths = rounded(d, unit / 100n);
    if (hundredths < 1000n) {
      if (hundredths % 10n > 0n) return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')} ${name}`;
      return `${tenths(hundredths / 10n)} ${name}`;
    }
    const tens = rounded(d, unit / 10n);
    if (tens < 1000n) return `${tenths(tens)} ${name}`;
    const whole = rounded(d, unit);
    if (whole < 1000n || unit === 1000000000n) return `${whole} ${name}`;
    unit *= 1000n;
  }
}

function tenths(n: bigint): string {
  return n % 10n > 0n ? `${n / 10n}.${n % 10n}` : `${n / 10n}`;
}

// d / by, rounded half up, without adding to d.
function rounded(d: bigint, by: bigint): bigint {
  return (d % by) * 2n >= by ? d / by + 1n : d / by;
}

// ---------- rows ----------

// A row: a <g> that takes the focus, with the span's tooltip; the label in its column; in the track, the bar (a
// call's row: the client span as a pale envelope, the server span solid inside it), the event marks and the
// duration.
function row(f: Frame, y: number, axis: Axis, gapX: { a: number; b: number }[], cut: number): string {
  const s = f.span;
  const p = f.pair;
  const x = xOf(s.b - axis.t0, axis);
  const xe = xOf(s.e - axis.t0, axis);
  const err = s.code === 2 || p?.code === 2;
  let out = `<g class="row${err ? ' err' : ''}${f.mark === 1 ? ' orphan' : f.mark === 2 ? ' cycle' : ''}" tabindex="0" data-idx="${s.idx}"`;
  if (p) out += ` data-pair="${p.idx}"`;
  out += ` data-id="${short(s.id, 64)}" data-depth="${f.depth}"><title>${tooltip(s, f.mark, axis)}</title><rect class="bg" x="0" y="${y}" width="100%" height="26"/>`;
  if (err) out += `<rect class="acc" x="0" y="${y + 3}" width="3" height="20" rx="1.5"/>`;
  out += label(f, y, cut);
  out += `<svg class="tc" x="33%" y="${y}" width="65.5%" height="26" overflow="visible">`;
  if (p) {
    out += bar(s, x, xe, ' env', '" y="4" height="18" rx="3"/>');
    const px = xOf(p.b - axis.t0, axis);
    out +=
      `<rect class="bar c${Math.min(p.color, 7)}${p.code === 2 ? ' e' : ''}" data-idx="${p.idx}" x="${bp(px)}" width="${bp(Math.max(xOf(p.e - axis.t0, axis) - px, 30))}"` +
      ` y="8" height="10" rx="2"><title>${tooltip(p, 0, axis)}</title></rect>`;
  } else out += bar(s, x, xe, '', '" y="7" height="12" rx="2"/>');
  out += markers(s, axis);
  if (p) out += markers(p, axis);
  // Room for the duration beside an edge: not when a compressed gap starts within 15% of the track after the
  // bar's end, or ends within 15% before its start.
  const after = gapX.every(g => g.a - xe < 0 || g.a - xe >= 1500);
  const before = gapX.every(g => g.b - x > 0 || g.b - x <= -1500);
  out += duration(x, xe, dur(s.e - s.b), after, before);
  return out + '</svg></g>';
}

// The label: indented 14 px a level (to twelve levels; deeper rows say their depth), a swatch of the service's
// colour, the name, and the service when it is not the one of the row above it in the tree.
function label(f: Frame, y: number, cut: number): string {
  const ind = 12 + 14 * Math.min(f.depth, 12);
  const shown = f.pair ?? f.span;
  let out = `<svg class="lc" y="${y}" width="32%" height="26"><rect class="sw c${Math.min(shown.color, 7)}" x="${ind}" y="9" width="8" height="8" rx="2"/><text class="nm" x="${ind + 14}" y="17">`;
  if (f.depth > 12) out += `<tspan class="tag">${f.depth} ▸ </tspan>`;
  out += f.span.name === '' ? '<tspan class="anon">(unnamed)</tspan>' : short(f.span.name, 80);
  if (shown.service !== f.above) out += `<tspan class="svc" dx="4"> ${serviceShort(shown.service, cut, 40)}</tspan>`;
  if (f.mark === 1) out += '<tspan class="tag" dx="4"> orphan</tspan>';
  else if (f.mark === 2) out += '<tspan class="tag" dx="4"> cycle</tspan>';
  return out + '</text></svg>';
}

// A bar, at least 0.30% of the track wide, so a span with no duration is still seen.
function bar(s: Span, x: number, xe: number, env: string, rest: string): string {
  return `<rect class="bar c${Math.min(s.color, 7)}${s.code === 2 ? ' e' : ''}${env}" data-idx="${s.idx}" x="${bp(x)}" width="${bp(Math.max(xe - x, 30))}${rest}`;
}

// The duration beside the bar: after it when it ends before 78% of the track and there is room, else before it
// when it starts after 22% and there is room, else inside it when it is wide enough, else after it, or before it
// when it ends past 88%.
function duration(x: number, xe: number, d: string, after: boolean, before: boolean): string {
  if (xe <= 7800 && after) return `<text class="dur" x="${bp(Math.max(xe, x + 30))}" dx="6" y="17">${d}</text>`;
  if (x >= 2200 && before) return `<text class="dur" x="${bp(x)}" dx="-6" text-anchor="end" y="17">${d}</text>`;
  if (xe - x >= 1800) return `<text class="dur in" x="${bp(xe)}" dx="-6" text-anchor="end" y="17">${d}</text>`;
  if (xe <= 8800) return `<text class="dur" x="${bp(Math.max(xe, x + 30))}" dx="6" y="17">${d}</text>`;
  return `<text class="dur" x="${bp(x)}" dx="-6" text-anchor="end" y="17">${d}</text>`;
}

// A mark for each event, to 100, at its time (kept to the axis; an unreadable time is the span's start): a tick
// for SQL, a ring for a timer, a red diamond for an error, a dot for anything else. One outside its span's time is
// drawn faint and says so.
function markers(s: Span, axis: Axis): string {
  let out = '';
  const b = s.b - axis.t0;
  for (const ev of s.events.slice(0, 100)) {
    const t = ev.time < 0n ? b : big(0n, small(ev.time - axis.t0, axis.d));
    const x = bp(xOf(t, axis));
    const kind = kindBit(ev.name);
    const outside = ev.time >= 0n && (ev.time < s.b || ev.time > s.e);
    const faint = outside ? ' out' : '';
    let title = `${nonempty(ev.name, 120, '(unnamed event)')}\n`;
    title += t - b < 0n ? `${dur(b - t)} before the span starts` : `${dur(t - b)} after the span starts`;
    if (outside) title += "\noutside the span's time";
    title += attrLines(ev.attrs, 12);
    if (kind === 1)
      out += `<line class="ev q${faint}" x1="${x}" x2="${x}" y1="5" y2="21"><title>${title}</title></line>`;
    else if (kind === 4)
      out += `<svg class="ev x${faint}" x="${x}" overflow="visible"><title>${title}</title><path d="M0 7.5 5.5 13 0 18.5-5.5 13Z"/></svg>`;
    else
      out += `<circle class="ev ${kind === 2 ? 't' : 'o'}${faint}" cx="${x}" cy="13" r="${kind === 2 ? '3.5' : '2.5'}"><title>${title}</title></circle>`;
  }
  return out;
}

// ---------- tooltips ----------

const KIND_NAMES = ['unspecified kind', 'internal', 'server', 'client', 'producer', 'consumer'];

function tooltip(s: Span, mark: number, axis: Axis): string {
  let out = `${nonempty(s.name, 200, '(unnamed)')}\n${short(s.service, 80)} · ${KIND_NAMES[s.kind]} · ${dur(s.e - s.b)}`;
  out += `\nstarts ${dur(s.b - axis.t0)} into the trace\nspan ${nonempty(s.id, 64, '(no id)')}`;
  if (s.parent !== '') out += ` · parent ${short(s.parent, 64)}`;
  if (s.code === 2) out += s.message !== '' ? `\nerror: ${short(s.message, 300)}` : '\nerror';
  if (mark === 1) out += '\norphan: its parent is not in this trace';
  else if (mark === 2) out += '\ncycle: its parents lead back to it, so it is shown at the top';
  if (s.start < 0n && s.end < 0n) out += '\nno readable start or end time';
  else if (s.start < 0n) out += '\nno readable start time';
  else if (s.end < 0n) out += '\nno readable end time';
  else if (s.end < s.start) out += '\nit ends before it starts';
  out += attrLines(s.attrs, 24);
  const n = s.events.length;
  if (n === 1) out += '\n1 event';
  else if (n > 1) out += `\n${n} events`;
  return out;
}

function attrLines(attrs: Attr[], most: number): string {
  let out = '';
  for (const { key, value } of attrs.slice(0, most)) out += `\n${short(key, 80)} = ${short(value, 160)}`;
  if (attrs.length > most) out += `\n… and ${attrs.length - most} more`;
  return out;
}

// ---------- text into XML ----------

// A service name with the shared prefix left off.
function serviceShort(name: string, cut: number, n: number): string {
  return short(name.slice(Math.min(cut, name.length)), n);
}

function nonempty(t: string, n: number, none: string): string {
  return t === '' ? none : short(t, n);
}

// Text, to n characters (code points): past that, its first n - 1 and an ellipsis.
function short(text: string, n: number): string {
  if (text.length <= n) return xml(text);
  let count = 0;
  let cutAt = -1;
  for (let i = 0; i < text.length; i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1) {
    if (count === n - 1) cutAt = i;
    count++;
  }
  return count <= n ? xml(text) : `${xml(text.slice(0, cutAt))}…`;
}

// Text as XML character data or attribute text: & < > " ' as references; tab, line feed and carriage return as
// spaces; any other control character, and U+FFFE and U+FFFF (which XML does not allow), as U+FFFD.
// oxlint-disable-next-line no-control-regex
const XML_SPECIAL = /[&<>"'\u0000-\u001F\uFFFE\uFFFF]/g;
// oxlint-disable-next-line no-control-regex
const XML_TEST = /[&<>"'\u0000-\u001F\uFFFE\uFFFF]/;
function xml(text: string): string {
  if (!XML_TEST.test(text)) return text;
  return text.replaceAll(XML_SPECIAL, c => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      case '\t':
      case '\n':
      case '\r':
        return ' ';
      default:
        return '�';
    }
  });
}

// ---------- when the trace cannot be drawn ----------

function problem(why: string, detail: string, raw: Uint8Array | null, at: number): string {
  let out =
    `<svg xmlns="http://www.w3.org/2000/svg" class="otlp-waterfall problem" width="100%" height="104" role="img" aria-label="${xml(why)}">` +
    STYLE +
    '<rect class="page" x="0" y="0" width="100%" height="104"/>' +
    `<text class="why" x="12" y="32">${xml(why)}</text><text class="meta" x="12" y="56">${xml(detail)}</text>`;
  if (raw !== null && at >= 0 && raw.length > 0) {
    // the bytes around where it stopped, narrowed to whole UTF-8 characters, and to nothing if they are not UTF-8
    const isCont = (i: number): boolean => i < raw.length && ((raw[i] ?? 0) & 192) === 128;
    let a = Math.max(0, at - 24);
    while (isCont(a)) a++;
    let b = Math.min(raw.length, at + 24);
    while (b > 0 && isCont(b)) b--;
    let near = '';
    try {
      near = utf8.decode(raw.subarray(a, Math.max(a, b)));
    } catch {
      near = '';
    }
    out += `<text class="meta" x="12" y="80"><tspan class="v">near: </tspan>${short(near, 48)}</text>`;
  }
  return `${out}</svg>\n`;
}
