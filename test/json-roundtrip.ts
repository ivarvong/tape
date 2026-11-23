// write_json writes what decode reads: decode(write_json(v)) is v for every type write_json takes. On generated
// types (records, several constructors, Option fields, lists, lists of lists, records inside them, Floats) and generated
// values, compiled and in the reference interpreter: the text written is the one an oracle here writes from the
// value (an Option field that is None has no key; a type with several constructors is {"Constructor": {…}}), and
// decoding it writes the same text again. Damaged text is refused with the same reason by both.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { interpret } from '../interp.ts';
import { rng } from '../sim.ts';
import { finish, ok, std } from './harness.ts';

const enc = new TextEncoder(),
  dec = new TextDecoder();
type FT =
  | { k: 'Int' }
  | { k: 'Float' }
  | { k: 'Bool' }
  | { k: 'View' }
  | { k: 'rec'; of: number }
  | { k: 'list'; of: FT }
  | { k: 'opt'; of: FT };
type Ctor = { name: string; fields: { name: string; t: FT }[] };
type Decl = { name: string; ctors: Ctor[] };
/** A value as the oracle holds it: a record, a list, a scalar, or an Option field's Some (undefined is None). */
type V = { c: string; f: Record<string, V | undefined> } | V[] | bigint | number | boolean | string | { some: V };

const r = rng(11),
  below = (n: number): number => Math.floor(r() * n),
  pick = <T>(xs: readonly T[]): T => {
    const x = xs[below(xs.length)];
    if (x === undefined) throw new Error('pick from nothing');
    return x;
  };
const NAMES = ['id', 'name', 'type', 'at', 'qty', 'note', 'items', 'grid', 'ok', 'match', 'value', 'tag'];
const TEXTS = ['a', 'é', '✓', '"', '\\', '\n', '\t', '{', ']', ',', ' ', '😀', ':', 'Sets', '}'];

// types T0..T(n-1); a field of Ti names only Tj with j > i, so no type contains itself
function family(n: number, serial: number): Decl[] {
  const scalar = (): FT => pick<FT>([{ k: 'Int' }, { k: 'Float' }, { k: 'Bool' }, { k: 'View' }]);
  const field = (i: number, depth: number, inList: boolean): FT => {
    const roll = below(10);
    if (depth < 2 && roll === 0 && !inList) return { k: 'opt', of: field(i, depth + 1, true) };
    if (depth < 2 && (roll === 1 || (inList && roll === 2))) return { k: 'list', of: field(i, depth + 1, true) };
    if (roll <= 3 && i + 1 < n) return { k: 'rec', of: i + 1 + below(n - i - 1) };
    if (roll === 4 && !inList) return { k: 'opt', of: scalar() };
    return scalar();
  };
  return Array.from({ length: n }, (_, i) => {
    const ctors = Array.from({ length: 1 + (below(3) === 0 ? 0 : below(3)) }, (_c, j) => {
      const names = NAMES.toSorted(() => r() - 0.5).slice(0, below(4));
      return { name: `C${serial}x${i}x${j}`, fields: names.map(name => ({ name, t: field(i, 0, false) })) };
    });
    return { name: `T${serial}x${i}`, ctors };
  });
}
const typeText = (fam: Decl[], t: FT): string =>
  t.k === 'rec'
    ? (fam[t.of]?.name ?? '?')
    : t.k === 'list'
      ? `List[${typeText(fam, t.of)}]`
      : t.k === 'opt'
        ? `Option[${typeText(fam, t.of)}]`
        : t.k;
const declText = (fam: Decl[], d: Decl): string =>
  `type ${d.name} {\n${d.ctors.map(c => `  ${c.name}${c.fields.length > 0 ? `(${c.fields.map(f => `${f.name}: ${typeText(fam, f.t)}`).join(', ')})` : ''}`).join('\n')}\n}\n`;

function value(fam: Decl[], t: FT): V {
  switch (t.k) {
    case 'Int':
      return BigInt(below(2000001) - 1000000);
    case 'Float':
      return pick([0.5, -2.25, 1e-7, 123456.789, 3, 1e21, -0.1]);
    case 'Bool':
      return r() < 0.5;
    case 'View':
      return Array.from({ length: below(5) }, () => pick(TEXTS)).join('');
    case 'list':
      return Array.from({ length: below(3) }, () => value(fam, t.of));
    case 'opt':
      return { some: value(fam, t.of) };
    default: {
      const d = fam[t.of];
      if (!d) throw new Error('no such type');
      const c = pick(d.ctors);
      return {
        c: c.name,
        f: Object.fromEntries(
          c.fields.map(f => [f.name, f.t.k === 'opt' && r() < 0.4 ? undefined : value(fam, f.t)] as const),
        ),
      };
    }
  }
}
const isRecord = (v: V): v is { c: string; f: Record<string, V | undefined> } =>
  typeof v === 'object' && !Array.isArray(v) && 'c' in v;
const tapeText = (s: string): string =>
  `"${s.replaceAll(/["\\\n\t]/g, ch => ({ '"': '\\"', '\\': '\\\\', '\n': '\\n', '\t': '\\t' })[ch] ?? ch)}"`;
/** The value as a Tape expression. */
function tape(v: V | undefined): string {
  if (v === undefined) return 'None';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'number') return `${v}f`;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') return tapeText(v);
  if (Array.isArray(v)) return v.reduceRight((tail: string, x) => `Cons(head: ${tape(x)}, tail: ${tail})`, 'Nil');
  if (!isRecord(v)) return `Some(value: ${tape(v.some)})`;
  const fs = Object.entries(v.f);
  return fs.length > 0 ? `${v.c}(${fs.map(([k, x]) => `${k}: ${tape(x)}`).join(', ')})` : v.c;
}
/** The oracle: the JSON the value is, written here from the rule, not by the code under test. */
function json(fam: Decl[], v: V): string {
  if (typeof v === 'bigint' || typeof v === 'number') return String(v);
  if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(x => json(fam, x)).join(',')}]`;
  if (!isRecord(v)) return json(fam, v.some);
  const decl = fam.find(d => d.ctors.some(c => c.name === v.c));
  const body = `{${Object.entries(v.f)
    .filter((e): e is [string, V] => e[1] !== undefined)
    .map(([k, x]) => `${JSON.stringify(k)}:${json(fam, x)}`)
    .join(',')}}`;
  return decl && decl.ctors.length > 1 ? `{${JSON.stringify(v.c)}:${body}}` : body;
}
/** One thing wrong somewhere inside: a value of another kind, or a key gone. */
function damage(x: unknown): unknown {
  if (Array.isArray(x)) {
    if (x.length === 0 || r() < 0.3) return pick<unknown>(['x', 1, {}, [1.5]]);
    const i = below(x.length);
    return x.map((el: unknown, j) => (j === i ? damage(el) : el));
  }
  if (typeof x === 'object' && x !== null) {
    const keys = Object.keys(x);
    if (keys.length === 0 || r() < 0.25) return pick<unknown>([[], 'x', 7]);
    const k = pick(keys);
    const entries = Object.entries(x);
    if (r() < 0.3) return Object.fromEntries(entries.filter(([key]) => key !== k));
    return Object.fromEntries(entries.map(([key, el]): [string, unknown] => [key, key === k ? damage(el) : el]));
  }
  if (typeof x === 'string') return pick<unknown>([1, true, null]);
  if (typeof x === 'number') return pick<unknown>(['1', 0.5, 2 ** 60, false]);
  return pick<unknown>([0, 'true', null]);
}

const FAMILIES = 60,
  VALUES = 4;
let built = 0,
  written = 0,
  back = 0,
  lists = 0,
  refusedAlike = 0,
  refused = 0,
  damaged = 0;
// what the generated types hold, so the checks are seen to cover each form
const seen = { several: 0, optional: 0, nested: 0, listOfLists: 0, fieldless: 0 };
const firsts: string[] = [];
const note = (what: string): void => {
  if (firsts.length < 6) firsts.push(what.slice(0, 400));
};
for (let s = 0; s < FAMILIES; s++) {
  const fam = family(1 + below(4), s),
    top: FT = { k: 'rec', of: 0 },
    T0 = fam[0]?.name ?? '?',
    vals = Array.from({ length: VALUES }, () => value(fam, top));
  const program = `${fam.map(d => declText(fam, d)).join('\n')}
fn handle(raw: View) -> Buf {
  match raw {
${vals.map((v, i) => `    "e${i}" -> buf() |> write_json(value: ${tape(v)})`).join('\n')}
    "l" -> buf() |> write_json(value: ${tape(vals)})
    "d" ++ json -> again(decoded: decode(json, as: ${T0}))
    "m" ++ json -> again_list(decoded: decode(json, as: List[${T0}]))
    _ -> buf()
  }
}

fn again(decoded: Result[${T0}, View]) -> Buf {
  match decoded {
    Ok(value) -> buf() |> write_json(value)
    Err(error) -> buf() |> append(view: "error: ") |> append(view: error)
  }
}

fn again_list(decoded: Result[List[${T0}], View]) -> Buf {
  match decoded {
    Ok(value) -> buf() |> write_json(value)
    Err(error) -> buf() |> append(view: "error: ") |> append(view: error)
  }
}
`;
  const within = (t: FT): FT[] => [t, ...(t.k === 'list' || t.k === 'opt' ? within(t.of) : [])];
  const fts = fam.flatMap(d => d.ctors.flatMap(c => c.fields.flatMap(f => within(f.t))));
  if (fam.some(d => d.ctors.length > 1)) seen.several++;
  if (fts.some(t => t.k === 'opt')) seen.optional++;
  if (fts.some(t => t.k === 'rec')) seen.nested++;
  if (fts.some(t => t.k === 'list' && t.of.k === 'list')) seen.listOfLists++;
  if (fam.some(d => d.ctors.some(c => c.fields.length === 0))) seen.fieldless++;
  const sources = [...std, { name: 'program.tape', text: program }];
  const b = compile(sources);
  if (b.wasm === null) {
    note(`does not compile: ${b.errors.map(e => `${e.code}:${e.line} ${e.message}`).join(' | ')}\n${program}`);
    continue;
  }
  built++;
  const app = instantiate(new WebAssembly.Module(b.wasm), {}),
    it = interpret(sources);
  const both = (input: string): [string, string] => {
    const bytes = enc.encode(input);
    let compiled: string, meant: string;
    try {
      compiled = dec.decode(app.handle(bytes));
    } catch (e) {
      compiled = `threw ${String(e)}`;
    }
    try {
      meant = dec.decode(it.handle(bytes));
    } catch (e) {
      meant = `threw ${String(e)}`;
    }
    return [compiled, meant];
  };
  for (const [i, v] of vals.entries()) {
    const want = json(fam, v);
    const [c, m] = both(`e${i}`);
    if (c === want && m === want) written++;
    else note(`write_json of ${tape(v)}: want ${want}, compiled ${c}, interpreted ${m}`);
    const [c2, m2] = both(`d${want}`);
    if (c2 === want && m2 === want) back++;
    else note(`decode of ${want}: compiled ${c2}, interpreted ${m2}`);
    const bad = JSON.stringify(damage(JSON.parse(want)));
    const [c3, m3] = both(`d${bad}`);
    damaged++;
    if (c3.startsWith('error: ')) refused++;
    if (c3 === m3 && !c3.startsWith('threw')) refusedAlike++;
    else note(`damaged ${bad}: compiled ${c3}, interpreted ${m3}`);
  }
  const all = `[${vals.map(v => json(fam, v)).join(',')}]`;
  const [cl, ml] = both('l'),
    [cm, mm] = both(`m${all}`);
  if (cl === all && ml === all && cm === all && mm === all) lists++;
  else note(`a list: want ${all}, compiled ${cl} / ${cm}, interpreted ${ml} / ${mm}`);
}
for (const f of firsts) console.log(`   ${f}`);
ok(
  'the generated families hold every form: several constructors, Option fields, records inside, lists of lists, constructors without fields',
  Object.values(seen).every(n => n >= 5),
  JSON.stringify(seen),
);
ok(`${FAMILIES} generated families of types compile`, built === FAMILIES, `${built} of ${FAMILIES}`);
const N = FAMILIES * VALUES;
ok(`${N} generated values: write_json writes the oracle's JSON, compiled and interpreted`, written === N, `${written}`);
ok(`${N} values: decode of that JSON writes it again (decode(encode(v)) is v), both`, back === N, `${back}`);
ok(`${FAMILIES} lists of them: written as an array, and decoded from one as List[T]`, lists === FAMILIES, `${lists}`);
ok(
  `${damaged} damaged texts: the compiled build and the interpreter give the same answer`,
  refusedAlike === damaged && refused >= damaged / 2,
  `${refusedAlike} of ${damaged} alike, ${refused} refused`,
);

// the forms, by hand: an Option field, several constructors, a list on its own
{
  const program = `type Found {
  Sets(ms: Int, rounds: Int)
  AlwaysUp
}

type Day { Day(date: View, found: Found, note: Option[View]) }

fn handle(raw: View) -> Buf {
  match raw {
    "a" -> buf() |> write_json(value: Day(date: "d", found: Sets(ms: 5, rounds: 2), note: None))
    "b" -> buf() |> write_json(value: Day(date: "d", found: AlwaysUp, note: Some(value: "hi")))
    "c" -> buf() |> write_json(value: Cons(head: 1, tail: Cons(head: 2, tail: Nil)))
    "f" ++ json -> shown(d: decode(json, as: Found))
    "n" ++ json -> numbers(d: decode(json, as: List[Int]))
    _ -> buf()
  }
}

fn shown(d: Result[Found, View]) -> Buf {
  match d {
    Ok(value: Sets(ms)) -> buf() |> append(view: "sets \\(ms)")
    Ok(value: AlwaysUp) -> buf() |> append(view: "up")
    Err(error) -> buf() |> append(view: error)
  }
}

fn numbers(d: Result[List[Int], View]) -> Buf {
  match d {
    Ok(value) -> buf() |> append(view: "\\(length(list: value))")
    Err(error) -> buf() |> append(view: error)
  }
}
`;
  const sources = [...std, { name: 'program.tape', text: program }];
  const b = compile(sources);
  ok(
    'a record with an Option field and a field of several constructors builds',
    b.wasm !== null,
    b.errors.map(e => `${e.code}:${e.line} ${e.message}`).join(' | '),
  );
  if (b.wasm !== null) {
    const app = instantiate(new WebAssembly.Module(b.wasm), {}),
      it = interpret(sources);
    const answer = (input: string): string => {
      const c = dec.decode(app.handle(enc.encode(input))),
        m = dec.decode(it.handle(enc.encode(input)));
      return c === m ? c : `compiled ${c}, interpreted ${m}`;
    };
    const CASES: readonly (readonly [string, string, string])[] = [
      ['None has no key', 'a', '{"date":"d","found":{"Sets":{"ms":5,"rounds":2}}}'],
      [
        'Some is its value; a constructor without fields is {}',
        'b',
        '{"date":"d","found":{"AlwaysUp":{}},"note":"hi"}',
      ],
      ['a list on its own is an array', 'c', '[1,2]'],
      ['the tagged form is read back', 'f{"Sets":{"ms":7,"rounds":1}}', 'sets 7'],
      ['a constructor without fields, tagged', 'f{"AlwaysUp":{}}', 'up'],
      ['the tag says which constructor, whatever the keys inside', 'f{"AlwaysUp":{"ms":1,"rounds":1}}', 'up'],
      ['untagged, the constructor whose fields are there, as before', 'f{"ms":3,"rounds":1}', 'sets 3'],
      ['a tag whose value is not an object', 'f{"Sets":5}', 'Sets: expected an object'],
      ['a field wrong inside a tag', 'f{"Sets":{"ms":"x","rounds":1}}', 'ms: expected a whole number'],
      ['a list of numbers', 'n[1,2,3]', '3'],
      ['an empty list', 'n[]', '0'],
      ['not an array', 'n{"value":[1]}', 'not an array'],
      ['an element that is wrong', 'n[1,"2"]', '[1]: expected a whole number'],
      ['not JSON', 'n[1,', 'not JSON'],
    ];
    for (const [what, input, want] of CASES) {
      const got = answer(input);
      ok(`${what}: ${want}`, got === want, got);
    }
  }
}

finish();
