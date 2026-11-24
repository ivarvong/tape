// A trace is made by replaying a request's log through the traced build, and each arm tried is an event. A request
// that loops over its input makes millions: csv2chart's 60 KB CSV (apps/products/csv2chart) made 2,234,855 events
// and 124 MB of heap in one replay, so on Workers (128 MB an isolate) its trace page and OTLP link answered 1101.
// traceOf keeps the first TRACE_SITES line events (`most`) and counts the rest (`cut`); every effect (SQL, calls,
// the clock) is still recorded, so spans and the effect lines stay whole.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { instantiate, traceOf, TRACE_SITES } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { finish, ok, same, std } from './harness.ts';

const program = `schema "CREATE TABLE IF NOT EXISTS seen(n INTEGER NOT NULL)"

fn handle(raw: View, db: Sql) -> Buf {
  let n = count(v: request(raw).body, at: 0, k: 0)
  do sql_exec(query: "INSERT INTO seen(n) VALUES (:n)", repeat: True, n)
  respond(status: 200) |> append(view: "\\(n)")
}

fn count(v: View, at: Int, k: Int) -> Int {
  match {
    at >= len(v) -> k
    v[at] == 120 -> count(v, at: at + 1, k: k + 1)
    else -> count(v, at: at + 1, k)
  }
}
`;
const files = [...std, { name: 'loop.tape', text: program }];
const plain = compile(files),
  traced = compile(files, { trace: true });
if (!plain.wasm || !traced.wasm) throw new Error('the program does not compile');
const app = instantiate(new WebAssembly.Module(plain.wasm), { sql: nodeSql(), name: 'loop' });
const tmod = new WebAssembly.Module(traced.wasm);
const enc = new TextEncoder();
const sites = (events: readonly object[]): number => events.filter(e => 'site' in e).length;

const small = enc.encode(`POST /\n${'xy'.repeat(10)}`);
const whole = traceOf(tmod, small, (await app.runLogged(small)).effects);
ok('a short request is traced whole: nothing cut', whole.cut === 0, `cut ${whole.cut}`);
const all = sites(whole.events);

const cut = traceOf(tmod, small, (await app.runLogged(small)).effects, 10);
same('with most 10, ten line events are kept', sites(cut.events), 10);
same('and the rest are counted as cut', cut.cut, all - 10);
ok(
  'the SQL after the cut is still in the trace',
  cut.events.some(e => 'sql' in e),
);
same('and the replay answers as the run did', new TextDecoder().decode(cut.out ?? new Uint8Array()), '200\n10');

// 200,000 bytes: about 600,000 events; the default keeps TRACE_SITES of them
const big = enc.encode(`POST /\n${'x'.repeat(200_000)}`);
const long = traceOf(tmod, big, (await app.runLogged(big)).effects);
same('a long request keeps TRACE_SITES line events by default', sites(long.events), TRACE_SITES);
ok('and counts the rest', long.cut > 400_000, `cut ${long.cut}`);
ok('TRACE_SITES is at most 100,000', TRACE_SITES <= 100_000);

finish();
