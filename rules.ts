// rules.ts: rules over a parsed program that make some defects impossible to write. compiler.ts runs them on every
// build, after the program has type-checked; each problem is a compile error with its own code. They were chosen by
// experiment: each rejects a defect this project actually shipped.
//
// Every rule reads SQL as a tree (sql.ts: a parser for the subset tape programs use, the schema the program's
// statements build, and a checker that resolves each name and types each expression), never as text. A statement
// the parser does not take is refused (C67), so no rule is ever passed by a statement it could not read.
//
//   C51 migration form   a migration that is not `contract` takes only CREATE TABLE, CREATE INDEX, ALTER TABLE t
//                        ADD COLUMN and INSERT INTO t(columns …) (or INSERT INTO t SELECT): an allow-list, so a removal or rename cannot be written to pass as
//                        an expansion (M2). Anything else is a `contract` migration.
//   C52 qualified        a query over two or more tables names the table (or alias) of every column, so a column a
//                        later migration adds to another of them cannot make it ambiguous or change its meaning (M1).
//                        A subquery that names a column of the query around it names its table too: unqualified,
//                        a column of that name added to the subquery's own table would silently take its place.
//   C53 one schema       a program declares its tables with `schema` statements or with migrations, not both (M3).
//   C54 replay           a write reached from `handle` or `woken` is safe to run twice. A request is retried (by a
//                        client that timed out, a router, a timer that fires at least once), and a write that does
//                        not survive that is applied twice (J2, R7). An UPDATE (or upsert) whose new values depend on
//                        the row it changes (n = n + 1) is refused unless its WHERE, at the top level (not under an
//                        OR or a NOT), stops a second run:
//                        - a compare-and-set on a column it changes (`AND state = 'pending'` with a new state, `AND
//                          version = :version` with version = version + 1), or
//                        - an op-id guard, `NOT EXISTS (SELECT … FROM ops WHERE op = :op AND <the row's key>)`, over
//                          a table the program records op ids in, or
//                        - a witness `AND :done = 1` whose argument is the count of such a guarded write.
//                        (The rules read the statement as the database is given it, each name numbered: ?1, ?2.)
//                        An assignment that settles on its first run is not counted as depending on the row:
//                        `col = max(col, e)`, `min(col, e)`, `coalesce(col, e)` or `ifnull(col, e)` where e reads
//                        no column the write changes (applied twice, it gives what it gave once).
//   C55 replay           an INSERT reached from `handle` or `woken` names a whole unique key of its table (the key
//                        the client sent: a client key, an op id), so a second run conflicts instead of making a
//                        second row. ON CONFLICT … DO NOTHING (or OR IGNORE) protects only when such a key exists.
//   C56 replay           an op-id guard names the row the write changes: the same op id sent for another key is
//                        another write, not a repeat (R11).
//
//   C57-C61 machines     `machine table.column { "from" -> "to" … }`: every write of the column makes a declared move,
//                        from the state its WHERE names; see the section at the end of this file (J2, J3). C70: the
//                        statements of migrations and schema, which run while the machine's triggers are off, leave
//                        every row in a declared state.
//
//   C67 subset           a statement (a query, a schema statement, a migration's) outside the SQL sql.ts reads: a
//                        WITH clause, a trigger, a schema-qualified name, a window function, an unknown function …
//   C68 names            a migration or schema statement SQLite would refuse against the tables before it (a table
//                        made twice, a column that is not there, a NOT NULL column added with no default).
//                        (The compiler reports C68 and C69 for queries, where it knows the parameters' types.)
//
// The one opt-out from C54 and C55 is the argument `repeat: True` on the call, for a write that is meant to count
// every attempt (a visit counter, a retry counter, a rate limit).
//
// Writes reached only from an exported method are not checked: a caller reaches one with `call`, and the host
// answers a repeated once key with the stored reply, so the method does not run twice.
//
// The parts, in rules/: driver.ts (rules(prog): every rule run, and the rules about one statement and its retries),
// machines.ts and statecol.ts (a machine's column), timers.ts and origins.ts (a row that must be left has a
// timer that comes back for it), move.ts (sql_move), plan.ts (machines across versions), flow.ts, writes.ts,
// model.ts and syntax.ts (how a program and its statements are read). Each imports only from the ones after it
// in this list.
export { rules } from './rules/driver.ts';
export { checkMachine, machineContext } from './rules/machines.ts';
export { machinePlan } from './rules/plan.ts';
export { wayOut } from './rules/timers.ts';
export { movePlan } from './rules/move.ts';
export { writeOf } from './rules/writes.ts';
export { sqlModel, stateFields, tablesOf, treeOf } from './rules/model.ts';
