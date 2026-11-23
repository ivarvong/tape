// test/timers-transient.ts: a woken run that fails on a storage error keeps its timer and is tried again later, with
// a wait that doubles each time up to a cap; a run that traps loses it. Before 22 November 2026 every failure but a
// cut removed the timer, so a transient SQLITE_BUSY lost the work for good (lab_notebook repros/wakeloss.ts).
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { TRANSIENT, WAKE_RETRY } from '../host/run.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import { finish, messageOf, same as T } from './harness.ts';

const text = `schema "CREATE TABLE IF NOT EXISTS hits(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)"
type Hit { Hit(n: Int) }
export fn woken(db: Sql, timer: Timer, message: Wake) -> Result[Hit, View] {
  let Wake(key) = message
  do sql_exec(query: "INSERT INTO hits(id, n) VALUES (:key, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1", key)
  // key 13 traps: division by zero
  Ok(value: Hit(n: 1 / (key - 13)))
}
fn handle(raw: View, db: Sql, timer: Timer) -> Buf {
  do wake(after: 0, key: 7)
  do wake(after: 0, key: 13)
  respond(status: 202)
}
`;
const r = compile([...std, { name: 't', text }], { rules: false });
if (r.wasm === null) throw new Error(r.errors.map(e => `${e.code} ${e.line} ${e.message}`).join('\n'));
const sql = nodeSql();
const app = instantiate(new WebAssembly.Module(r.wasm), { sql });
app.handleIn(f => sql.transaction(f), new TextEncoder().encode('POST /\n'));
const wakes = (): [number, number][] =>
  sql
    .exec('SELECT key, due FROM _wakes ORDER BY key')
    .raw()
    .toArray()
    .map(([k, d]) => [Number(k), Number(d)]);
const hits = (): number => Number(sql.exec('SELECT coalesce(sum(n), 0) FROM hits').raw().toArray()[0]?.[0]);
let busy = 0;
const flaky = <R>(f: () => R): R =>
  sql.transaction(() => {
    const out = f();
    if (busy > 0) {
      busy--;
      throw new Error('SQLITE_BUSY: database is locked');
    }
    return out;
  });
const wake = async (key: number, now: number): Promise<string> => {
  try {
    const w = await app.wake(key, { transaction: flaky, now });
    return w ? w.status : 'not due';
  } catch (e) {
    return messageOf(e);
  }
};

const t0 = Date.now() + 1;
busy = 1;
T('a woken run whose commit fails on SQLITE_BUSY fails', await wake(7, t0), 'SQLITE_BUSY: database is locked');
const [[, due1] = [0, 0]] = wakes();
T(
  'its timer is kept, set for later by the first wait, and its write is not applied',
  [wakes().map(([k]) => k), due1 - t0, hits()],
  [[7, 13], WAKE_RETRY.first, 0],
);
T('not due before then', await wake(7, due1 - 1), 'not due');
busy = 1;
const second = await wake(7, due1);
const [[, due2] = [0, 0]] = wakes();
T(
  'failing again waits twice as long',
  [second, due2 - due1],
  ['SQLITE_BUSY: database is locked', 2 * WAKE_RETRY.first],
);
// many failures in a row: the wait stops growing at the cap
let at = due2;
for (let i = 0; i < 30; i++) {
  busy = 1;
  await wake(7, at);
  at = wakes()[0]?.[1] ?? at;
}
busy = 1;
await wake(7, at);
T('the wait is capped', (wakes()[0]?.[1] ?? 0) - at, WAKE_RETRY.most);
at = wakes()[0]?.[1] ?? at;
T(
  'when storage recovers, the run is done once and its timer removed',
  [await wake(7, at), hits(), wakes().map(([k]) => k)],
  ['ok', 1, [13]],
);

// a trap is the program's own failure: it would fail again, so its timer goes, as before
T('a woken run that traps fails', /division by zero/.test(await wake(13, t0)), true);
T('and its timer is removed', wakes(), []);

// a transient failure of the bookkeeping itself (moving the timer later) leaves the timer due; nothing is lost
app.handleIn(f => sql.transaction(f), new TextEncoder().encode('POST /\n'));
sql.exec('DELETE FROM _wakes WHERE key = 13');
busy = 2;
T('the run and its rescheduling both fail', await wake(7, Date.now() + 1), 'SQLITE_BUSY: database is locked');
T('the timer stays, still due', wakes().length === 1 && (wakes()[0]?.[1] ?? Infinity) <= Date.now() + 1, true);

// the host's storage-failure pattern is the service's (service/src/program.ts TRANSIENT, R-ANS-2)
const service = readFileSync(new URL('../service/src/program.ts', import.meta.url), 'utf8');
const [, body = '', flags = ''] = /export const TRANSIENT =\s*\/(.+)\/(\w*);/.exec(service) ?? [];
T("the host's TRANSIENT is the service's", [TRANSIENT.source, TRANSIENT.flags], [body, flags]);
finish();
