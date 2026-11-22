// What a sample of mutants survived (proof/mutate.ts --since, 19 November 2026): each case here is a line of
// sql.ts or compiler.ts that could be changed without any test noticing. Each now has a test that notices.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { tryParse, print } from '../sql.ts';
import { ok, finish, std } from './harness.ts';

const codes = (text: string): string => {
  const b = compile([...std, { name: 'program.tape', text }]);
  return b.errors.map(e => e.code).join(',') || 'builds';
};
const said = (text: string): string => compile([...std, { name: 'program.tape', text }]).errors[0]?.message ?? '';
const head = `migration 1 "t" {\n  CREATE TABLE t(\n    id INTEGER PRIMARY KEY,\n    n INTEGER NOT NULL,\n    mean REAL NOT NULL DEFAULT 0\n  );\n  INSERT INTO t(id, n) VALUES (1, 2)\n}\n\ntype N { N(n: Int) }\n\ntype R { R(id: Int, xs: List[Int]) }\n\ntype Two {\n  A(n: Int)\n  B(n: Int)\n}\n\n`;
const h = (body: string): string =>
  `${head}fn handle(raw: View, db: Sql) -> Buf {\n${body}\n}\n\nfn shown(found: Option[N]) -> Buf {\n  match found {\n    Some(value: N(n)) -> respond(status: 200) |> write_int(value: n)\n    None -> respond(status: 404)\n  }\n}\n`;
const reads = (type: string): string =>
  `${head}fn handle(raw: View, db: Sql) -> Buf {\n  match sql_first(row: ${type}, query: "SELECT ${type === 'R' ? 'id, n' : 'n'} FROM t") {\n    Some(value) -> respond(status: 200)\n    None -> respond(status: 404)\n  }\n}\n`;

// sql.ts: what may be NULL
ok(
  'changes() is never NULL: it can be read into an Int',
  codes(h('  shown(found: sql_first(row: N, query: "SELECT changes() AS n"))')) === 'builds',
);
ok(
  'avg() may be NULL: it cannot be written to a NOT NULL column (C69)',
  codes(
    h('  do sql_exec(query: "UPDATE t SET mean = (SELECT avg(n) FROM t) WHERE id = 1")\n  respond(status: 200)'),
  ) === 'C69' &&
    said(
      h('  do sql_exec(query: "UPDATE t SET mean = (SELECT avg(n) FROM t) WHERE id = 1")\n  respond(status: 200)'),
    ).includes('may be NULL'),
);
ok(
  'and with coalesce it can',
  codes(
    h(
      '  do sql_exec(query: "UPDATE t SET mean = coalesce((SELECT avg(n) FROM t), 0.0) WHERE id = 1")\n  respond(status: 200)',
    ),
  ) === 'builds',
);
// sql.ts: where an aggregate may stand
ok(
  'an aggregate in a VALUES row is refused (C68)',
  codes(
    h(
      '  do sql_exec(query: "INSERT INTO t(id, n) VALUES (7, count(*)) ON CONFLICT(id) DO NOTHING")\n  respond(status: 200)',
    ),
  ) === 'C68',
);
// sql.ts: the parser
for (const q of ['SELECT CURRENT_TIMESTAMP', 'SELECT CURRENT_DATE', 'SELECT CURRENT_TIME']) {
  const r = tryParse(q);
  ok(`${q} parses and prints as written`, !r.error && print(r.ast) === q, r.error?.message);
}
ok(
  'NOT with nothing it can negate after it is not SQL',
  (tryParse('SELECT id FROM t WHERE id NOT 5').error?.message ?? '').includes('NOT'),
);
{
  const q = 'SELECT id FROM t WHERE n NOT IN (1, 2) AND n NOT LIKE 3 AND n NOT BETWEEN 1 AND 2',
    r = tryParse(q);
  ok(
    'NOT IN, NOT LIKE and NOT BETWEEN bind as comparisons, tighter than AND',
    !r.error &&
      print(r.ast) === 'SELECT id FROM t WHERE (((n NOT IN (1, 2)) AND (n NOT LIKE 3)) AND (n NOT BETWEEN 1 AND 2))',
    r.error?.message ?? print(r.ast),
  );
}
{
  const r = tryParse('SELECT 1 + NULL * 2 AS a, 3 - 2 IN (1) AS b');
  ok(
    'an operator before NULL or IN keeps its own strength',
    !r.error && print(r.ast) === 'SELECT (1 + (NULL * 2)) AS a, ((3 - 2) IN (1)) AS b',
    r.error?.message ?? print(r.ast),
  );
}
{
  const q =
      'CREATE TABLE a(x INTEGER, y INTEGER, PRIMARY KEY (x, y), UNIQUE (y), FOREIGN KEY (x) REFERENCES b (id), CHECK (x > 0))',
    r = tryParse(q);
  ok(
    'each kind of table constraint prints as its own kind',
    !r.error &&
      print(r.ast) ===
        'CREATE TABLE a (x INTEGER, y INTEGER, PRIMARY KEY (x, y), UNIQUE (y), FOREIGN KEY (x) REFERENCES b (id), CHECK ((x > 0)))',
    r.error?.message ?? print(r.ast),
  );
}
// compiler.ts: what a row type is
ok(
  'a row type with a field that is not a column (a list) is refused (C09)',
  codes(reads('R')) === 'C09' && said(reads('R')).includes('cannot be a row type'),
);
ok(
  'a row type with two constructors is refused (C09)',
  codes(reads('Two')) === 'C09' && said(reads('Two')).includes('cannot be a row type'),
);
ok('a row type with one constructor of columns is accepted', codes(reads('N')) === 'builds');

finish();
