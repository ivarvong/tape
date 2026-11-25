// Changes to rules/ and sql/ that no test noticed (proof/mutate.ts --files rules/,sql/), each with the program
// that tells the change from the code as written.
import '../node25.ts';
import { finish, problems, same as T, swap as swapIn, tour } from './harness.ts';
const whole = tour();
const codes = (text: string): string[] => problems(text).map(e => e.code);
const swap = (from: string, to: string): string => swapIn(whole, from, to);
const LOAD = '"SELECT * FROM orders WHERE id = :id"';
T('the program these are edits of compiles', codes(whole), []);

// rules/driver.ts: only an arm for Rejected is an arm for the refusal. An arm for Timeout is not one.
const REFUSED = whole.split('\n').find(l => l.includes('Err(error: Rejected(reason: Declined(reason))) ->')) ?? '';
T(
  'C87: an arm for Timeout does not stand for the arm a refusal needs',
  codes(swap(REFUSED, '        Err(error: Timeout) -> shown(status: 202, found: load(id))')).includes('C87'),
  true,
);

// sql/analyze.ts: a table given an alias is named by the alias. SQLite refuses its own name there at run time.
T(
  'a column qualified by the name of a table that has an alias is refused',
  codes(swap(LOAD, '"SELECT * FROM orders AS o WHERE orders.id = :id"')).length > 0,
  true,
);
T('qualified by the alias, it is accepted', codes(swap(LOAD, '"SELECT * FROM orders AS o WHERE o.id = :id"')), []);

finish();
