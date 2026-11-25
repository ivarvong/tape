// rules/model.ts: a program read once for the rules: each query's tree, the schema, each analysis, the queries by
// function, and the tables.
import type { Program } from '../compiler/ast.ts';
import type { Schema, Statement } from '../sql/ast.ts';
import type { ProgramSchema } from '../sql/program.ts';
import { analyze, schemaOf, tryParse } from '../sql.ts';
import type { Analysis, CallSite, Query, RuleTable } from './types.ts';
import { calleeOf, dec, lc, walk } from './syntax.ts';
import { writeOf } from './writes.ts';

// ---- trees, schemas and analyses, each made once
type Parsed = ReturnType<typeof tryParse>;
const TREES = new Map<string, Parsed>();
export function treeOf(sql: string): Parsed {
  let r = TREES.get(sql);
  if (!r) {
    r = tryParse(sql);
    if (TREES.size > 20000) TREES.clear();
    TREES.set(sql, r);
  }
  return r;
}
const MODELS = new WeakMap<Program, ProgramSchema>();
// The program's schema as sql.ts builds it from its schema statements and migrations: { schema, asts, errors }
export function sqlModel(prog: Program): ProgramSchema {
  let m = MODELS.get(prog);
  if (!m) {
    m = schemaOf(prog.schema, prog.migrations);
    MODELS.set(prog, m);
  }
  return m;
}
const ANALYSES = new WeakMap<Schema, Map<string, Analysis>>();
// A statement read against one schema (no parameter types: the rules ask what it names, not what it is given)
export function analysisOf(sql: string, ast: Statement, schema: Schema): Analysis {
  let per = ANALYSES.get(schema);
  if (!per) {
    per = new Map();
    ANALYSES.set(schema, per);
  }
  let a = per.get(sql);
  if (!a) {
    a = analyze(ast, schema, { src: sql });
    per.set(sql, a);
  }
  return a;
}

// The queries of a program: each sql_* call with a literal query, its tree (or the parse error) and its arguments.
export function queriesOf(prog: Program): { queries: Query[]; calls: Map<string, CallSite[]> } {
  const queries: Query[] = [],
    calls = new Map<string, CallSite[]>();
  for (const f of prog.fns.values())
    walk(f.body, n => {
      if (n.k !== 'call') return;
      if (/^sql_(exec|first|all|move)$/.test(n.name)) {
        const q = n.args.find(a => a.label === 'query')?.value;
        if (q?.k === 'str') {
          const raw = dec(q.bytes),
            t = treeOf(raw);
          queries.push({
            fn: f,
            via: n.name,
            raw,
            repeat: n.args.some(a => a.label === 'repeat'),
            noFloor: n.args.some(a => a.label === 'no_floor'),
            ast: t.ast ?? null,
            error: t.error ?? null,
            args: Object.fromEntries(
              n.args.flatMap(a => (a.label && /^p\d+$/.test(a.label) ? [[a.label.slice(1), a.value]] : [])),
            ),
            at: n,
          });
        }
      }
      const callee = calleeOf(prog, n.name, f);
      if (callee) {
        const sites = calls.get(callee) ?? [];
        sites.push({ from: f, node: n });
        calls.set(callee, sites);
      }
    });
  return { queries, calls };
}

// row type -> table, when every query reading into it reads one table (null when two do, or one reads a join)
export function rowTablesOf(queries: readonly Query[]): Map<string, string | null> {
  const rowTable = new Map<string, string | null>();
  for (const q of queries) {
    const r = q.at.args.find(a => a.label === 'row')?.value;
    if (r?.k !== 'ctor' || !q.ast) continue;
    const w = writeOf(q.ast),
      only = q.ast.k === 'select' && q.ast.from.length === 1 ? q.ast.from[0] : undefined,
      from = only && !only.sub ? only.name : null;
    const tb = w?.table ?? from;
    if (!tb) {
      rowTable.set(r.name, null);
      continue;
    }
    const had = rowTable.get(r.name);
    rowTable.set(r.name, had === undefined || lc(had) === lc(tb) ? tb : null);
  }
  return rowTable;
}

// --- the program's tables, as the rules use them: { cols, pk, uniques (the primary key first), defaults: column →
// its DEFAULT as SQL text ('reserving', 0, NULL), or null for one that is not a literal }, by table name. Read from
// sql.ts's schema: schema statements, then migrations, then schema statements again (the order a name's data is
// made in).
export function tablesOf(prog: Program): Map<string, RuleTable> {
  const t = new Map<string, RuleTable>();
  for (const x of sqlModel(prog).schema.tables.values()) {
    const defaults: Record<string, string | null> = {};
    for (const c of x.cols)
      if (c.default !== undefined)
        defaults[c.name] =
          c.default.k === 'lit' && !c.default.paren
            ? c.default.v === null
              ? 'NULL'
              : c.default.type === 'text'
                ? `'${String(c.default.v).replaceAll("'", "''")}'`
                : String(c.default.v)
            : null;
    const uniques = x.uniques.map(u => u.cols);
    if (x.pk.length > 0) uniques.unshift(x.pk);
    t.set(x.name, { cols: x.cols.map(c => c.name), pk: x.pk, uniques, defaults });
  }
  return t;
}
