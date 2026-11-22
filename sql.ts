// sql.ts: the SQL a tape program runs, read as SQLite reads it. A tokenizer and a recursive-descent parser for the
// subset tape programs use (SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, CREATE INDEX, ALTER TABLE, DROP), the
// schema those statements build, and a checker that resolves every name against it and types every expression.
// It has no dependencies, so it runs in the compiler inside a Worker as well as in Node.
//
// Sound by refusal: a statement outside the subset is not guessed at. parse() throws an SqlError that names the
// first token it cannot take and why (a WITH clause, a trigger, a schema-qualified name, a window function …), and
// the compiler reports it (C67). The rules (rules.ts) then read the tree, never the text.
//
// Types. Every expression has a type { t, null }: t is 'int', 'real', 'text', 'blob', 'null' or 'any' (not known:
// a parameter nothing constrains), null is whether it can be NULL. A column's t is its declared type's affinity
// (SQLite 3.1 rules: INT → int; CHAR, CLOB, TEXT → text; BLOB or none → blob; REAL, FLOA, DOUB → real; else
// numeric, typed 'any'). Nullability follows SQLite: a column is NOT NULL when declared so, or when it is the
// INTEGER PRIMARY KEY (the rowid), or a PRIMARY KEY column of a WITHOUT ROWID table; any other PRIMARY KEY column
// may hold NULL (SQLite's long-standing quirk). A LEFT JOIN makes the right side's columns nullable. An aggregate
// other than count over no rows is NULL (sum, max, min, group_concat, avg), and so is a scalar subquery that finds
// no row.
//
// The parts, in sql/: tokens.ts, parse.ts (text to a tree), tree.ts (walking and printing one), schema.ts (what
// CREATE, ALTER and DROP build), analyze.ts (a statement against a schema), program.ts (a program's whole schema).
export { SqlError, tokenize } from './sql/tokens.ts';
export { parse, tryParse } from './sql/parse.ts';
export { children, walkSql, conjunctsOf, print } from './sql/tree.ts';
export { affinity, newSchema, cloneSchema, applyToSchema } from './sql/schema.ts';
export { TAPE_T, analyze, integerParams } from './sql/analyze.ts';
export { schemaOf } from './sql/program.ts';
