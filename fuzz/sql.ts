// fuzz/sql.ts: random statements through the checker and the binder, against node:sqlite. Each seed makes a table
// (columns of every kind, NULL or NOT NULL, some named by SQL keywords), a row type for it (Int, Bool, Dec[2], View,
// Float and Options of them) and a few statements over it (INSERT … RETURNING *, SELECT * and SELECT count(*) with
// WHERE clauses of =, IS, IS NULL, ranges, IN, LIKE, NOT, AND, OR and the optional filter `(:p IS NULL OR c = :p)`,
// UPDATE … RETURNING *, DELETE), each with its values passed from a decoded request. The program runs them in order
// on random values under node:sqlite; the same statements run directly on a second database with the values bound
// as LANGUAGE.md says (an Int as INTEGER, a Bool as 1 or 0, a Dec as its count, a View as TEXT, a Float as REAL,
// None as NULL), and the rows each gives, written as write_json writes them, must be the program's. A statement the
// checker takes must run: one SQLite refuses is a finding. What the checker refuses is counted by its code.
//   node fuzz/sql.ts --seconds 60 [--seed 1] [--shard 0/8] [--only <seed>]
import { unreachable } from '../compiler/ast.ts';
import { DatabaseSync } from 'node:sqlite';
import { compile } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import { cli, seeds } from './run.ts';
import { rng } from './rng.ts';
import type { Rng } from './rng.ts';
import { decText } from './numbers.ts';

type Kind = 'Int' | 'Bool' | 'Dec' | 'View' | 'Float';
type Col = { name: string; sql: string; kind: Kind; nullable: boolean };
const NAMES = [
  'a',
  'b',
  'qty',
  'note',
  'from',
  'to',
  'key',
  'value',
  'order',
  'group',
  'limit',
  'select',
  'amount',
  'state',
  'when',
];
const SQL_KEYWORDS = new Set(['from', 'to', 'order', 'group', 'limit', 'select', 'when']);
const q = (n: string): string => (SQL_KEYWORDS.has(n) ? `"${n}"` : n);
const tapeType = (c: Col): string => {
  const t = c.kind === 'Dec' ? 'Dec[2]' : c.kind;
  return c.nullable ? `Option[${t}]` : t;
};
const sqlType = (k: Kind): string => (k === 'View' ? 'TEXT' : k === 'Float' ? 'REAL' : 'INTEGER');
const DEFAULT: Record<Kind, string> = { Int: '0', Bool: '0', Dec: '0', View: "''", Float: '0.0' };

type Param = { name: string; kind: Kind; optional: boolean };
type Stmt = { sql: string; call: 'first' | 'all' | 'exec' | 'count'; params: Param[] };

function tableOf(r: Rng): Col[] {
  const cols: Col[] = [];
  const used = new Set<string>();
  for (let i = 0, n = r.between(1, 4); i < n; i++) {
    let name = r.one(NAMES);
    while (used.has(name)) name = `${name}${i}`;
    used.add(name);
    const kind = r.one<Kind>(['Int', 'Int', 'Bool', 'Dec', 'View', 'View', 'Float']);
    const nullable = r.chance(2);
    cols.push({
      name,
      kind,
      nullable,
      sql: `${q(name)} ${sqlType(kind)}${nullable ? '' : ` NOT NULL DEFAULT ${DEFAULT[kind]}`}`,
    });
  }
  return cols;
}
function stmtsOf(r: Rng, cols: Col[]): Stmt[] {
  let pn = 0;
  const param = (c: Col, optional = false): Param => ({ name: `p${pn++}`, kind: c.kind, optional });
  const cond = (params: Param[], depth: number): string => {
    const c = r.one(cols);
    const p = (): string => {
      const x = param(c);
      params.push(x);
      return `:${x.name}`;
    };
    switch (r.int(depth > 1 ? 8 : 12)) {
      case 0:
      case 1:
        return `${q(c.name)} = ${p()}`;
      case 2: {
        const x = param(c, true);
        params.push(x);
        return `${q(c.name)} IS :${x.name}`;
      }
      case 3: {
        const x = param(c, true);
        params.push(x);
        return `(:${x.name} IS NULL OR ${q(c.name)} = :${x.name})`;
      }
      case 4:
        return `${q(c.name)} ${r.one(['<', '<=', '>', '>=', '<>'])} ${p()}`;
      case 5:
        return `${q(c.name)} IS ${r.one(['NULL', 'NOT NULL'])}`;
      case 6:
        return `${q(c.name)} BETWEEN ${p()} AND ${p()}`;
      case 7:
        return `${q(c.name)} IN (${p()}, ${p()})`;
      case 8:
        return `NOT (${cond(params, depth + 1)})`;
      case 9:
      case 10:
        return `(${cond(params, depth + 1)} ${r.one(['AND', 'OR'])} ${cond(params, depth + 1)})`;
      default:
        return c.kind === 'View'
          ? `${q(c.name)} LIKE ${p()}`
          : `id > ${(() => {
              const x: Param = { name: `p${pn++}`, kind: 'Int', optional: false };
              params.push(x);
              return `:${x.name}`;
            })()}`;
    }
  };
  const out: Stmt[] = [];
  for (let i = 0, n = r.between(3, 6); i < n; i++) {
    const params: Param[] = [];
    switch (r.int(5)) {
      case 0: {
        const some = cols.filter(() => r.chance(2));
        const set = some.length > 0 ? some : cols.slice(0, 1);
        const ps = set.map(c => {
          const x = param(c, c.nullable && r.chance(2));
          params.push(x);
          return `:${x.name}`;
        });
        out.push({
          sql: `INSERT INTO t(${set.map(c => q(c.name)).join(', ')}) VALUES (${ps.join(', ')}) RETURNING *`,
          call: 'first',
          params,
        });
        break;
      }
      case 1:
        out.push({ sql: `SELECT * FROM t WHERE ${cond(params, 0)} ORDER BY id`, call: 'all', params });
        break;
      case 2:
        out.push({ sql: `SELECT count(*) AS n FROM t WHERE ${cond(params, 0)}`, call: 'count', params });
        break;
      case 3: {
        const c = r.one(cols);
        const x = param(c, c.nullable && r.chance(2));
        params.push(x);
        out.push({
          sql: `UPDATE t SET ${q(c.name)} = :${x.name} WHERE ${cond(params, 0)} RETURNING *`,
          call: 'all',
          params,
        });
        break;
      }
      default:
        out.push({ sql: `DELETE FROM t WHERE ${cond(params, 0)}`, call: 'exec', params });
    }
  }
  return out;
}
const ptype = (p: Param): string => {
  const t = p.kind === 'Dec' ? 'Dec[2]' : p.kind;
  return p.optional ? `Option[${t}]` : t;
};
function programOf(cols: Col[], stmts: Stmt[]): string {
  const all = stmts.flatMap(s => s.params);
  const fields = `id: Int${cols.map(c => `, ${c.name}: ${tapeType(c)}`).join('')}`;
  const arms = stmts.map((s, i) => {
    const args = s.params.map(p => `${p.name}: v.${p.name}`).join(', ');
    const tail = args ? `, ${args}` : '';
    const call =
      s.call === 'first'
        ? `match sql_first(row: T, query: "${s.sql.replaceAll('"', '\\"')}"${tail}, repeat: True) {\n      Some(value: row) -> buf() |> write_json(value: row)\n      None -> buf() |> append(view: "none")\n    }`
        : s.call === 'all'
          ? `buf() |> write_rows(rows: sql_all(row: T, query: "${s.sql.replaceAll('"', '\\"')}"${tail}))`
          : s.call === 'count'
            ? `match sql_first(row: N, query: "${s.sql.replaceAll('"', '\\"')}"${tail}) {\n      Some(value: N(n)) -> buf() |> write_int(value: n)\n      None -> buf() |> append(view: "none")\n    }`
            : `buf() |> write_int(value: sql_exec(query: "${s.sql.replaceAll('"', '\\"')}"${tail}))`;
    return `    "${i}" -> ${call}`;
  });
  return `migration 1 "t" {
  CREATE TABLE t(id INTEGER PRIMARY KEY, ${cols.map(c => c.sql).join(', ')})
}

type T {
  T(${fields})
}

type N {
  N(n: Int)
}

type V {
  V(${all.length > 0 ? all.map(p => `${p.name}: ${ptype(p)}`).join(', ') : 'none: Option[Int]'})
}

fn handle(raw: View, db: Sql) -> Buf {
  let which ++ "\\n" ++ body = raw else -> buf() |> append(view: "bad")
  let Ok(value: v) = decode(json: body, as: V) else {
    Err(error) -> buf() |> append(view: "decode: \\(error)")
  }
  match which {
${arms.join('\n')}
    _ -> buf() |> append(view: "no such statement")
  }
}
`;
}
type Val = bigint | boolean | string | number | null;
function valueOf(r: Rng, p: Param): Val {
  if (p.optional && r.chance(3)) return null;
  switch (p.kind) {
    case 'Int':
      return BigInt(r.one([0, 1, -1, 2, 3, 7, 100, r.between(-50, 50), 9007199254740991]));
    case 'Bool':
      return r.chance(2);
    case 'Dec':
      return BigInt(r.one([0, 1, 50, 100, -250, r.between(-1000, 1000)]));
    case 'View':
      return r.one(['', 'a', 'b', 'ab', 'A', 'a%', '%', '_', 'é', "it's", '"q"', 'NULL', '0']);
    case 'Float':
      return r.one([0, 1, -1, 0.5, 2.5, 1e-7, 123.25, -0.1]);
  }
  return unreachable(p.kind, 'case');
}
/** the request's JSON value of a parameter */
const jsonOf = (p: Param, v: Val): string =>
  v === null
    ? 'null'
    : p.kind === 'Dec' && typeof v === 'bigint'
      ? JSON.stringify(decText(v, 2))
      : typeof v === 'string'
        ? JSON.stringify(v)
        : String(v);
/** the value bound as LANGUAGE.md says */
const bound = (v: Val): bigint | string | number | null => (typeof v === 'boolean' ? (v ? 1n : 0n) : v);
const str = (cell: unknown): string =>
  typeof cell === 'string'
    ? cell
    : typeof cell === 'number' || typeof cell === 'bigint'
      ? String(cell)
      : JSON.stringify(cell);
const big = (cell: unknown): bigint => (typeof cell === 'bigint' ? cell : BigInt(typeof cell === 'number' ? cell : 0));
/** a cell read back into a field, written as write_json writes it; undefined for None (no key) */
function cellJson(c: { kind: Kind }, cell: unknown): string | undefined {
  if (cell === null || cell === undefined) return undefined;
  switch (c.kind) {
    case 'Int':
      return str(cell);
    case 'Bool':
      return Number(cell) !== 0 ? 'true' : 'false';
    case 'Dec':
      return JSON.stringify(decText(big(cell), 2));
    case 'View':
      return JSON.stringify(str(cell));
    case 'Float':
      return String(Number(cell));
  }
  return unreachable(c.kind, 'case');
}
function rowJson(cols: Col[], row: Record<string, unknown>): string {
  const parts = [`"id":${String(row['id'])}`];
  for (const c of cols) {
    const j = cellJson(c, row[c.name]);
    if (j !== undefined) parts.push(`${JSON.stringify(c.name)}:${j}`);
  }
  return `{${parts.join(',')}}`;
}

const REFUSED = new Map<string, number>();
const enc = new TextEncoder(),
  dec = new TextDecoder();
export async function sqlCase(
  seed: number,
  verbose = false,
): Promise<{ statements: number; runs: number; bad: string | null }> {
  const r = rng(seed);
  const cols = tableOf(r),
    stmts = stmtsOf(r, cols);
  const text = programOf(cols, stmts);
  if (verbose) console.log(text);
  let b;
  try {
    b = compile([...std, { name: 'sql.tape', text }]);
  } catch (e) {
    return {
      statements: stmts.length,
      runs: 0,
      bad: `the compiler threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (b.wasm === null) {
    const code = b.errors[0]?.code ?? '?';
    REFUSED.set(code, (REFUSED.get(code) ?? 0) + 1);
    if (verbose) console.log(b.errors.slice(0, 2));
    return { statements: stmts.length, runs: 0, bad: null };
  }
  const sql = nodeSql(),
    app = instantiate(new WebAssembly.Module(b.wasm), { sql });
  const ref = new DatabaseSync(':memory:');
  ref.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, ${cols.map(c => c.sql).join(', ')})`);
  let runs = 0;
  for (let i = 0; i < 30; i++) {
    const k = r.int(stmts.length),
      s = stmts[k];
    if (!s) continue;
    const vals = new Map<string, Val>();
    for (const p of s.params) vals.set(p.name, valueOf(r, p));
    const all = stmts.flatMap(x => x.params);
    // every field of V in the body: the statement's values, and null for the others' (they are Options or unread)
    const body = `{${all.map(p => `${JSON.stringify(p.name)}:${vals.has(p.name) ? jsonOf(p, vals.get(p.name) ?? null) : jsonOf(p, valueOf(r, p) ?? null)}`).join(',')}}`;
    // a value the body sends for another statement's parameter is not used by this one
    const got = dec.decode(
      (await app.runLogged(enc.encode(`${k}\n${body}`), { transaction: g => sql.transaction(g) })).out,
    );
    let want: string;
    try {
      const st = ref.prepare(s.sql);
      st.setReadBigInts(true);
      const named = Object.fromEntries(s.params.map(p => [p.name, bound(vals.get(p.name) ?? null)]));
      if (s.call === 'exec') want = String(st.run(named).changes);
      else {
        const rows = st.all(named);
        if (s.call === 'count') want = rows[0] ? str(rows[0]['n']) : 'none';
        else if (s.call === 'first') want = rows[0] ? rowJson(cols, rows[0]) : 'none';
        else want = `[${rows.map(x => rowJson(cols, x)).join(',')}]`;
      }
    } catch (e) {
      want = `sqlite: ${e instanceof Error ? e.message : String(e)}`;
    }
    runs++;
    if (got !== want)
      return {
        statements: stmts.length,
        runs,
        bad: `${s.sql} with ${body}: the program answered ${got.slice(0, 300)}, SQLite ${want.slice(0, 300)}`,
      };
  }
  return { statements: stmts.length, runs, bad: null };
}

if (import.meta.main) {
  const c = cli();
  let statements = 0,
    runs = 0,
    bad = 0;
  const start = Date.now();
  for (const seed of seeds(c)) {
    const v = await sqlCase(seed, c.only !== null);
    statements += v.statements;
    runs += v.runs;
    if (v.bad) {
      bad++;
      console.log(`FINDING sql seed=${seed}: ${v.bad}`);
    }
  }
  const s = (Date.now() - start) / 1000;
  console.log(
    `sql: ${statements} statements, ${runs} runs against SQLite, ${bad} findings, refused ${[...REFUSED].map(([k, n]) => `${k}:${n}`).join(' ')}, ${(runs / s).toFixed(0)} runs/s`,
  );
}
