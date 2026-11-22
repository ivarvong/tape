// What a SELECT's columns may be, and which rows a WHERE names: two cases that were wrong and are fixed.
import '../node25.ts';
import { namesOneRow } from '../rules/move.ts';
import { analyze, parse, schemaOf } from '../sql.ts';
import { finish, same } from './harness.ts';

const { schema } = schemaOf(['CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL)']);
/** each result column: `?` when it may be NULL, `.` when it cannot */
const nullable = (sql: string): string =>
  (analyze(parse(sql), schema).result ?? []).map(c => (c.null ? '?' : '.')).join('');

// an aggregate with no GROUP BY gives one row even over no rows: every column beside it is NULL then
same('a column beside count(*)', nullable('SELECT a, count(*) FROM t'), '?.');
same('* beside count(*): every column of the star', nullable('SELECT *, count(*) FROM t'), '???.');
same('count(*) before *', nullable('SELECT count(*), * FROM t'), '.???');
same('with GROUP BY nothing changes', nullable('SELECT *, count(*) FROM t GROUP BY id'), '....');

// a WHERE that fixes a whole unique key names one row, however the table's keys are written down
const where = (sql: string) => {
  const ast = parse(sql);
  return ast.k === 'select' ? ast.where : null;
};
const byPair = where("SELECT 1 FROM t WHERE a = 'x' AND b = 'y'");
same(
  'unique key as the schema holds it',
  namesOneRow(byPair, ['t'], { pk: ['id'], uniques: [{ cols: ['a', 'b'] }] }),
  true,
);
same('unique key as the rules hold it', namesOneRow(byPair, ['t'], { pk: ['id'], uniques: [['a', 'b']] }), true);
same(
  'half a unique key is not one row',
  namesOneRow(where("SELECT 1 FROM t WHERE a = 'x'"), ['t'], { pk: ['id'], uniques: [['a', 'b']] }),
  false,
);

finish();
