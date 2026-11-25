// apps/highlight/test.ts: the gates for highlight.tape, each with an oracle that is not the highlighter.
//   node apps/highlight/test.ts            run every gate; exit 1 if one fails
//   node apps/highlight/test.ts --max      the largest source (the corpus, repeated) it highlights, to 1 KB
//   node apps/highlight/test.ts --plants   plant a bug in a scratch copy of the highlighter for each gate, and
//                                          show that the gate it is meant for fails (exit 1 if one does not)
// The oracles: the input bytes themselves (round trip), compiler/lex.ts (token boundaries and kinds), LANGUAGE.md
// (the two word lists, read from its text), fmt.ts and compile() (the gate a program passes), and hand-written
// expected HTML for the edge cases.
import '../../node25.ts';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../../compiler.ts';
import type { Token } from '../../compiler/ast.ts';
import { CompileError } from '../../compiler/common.ts';
import { KEYWORDS, lex } from '../../compiler/lex.ts';
import { format } from '../../fmt.ts';
import { instantiate } from '../../host.ts';
import { std } from '../../std.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const SOURCE = new URL('./highlight.tape', import.meta.url).pathname;

// ---------- running the highlighter ----------

type Run = { out: Uint8Array; steps: number; bytes: number; ms: number };
type Highlighter = { run: (input: Uint8Array) => Run; wasm: number };

function build(text: string): Highlighter | string {
  const r = compile([...std, { name: 'highlight.tape', text }]);
  if (!r.wasm) return r.errors.map(e => `${e.file}:${e.line}: ${e.code} ${e.message}`).join('\n');
  const mod = new WebAssembly.Module(r.wasm);
  return {
    wasm: r.wasm.length,
    run: input => {
      const app = instantiate(mod, {}),
        t0 = performance.now(),
        out = new Uint8Array(app.handle(input)),
        cost = app.exports['cost'];
      return {
        out,
        steps: cost instanceof WebAssembly.Global ? Number(cost.value) : -1,
        bytes: app.bytesUsed,
        ms: performance.now() - t0,
      };
    },
  };
}

// ---------- reading the HTML back (the round-trip oracle) ----------

type Span = { cls: string; from: number; to: number; inner: Span[] };
type Parsed = { plain: Uint8Array; tops: Span[]; problems: string[] };
const ENTITIES: Record<string, number> = { '&amp;': 38, '&lt;': 60, '&gt;': 62, '&quot;': 34 };
const TOP = new Set(['c', 's', 'n', 'k', 'w', 't', 'i', 'o', 'q', 'x']);
const CODE = ['c', 'n', 'k', 'w', 't', 'i', 'o', 'x'];
const INNER: Record<string, Set<string>> = {
  s: new Set(['e', 'sk', 'sp', 'h']),
  q: new Set(['sk', 'sp', 'ss']),
  // a hole: its two delimiters, and the expression between them as code (no text literal can be in one)
  h: new Set(['hd', ...CODE]),
};

function parse(html: Uint8Array): Parsed {
  const s = Buffer.from(html).toString('latin1'),
    plain: number[] = [],
    tops: Span[] = [],
    problems: string[] = [],
    stack: Span[] = [];
  for (let i = 0; i < s.length;) {
    if (s.startsWith('<span class="', i)) {
      const j = s.indexOf('">', i),
        cls = s.slice(i + 13, j);
      if (j < 0 || !/^[a-z]+( [a-z]+)*$/.test(cls)) problems.push(`bad tag at ${i}`);
      const sp: Span = { cls, from: plain.length, to: -1, inner: [] },
        parent = stack.at(-1);
      const head = cls.split(' ')[0] ?? '';
      if (parent === undefined ? !TOP.has(head) : !INNER[parent.cls.split(' ')[0] ?? '']?.has(head))
        problems.push(`class "${cls}" inside ${parent?.cls ?? 'nothing'}`);
      if (parent) parent.inner.push(sp);
      stack.push(sp);
      i = j + 2;
    } else if (s.startsWith('</span>', i)) {
      const sp = stack.pop();
      if (!sp) problems.push(`stray </span> at ${i}`);
      else {
        sp.to = plain.length;
        if (sp.to === sp.from) problems.push(`empty span "${sp.cls}"`);
        if (stack.length === 0) tops.push(sp);
      }
      i += 7;
    } else if (s[i] === '&') {
      const e = Object.keys(ENTITIES).find(k => s.startsWith(k, i));
      if (!e) problems.push(`unescaped & at ${i}`);
      plain.push(e ? (ENTITIES[e] ?? 0) : 38);
      i += e ? e.length : 1;
    } else {
      if (s[i] === '<' || s[i] === '>' || s[i] === '"') problems.push(`unescaped ${s[i]} at ${i}`);
      plain.push(s.codePointAt(i) ?? 0);
      i++;
    }
  }
  if (stack.length > 0) problems.push(`${stack.length} spans not closed`);
  return { plain: Uint8Array.from(plain), tops, problems };
}

// ---------- the compiler's lexer as the oracle for tokens ----------

// The two word lists, from LANGUAGE.md's own sentences.
const definition = readFileSync(`${ROOT}LANGUAGE.md`, 'utf8').replaceAll(/\s+/g, ' ');
const listAfter = (lead: string): string[] =>
  [
    ...(definition
      .split(lead)[1]
      ?.split('.')[0]
      ?.matchAll(/`([^`]+)`/g) ?? []),
  ].flatMap(m => (m[1] ?? '').split(' '));
const RESERVED = listAfter('Reserved words:'),
  CONTEXTUAL = listAfter('Words with a meaning only where they stand:');

const ESC: Record<number, number> = { 34: 34, 92: 92, 47: 47, 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
// The bytes of a text literal's inside, read by LANGUAGE.md section 2's rules: an escape is one byte; a backslash
// that ends a line carries the text on after the next line's indentation; a hole `\(…)` (from LANGUAGE.md, its
// span told by the highlighter's `h`) splits the text into the parts around it.
function decodeText(raw: Uint8Array, holes: readonly [number, number][] = []): number[][] {
  const parts: number[][] = [[]];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i] ?? 0,
      hole = holes.find(([from]) => from === i);
    if (hole) {
      parts.push([]);
      i = hole[1] - 1;
    } else if (b === 92 && raw[i + 1] === 10) {
      i += 2;
      while (raw[i] === 32 || raw[i] === 9) i++;
      i--;
    } else if (b === 92) parts.at(-1)?.push(ESC[raw[++i] ?? 0] ?? -1);
    else parts.at(-1)?.push(b);
  }
  return parts;
}

const lineStarts = (input: Uint8Array): number[] => {
  const starts = [0];
  input.forEach((b, i) => {
    if (b === 10) starts.push(i + 1);
  });
  return starts;
};
const lineOf = (starts: number[], at: number): number => {
  let lo = 0,
    hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};

const expectedClass = (t: Token): string =>
  t.t === 'kw'
    ? 'k'
    : t.t === 'Id'
      ? 't'
      : t.t === 'id'
        ? CONTEXTUAL.includes(t.v)
          ? 'w'
          : 'i'
        : t.t === 'int' || t.t === 'float' || t.t === 'dec'
          ? 'n'
          : t.t === 'str' || t.t === 'interp'
            ? 's'
            : t.t === 'op'
              ? 'o'
              : t.t === 'sql'
                ? 'q'
                : '?';

// The spans against lex(): the same tokens, in order, each the same kind, value and line. Comments are the one
// kind lex() drops; they are checked to be `//` to the end of the line. Returns the disagreements.
function agree(name: string, input: Uint8Array, p: Parsed): string[] {
  const text = new TextDecoder().decode(input);
  let toks: Token[];
  try {
    toks = lex(name, text).filter(t => t.t !== 'nl' && t.t !== 'eof');
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    return refused(e, input, p);
  }
  const bad: string[] = [],
    starts = lineStarts(input);
  let covered = 0;
  for (const s of p.tops) {
    for (let k = covered; k < s.from; k++)
      if (![9, 10, 13, 32].includes(input[k] ?? 0)) bad.push(`byte ${k} (${input[k]}) is in no span`);
    covered = s.to;
  }
  for (let k = covered; k < input.length; k++)
    if (![9, 10, 13, 32].includes(input[k] ?? 0)) bad.push(`byte ${k} is in no span`);
  compareTokens(p.tops, toks, input, starts, bad);
  return bad;
}

// The spans against tokens, in order (used again for the tokens of each hole). Comment spans are not tokens: each
// is checked to be `//` to the end of its line (or of its hole).
function compareTokens(
  spans: Span[],
  toks: Token[],
  input: Uint8Array,
  starts: number[],
  bad: string[],
  end = input.length,
): void {
  const raw = (s: Span): Uint8Array => input.subarray(s.from, s.to),
    str = (s: Span): string => Buffer.from(raw(s)).toString('utf8');
  const mine = spans.filter(s => {
    if (s.cls !== 'c') return true;
    const r = raw(s);
    if (r[0] !== 47 || r[1] !== 47 || r.includes(10) || (s.to < end && input[s.to] !== 10))
      bad.push(`line ${lineOf(starts, s.from)}: comment span ${JSON.stringify(str(s))} is not // to the line's end`);
    return false;
  });
  const n = Math.max(mine.length, toks.length);
  for (let k = 0; k < n && bad.length < 20; k++) {
    const s = mine[k],
      t = toks[k];
    if (!s || !t) {
      bad.push(
        `token ${k}: ${s ? `extra span ${JSON.stringify(str(s))}` : `lex has ${t?.t} ${JSON.stringify(t?.v, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x))} with no span`}`,
      );
      break;
    }
    const cls = s.cls.split(' ')[0],
      want = expectedClass(t);
    // lex.ts gives a text literal the line it ends on (after any line it was carried over), every other token
    // the line it starts on
    const line = lineOf(starts, cls === 's' ? s.to - 1 : s.from);
    const holes = s.inner.filter(h => h.cls === 'h'),
      parts =
        cls === 's'
          ? decodeText(
              raw(s).subarray(1, -1),
              holes.map(h => [h.from - s.from - 1, h.to - s.from - 1]),
            )
          : [];
    let value: boolean;
    if (t.t === 'str') value = holes.length === 0 && JSON.stringify(parts[0]) === JSON.stringify(t.v);
    else if (t.t === 'interp') {
      const texts = t.v.flatMap(x => ('text' in x ? [x.text] : [])),
        inside = t.v.flatMap(x => ('hole' in x ? [x.hole] : []));
      value = JSON.stringify(texts) === JSON.stringify(parts) && inside.length === holes.length;
      // each hole's spans against the tokens lex.ts made of it, without the delimiters and the end of input
      inside.forEach((ht, j) => {
        const h = holes[j];
        if (h)
          compareTokens(
            h.inner.filter(x => x.cls !== 'hd'),
            ht.filter(x => x.t !== 'nl' && x.t !== 'eof'),
            input,
            starts,
            bad,
            h.to - 1,
          );
      });
    } else if (t.t === 'int') value = (/^[0-9]+$/.test(str(s)) && BigInt(str(s)) === t.v) || byteOf(str(s)) === t.v;
    // a Float's span is the whole literal, its f included
    // a Dec's span is its digits and point: the count of its last place, and that many digits after the point
    else if (t.t === 'dec')
      value =
        /^[0-9]+\.[0-9]+$/.test(str(s)) &&
        BigInt(str(s).replace('.', '')) === t.v &&
        str(s).length - str(s).indexOf('.') - 1 === t.s;
    else if (t.t === 'float') value = /^[0-9.eE+-]+f$/.test(str(s)) && Number(str(s).slice(0, -1)) === t.v;
    else if (t.t === 'sql') value = str(s) === `{${t.v}}`;
    else value = str(s) === t.v;
    const shown =
      t.t === 'str'
        ? Buffer.from(t.v).toString()
        : t.t === 'interp'
          ? JSON.stringify(t.v, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x))
          : String(t.v);
    if (cls !== want || !value || line !== t.line || s.cls.includes('x') || s.inner.some(x => x.cls.includes('x')))
      bad.push(
        `line ${line}: span ${s.cls} ${JSON.stringify(str(s))}; lex: ${t.t} ${JSON.stringify(shown)} line ${t.line}`,
      );
  }
}

// A source lex() refuses: the first span marked x must be the kind of thing refused, on the same line. Where a
// span's fault is: an unclosed text literal at its end (the line break or the end of the source), anything
// else at its start (lex.ts reports an unclosed migration at its opening line).
const REFUSAL: Record<string, string> = { L01: 'x', L02: 's', L03: 'e', L04: 'q', L05: 'h', L06: 'n', L07: 'n' };
/** The Int a byte literal spells, or null when the span is not one (`'*'` is 42, `'\n'` is 10). */
function byteOf(s: string): bigint | null {
  if (!s.startsWith("'") || !s.endsWith("'") || s.length < 3) return null;
  const inner = s.slice(1, -1);
  const esc: Readonly<Record<string, number>> = {
    '"': 34,
    '\\': 92,
    '/': 47,
    n: 10,
    r: 13,
    t: 9,
    b: 8,
    f: 12,
    "'": 39,
  };
  if (inner.startsWith('\\')) {
    const b = inner.length === 2 ? esc[inner[1] ?? ''] : undefined;
    return b === undefined ? null : BigInt(b);
  }
  const cp = inner.codePointAt(0) ?? -1;
  return cp >= 0 && cp < 128 && inner.length === String.fromCodePoint(cp).length ? BigInt(cp) : null;
}
const fault = (s: Span): number => (s.cls.startsWith('s ') ? s.to : s.from);
function refused(e: CompileError, input: Uint8Array, p: Parsed): string[] {
  const all = p.tops
      .flatMap(s => [s, ...s.inner])
      .filter(s => s.cls.split(' ').includes('x'))
      .toSorted((a, b) => fault(a) - fault(b)),
    first = all[0];
  const want = REFUSAL[e.info.code];
  if (!first) return [`lex refuses (${e.info.code} line ${e.info.line}) but no span is marked x`];
  const line = lineOf(lineStarts(input), fault(first));
  return first.cls.split(' ')[0] === want && line === e.info.line
    ? []
    : [`lex refuses ${e.info.code} at line ${e.info.line}; first x span is "${first.cls}" at line ${line}`];
}

// Sources lex() accepts must have no x span; this is checked by agree(), so a mismatch on either side shows.

// ---------- the corpus ----------

function tapeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    if (n === 'node_modules' || n.startsWith('.')) return []; // .git, and .claude's agent worktrees: other branches' files
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tapeFiles(p) : n.endsWith('.tape') ? [p] : [];
  });
}

// ---------- the gates ----------

type Gate = { name: string; run: (h: Highlighter, text: string) => string[] };
// a gate's problems; a trap or a throw is one
const check = (g: Gate, h: Highlighter, text: string): string[] => {
  try {
    return g.run(h, text);
  } catch (e) {
    return [`threw: ${e instanceof Error ? e.message : String(e)}`];
  }
};
const say = (line: string): void => {
  console.log(line);
};
const enc = new TextEncoder();

const corpus = tapeFiles(ROOT).toSorted();

const gates: Gate[] = [
  {
    name: 'build',
    run: (_h, text) => {
      const out: string[] = [];
      let formatted = '';
      try {
        formatted = format(text, 'highlight.tape');
      } catch (e) {
        out.push(`tape fmt refuses it: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (formatted && formatted !== text) out.push('tape fmt --check: not in the canonical layout');
      if (/\b(Sql|Remote|Clock|Entropy|Timer)\b/.test(text.replaceAll(/\/\/.*$/gm, '')))
        out.push('the program names a capability');
      const words = new Set(KEYWORDS);
      if (RESERVED.length !== words.size || RESERVED.some(w => !words.has(w)))
        out.push(`LANGUAGE.md's reserved words (${RESERVED.join(' ')}) are not lex.ts's KEYWORDS`);
      return out;
    },
  },
  {
    name: 'round trip',
    run: h => {
      const out: string[] = [];
      let bytes = 0;
      for (const f of corpus) {
        const input = readFileSync(f),
          p = parse(h.run(input).out);
        bytes += input.length;
        if (p.problems.length > 0) out.push(`${f}: ${p.problems.slice(0, 3).join('; ')}`);
        if (!Buffer.from(p.plain).equals(input)) out.push(`${f}: tags removed and unescaped, it is not the input`);
      }
      say(`  round trip: ${corpus.length} files, ${bytes} bytes`);
      return out;
    },
  },
  {
    name: 'lexer agreement',
    run: h => {
      const out: string[] = [];
      let tokens = 0,
        contextual = 0;
      for (const f of corpus) {
        const input = readFileSync(f),
          p = parse(h.run(input).out);
        tokens += p.tops.length;
        contextual += p.tops.filter(s => s.cls === 'w').length;
        for (const b of agree(f, input, p)) out.push(`${f.slice(ROOT.length)}: ${b}`);
      }
      const fz = fuzz(h);
      say(
        `  lexer agreement: ${corpus.length} files, ${tokens} spans (${contextual} contextual words); fuzz ${fz.cases} sources (${fz.refused} refused by lex)`,
      );
      return [...out, ...fz.bad];
    },
  },
  {
    name: 'self',
    run: (h, text) => {
      const input = enc.encode(text),
        r = h.run(input),
        p = parse(r.out),
        out = agree('highlight.tape', input, p);
      if (!Buffer.from(p.plain).equals(input)) out.push('highlight.tape does not round-trip');
      // independent counts: every `fn ` that starts a line is a reserved word span, and every // comment line a comment
      const fns = text.split('\n').filter(l => l.startsWith('fn ')).length,
        comments = text.split('\n').filter(l => l.trimStart().startsWith('//')).length,
        k = p.tops.filter(s => s.cls === 'k' && Buffer.from(input.subarray(s.from, s.to)).toString() === 'fn').length;
      if (k !== fns) out.push(`${fns} lines start with fn, ${k} fn spans`);
      if (p.tops.filter(s => s.cls === 'c').length !== comments) out.push('comment spans are not the comment lines');
      say(
        `  self: ${input.length} bytes, ${p.tops.length} spans, ${fns} functions, ${r.steps} steps, ${r.ms.toFixed(1)} ms`,
      );
      return out;
    },
  },
  {
    name: 'edges',
    run: h => {
      const out: string[] = [];
      for (const [input, want] of EDGES) {
        const got = Buffer.from(h.run(Buffer.from(input, 'utf8')).out).toString('utf8');
        if (got !== want)
          out.push(`${JSON.stringify(input)}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`);
        const p = parse(enc.encode(got)),
          bytes = Buffer.from(input, 'utf8');
        if (!Buffer.from(p.plain).equals(bytes)) out.push(`${JSON.stringify(input)} does not round-trip`);
        for (const b of agree('edge', bytes, p)) out.push(`${JSON.stringify(input)}: ${b}`);
      }
      say(`  edges: ${EDGES.length} cases`);
      return out;
    },
  },
  {
    name: 'large',
    run: h => {
      const out: string[] = [],
        all = Buffer.concat(corpus.map(f => readFileSync(f)));
      const of = (size: number): Buffer =>
        Buffer.concat(Array.from({ length: Math.ceil(size / all.length) }, () => all)).subarray(0, size);
      const MB = 1 << 20;
      // A highlighter must take 4 MB of ordinary source within the budget, and one 1 MB comment and text literal.
      for (const [what, input] of [
        ['4 MB of the corpus', of(4 * MB)],
        ['a 1 MB comment', Buffer.from('//' + 'a'.repeat(MB))],
        ['a 1 MB text literal', Buffer.from('"' + 'a&'.repeat(MB / 2) + '"')],
      ] as const) {
        try {
          const r = h.run(input),
            p = parse(r.out);
          if (!Buffer.from(p.plain).equals(input)) out.push(`${what}: does not round-trip`);
          say(
            `  large: ${what}: ${input.length} bytes in, ${r.out.length} out, ${r.steps} steps (${(r.steps / input.length).toFixed(2)}/byte), ${(r.bytes / MB).toFixed(1)} MB memory, ${r.ms.toFixed(0)} ms`,
          );
        } catch (e) {
          out.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return out;
    },
  },
];

// Hand-written: what each input must give, by the rules in LANGUAGE.md section 2 and the classes in highlight.tape.
const sp = (c: string, t: string): string => `<span class="${c}">${t}</span>`;
const hole = (inside: string): string => sp('h', `${sp('hd', '\\(')}${inside}${sp('hd', ')')}`);
const EDGES: [string, string][] = [
  ['', ''],
  // a Float is one span, its point, exponent and f included; a point or an exponent without the f is refused
  ['1.5f 2f 1e-3f 6.02E+23f', [sp('n', '1.5f'), sp('n', '2f'), sp('n', '1e-3f'), sp('n', '6.02E+23f')].join(' ')],
  [
    '2fa 1.x 1e',
    `${sp('n', '2')}${sp('i', 'fa')} ${sp('n', '1')}${sp('o', '.')}${sp('i', 'x')} ${sp('n', '1')}${sp('i', 'e')}`,
  ],
  // a point without the f is a Dec, of at most 18 digits after the point; an exponent without the f is refused
  ['12.30 0.123456789012345678', `${sp('n', '12.30')} ${sp('n', '0.123456789012345678')}`],
  ['0.1234567890123456789', sp('n x', '0.1234567890123456789')],
  ['1e5', sp('n x', '1e5')],
  ['1.5e3', sp('n x', '1.5e3')],
  ['1.5fx', `${sp('n', '1.5')}${sp('i', 'fx')}`],
  ['123456789012345678901f', sp('n x', '123456789012345678901f')],
  ['1797693134862315807e290f', sp('n', '1797693134862315807e290f')],
  ['1797693134862315808e290f', sp('n x', '1797693134862315808e290f')],
  ['\n\n', '\n\n'],
  ['"abc', sp('s x', '&quot;abc')],
  ['"abc\nx', `${sp('s x', '&quot;abc')}\n${sp('i', 'x')}`],
  [
    '"\\" \\\\ \\/ \\n \\r \\t \\b \\f"',
    sp(
      's',
      `&quot;${['\\&quot;', '\\\\', '\\/', '\\n', '\\r', '\\t', '\\b', '\\f'].map(e => sp('e', e)).join(' ')}&quot;`,
    ),
  ],
  ['"\\q"', sp('s', `&quot;${sp('e x', '\\q')}&quot;`)],
  ['"a\\', sp('s x', `&quot;a${sp('e x', '\\')}`)],
  ['"// not a comment" // a comment', `${sp('s', '&quot;// not a comment&quot;')} ${sp('c', '// a comment')}`],
  ['"<a href=\'x\'>&amp;</a>"', sp('s', "&quot;&lt;a href='x'&gt;&amp;amp;&lt;/a&gt;&quot;")],
  ['// café ☕ 𝄞\n"日本語"', `${sp('c', '// café ☕ 𝄞')}\n${sp('s', '&quot;日本語&quot;')}`],
  ['let é = 1', `${sp('k', 'let')} ${sp('x', 'é')} ${sp('o', '=')} ${sp('n', '1')}`],
  [
    'a<<b>>c<=d->e|>f++g!=h',
    [
      'i:a',
      'o:&lt;&lt;',
      'i:b',
      'o:&gt;&gt;',
      'i:c',
      'o:&lt;=',
      'i:d',
      'o:-&gt;',
      'i:e',
      'o:|&gt;',
      'i:f',
      'o:++',
      'i:g',
      'o:!=',
      'i:h',
    ]
      .map(x => sp(x.split(':')[0] ?? '', x.slice(2)))
      .join(''),
  ],
  [
    '_ _x x_1 X1 1x',
    `${sp('o', '_')} ${sp('i', '_x')} ${sp('i', 'x_1')} ${sp('t', 'X1')} ${sp('n', '1')}${sp('i', 'x')}`,
  ],
  ['a ! b', `${sp('i', 'a')} ${sp('x', '!')} ${sp('i', 'b')}`],
  ['a / b // c', `${sp('i', 'a')} ${sp('o', '/')} ${sp('i', 'b')} ${sp('c', '// c')}`],
  ['read where machine', `${sp('w', 'read')} ${sp('w', 'where')} ${sp('w', 'machine')}`],
  [
    'migration 1 "m" { SELECT \'}\' }',
    `${sp('k', 'migration')} ${sp('n', '1')} ${sp('s', '&quot;m&quot;')} ${sp('q', `{ ${sp('sk', 'SELECT')} ${sp('ss', "'}'")} }`)}`,
  ],
  ['migration 1 "m" { a', `${sp('k', 'migration')} ${sp('n', '1')} ${sp('s', '&quot;m&quot;')} ${sp('q x', '{ a')}`],
  [
    'invariant "i" settled { x }',
    `${sp('w', 'invariant')} ${sp('s', '&quot;i&quot;')} ${sp('w', 'settled')} ${sp('q', '{ x }')}`,
  ],
  [
    'f(invariant "i" { x })',
    `${sp('i', 'f')}${sp('o', '(')}${sp('w', 'invariant')} ${sp('s', '&quot;i&quot;')} ${sp('o', '{')} ${sp('i', 'x')} ${sp('o', '}')}${sp('o', ')')}`,
  ],
  ['"SELECT a FROM t"', sp('s q', `&quot;${sp('sk', 'SELECT')} a ${sp('sk', 'FROM')} t&quot;`)],
  // named placeholders (LANGUAGE.md 0.1): a colon and a name; not after a word or a colon, and not in plain text
  [
    '"SELECT a FROM t WHERE id = :id AND x=:x_1 AND y = a:b"',
    sp(
      's q',
      `&quot;${sp('sk', 'SELECT')} a ${sp('sk', 'FROM')} t ${sp('sk', 'WHERE')} id = ${sp('sp', ':id')} ${sp('sk', 'AND')} x=${sp('sp', ':x_1')} ${sp('sk', 'AND')} y = a:b&quot;`,
    ),
  ],
  ['"at :noon"', sp('s', '&quot;at :noon&quot;')],
  ['x\r\n\ty', `${sp('i', 'x')}\r\n\t${sp('i', 'y')}`],
  // a backslash that ends a line carries the text on; the next line's indentation is inside the literal
  ['"a \\\n    b" c', `${sp('s', `&quot;a ${sp('e', '\\')}\n    b&quot;`)} ${sp('i', 'c')}`],
  // holes: the expression inside is code, its parentheses balanced; a text after a hole goes on
  [
    '"Hi, \\(name) #\\(f(n + 1))!"',
    sp(
      's',
      `&quot;Hi, ${hole(sp('i', 'name'))} #${hole(`${sp('i', 'f')}${sp('o', '(')}${sp('i', 'n')} ${sp('o', '+')} ${sp('n', '1')}${sp('o', ')')}`)}!&quot;`,
    ),
  ],
  ['"\\\\(x)"', sp('s', `&quot;${sp('e', '\\\\')}(x)&quot;`)],
  // a hole that a double quote breaks: refused (L05); the quote still ends the text
  ['"\\(a" b', `${sp('s', `&quot;${sp('h x', `${sp('hd', '\\(')}${sp('i', 'a')}`)}&quot;`)} ${sp('i', 'b')}`],
  // `invariant "name"` with a hole is not a text (lex.ts makes it a text with holes), so its { is not SQL
  [
    'invariant "\\(x)" { y }',
    `${sp('w', 'invariant')} ${sp('s', `&quot;${hole(sp('i', 'x'))}&quot;`)} ${sp('o', '{')} ${sp('i', 'y')} ${sp('o', '}')}`,
  ],
  // a line that starts with |> carries the line before it on: the migration is still among the last four tokens
  [
    'migration x\n|> y { a }',
    `${sp('k', 'migration')} ${sp('i', 'x')}\n${sp('o', '|&gt;')} ${sp('i', 'y')} ${sp('q', '{ a }')}`,
  ],
  // a byte literal is a number, the Int it spells; none, two, or a character past ASCII is refused (L07)
  ["'*' '\\n' '\\\\'", `${sp('n', "'*'")} ${sp('n', "'\\n'")} ${sp('n', "'\\\\'")}`],
  ["'\"'", sp('n', "'&quot;'")],
  ["b == '*'", `${sp('i', 'b')} ${sp('o', '==')} ${sp('n', "'*'")}`],
  [`"\\('*')"`, sp('s', `&quot;${hole(sp('n', "'*'"))}&quot;`)],
  [`"\\(')')"`, sp('s', `&quot;${hole(sp('n', "')'"))}&quot;`)],
  [`"\\('(')"`, sp('s', `&quot;${hole(sp('n', "'('"))}&quot;`)],
  [`"\\('"')"`, sp('s', `&quot;${hole(sp('n', "'&quot;'"))}&quot;`)],
  [`"\\('\\n')"`, sp('s', `&quot;${hole(sp('n', "'\\n'"))}&quot;`)],
  ["''", sp('n x', "''")],
  ["'ab'", sp('n x', "'ab'")],
  ["'", sp('n x', "'")],
  ["'\\q'", sp('n x', "'\\q'")],
  ["'é'", sp('n x', "'é'")],
];

// Random sources from a few dozen fragments, against lex(): when it accepts, the same tokens; when it refuses,
// an x span of the right kind on its line. Seeded, so a failure repeats.
function fuzz(h: Highlighter): { cases: number; refused: number; bad: string[] } {
  const clean = [
    'fn',
    'let',
    'migration',
    'invariant',
    'settled',
    'machine',
    '1',
    '42',
    'Foo',
    'bar',
    '_',
    '_x',
    '"s"',
    '"a\\nb"',
    '"SELECT 1"',
    '{',
    '}',
    '(',
    ')',
    '[',
    ']',
    '\n',
    '\n',
    ' ',
    ' ',
    ' ',
    '->',
    '|>',
    '<<',
    '<',
    '=',
    '!=',
    '/',
    '// c\n',
    'x.y',
    ',',
    'migration 1 "m" {',
    '\ninvariant "i" {',
    'invariant "i" settled {',
    "'q'",
    "'*'",
    "'\\n'",
    "'\\\\'",
    "'\\''",
    "'\"'",
    '"{"',
    '"a\\(x)b"',
    '"\\(f(1, y.z))"',
    '"x \\\n   y"',
    '"\\(n) \\\n  \\(m)"',
    'invariant "\\(i)" {',
    '\n|> ',
  ];
  // a hole that breaks does so at its end (a quote, a line break), so no fragment after it lands inside it
  const broken = ["'", '"', '!', '\\', 'é', '"\\q"', '#', '"\\(x"', '"\\(x\n', '"a \\', "''", "'ab'", "'\\q'"];
  // the numbers, in cases of their own (after the first 6000, so those stay the sources they were): pieces of
  // literals lex() accepts alone, which joined make more (`1` `.` `5` `f`), then ones it refuses: an exponent
  // with no f, a Dec with more than 18 digits after its point, a Float with too many digits or too large
  const numbers = [
    '0',
    '5',
    '1.5f',
    '2f',
    '0f',
    '1e-3f',
    '6.02E+23f',
    '2fa',
    'f',
    'e',
    'E',
    '.',
    '-',
    '+',
    '17976931348623158f',
    '1797693134862315807e290f',
    '12345678901234567890f',
    '0.000000000000000000000123f',
    '12.30',
    '1.5fx',
    '0.123456789012345678',
    '00.0',
  ];
  const badNumbers = [
    '1e5',
    '1.5e3',
    '0.1234567890123456789',
    '123456789012345678901f',
    '1e309f',
    '1797693134862315808e290f',
    '1e99999999999999999999f',
  ];
  let seed = 7,
    refusedCount = 0;
  const rnd = (n: number): number => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  const bad: string[] = [],
    cases = 9000;
  for (let c = 0; c < cases && bad.length < 10; c++) {
    // half the sources from fragments lex() accepts alone, half with a few it refuses mixed in
    const ok = c < 6000 ? clean : [...clean, ...numbers],
      parts = c % 2 ? ok : c < 6000 ? [...ok, ...broken] : [...ok, ...broken, ...badNumbers],
      src = Array.from({ length: 1 + rnd(30) }, () => parts[rnd(parts.length)] ?? '').join(''),
      input = enc.encode(src),
      p = parse(h.run(input).out);
    try {
      lex('fuzz', src);
    } catch {
      refusedCount++;
    }
    if (!Buffer.from(p.plain).equals(input)) bad.push(`fuzz ${JSON.stringify(src)}: does not round-trip`);
    for (const b of agree('fuzz', input, p)) bad.push(`fuzz ${JSON.stringify(src)}: ${b}`);
  }
  return { cases, refused: refusedCount, bad };
}

// ---------- plants: one bug per gate, each in a scratch copy ----------

const PLANTS: { gate: string; what: string; from: string; to: string }[] = [
  {
    gate: 'build',
    what: 'a line out of the canonical layout',
    from: 'fn letter(b: Int) -> Bool {',
    to: 'fn letter(b: Int) -> Bool  {',
  },
  {
    gate: 'round trip',
    what: '> is escaped without its semicolon',
    from: `'>' -> append(buf: out, view: "&gt;")`,
    to: `'>' -> append(buf: out, view: "&gt")`,
  },
  { gate: 'lexer agreement', what: '<< is not an operator (it lexes as two <)', from: '    "<<" -> True\n', to: '' },
  {
    gate: 'lexer agreement',
    what: 'a migration opens SQL only three tokens back',
    from: 'state.mig <= 3',
    to: 'state.mig <= 2',
  },
  { gate: 'self', what: '`fn` is not a reserved word', from: '    "fn" -> True\n', to: '' },
  {
    gate: 'edges',
    what: 'an escaped quote ends a text literal',
    from: 'src[at] == 92 and at + 1 < len(src) -> text_end(src, at: at + 2)',
    to: 'src[at] == 92 and at + 1 < len(src) and src[at + 1] != 34 -> text_end(src, at: at + 2)',
  },
  {
    gate: 'lexer agreement',
    what: 'a backslash at the end of a line ends the text',
    from: 'src[at] == 92 and at + 1 < len(src) -> text_end(src, at: at + 2)',
    to: 'src[at] == 92 and at + 1 < len(src) and src[at + 1] != 10 -> text_end(src, at: at + 2)',
  },
  {
    gate: 'edges',
    what: 'a hole ends at its first )',
    from: 'src[at] == 41 and depth == 1 -> Closed(at: at + 1)',
    to: 'src[at] == 41 -> Closed(at: at + 1)',
  },
  {
    gate: 'lexer agreement',
    what: "a hole's expression is not highlighted (its inside is dropped)",
    from: 'src: slice(v: src, from: at + 2, to: to - 1),',
    to: 'src: slice(v: src, from: at + 2, to: at + 2),',
  },
  {
    gate: 'edges',
    what: "a text with a hole counts as a text before an invariant's {",
    from: '    holed(src, at, to) -> 0\n',
    to: '',
  },
  {
    gate: 'lexer agreement',
    what: 'a |> that starts a line does not take the line break back',
    from: 'last == 1 -> Scan(stack, depth, last: 2, mig, inv: after_inv(inv: held, kind: 0, last: 2), held)',
    to: 'last == 1 -> pushed(state, kind: 0)',
  },
  {
    gate: 'edges',
    what: 'a placeholder may follow a word (a:b is one)',
    from: 'at == 0 or (not word_byte(b: src[at - 1]) and src[at - 1] != 58)',
    to: 'at == 0 or src[at - 1] != 58',
  },
  {
    gate: 'lexer agreement',
    what: "a Float's f is left out of its span",
    from: 'from: at, to: end + 1)',
    to: 'from: at, to: end)',
  },
  {
    gate: 'edges',
    what: 'a point counts without a digit after it',
    from: 'byte_at(src, at) == 46 and is_digit(byte_at(src, at: at + 1))',
    to: 'byte_at(src, at) == 46',
  },
  {
    gate: 'edges',
    what: 'a Float at 10^308 is compared to the largest on 18 digits, not 20',
    from: 'k == 20 -> False',
    to: 'k == 18 -> False',
  },
  {
    gate: 'lexer agreement',
    what: 'a point without the f is refused (as before Dec)',
    from: 'end > fraction_end(src, at: point) or',
    to: 'end > point or',
  },
  {
    gate: 'edges',
    what: 'a Dec may have 19 digits after its point',
    from: 'end > point + 19',
    to: 'end > point + 20',
  },
  {
    gate: 'large',
    what: 'every line break rescans the source from the start',
    from: 'ch == 10 -> scan(src, at: at + 1,',
    to: 'ch == 10 -> scan(src, at: at + 1 + find(v: src, byte: 0, at: 0) - len(src),',
  },
];

function main(): void {
  const text = readFileSync(SOURCE, 'utf8');
  if (process.argv.includes('--plants')) return plants(text);
  if (process.argv.includes('--max')) return largest(text);
  const h = build(text);
  if (typeof h === 'string') {
    console.log(`highlight.tape does not compile:\n${h}`);
    process.exit(1);
  }
  say(`highlight.tape: ${text.length} bytes, ${h.wasm} bytes of Wasm`);
  let failed = 0;
  for (const g of gates) {
    const bad = check(g, h, text);
    failed += bad.length > 0 ? 1 : 0;
    say(`${bad.length > 0 ? 'FAIL' : 'ok  '} ${g.name}${bad.length > 0 ? `: ${bad.length} problems` : ''}`);
    for (const b of bad.slice(0, 12)) say(`    ${b}`);
  }
  say(failed ? `${failed} of ${gates.length} gates failed` : `all ${gates.length} gates pass`);
  process.exit(failed ? 1 : 0);
}

function largest(text: string): void {
  const h = build(text);
  if (typeof h === 'string') throw new TypeError(h);
  const all = Buffer.concat(corpus.map(f => readFileSync(f))),
    of = (size: number): Buffer =>
      Buffer.concat(Array.from({ length: Math.ceil(size / all.length) }, () => all)).subarray(0, size);
  const tryAt = (size: number): Run | string => {
    try {
      return h.run(of(size));
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  let lo = 1 << 20,
    hi = 64 << 20;
  while (hi - lo > 1024) {
    const mid = Math.floor((lo + hi) / 2);
    if (typeof tryAt(mid) === 'string') hi = mid;
    else lo = mid;
  }
  const ok = tryAt(lo),
    over = tryAt(hi);
  if (typeof ok === 'string') throw new TypeError(ok);
  say(
    `largest: ${lo} bytes (${(lo / 2 ** 20).toFixed(2)} MB): ${ok.steps} steps, ${(ok.bytes / 2 ** 20).toFixed(1)} MB of memory, ${ok.out.length} bytes out, ${ok.ms.toFixed(0)} ms`,
  );
  say(`${hi} bytes: ${typeof over === 'string' ? over : 'ran'}`);
}

function plants(text: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'highlight-plant-'));
  let missed = 0;
  for (const [n, p] of PLANTS.entries()) {
    if (!text.includes(p.from)) {
      say(`plant ${n} (${p.what}): its text is not in highlight.tape`);
      missed++;
      continue;
    }
    const planted = text.replace(p.from, p.to),
      file = join(dir, `plant${n}.tape`);
    writeFileSync(file, planted);
    const h = build(planted);
    if (typeof h === 'string') {
      say(`plant ${n} (${p.what}): does not compile: ${h}`);
      missed++;
      continue;
    }
    const failing = gates.filter(g => check(g, h, planted).length > 0).map(g => g.name);
    const caught = failing.includes(p.gate);
    missed += caught ? 0 : 1;
    say(
      `${caught ? 'caught' : 'MISSED'} plant ${n} for "${p.gate}": ${p.what} (${file}); failing gates: ${failing.join(', ') || 'none'}`,
    );
  }
  say(missed ? `${missed} plants not caught` : `all ${PLANTS.length} plants caught`);
  process.exit(missed ? 1 : 0);
}

main();
