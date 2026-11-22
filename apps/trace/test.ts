// apps/trace/test.ts: the gates for trace.tape, each with an oracle that is not the renderer.
//   node apps/trace/test.ts             run every gate; exit 1 if one fails
//   node apps/trace/test.ts --max       the largest synthetic trace it renders within the budget
//   node apps/trace/test.ts --plants    plant a bug in a scratch copy of trace.tape for each gate, and show that
//                                       the gate it is meant for fails (exit 1 if one does not)
// The oracles: JSON.parse (with the source text of every scalar, so a number is read as it was written) and
// BigInt arithmetic for what the picture should show, computed from the OTLP alone by the rules at the top of
// trace.tape; an XML reader written here for the SVG; fmt.ts and compile() for the gate a program passes.
import '../../node25.ts';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../../compiler.ts';
import { format } from '../../fmt.ts';
import { instantiate } from '../../host.ts';
import { std } from '../../std.ts';

const HERE = new URL('./', import.meta.url).pathname;
const SOURCE = `${HERE}trace.tape`;
const enc = new TextEncoder();

// ---------- running the renderer ----------

type Ran = { out: Uint8Array | null; trap: string | null; steps: number; bytes: number; ms: number };
type Renderer = { run: (input: Uint8Array) => Ran; wasm: number };

function build(text: string): Renderer | string {
  const r = compile([...std, { name: 'trace.tape', text }]);
  if (!r.wasm) return r.errors.map(e => `${e.file}:${e.line}: ${e.code} ${e.message}`).join('\n');
  const mod = new WebAssembly.Module(r.wasm);
  return {
    wasm: r.wasm.length,
    run: input => {
      const app = instantiate(mod, {});
      const t0 = performance.now();
      let out: Uint8Array | null = null,
        trap: string | null = null;
      try {
        out = app.handle(input);
      } catch (e) {
        trap = e instanceof Error ? e.message : String(e);
      }
      const cost = app.exports['cost'];
      return {
        out,
        trap,
        steps: cost instanceof WebAssembly.Global ? Number(cost.value) : -1,
        bytes: app.bytesUsed,
        ms: performance.now() - t0,
      };
    },
  };
}

// ---------- an XML reader ----------

type El = { name: string; attrs: Record<string, string>; kids: (El | string)[] };
const XML_CHAR = /^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;
const NAME = /[A-Za-z_:][A-Za-z0-9_:.-]*/y;

function entity(s: string, i: number): [string, number] {
  const end = s.indexOf(';', i);
  if (end < 0 || end - i > 10) throw new Error(`bare & at ${i}`);
  const body = s.slice(i + 1, end);
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  let ch: string | undefined = named[body];
  if (ch === undefined && /^#[0-9]+$/.test(body)) ch = String.fromCodePoint(Number(body.slice(1)));
  if (ch === undefined && /^#x[0-9a-fA-F]+$/.test(body)) ch = String.fromCodePoint(parseInt(body.slice(2), 16));
  if (ch === undefined || !XML_CHAR.test(ch)) throw new Error(`bad reference &${body}; at ${i}`);
  return [ch, end + 1];
}

/** The document's root element; throws when the text is not well-formed XML. */
function parseXml(s: string): El {
  if (!XML_CHAR.test(s)) throw new Error('a character XML does not allow');
  let i = 0;
  const ws = (): void => {
    while (i < s.length && ' \t\r\n'.includes(s.charAt(i))) i++;
  };
  const name = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(s);
    if (!m) throw new Error(`a name expected at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const element = (): El => {
    if (s[i] !== '<') throw new Error(`< expected at ${i}`);
    i++;
    const el: El = { name: name(), attrs: {}, kids: [] };
    for (;;) {
      const before = i;
      ws();
      if (s.startsWith('/>', i)) {
        i += 2;
        return el;
      }
      if (s[i] === '>') {
        i++;
        break;
      }
      if (i === before) throw new Error(`space expected before an attribute at ${i}`);
      const a = name();
      ws();
      if (s[i] !== '=') throw new Error(`= expected at ${i}`);
      i++;
      ws();
      const q = s[i];
      if (q !== '"' && q !== "'") throw new Error(`a quote expected at ${i}`);
      i++;
      let v = '';
      while (s[i] !== q) {
        if (i >= s.length || s[i] === '<') throw new Error(`bad attribute value at ${i}`);
        if (s[i] === '&') {
          const [c, next] = entity(s, i);
          v += c;
          i = next;
        } else v += '\t\n\r'.includes(s.charAt(i)) ? (i++, ' ') : s[i++];
      }
      i++;
      if (Object.hasOwn(el.attrs, a)) throw new Error(`attribute ${a} twice`);
      el.attrs[a] = v;
    }
    let text = '';
    for (;;) {
      if (i >= s.length) throw new Error(`<${el.name}> not closed`);
      if (s.startsWith('</', i)) {
        if (text) el.kids.push(text);
        i += 2;
        const n = name();
        ws();
        if (n !== el.name || s[i] !== '>') throw new Error(`</${n}> closes <${el.name}> at ${i}`);
        i++;
        return el;
      }
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i);
        if (end < 0) throw new Error('comment not closed');
        i = end + 3;
      } else if (s[i] === '<') {
        if (text) el.kids.push(text);
        text = '';
        el.kids.push(element());
      } else if (s[i] === '&') {
        const [c, next] = entity(s, i);
        text += c;
        i = next;
      } else {
        if (s.startsWith(']]>', i)) throw new Error(']]> in text');
        text += s[i++];
      }
    }
  };
  ws();
  const root = element();
  ws();
  if (i !== s.length) throw new Error(`content after the root element at ${i}`);
  return root;
}

const kids = (el: El): El[] => el.kids.filter((k): k is El => typeof k !== 'string');
const textOf = (el: El): string => el.kids.map(k => (typeof k === 'string' ? k : textOf(k))).join('');
const classes = (el: El): string[] => (el.attrs['class'] ?? '').split(' ').filter(Boolean);
const has = (el: El, c: string): boolean => classes(el).includes(c);
function all(el: El, keep: (e: El) => boolean, out: El[] = []): El[] {
  for (const k of kids(el)) {
    if (keep(k)) out.push(k);
    all(k, keep, out);
  }
  return out;
}

// ---------- the oracle: what the picture must show, from the OTLP alone ----------

const SCALAR = Symbol('scalar');
type Scalar = { [SCALAR]: true; v: string | number | boolean | null; src: string };
const isScalar = (x: unknown): x is Scalar => typeof x === 'object' && x !== null && SCALAR in x;
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !isScalar(x) && !Array.isArray(x);
const get = (o: unknown, k: string): unknown => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string => (isScalar(x) && typeof x.v === 'string' ? x.v : '');
const MAX63 = 2n ** 63n - 1n,
  MAX53 = 2n ** 53n - 1n;

function wellFormed(x: unknown): boolean {
  if (isScalar(x)) return typeof x.v !== 'string' || x.v.isWellFormed();
  if (Array.isArray(x)) return x.every(wellFormed);
  if (isObj(x)) return Object.entries(x).every(([k, v]) => k.isWellFormed() && wellFormed(v));
  return true;
}

/** JSON, every scalar with the text it was written as; null when the bytes are not JSON (RFC 8259, UTF-8). */
function readJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    // the reviver's third argument (the source text of a scalar) is newer than TypeScript's lib
    const reviver = (_k: string, v: unknown, ctx?: { source?: string }): unknown =>
      typeof v === 'object' && v !== null ? v : { [SCALAR]: true, v, src: ctx?.source ?? '' };
    doc = JSON.parse(text, reviver);
  } catch {
    return null;
  }
  return wellFormed(doc) ? doc : null;
}

function nanos(x: unknown): bigint {
  if (!isScalar(x)) return -1n;
  if (typeof x.v === 'string') return /^[0-9]{1,19}$/.test(x.v) && BigInt(x.v) <= MAX63 ? BigInt(x.v) : -1n;
  return /^[0-9]{1,19}$/.test(x.src) && BigInt(x.src) <= MAX53 ? BigInt(x.src) : -1n;
}
const KINDS = ['', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];
function enumOf(x: unknown, names: string[], prefix: string): number {
  if (!isScalar(x)) return 0;
  const t = typeof x.v === 'string' ? x.v : x.src;
  const i = names.findIndex((n, k) => k > 0 && (t === String(k) || t === `${prefix}${n}`));
  return Math.max(i, 0);
}
const PRECEDENCE = ['stringValue', 'intValue', 'boolValue', 'doubleValue', 'bytesValue', 'arrayValue', 'kvlistValue'];
function shown(av: unknown): string {
  const k = PRECEDENCE.find(key => isObj(av) && Object.hasOwn(av, key));
  if (k === undefined) return '';
  const x = get(av, k);
  if (isScalar(x)) return typeof x.v === 'string' ? x.v : x.src;
  return Array.isArray(x) ? '[…]' : '{…}';
}
type Attr = { key: string; value: string };
const attrsOf = (x: unknown): Attr[] =>
  arr(x)
    .filter(isObj)
    .map(a => ({ key: str(get(a, 'key')), value: shown(get(a, 'value')) }));

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
};
type Frame = { span: Span; depth: number; mark: number; above: string; prow: number; pair: Span | null };
type Gap = { a: bigint; b: bigint };
type Axis = { d: bigint; gaps: Gap[]; u: bigint; w: bigint; step: bigint; unit: bigint };
type Expect =
  | { kind: 'problem'; why: string }
  | {
      kind: 'trace';
      spans: Span[];
      rows: Frame[];
      t0: bigint;
      t1: bigint;
      lo: bigint;
      services: string[];
      axis: Axis;
      cut: number;
    };

const utf8 = (t: string): Uint8Array => enc.encode(t);
/** How many bytes to leave off every service name: the prefix all share, to its last "/", if every name is longer. */
function serviceCut(names: string[]): number {
  const bytes = names.map(utf8);
  const [first] = bytes;
  if (!first) return 0;
  let n = first.length;
  for (const b of bytes) {
    let i = 0;
    while (i < n && i < b.length && b[i] === first[i]) i++;
    n = i;
  }
  let cut = n;
  while (cut > 0 && first[cut - 1] !== 47) cut--;
  return bytes.every(b => b.length > cut) ? cut : 0;
}
const KIND_BAD = new Set([
  'tape.span.missing',
  'tape.run.rolled_back',
  'tape.check.problem',
  'db.prepare.failed',
  'exception',
]);
const kindBit = (name: string): number =>
  KIND_BAD.has(name) ? 4 : name.startsWith('db.') ? 1 : name === 'tape.timer.set' ? 2 : 8;
/** An event's mark: an SQL event whose first tape.sql.undone attribute is true is a write its run undid (16), a
 * timer whose first tape.timer.undone is true a timer it undid (32). */
const firstIs = (ev: Ev, key: string): boolean => (ev.attrs.find(a => a.key === key)?.value ?? '') === 'true';
const kindOf = (ev: Ev): number => {
  const k = kindBit(ev.name);
  return k === 1 && firstIs(ev, 'tape.sql.undone') ? 16 : k === 2 && firstIs(ev, 'tape.timer.undone') ? 32 : k;
};

function expect(bytes: Uint8Array): Expect {
  const doc = readJson(bytes);
  if (doc === null) return { kind: 'problem', why: 'This is not JSON.' };
  if (!isObj(doc) || !Array.isArray(get(doc, 'resourceSpans')))
    return { kind: 'problem', why: 'This is not an OTLP trace.' };
  const spans: Span[] = [],
    services: string[] = [];
  for (const r of arr(get(doc, 'resourceSpans'))) {
    if (!isObj(r)) continue;
    const named = attrsOf(get(get(r, 'resource'), 'attributes')).filter(a => a.key === 'service.name');
    const last = named.at(-1)?.value ?? '';
    const service = last === '' ? '(unknown service)' : last;
    for (const scope of arr(get(r, 'scopeSpans')))
      for (const s of arr(get(scope, 'spans'))) {
        if (!isObj(s)) continue;
        if (!services.includes(service)) services.push(service);
        const status = get(s, 'status');
        spans.push({
          idx: spans.length,
          trace: str(get(s, 'traceId')),
          id: str(get(s, 'spanId')),
          parent: str(get(s, 'parentSpanId')),
          name: str(get(s, 'name')),
          kind: enumOf(get(s, 'kind'), KINDS, 'SPAN_KIND_'),
          start: nanos(get(s, 'startTimeUnixNano')),
          end: nanos(get(s, 'endTimeUnixNano')),
          service,
          color: services.indexOf(service),
          code: enumOf(get(status, 'code'), ['', 'OK', 'ERROR'], 'STATUS_CODE_'),
          message: str(get(status, 'message')),
          attrs: attrsOf(get(s, 'attributes')),
          events: arr(get(s, 'events'))
            .filter(isObj)
            .map(e => ({
              time: nanos(get(e, 'timeUnixNano')),
              name: str(get(e, 'name')),
              attrs: attrsOf(get(e, 'attributes')),
            })),
        });
      }
  }
  if (spans.length === 0) return { kind: 'problem', why: 'This trace has no spans.' };
  const times = spans.flatMap(s => [s.start, s.end]).filter(t => t >= 0n);
  const lo = times.length > 0 ? times.reduce((a, b) => (b < a ? b : a)) : 0n;
  const begin = (s: Span): bigint => (s.start >= 0n ? s.start : s.end >= 0n ? s.end : lo);
  const finish = (s: Span): bigint => (s.end > begin(s) ? s.end : begin(s));
  const t0 = spans.map(begin).reduce((a, b) => (b < a ? b : a));
  const t1 = spans.map(finish).reduce((a, b) => (b > a ? b : a));
  const byStart = (list: Span[]): Span[] =>
    list.toSorted((a, b) => (begin(a) < begin(b) ? -1 : begin(a) > begin(b) ? 1 : 0));
  // the tree: a call (client span) whose only child is a server span is one row with it
  const holder = new Map<string, Span>();
  for (const s of spans) if (s.id !== '' && !holder.has(s.id)) holder.set(s.id, s);
  const inTrace = (s: Span): boolean => s.parent !== '' && holder.has(s.parent);
  const children = new Map<string, Span[]>();
  for (const s of spans) if (inTrace(s)) children.set(s.parent, [...(children.get(s.parent) ?? []), s]);
  const kidsOf = (s: Span): Span[] => (holder.get(s.id) === s ? byStart(children.get(s.id) ?? []) : []);
  const rows: Frame[] = [],
    seen = new Set<number>();
  const walk = (stack: Frame[]): void => {
    while (stack.length > 0) {
      const f = stack.pop();
      if (!f) break;
      if (seen.has(f.span.idx)) continue;
      const mine = kidsOf(f.span);
      const k = mine.length === 1 ? mine[0] : undefined;
      seen.add(f.span.idx);
      if (f.span.kind === 3 && k && k.kind === 2 && !seen.has(k.idx)) {
        seen.add(k.idx);
        rows.push({ ...f, pair: k });
        const prow = rows.length - 1;
        for (const c of kidsOf(k).toReversed())
          stack.push({ span: c, depth: f.depth + 1, mark: 0, above: k.service, prow, pair: null });
      } else {
        rows.push(f);
        const prow = rows.length - 1;
        for (const c of mine.toReversed())
          stack.push({ span: c, depth: f.depth + 1, mark: 0, above: f.span.service, prow, pair: null });
      }
    }
  };
  walk(
    byStart(spans.filter(s => !inTrace(s)))
      .map(s => ({ span: s, depth: 0, mark: s.parent === '' ? 0 : 1, above: '', prow: -1, pair: null }))
      .toReversed(),
  );
  for (const s of byStart(spans))
    if (!seen.has(s.idx)) walk([{ span: s, depth: 0, mark: 2, above: '', prow: -1, pair: null }]);
  // the axis: idle gaps of a fifth of the trace or more, compressed
  const d = t1 - t0 > 0n ? t1 - t0 : 1_000_000n;
  const need = (d + 4n) / 5n;
  const gaps: Gap[] = [];
  let end = 0n;
  for (const s of byStart(spans)) {
    const b = begin(s) - t0,
      e = finish(s) - t0;
    if (b - end >= need) gaps.push({ a: end, b });
    end = e > end ? e : end;
  }
  const idle = gaps.reduce((n, g) => n + g.b - g.a, 0n);
  const kept = idle < d ? gaps : [];
  const u = idle < d ? d - idle : d,
    w = 10000n - 800n * BigInt(kept.length);
  const q = w / 1100n,
    least = (u + q - 1n) / q;
  let step = 1n;
  for (let pow = 1n; ; pow *= 10n) {
    const m = [1n, 2n, 5n].find(k => k * pow >= least);
    if (m !== undefined) {
      step = m * pow;
      break;
    }
  }
  const unit = step >= 200_000_000n ? 1_000_000_000n : step >= 200_000n ? 1_000_000n : step >= 200n ? 1000n : 1n;
  return {
    kind: 'trace',
    spans,
    rows,
    t0,
    t1,
    lo,
    services,
    axis: { d, gaps: kept, u, w, step, unit },
    cut: serviceCut(services),
  };
}

// what text becomes in the SVG: tab, line feed, return as space; other controls, U+FFFE, U+FFFF as U+FFFD
const unwritable = (code: number): boolean => code < 0x20 || code === 0xfffe || code === 0xffff;
const clean = (t: string): string =>
  Array.from(t)
    .map(c => (c === '\t' || c === '\n' || c === '\r' ? ' ' : unwritable(c.codePointAt(0) ?? 0) ? '�' : c))
    .join('');
const short = (t: string, n: number): string => {
  const cs = Array.from(t);
  return cs.length <= n ? clean(t) : `${clean(cs.slice(0, n - 1).join(''))}…`;
};
const div = (a: bigint, b: bigint): bigint => a / b;
/** A number of hundredths or tenths as text, with no trailing zeros. */
const decimals = (n: bigint, places: number): string => {
  const s = (Number(n) / 10 ** places).toFixed(places);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};
function duration(d: bigint): string {
  if (d < 1000n) return `${d} ns`;
  const name: Record<string, string> = { '1000': 'µs', '1000000': 'ms', '1000000000': 's' };
  const at = (u: bigint): string => {
    const h = div(d + u / 200n, u / 100n),
      t = div(d + u / 20n, u / 10n),
      w = div(d + u / 2n, u);
    if (h < 1000n) return `${decimals(h, 2)} ${name[String(u)]}`;
    if (t < 1000n) return `${decimals(t, 1)} ${name[String(u)]}`;
    if (w < 1000n || u === 1_000_000_000n) return `${w} ${name[String(u)]}`;
    return at(u * 1000n);
  };
  return at(d < 1_000_000n ? 1000n : d < 1_000_000_000n ? 1_000_000n : 1_000_000_000n);
}
const UNIT_NAME: Record<string, string> = { '1': 'ns', '1000': 'µs', '1000000': 'ms', '1000000000': 's' };
/** Where time t (after t0) is on the track, in basis points of its width, exactly. */
function xOf(t: bigint, ax: Axis): number {
  const lin = (a: bigint, d: bigint, w: bigint): bigint => (a * w + d / 2n) / d;
  let removed = 0n,
    k = 0n;
  for (const g of ax.gaps) {
    if (t > g.b) {
      removed += g.b - g.a;
      k++;
    } else if (t > g.a) return Number(lin(g.a - removed, ax.u, ax.w) + 800n * k + lin(t - g.a, g.b - g.a, 800n));
    else break;
  }
  return Number(lin(t - removed, ax.u, ax.w) + 800n * k);
}
function ticks(ax: Axis): { x: number; label: string }[] {
  const out = [];
  const bounds = [0n, ...ax.gaps.flatMap(g => [g.a, g.b]), ax.d];
  for (let j = 0; j * 2 < bounds.length; j++) {
    const a = bounds[2 * j] ?? 0n,
      b = bounds[2 * j + 1] ?? 0n;
    for (let m = j > 0 ? 1n : 0n; m * ax.step <= b - a; m++) {
      const v = m * ax.step;
      const value =
        v === 0n
          ? '0'
          : v % ax.unit === 0n
            ? `${v / ax.unit} ${UNIT_NAME[String(ax.unit)]}`
            : `${v / ax.unit}.${(v % ax.unit) / (ax.unit / 10n)} ${UNIT_NAME[String(ax.unit)]}`;
      out.push({ x: xOf(a + v, ax), label: `${j > 0 ? '+' : ''}${value}` });
    }
  }
  return out;
}
const bp = (pct: string | undefined): number => {
  const m = /^(\d+)\.(\d\d)%$/.exec(pct ?? '');
  return m ? Number(m[1]) * 100 + Number(m[2]) : NaN;
};
// one pixel of the track at 1280 px is about 12 basis points
const NEAR = 7;
const textNoTitle = (el: El): string =>
  el.kids.map(k => (typeof k === 'string' ? k : k.name === 'title' ? '' : textNoTitle(k))).join('');
const EV_CLASS: Record<number, string> = { 1: 'q', 2: 't', 4: 'x', 8: 'o', 16: 'u', 32: 'tu' };

/** What is wrong with this SVG for this input: a list of [check, detail]. */
function check(input: Uint8Array, svg: Uint8Array): [string, string][] {
  const bad: [string, string][] = [];
  const say = (what: string, detail: string): void => {
    if (bad.filter(b => b[0] === what).length < 3) bad.push([what, detail]);
  };
  let root: El;
  try {
    root = parseXml(new TextDecoder('utf-8', { fatal: true }).decode(svg));
  } catch (e) {
    return [['xml', e instanceof Error ? e.message : String(e)]];
  }
  if (root.name !== 'svg' || root.attrs['xmlns'] !== 'http://www.w3.org/2000/svg') say('xml', 'the root is not an svg');
  const want = expect(input);
  if (want.kind === 'problem') {
    const why = all(root, e => has(e, 'why'))[0];
    if (!has(root, 'problem') || !why || textOf(why) !== want.why) say('problem', `expected "${want.why}"`);
    return bad;
  }
  if (has(root, 'problem')) return [['problem', `a problem SVG for a trace: ${textOf(root).slice(0, 200)}`]];
  const { rows, t0, lo, axis, cut } = want;
  const begin = (s: Span): bigint => (s.start >= 0n ? s.start : s.end >= 0n ? s.end : lo);
  const finish = (s: Span): bigint => (s.end > begin(s) ? s.end : begin(s));
  const svcShort = (name: string): string => new TextDecoder().decode(utf8(name).slice(cut));
  // the header: what happened, then the numbers, then the services and the kinds of event
  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
  const first = rows[0]?.span;
  if (first) {
    const h1 = all(root, e => has(e, 'h1'))[0];
    const code = first.attrs.find(a => a.key === 'http.response.status_code')?.value ?? '';
    const st = code !== '' ? short(code, 12) : first.code === 2 ? 'Error' : 'OK';
    const title = `${first.name === '' ? '(unnamed)' : short(first.name, 80)}${st}`;
    if (!h1 || textOf(h1) !== title) say('header', `title "${h1 ? textOf(h1) : ''}" is not "${title}"`);
  }
  const meta = all(root, e => has(e, 'meta'))[0];
  const errors = want.spans.filter(s => s.code === 2).length;
  const traces = [...new Set(want.spans.map(s => s.trace).filter(t => t !== ''))];
  const header = `${duration(want.t1 - t0)} · ${plural(want.spans.length, 'span')} · ${plural(want.services.length, 'service')}${errors > 0 ? ` · ${plural(errors, 'error')}` : ''}${traces.length === 1 ? ` · trace ${short(traces[0] ?? '', 9)}` : traces.length > 1 ? ` · ${traces.length} traces` : ''}`;
  if (!meta || textNoTitle(meta) !== header) say('header', `"${meta ? textNoTitle(meta) : ''}" is not "${header}"`);
  const lg = all(root, e => has(e, 'lg'))[0];
  const kinds = want.spans.reduce((k, s) => s.events.slice(0, 100).reduce((k2, e) => k2 | kindOf(e), k), 0);
  const n = want.services.length;
  const legend =
    want.services
      .slice(0, n > 8 ? 7 : 8)
      .map((sv, i) => `■ ${short(svcShort(sv), 32)} ${want.spans.filter(s => s.color === i).length}`)
      .join('') +
    (n > 8 ? `■ ${n - 7} more` : '') +
    (kinds & 1 ? '│ sql ' : '') +
    (kinds & 16 ? '┆ undone ' : '') +
    (kinds & 2 ? '○ timer ' : '') +
    (kinds & 32 ? '◌ timer undone ' : '') +
    (kinds & 4 ? '◆ error ' : '') +
    (kinds & 8 ? '• event ' : '');
  if (!lg || textOf(lg) !== legend) say('header', `legend "${lg ? textOf(lg) : ''}" is not "${legend}"`);
  // the axis, and the compressed gaps
  const got = all(root, e => has(e, 'tick')).map(g => {
    const t = kids(g).find(k => k.name === 'text');
    return { x: bp(t?.attrs['x']), label: t ? textOf(t) : '' };
  });
  const want_ticks = ticks(axis);
  if (
    got.length !== want_ticks.length ||
    want_ticks.some((t, i) => got[i]?.label !== t.label || Math.abs((got[i]?.x ?? NaN) - t.x) > NEAR)
  )
    say('axis', `ticks ${JSON.stringify(got.slice(0, 4))} are not ${JSON.stringify(want_ticks.slice(0, 4))}`);
  const bands = all(root, e => e.name === 'rect' && has(e, 'gap'));
  const labels = all(root, e => has(e, 'gapl')).map(textOf);
  if (
    bands.length !== axis.gaps.length ||
    axis.gaps.some(
      (g, i) =>
        Math.abs(bp(bands[i]?.attrs['x']) - xOf(g.a, axis)) > NEAR || labels[i] !== `${duration(g.b - g.a)} idle`,
    )
  )
    say(
      'axis',
      `gaps ${bands.map(b => b.attrs['x']).join(' ')} ${labels.join(', ')} are not ${axis.gaps.map(g => `${xOf(g.a, axis) / 100}% ${duration(g.b - g.a)}`).join(', ')}`,
    );
  // the rows
  const shownRows = all(root, e => e.name === 'g' && has(e, 'row'));
  if (shownRows.length !== rows.length) say('rows', `${shownRows.length} rows for ${rows.length} rows expected`);
  const seen = new Set<string>();
  const barsSeen = new Map<string, number>();
  shownRows.forEach((g, i) => {
    const idx = g.attrs['data-idx'] ?? '';
    if (seen.has(idx)) say('rows', `span ${idx} has two rows`);
    seen.add(idx);
    const f = rows[i];
    if (!f) return;
    const s = f.span,
      p = f.pair;
    if (idx !== String(s.idx)) say('order', `row ${i} is span ${idx}, expected ${s.idx}`);
    if ((g.attrs['data-pair'] ?? '') !== (p ? String(p.idx) : ''))
      say('order', `row ${i}: data-pair ${g.attrs['data-pair']}, expected ${p?.idx}`);
    if (g.attrs['data-depth'] !== String(f.depth))
      say('depth', `span ${s.idx}: depth ${g.attrs['data-depth']} is not ${f.depth}`);
    const cls = classes(g).toSorted().join(' ');
    const wantCls = [
      'row',
      ...(s.code === 2 || p?.code === 2 ? ['err'] : []),
      ...(f.mark === 1 ? ['orphan'] : f.mark === 2 ? ['cycle'] : []),
    ]
      .toSorted()
      .join(' ');
    if (cls !== wantCls) say('class', `span ${s.idx}: class "${cls}" is not "${wantCls}"`);
    if (g.attrs['data-id'] !== short(s.id, 64)) say('text', `span ${s.idx}: data-id ${g.attrs['data-id']}`);
    const track = kids(g).find(k => k.name === 'svg' && has(k, 'tc'));
    const lab = kids(g).find(k => k.name === 'svg' && has(k, 'lc'));
    // the bars: the span's, and a call's callee inside it
    const bars = track ? kids(track).filter(k => k.name === 'rect' && has(k, 'bar')) : [];
    const spansHere = p ? [s, p] : [s];
    if (bars.length !== spansHere.length) say('bar', `row ${i} has ${bars.length} bars for ${spansHere.length} spans`);
    spansHere.forEach((sp, k) => {
      const bar = bars[k];
      if (!bar) return;
      barsSeen.set(bar.attrs['data-idx'] ?? '', (barsSeen.get(bar.attrs['data-idx'] ?? '') ?? 0) + 1);
      if (bar.attrs['data-idx'] !== String(sp.idx)) say('bar', `row ${i} bar ${k} is span ${bar.attrs['data-idx']}`);
      const barCls = classes(bar).toSorted().join(' ');
      const wantBar = [
        'bar',
        `c${Math.min(sp.color, 7)}`,
        ...(sp.code === 2 ? ['e'] : []),
        ...(k === 0 && p ? ['env'] : []),
      ]
        .toSorted()
        .join(' ');
      if (barCls !== wantBar) say('class', `span ${sp.idx}: bar class "${barCls}" is not "${wantBar}"`);
      const x = xOf(begin(sp) - t0, axis),
        xe = xOf(finish(sp) - t0, axis);
      if (Math.abs(bp(bar.attrs['x']) - x) > NEAR)
        say('bar-x', `span ${sp.idx}: x ${bar.attrs['x']}, expected ${x / 100}%`);
      if (Math.abs(bp(bar.attrs['width']) - Math.max(xe - x, 30)) > NEAR)
        say('bar-width', `span ${sp.idx}: width ${bar.attrs['width']}, expected ${Math.max(xe - x, 30) / 100}%`);
    });
    // the label
    const face = p ?? s;
    const sw = lab ? kids(lab).find(k => k.name === 'rect' && has(k, 'sw')) : undefined;
    if (!sw || !has(sw, `c${Math.min(face.color, 7)}`)) say('class', `span ${s.idx}: swatch ${sw?.attrs['class']}`);
    const nm = lab ? kids(lab).find(k => k.name === 'text' && has(k, 'nm')) : undefined;
    const indent = 26 + 14 * Math.min(f.depth, 12);
    if (!nm || nm.attrs['x'] !== String(indent))
      say('depth', `span ${s.idx}: label at ${nm?.attrs['x']}, expected ${indent}`);
    const svcTag = face.service === f.above ? '' : ` ${short(svcShort(face.service), 40)}`;
    const markTag = f.mark === 1 ? ' orphan' : f.mark === 2 ? ' cycle' : '';
    const wantLine = `${f.depth > 12 ? `${f.depth} ▸ ` : ''}${s.name === '' ? '(unnamed)' : short(s.name, 80)}${svcTag}${markTag}`;
    if (!nm || textOf(nm) !== wantLine)
      say('text', `span ${s.idx}: name line "${nm ? textOf(nm) : ''}" is not "${wantLine}"`);
    // the tooltips: the row's is its span's; a callee's is on its bar
    const tip = (sp: Span, title: El | undefined): void => {
      const lines = title ? textOf(title).split('\n') : [];
      if (lines[0] !== (sp.name === '' ? '(unnamed)' : short(sp.name, 200)))
        say('text', `span ${sp.idx}: tooltip "${lines[0]}"`);
      let at = 1;
      for (const a of sp.attrs.slice(0, 24)) {
        const line = `${short(a.key, 80)} = ${short(a.value, 160)}`;
        const found = lines.indexOf(line, at);
        if (found < 0) say('text', `span ${sp.idx}: no tooltip line "${line}"`);
        else at = found + 1;
      }
      if (sp.attrs.length > 24 && !lines.includes(`… and ${sp.attrs.length - 24} more`))
        say('text', `span ${sp.idx}: no "more" line`);
    };
    tip(
      s,
      kids(g).find(k => k.name === 'title'),
    );
    if (p) tip(p, bars[1] ? kids(bars[1]).find(k => k.name === 'title') : undefined);
    // the duration: the span's (a call's: as its caller waited)
    const dur = track ? kids(track).find(k => k.name === 'text' && has(k, 'dur')) : undefined;
    const wantDur = duration(finish(s) - begin(s));
    if (!dur || textOf(dur) !== wantDur)
      say('duration', `span ${s.idx}: "${dur ? textOf(dur) : ''}" is not "${wantDur}"`);
    // the events: the span's, then the callee's, each its kind's mark, at its time, faint when outside its span
    const marks = track ? kids(track).filter(k => has(k, 'ev')) : [];
    const evs = spansHere.flatMap(sp => sp.events.slice(0, 100).map(ev => ({ ev, sp })));
    if (marks.length !== evs.length) say('events', `span ${s.idx}: ${marks.length} marks for ${evs.length} events`);
    evs.forEach(({ ev, sp }, k) => {
      const b = begin(sp);
      const t = ev.time < 0n ? b : ev.time < t0 ? t0 : ev.time > t0 + axis.d ? t0 + axis.d : ev.time;
      const mk = marks[k];
      if (!mk) return;
      const x = bp(mk.attrs['x1'] ?? mk.attrs['cx'] ?? mk.attrs['x']);
      if (Math.abs(x - xOf(t - t0, axis)) > NEAR)
        say('events', `span ${sp.idx} event ${k}: at ${x / 100}%, expected ${xOf(t - t0, axis) / 100}%`);
      const kind = EV_CLASS[kindOf(ev)] ?? '';
      if (!has(mk, kind))
        say('events', `span ${sp.idx} event ${k} (${ev.name}): class "${mk.attrs['class']}", not ${kind}`);
      const out = ev.time >= 0n && (ev.time < b || ev.time > finish(sp));
      if (has(mk, 'out') !== out)
        say('events', `span ${sp.idx} event ${k}: outside its span is ${out}, marked ${has(mk, 'out')}`);
      const tt = kids(mk).find(c => c.name === 'title');
      const firstLine = tt ? textOf(tt).split('\n')[0] : '';
      if (firstLine !== (ev.name === '' ? '(unnamed event)' : short(ev.name, 120)))
        say('text', `span ${sp.idx} event ${k}: title "${firstLine}"`);
    });
  });
  for (const sp of want.spans)
    if ((barsSeen.get(String(sp.idx)) ?? 0) !== 1 && shownRows.length === rows.length)
      say('bar', `span ${sp.idx} has ${barsSeen.get(String(sp.idx)) ?? 0} bars`);
  return bad;
}

/** Events whose time is not within their span's: [span name, event name, µs from the span's start]. */
function eventsOutside(input: Uint8Array): string[] {
  const want = expect(input);
  if (want.kind !== 'trace') return [];
  const begin = (s: Span): bigint => (s.start >= 0n ? s.start : s.end >= 0n ? s.end : want.lo);
  const finish = (s: Span): bigint => (s.end > begin(s) ? s.end : begin(s));
  return want.spans.flatMap(s =>
    s.events
      .filter(e => e.time < 0n || e.time < begin(s) || e.time > finish(s))
      .map(
        e =>
          `${s.name}: ${e.name} at ${Number(e.time - begin(s)) / 1000} µs from its start (span ${Number(finish(s) - begin(s)) / 1000} µs)`,
      ),
  );
}

// ---------- inputs ----------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** JSON text written by hand, so it can carry what JSON.stringify never writes: raw numbers, escapes, spacing. */
type J = string | { raw: string } | J[] | { obj: [string, J][] };
function emit(v: J, r: () => number): string {
  const sp = (): string => (r() < 0.1 ? ([' ', '\n', '\t', '\r\n  '][Math.floor(r() * 4)] ?? '') : '');
  if (typeof v === 'string') {
    let out = '"';
    for (const c of v) {
      const code = c.codePointAt(0) ?? 0;
      if (c === '"' || c === '\\') out += `\\${c}`;
      else if (code < 0x20 || (r() < 0.05 && code < 0x10000)) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else if (c === '/' && r() < 0.5) out += '\\/';
      else out += c;
    }
    return `${out}"`;
  }
  if (Array.isArray(v)) return `[${sp()}${v.map(x => emit(x, r)).join(`${sp()},${sp()}`)}${sp()}]`;
  if ('raw' in v) return v.raw;
  return `{${sp()}${v.obj.map(([k, x]) => `${emit(k, r)}${sp()}:${sp()}${emit(x, r)}`).join(`${sp()},${sp()}`)}${sp()}}`;
}

const NAMES = [
  'GET /hello/ada',
  'SELECT * FROM orders WHERE id = ?1',
  'ünïcödé ✓ 名前 🚀',
  'e\u0301 combining',
  '<script>alert("x")</script> & \'quoted\'',
  'tab\there\nnewline\rreturn',
  'ctrl \u0001\u0007\u001F end',
  'non-chars \uFFFE \uFFFF',
  '',
  'x'.repeat(300),
  '👩‍👩‍👧‍👦 family '.repeat(8),
  ']]> --> <!--',
];

function randomDoc(r: () => number): Uint8Array {
  const pick = <T>(xs: readonly T[]): T => {
    const x = xs[Math.floor(r() * xs.length)];
    if (x === undefined) throw new RangeError('pick from nothing');
    return x;
  };
  const ids = Array.from({ length: 2 + Math.floor(r() * 12) }, (_, i) => `s${i}`);
  const time = (): J =>
    pick<() => J>([
      () => String(1763800000000000000n + BigInt(Math.floor(r() * 5e9))),
      () => String(1763800000000000000n + BigInt(Math.floor(r() * 5e3))),
      () => ({ raw: String(Math.floor(r() * 2 ** 53)) }),
      () => ({ raw: '1.5e3' }),
      () => '99999999999999999999',
      () => '9223372036854775807',
      () => '9223372036854775808',
      () => '-5',
      () => '0001763800000000000',
      () => '',
      () => ({ raw: 'null' }),
      () => ({ raw: String(2 ** 53) }),
    ])();
  const anyValue = (): J =>
    pick<() => J>([
      () => ({ obj: [['stringValue', pick(NAMES)]] }),
      () => ({ obj: [['intValue', String(Math.floor(r() * 1e6))]] }),
      () => ({ obj: [['intValue', { raw: '42' }]] }),
      () => ({ obj: [['boolValue', { raw: r() < 0.5 ? 'true' : 'false' }]] }),
      () => ({ obj: [['doubleValue', { raw: pick(['1.5', '-0.25e-3', '1E+2', '3']) }]] }),
      () => ({ obj: [['arrayValue', { obj: [['values', [{ obj: [['stringValue', 'a']] }]]] }]] }),
      () => ({ obj: [['kvlistValue', { obj: [] }]] }),
      () => ({
        obj: [
          ['intValue', '1'],
          ['stringValue', 'both'],
        ],
      }),
      () => ({ obj: [] }),
      () => ({ raw: '"not an object"' }),
    ])();
  const attrs = (): J[] =>
    Array.from({ length: Math.floor(r() * (r() < 0.1 ? 40 : 5)) }, () =>
      r() < 0.05
        ? { raw: '7' }
        : {
            obj: [
              [
                'key',
                pick(['service.name', 'db.query.text', 'tape.sql.undone', 'tape.timer.undone', 'k', pick(NAMES)]),
              ],
              ['value', anyValue()],
            ],
          },
    );
  const span = (): J => {
    const fields: [string, J][] = [];
    const maybe = (k: string, v: () => J, p = 0.9): void => {
      if (r() < p) fields.push([k, v()]);
    };
    maybe('traceId', () => pick(['4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7aaaaaaaaaaaaaaaa']));
    maybe('spanId', () => pick(ids));
    maybe('parentSpanId', () => (r() < 0.2 ? '' : pick([...ids, 'missing'])), 0.8);
    maybe('name', () => (r() < 0.05 ? { raw: '12' } : pick(NAMES)));
    maybe(
      'kind',
      () => pick<J>([{ raw: '2' }, { raw: '7' }, 'SPAN_KIND_CLIENT', { raw: '2.0' }, { raw: 'null' }]),
      0.7,
    );
    maybe('startTimeUnixNano', time);
    maybe('endTimeUnixNano', time);
    maybe('attributes', attrs, 0.7);
    maybe(
      'events',
      () =>
        Array.from({ length: Math.floor(r() * (r() < 0.05 ? 150 : 4)) }, (): J => {
          const obj: [string, J][] = [
            ['timeUnixNano', time()],
            ['name', pick(['db.query', 'tape.timer.set', 'tape.span.missing', 'exception', pick(NAMES)])],
            [
              'attributes',
              r() < 0.25
                ? [
                    {
                      obj: [
                        ['key', pick(['tape.sql.undone', 'tape.timer.undone'])],
                        ['value', { obj: [['boolValue', { raw: 'true' }]] }],
                      ],
                    },
                    ...attrs(),
                  ]
                : attrs(),
            ],
          ];
          return { obj };
        }),
      0.6,
    );
    maybe(
      'status',
      () => ({
        obj: [
          ['code', pick<J>([{ raw: '0' }, { raw: '2' }, 'STATUS_CODE_ERROR', { raw: '1' }])],
          ['message', pick(NAMES)],
        ],
      }),
      0.8,
    );
    maybe('flags', () => ({ raw: '256' }), 0.2);
    maybe('extra', () => ({ raw: '[[[[[{"deep":[[["x", "]}"]]]}]]]]]' }), 0.05);
    const again = fields[0];
    if (r() < 0.1 && again) fields.push([again[0], again[1]]); // a repeated key
    return r() < 0.03 ? { raw: '"not a span"' } : { obj: fields.toSorted(() => r() - 0.5) };
  };
  const resource = (): J => ({
    obj: [
      [
        'resource',
        {
          obj: [
            [
              'attributes',
              r() < 0.1
                ? []
                : [
                    {
                      obj: [
                        ['key', 'service.name'],
                        ['value', { obj: [['stringValue', pick(['api', 'db', pick(NAMES)])]] }],
                      ],
                    },
                  ],
            ],
          ],
        },
      ],
      [
        'scopeSpans',
        Array.from({ length: 1 + Math.floor(r() * 2) }, () => ({
          obj: [
            ['scope', { obj: [['name', 't']] }],
            ['spans', Array.from({ length: Math.floor(r() * 12) }, span)],
          ],
        })),
      ],
    ],
  });
  let text = emit({ obj: [['resourceSpans', Array.from({ length: Math.floor(r() * 4) }, resource)]] }, r);
  const bytes = (): Uint8Array => enc.encode(text);
  const roll = r();
  if (roll < 0.05) text = text.slice(0, Math.floor(r() * text.length));
  else if (roll < 0.1) {
    const i = Math.floor(r() * text.length);
    text = text.slice(0, i) + pick(['{', '}', ',', '"', ']', 'x', '\\', '\u0001', '\uD800']) + text.slice(i);
  } else if (roll < 0.12) text = `\uFEFF${text}`;
  else if (roll < 0.14) text = `${text} trailing`;
  else if (roll < 0.16)
    text = pick(['', '[]', 'null', '"x"', '{}', '{"resourceSpans":{}}', '{"resourceSpans":[1,2]}', '['.repeat(5000)]);
  else if (roll < 0.18) text = text.replace('"name"', '"na\\ud800me"');
  else if (roll < 0.2) {
    const b = bytes(),
      i = Math.floor(r() * b.length);
    const out = new Uint8Array(b.length + 1);
    out.set(b.subarray(0, i));
    out[i] = pick([0xff, 0xc0, 0xed, 0x80]);
    out.set(b.subarray(i), i + 1);
    return out;
  }
  return bytes();
}

// handwritten cases, each with something the fixtures do not have
const EDGES: [string, string][] = [
  ['empty spans', '{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"spans":[]}]}]}'],
  ['not an object', '[{"resourceSpans":[]}]'],
  ['no resourceSpans', '{"resourceSpan":[]}'],
  ['nested arrays far down', `{"resourceSpans":[],"x":${'['.repeat(2000)}${']'.repeat(2000)}}`],
  [
    'a cycle and a self parent',
    JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { spanId: 'a', parentSpanId: 'b', name: 'a', startTimeUnixNano: '200', endTimeUnixNano: '300' },
                { spanId: 'b', parentSpanId: 'a', name: 'b', startTimeUnixNano: '100', endTimeUnixNano: '400' },
                { spanId: 'c', parentSpanId: 'a', name: 'c under a', startTimeUnixNano: '250', endTimeUnixNano: '260' },
                {
                  spanId: 'd',
                  parentSpanId: 'd',
                  name: 'its own parent',
                  startTimeUnixNano: '0',
                  endTimeUnixNano: '10',
                },
                { spanId: 'r', name: 'root', startTimeUnixNano: '50', endTimeUnixNano: '60' },
                {
                  spanId: 'o',
                  parentSpanId: 'gone',
                  name: 'an orphan',
                  startTimeUnixNano: '55',
                  endTimeUnixNano: '70',
                },
              ],
            },
          ],
        },
      ],
    }),
  ],
  [
    'repeated ids and equal starts',
    JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { spanId: 'p', name: 'first p', startTimeUnixNano: '1000', endTimeUnixNano: '5000' },
                { spanId: 'p', name: 'second p', startTimeUnixNano: '1000', endTimeUnixNano: '2000' },
                { spanId: 'k1', parentSpanId: 'p', name: 'kid 1', startTimeUnixNano: '1500', endTimeUnixNano: '1600' },
                { spanId: 'k2', parentSpanId: 'p', name: 'kid 2', startTimeUnixNano: '1500', endTimeUnixNano: '1500' },
                { spanId: 'k0', parentSpanId: 'p', name: 'kid 0', startTimeUnixNano: '1200', endTimeUnixNano: '1100' },
              ],
            },
          ],
        },
      ],
    }),
  ],
  [
    'times past i64 and unreadable',
    JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  spanId: 'a',
                  name: 'huge',
                  startTimeUnixNano: '9223372036854775807',
                  endTimeUnixNano: '9223372036854775808',
                },
                { spanId: 'b', name: 'zero', startTimeUnixNano: '0', endTimeUnixNano: '1' },
                { spanId: 'c', name: 'none' },
                { spanId: 'd', name: 'end only', endTimeUnixNano: '77' },
              ],
            },
          ],
        },
      ],
    }),
  ],
  [
    'every key twice, the last kept',
    `{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"spans":[{"name":"dropped with the first resourceSpans"}]}]}],
     "resourceSpans":[
      {"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"first"}}]},
       "resource":{"attributes":[{"key":"service.name","value":{"stringValue":"not kept"}}],
                   "attributes":[{"key":"service.name","value":{"stringValue":"kept"}}]},
       "scopeSpans":[{"spans":[{"name":"dropped with the first scopeSpans"}]}],
       "scopeSpans":[{"spans":[{"name":"dropped with the first spans"}],
                      "spans":[{"spanId":"a","spanId":"b","name":"x","name":"two \\u0074wice",
                                "startTimeUnixNano":"100","startTimeUnixNano":"200","endTimeUnixNano":"900",
                                "status":{"code":2,"message":"m"},"status":{"code":0},
                                "attributes":[{"key":"gone","value":{"stringValue":"gone"}}],
                                "attributes":[{"key":"k","key":"k2","value":{"intValue":"1"},
                                               "value":{"stringValue":"s","intValue":"7","stringValue":"s2"}},
                                              {"key":"rank","value":{"kvlistValue":{},"boolValue":true,"doubleValue":1.5}}],
                                "events":[{"name":"e1","name":"e2","timeUnixNano":"300","timeUnixNano":"400"}]},
                               {"spanId":"c","parentSpanId":"b","name":"child","startTimeUnixNano":"300","endTimeUnixNano":"350"}]},
                     {"spans":[{"spanId":"d","parentSpanId":"b","name":"in the second scope","startTimeUnixNano":"250","endTimeUnixNano":"260"}]}]},
      {"scopeSpans":[{"spans":[{"name":"no resource","startTimeUnixNano":"500","endTimeUnixNano":"600"}]}]},
      {"scopeSpans":[{"spans":[{"name":"kept again","startTimeUnixNano":"700","endTimeUnixNano":"800"}]}],
       "resource":{"attributes":[{"key":"service.name","value":{"stringValue":"kept"}}]}}]}`,
  ],
  [
    'all zero',
    JSON.stringify({
      resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'z', startTimeUnixNano: '5', endTimeUnixNano: '5' }] }] }],
    }),
  ],
  [
    'eight services and more',
    JSON.stringify({
      resourceSpans: Array.from({ length: 11 }, (_, i) => ({
        resource: { attributes: [{ key: 'service.name', value: { stringValue: `svc-${i}` } }] },
        scopeSpans: [
          {
            spans: [
              {
                spanId: `x${i}`,
                name: `n${i}`,
                startTimeUnixNano: String(i * 1000),
                endTimeUnixNano: String(i * 1000 + 500),
              },
            ],
          },
        ],
      })),
    }),
  ],
  [
    'deep beyond twelve',
    JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: Array.from({ length: 20 }, (_, i) => ({
                spanId: `d${i}`,
                ...(i ? { parentSpanId: `d${i - 1}` } : {}),
                name: `level ${i} with a long name that will need cutting`,
                startTimeUnixNano: String(i),
                endTimeUnixNano: String(100 - i),
              })),
            },
          ],
        },
      ],
    }),
  ],
];

// ---------- the gates ----------

type Gate = { name: string; run: (r: Renderer, text: string) => string[] };
const fixtures = (): [string, Uint8Array][] =>
  readdirSync(join(HERE, 'fixtures'))
    .filter(f => f.endsWith('.json'))
    .toSorted()
    .map(f => [f, readFileSync(join(HERE, 'fixtures', f))]);
const report = (name: string, ran: Ran, input: Uint8Array): string[] => {
  if (ran.trap !== null || ran.out === null) return [`${name}: trapped: ${ran.trap}`];
  return check(input, ran.out).map(([what, detail]) => `${name}: ${what}: ${detail}`);
};

const GATES: Gate[] = [
  {
    name: 'fmt',
    run: (_r, text) => {
      try {
        return format(text, 'trace.tape') === text ? [] : ['trace.tape is not in tape fmt layout'];
      } catch (e) {
        return [`tape fmt refuses it: ${e instanceof Error ? e.message : String(e)}`];
      }
    },
  },
  { name: 'fixtures', run: r => fixtures().flatMap(([f, input]) => report(f, r.run(input), input)) },
  {
    // The producer's side: in every fixture (made by service/src/view.ts otlp() from real runs), each event's time
    // is readable and within its span's. The renderer's side (an event outside is drawn faint, class "out") is
    // checked by the events check in every gate above. TRACE_EVENTS_FROM=<dir> runs this on other OTLP files.
    name: 'event-in-span',
    run: () => {
      const dir = process.env['TRACE_EVENTS_FROM'];
      const files: [string, Uint8Array][] = dir
        ? readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .toSorted()
            .map(f => [f, readFileSync(join(dir, f))])
        : fixtures();
      return files.flatMap(([f, input]) => eventsOutside(input).map(e => `${f}: ${e}`));
    },
  },
  {
    name: 'edges',
    run: r => {
      const out = EDGES.flatMap(([name, text]) => report(name, r.run(enc.encode(text)), enc.encode(text)));
      // nesting deeper than JSON.parse can follow (it overflows its stack near 3,000 with a reviver): a value
      // 200,000 arrays deep under a key nobody reads must change nothing in the picture
      const plain = readFileSync(join(HERE, 'fixtures', 'hello.json'), 'utf8').trim();
      const deep = `{"deep":${'['.repeat(200000)}${']'.repeat(200000)},${plain.slice(1)}`;
      const a = r.run(enc.encode(plain)),
        b = r.run(enc.encode(deep));
      if (b.trap !== null) out.push(`200,000 deep: trapped: ${b.trap}`);
      else if (Buffer.compare(Buffer.from(a.out ?? []), Buffer.from(b.out ?? [])) !== 0)
        out.push('200,000 deep: the picture differs from the same trace without the deep value');
      return out;
    },
  },
  {
    name: 'random',
    run: r => {
      const rand = rng(20261122),
        out: string[] = [];
      let traces = 0,
        problems = 0,
        spans = 0;
      const marks = [0, 0, 0],
        whys = new Map<string, number>();
      for (let i = 0; i < 2000 && out.length < 12; i++) {
        const input = randomDoc(rand);
        const found = report(`random #${i}`, r.run(input), input);
        out.push(...found);
        const e = expect(input);
        if (e.kind === 'trace') {
          traces++;
          spans += e.rows.length;
          for (const f of e.rows) marks[f.mark] = (marks[f.mark] ?? 0) + 1;
        } else {
          problems++;
          whys.set(e.why, (whys.get(e.why) ?? 0) + 1);
        }
      }
      console.log(
        `  random: 2000 inputs: ${traces} traces (${spans} spans, ${marks[1]} orphans, ${marks[2]} cycle starts), ${problems} problems (${[...whys].map(([w, n]) => `${n} "${w}"`).join(', ')})`,
      );
      return out;
    },
  },
  {
    name: 'budget',
    run: r => {
      const input = readFileSync(join(HERE, 'fixtures', 'big.json'));
      const ran = r.run(input);
      if (ran.trap) return [`big.json trapped: ${ran.trap}`];
      const per = ran.steps / 2000;
      console.log(
        `  budget: big.json (2,000 spans, ${input.length} bytes) ${ran.steps} steps (${per.toFixed(0)} a span, ${(ran.steps / input.length).toFixed(2)} a byte), ${(ran.bytes / 1e6).toFixed(1)} MB, ${ran.ms.toFixed(1)} ms, ${ran.out?.length} bytes of SVG`,
      );
      const perByte = ran.steps / input.length;
      return perByte <= 4 ? [] : [`${perByte.toFixed(2)} steps a byte is over 4`];
    },
  },
];

function runGates(text: string, only?: string): Map<string, string[]> {
  const results = new Map<string, string[]>();
  const r = build(text);
  if (typeof r === 'string') {
    results.set('compile', [r]);
    return results;
  }
  results.set('compile', []);
  for (const g of GATES) if (only === undefined || g.name === only) results.set(g.name, g.run(r, text));
  return results;
}

// ---------- planted bugs: each must fail the gate named ----------

const PLANTS: { gate: string; why: string; from: string; to: string }[] = [
  {
    gate: 'random',
    why: 'an undone timer is drawn as a kept one',
    from: '    k == 2 and attr_named(list: ev.attrs, key: "tape.timer.undone") == "true" -> 32\n',
    to: '    k == 2 and attr_named(list: ev.attrs, key: "tape.timer.undone") == "true" -> 2\n',
  },
  {
    gate: 'random',
    why: 'an undone write is drawn as a kept one',
    from: '    k == 1 and attr_named(list: ev.attrs, key: "tape.sql.undone") == "true" -> 16\n',
    to: '    k == 1 and attr_named(list: ev.attrs, key: "tape.sql.undone") == "true" -> 1\n',
  },
  { gate: 'compile', why: 'a type error', from: '    a > b -> a\n', to: '    a > b -> "a"\n' },
  { gate: 'fmt', why: 'a second space', from: 'fn max(a: Int, b: Int)', to: 'fn max(a: Int,  b: Int)' },
  {
    gate: 'fixtures',
    why: 'bars shifted 0.1% right',
    from: '    _ -> scale(a: t - removed, d: axis.u, w: axis.w) + 800 * k\n',
    to: '    _ -> scale(a: t - removed, d: axis.u, w: axis.w) + 800 * k + 10\n',
  },
  {
    gate: 'fixtures',
    why: 'no least width',
    from: '    |> write_bp(bp: max(a: xe - x, b: 30))',
    to: '    |> write_bp(bp: max(a: xe - x, b: 3))',
  },
  {
    gate: 'fixtures',
    why: 'an unstable sort',
    from: 'if begin(s: y, lo) < begin(s: x, lo)',
    to: 'if begin(s: y, lo) <= begin(s: x, lo)',
  },
  {
    gate: 'fixtures',
    why: 'depth counted twice',
    from: '        depth: f.depth + 1,\n        above: f.span.service,',
    to: '        depth: f.depth + 2,\n        above: f.span.service,',
  },
  {
    gate: 'fixtures',
    why: 'indent of 15',
    from: 'let ind = 12 + 14 * min(a: f.depth, b: 12)',
    to: 'let ind = 12 + 15 * min(a: f.depth, b: 12)',
  },
  {
    gate: 'fixtures',
    why: 'colours by half',
    from: '    |> write_int(value: min(a: shown.color, b: 7))',
    to: '    |> write_int(value: min(a: shown.color / 2, b: 7))',
  },
  {
    gate: 'fixtures',
    why: 'error class on ok',
    from: '    s.code == 2 -> out |> append(view: " e")',
    to: '    s.code != 2 -> out |> append(view: " e")',
  },
  {
    gate: 'fixtures',
    why: 'events placed late',
    from: '  let x = x_of(t, axis)\n  let kind',
    to: '  let x = x_of(t: t + axis.d / 20, axis)\n  let kind',
  },
  {
    gate: 'fixtures',
    why: '< written raw',
    from: 'v[at] == 60 -> write_xml(out: append(buf: out, view: "&lt;")',
    to: 'v[at] == 60 -> write_xml(out: append(buf: out, view: "<")',
  },
  { gate: 'random', why: "' as the wrong reference", from: 'view: "&#39;"', to: 'view: "&#40;"' },
  { gate: 'random', why: 'controls left in', from: '    v[at] < 32 -> write_xml(', to: '    v[at] < 9 -> write_xml(' },
  {
    gate: 'random',
    why: 'a cut one character late',
    from: 'to: char_at(v: text, at: 0, n: n - 1)',
    to: 'to: char_at(v: text, at: 0, n: n)',
  },
  {
    gate: 'fixtures',
    why: 'too many ticks',
    from: 'mant * pow >= need -> mant * pow',
    to: 'mant * pow * 2 >= need -> mant * pow',
  },
  {
    gate: 'fixtures',
    why: 'durations to two digits',
    from: '    hundredths < 1000 -> out',
    to: '    hundredths < 100 -> out',
  },
  { gate: 'random', why: 'times overflow', from: '    value > (most - (t[at] - 48)) / 10 -> -1\n', to: '' },
  {
    gate: 'random',
    why: 'trailing bytes taken',
    from: '    at == len(v) -> Fine\n    else -> Broken(at)',
    to: '    at == len(v) -> Fine\n    else -> Fine',
  },
  {
    gate: 'random',
    why: 'quotes not skipped in nested values',
    from: '    b == 34 -> nested_end(v, at: string_end(v, at: at + 1), depth)\n',
    to: '',
  },
  {
    gate: 'edges',
    why: 'orphans not marked',
    from: '    depth == 0 and len(s.parent) > 0 -> 1',
    to: '    depth == 0 and len(s.parent) > 0 -> 0',
  },
  {
    gate: 'edges',
    why: 'cycles dropped',
    from: '    first.count >= length(list: spans) -> first',
    to: '    True -> first',
  },
  {
    gate: 'budget',
    why: 'a quadratic walk',
    from: '      count: count + 1,\n      nrows: nrows + 1,',
    to: '      count: count + 1 + 0 * length(list: rows) + 0 * length(list: rows) + 0 * length(list: rows) + 0 * length(list: rows),\n      nrows: nrows + 1,',
  },
  // the one-pass reader (each must fail the gate named)
  {
    gate: 'random',
    why: 'whitespace after a comma not skipped',
    from: '    v[s] == 44 -> json_ws(v, at: s + 1)\n    else -> s',
    to: '    v[s] == 44 -> s + 1\n    else -> s',
  },
  {
    gate: 'edges',
    why: 'a repeated spans added to, not replaced',
    from: '      got: span_items(v, at: inside(v, at: k.value), acc: base),',
    to: '      got: span_items(v, at: inside(v, at: k.value), acc: spans),',
  },
  {
    gate: 'edges',
    why: 'a repeated resourceSpans added to, not replaced',
    from: '      got: resources(v, at: inside(v, at: k.value), acc: Nil)',
    to: '      got: resources(v, at: inside(v, at: k.value), acc: res)',
  },
  {
    gate: 'edges',
    why: 'the second scope drops the first',
    from: 'got: scope(v, at: inside(v, at), base: acc, spans: acc))',
    to: 'got: scope(v, at: inside(v, at), base: Nil, spans: Nil))',
  },
  {
    gate: 'edges',
    why: 'the first of a repeated value kind kept',
    from: '    rank <= best -> any_taken(',
    to: '    rank < best -> any_taken(',
  },
  {
    gate: 'fixtures',
    why: 'a plain string read with its quote',
    from: 'Got(value: slice(v, from: at + 1, to: end), next: end + 1)',
    to: 'Got(value: slice(v, from: at, to: end), next: end + 1)',
  },
  {
    gate: 'random',
    why: 'the fourth byte of a run not checked',
    from: 'ascii(b: v[at + 2]) and ascii(\n      b: v[at + 3]\n    )',
    to: 'ascii(b: v[at + 2]) and ascii(\n      b: v[at + 2]\n    )',
  },
  {
    gate: 'edges',
    why: 'a resource with no name not called unknown',
    from: '    len(service) == 0 -> "(unknown service)"',
    to: '    len(service) == 0 -> ""',
  },
  // the redesign (each must fail the gate named)
  {
    gate: 'fixtures',
    why: 'a call and its callee not one row',
    from: 'if f.span.kind == 3 and k.kind == 2 and not (',
    to: 'if f.span.kind == 3 and k.kind == 5 and not (',
  },
  {
    gate: 'fixtures',
    why: 'idle gaps not compressed',
    from: '    b - end >= need -> gaps_in(',
    to: '    b - end >= need * 6 -> gaps_in(',
  },
  {
    gate: 'fixtures',
    why: 'a gap 700 wide, not 800',
    from: 'w: 10000 - 800 * length(list: found)',
    to: 'w: 10000 - 700 * length(list: found)',
  },
  {
    gate: 'fixtures',
    why: 'the shared service prefix kept',
    from: '    shortest(map, n: cut + 1) > cut -> cut',
    to: '    shortest(map, n: cut + 1) > cut -> 0',
  },
  {
    gate: 'random',
    why: 'an event after its span not flagged',
    from: 'ev.time >= 0 and (ev.time < b or ev.time > e)',
    to: 'ev.time >= 0 and ev.time < b',
  },
  {
    gate: 'fixtures',
    why: 'SQL marked as any event',
    from: '    starts_with(v: name, prefix: "db.") -> 1',
    to: '    starts_with(v: name, prefix: "db.") -> 8',
  },
  {
    gate: 'fixtures',
    why: 'durations with trailing zeros',
    from: '    places == 2 -> decimals(out, n: n / 10, places: 1)',
    to: '    places == 2 -> out |> write_int(value: n / 100) |> append(view: ".") |> two_digits(n: n % 100)',
  },
];

function plants(): boolean {
  const text = readFileSync(SOURCE, 'utf8'),
    dir = mkdtempSync(join(tmpdir(), 'trace-plants-'));
  let ok = true;
  for (const p of PLANTS) {
    if (text.split(p.from).length !== 2) {
      console.log(`PLANT NOT FOUND (${p.why}): ${p.from}`);
      ok = false;
      continue;
    }
    const planted = text.replace(p.from, p.to);
    writeFileSync(join(dir, 'trace.tape'), planted);
    const results = runGates(planted, p.gate === 'compile' ? 'none' : p.gate);
    const failed = (results.get(p.gate) ?? []).length > 0;
    const first = (results.get(p.gate) ?? [])[0] ?? '';
    console.log(
      `${failed ? 'caught' : 'MISSED'}  ${p.gate.padEnd(8)} ${p.why}${failed ? `: ${first.slice(0, 110)}` : ''}`,
    );
    ok &&= failed;
  }
  return ok;
}

// ---------- the largest trace within the budget ----------

function synthetic(n: number): Uint8Array {
  const r = rng(n);
  const spans: unknown[] = [];
  const T0 = 1763800000000000000n;
  for (let i = 0; i < n; i++)
    spans.push({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: `s${i}`,
      ...(i ? { parentSpanId: `s${Math.floor(r() * i)}` } : {}),
      name: `GET /orders/${i}`,
      kind: 2,
      startTimeUnixNano: String(T0 + BigInt(i) * 1000n),
      endTimeUnixNano: String(T0 + BigInt(i) * 1000n + 500000n),
      attributes: [
        { key: 'http.request.method', value: { stringValue: 'GET' } },
        { key: 'tape.sql.statements', value: { intValue: '2' } },
      ],
      events: [
        {
          timeUnixNano: String(T0 + BigInt(i) * 1000n),
          name: 'db.query',
          attributes: [{ key: 'db.query.text', value: { stringValue: 'SELECT 1' } }],
        },
      ],
      status: { code: i % 50 === 0 ? 2 : 0 },
    });
  return enc.encode(
    JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'demo/orders' } }] },
          scopeSpans: [{ spans }],
        },
      ],
    }),
  );
}

function largest(): void {
  const r = build(readFileSync(SOURCE, 'utf8'));
  if (typeof r === 'string') throw new TypeError(r);
  let good = 1000,
    bad = 0;
  for (let n = 1000; ; n *= 2) {
    const ran = r.run(synthetic(n));
    console.log(
      `  ${n} spans: ${ran.trap ? `trap (${ran.trap})` : `${ran.steps} steps, ${(ran.bytes / 1e6).toFixed(1)} MB, ${ran.ms.toFixed(0)} ms`}`,
    );
    if (ran.trap) {
      bad = n;
      break;
    }
    good = n;
  }
  while (bad - good > 50) {
    const mid = Math.floor((good + bad) / 2);
    const ran = r.run(synthetic(mid));
    if (ran.trap) bad = mid;
    else good = mid;
  }
  const at = r.run(synthetic(good)),
    over = r.run(synthetic(bad));
  console.log(
    `largest: ${good} spans (${synthetic(good).length} bytes of OTLP): ${at.steps} steps, ${(at.bytes / 1e6).toFixed(1)} MB; ${bad} spans traps: ${over.trap}`,
  );
}

// ---------- main ----------

if (process.argv.includes('--plants')) process.exit(plants() ? 0 : 1);
if (process.argv.includes('--max')) {
  largest();
  process.exit(0);
}
const text = readFileSync(SOURCE, 'utf8');
const r = build(text);
console.log(typeof r === 'string' ? '' : `trace.tape: ${r.wasm} bytes of Wasm`);
let failed = 0;
for (const [gate, problems] of runGates(text)) {
  console.log(
    `${problems.length === 0 ? 'ok  ' : 'FAIL'} ${gate}${problems.length > 0 ? `: ${problems.length} problems` : ''}`,
  );
  for (const p of problems.slice(0, 8)) console.log(`     ${p}`);
  if (problems.length > 0) failed++;
}
process.exit(failed ? 1 : 0);
