// A query names the values it takes (`WHERE id = :id`), and the call passes each by that name. What the database
// is given, what a run answers, and every way of writing it that is refused.
import '../node25.ts';
import { numbered } from '../compiler/sqltext.ts';
import { instantiate, isSql } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import type { Transaction } from '../host.ts';
import { built, finish, moduleOf, problems, same } from './harness.ts';

// ---- the statement the database is given: each name numbered in the order it first appears
same(
  'names are numbered as they first appear, and a name used twice is one value',
  numbered('a = :x AND b = :y AND c = :x'),
  {
    sql: 'a = ?1 AND b = ?2 AND c = ?1',
    names: ['x', 'y'],
    mixed: false,
  },
);
same(
  'a colon in quoted text, a quoted name or a comment is not a placeholder',
  numbered(`a = ':x' AND "b:c" = :y -- :z\n AND d = :w /* :v */`).names,
  ['y', 'w'],
);
same('a doubled quote inside text does not end it', numbered("a = 'it''s :x' AND b = :y").names, ['y']);
same('a statement with no placeholder takes no values', numbered('SELECT 1').names, []);
same('a statement that numbers its own has no names', numbered('a = ?1').names, null);
same('one that does both says so', numbered('a = ?1 AND b = :b').mixed, true);

// ---- a program: the arguments in another order than the names, one name used twice, one value an expression
const SCHEMA =
  'schema "CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, title TEXT NOT NULL, n INTEGER NOT NULL)"\n';
const program = (call: string): string =>
  `${SCHEMA}type Todo { Todo(id: Int, title: View, n: Int) }
fn handle(raw: View, db: Sql) -> Buf {
  let id = len(raw)
  let _ = sql_exec(db, query: "INSERT INTO todos(id, title, n) VALUES (:id, :title, :id * 10) ON CONFLICT(id) DO NOTHING", title: raw, id)
  match ${call} {
    Some(value: Todo(title, n)) -> respond(status: 200) |> append(view: "\\(title) \\(n)")
    None -> respond(status: 404)
  }
}
`;
const READ = 'sql_first(db, row: Todo, query: "SELECT * FROM todos WHERE title = :title AND id = :id", id, title: raw)';
{
  const b = built(program(READ)),
    sql = nodeSql(),
    tx: Transaction = f => sql.transaction(f),
    app = instantiate(moduleOf(b), { sql, name: 'names' });
  const r = await app.runLogged(new TextEncoder().encode('milk'), { transaction: tx });
  same(
    'a run binds each value to its name, whatever the order of the arguments',
    new TextDecoder().decode(r.out),
    '200\nmilk 40',
  );
  same('the stored row is the one the names say', sql.exec('SELECT id, title, n FROM todos').toArray(), [
    { id: 4, title: 'milk', n: 40 },
  ]);
  const select = b.queries.findIndex(q => q.sql.startsWith('SELECT'));
  same(
    "the module's statement is the numbered one, and the effect log holds the values in that order",
    [b.queries[select]?.sql, r.effects.flatMap(e => (isSql(e) && e.q === select ? [e.p] : []))],
    ['SELECT id, title, n FROM todos WHERE title = ?1 AND id = ?2', [['milk', 4]]],
  );
}

// ---- what is refused
const refused = (call: string): string[] => problems(program(call)).map(e => `${e.code} ${e.message}`);
const first = (call: string): string => refused(call)[0]?.split(' ')[0] ?? 'compiles';
same('as written, it compiles', refused(READ), []);
same('a name with no argument is C13, and the message says the name', refused(READ.replace(', id,', ',')), [
  'C13 sql_first is missing argument id',
]);
same(
  'an argument the query has no name for is C11',
  first(READ.replace('title: raw)', 'title: raw, extra: 1)')),
  'C11',
);
same('a numbered placeholder is C32', first(READ.replace(':id', '?1')), 'C32');
same('a bare ? is C32', first(READ.replace(':id', '?')), 'C32');
same("an argument named like the old form's is C11", first(READ.replace(', id,', ', id, p1: 3,')), 'C11');
same(
  "a placeholder with the name of one of the call's own arguments is C32",
  first(READ.replace(':id', ':row').replace(', id,', ',')),
  'C32',
);
same(
  'a value of a type SQL does not take is C14, and the message says the name',
  refused(READ.replace('title: raw)', 'title: db)'))[0],
  'C14 argument title should be Int, Dec, Float, Bool or View, or an Option of one, but is Sql',
);
{
  const [said] = refused(READ.replace('title = :title', "title = :title AND :id = 'x' || :id"));
  same(
    "what the checker says of a value, it says in the program's name for it",
    [said?.startsWith('C69'), said?.includes(':id'), said?.includes('?')],
    [true, true, false],
  );
}
finish();
