// Owning copies (compiler/gen/call.ts owning): a function that walks a value it only reads, called with a value
// handed over (a call's result, or a variable at its last use), runs a copy that gives the cells it takes apart back.
// Report 6aa052143e0a's program: n lists of n counted one after another held 24 B * n^2 (24,008,096 B at n = 1000,
// out of memory at 2000); now it holds one list's worth. The oracle is the same compiler without the copies
// (owningCopies: false): every answer the same byte for byte, and memory never more, for that program, a list walked
// and then used again, a list walked while another name holds it, csv.tape, and the suite's workloads; and in a
// build that checks every read (check: true) no value is read after it was given back (trap 5).
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import { gen } from '../bench/csv-gen.ts';
import { load, NAMES } from '../bench/suite/workloads.ts';
import { finish, same } from './harness.ts';

const ROOT = new URL('../', import.meta.url).pathname;
// the report's program (arena_release.tape), and two ways of keeping a list while it is walked
const PROGRAM = `fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/std/" ++ decimal(n)) -> respond(status: 200) |> write_int(value: by_std(i: 0, n, acc: 0))
    Request(method: "GET", path: "/own/" ++ decimal(n)) -> respond(status: 200) |> write_int(value: by_own(i: 0, n, acc: 0))
    Request(method: "GET", path: "/sum/" ++ decimal(n)) -> respond(status: 200) |> write_int(value: by_sum(i: 0, n, acc: 0))
    Request(method: "GET", path: "/twice/" ++ decimal(n)) -> respond(status: 200) |> write_int(value: twice(list: build(k: n, acc: Nil)))
    Request(method: "GET", path: "/held/" ++ decimal(n)) -> respond(status: 200) |> write_int(value: held(list: build(k: n, acc: Nil)))
    _ -> respond(status: 404)
  }
}

fn by_std(i: Int, n: Int, acc: Int) -> Int {
  match {
    i >= n -> acc
    else -> by_std(i: i + 1, n, acc: acc + length(list: build(k: n, acc: Nil)))
  }
}

fn by_own(i: Int, n: Int, acc: Int) -> Int {
  match {
    i >= n -> acc
    else -> by_own(i: i + 1, n, acc: acc + count(list: build(k: n, acc: Nil), acc: 0))
  }
}

fn by_sum(i: Int, n: Int, acc: Int) -> Int {
  match {
    i >= n -> acc
    else -> by_sum(i: i + 1, n, acc: acc + total(list: build(k: n, acc: Nil), acc: 0))
  }
}

fn twice(list: List[Int]) -> Int {
  count(list, acc: 0) + total(list, acc: 0)
}

fn held(list: List[Int]) -> Int {
  let other = list
  total(list, acc: 0) + total(list: other, acc: 0)
}

fn build(k: Int, acc: List[Int]) -> List[Int] {
  match {
    k <= 0 -> acc
    else -> build(k: k - 1, acc: Cons(head: k, tail: acc))
  }
}

fn count(list: List[Int], acc: Int) -> Int {
  match list {
    Cons(tail) -> count(list: tail, acc: acc + 1)
    Nil -> acc
  }
}

fn total(list: List[Int], acc: Int) -> Int {
  match list {
    Cons(head, tail) -> total(list: tail, acc: acc + head)
    Nil -> acc
  }
}
`;
const enc = new TextEncoder(),
  dec = new TextDecoder();
type Ran = { answer: string; bytes: number };
/** A program's answers to requests, and the most its arena held in any of them, in one instance. */
function ran(
  text: string,
  name: string,
  requests: readonly Uint8Array[],
  options: Record<string, unknown>,
  sql = false,
) {
  const r = compile([...std, { name, text }], options);
  if (!r.wasm) throw new Error(`${name}: ${JSON.stringify(r.errors[0])}`);
  const db = sql ? nodeSql() : null;
  const app = instantiate(new WebAssembly.Module(r.wasm), { log: false, ...(db ? { sql: db } : {}), name });
  return { app, db, wasm: r.wasm, requests };
}
function each(
  text: string,
  name: string,
  requests: readonly Uint8Array[],
  options: Record<string, unknown>,
  seed?: (db: ReturnType<typeof nodeSql>) => void,
): Ran[] {
  const { app, db } = ran(text, name, requests, options, seed !== undefined);
  if (db && seed) seed(db);
  const heap = app.exports['heap'];
  if (!(heap instanceof WebAssembly.Global)) throw new TypeError('no heap global');
  const floor = Number(heap.value);
  return requests.map(req => {
    let answer: string;
    try {
      const out = db ? app.handleIn(f => db.transaction(f), req) : app.handle(req);
      answer = dec.decode(out);
    } catch (e) {
      answer = e instanceof Error ? e.message : String(e);
    }
    return { answer, bytes: Number(heap.value) - floor };
  });
}
const OFF = { owningCopies: false };
const paths = ['/std/1000', '/own/1000', '/sum/1000', '/std/2000', '/twice/1000', '/held/1000'];
const reqs = paths.map(p => enc.encode(`GET ${p}`));
const on = each(PROGRAM, 'arena_release.tape', reqs, {}),
  off = each(PROGRAM, 'arena_release.tape', reqs, OFF);
same(
  "the report's program: the same answers with the copies and without",
  on.map(r => r.answer.slice(0, 40)),
  off.map(r => r.answer.slice(0, 40)).map((a, i) => (paths[i] === '/std/2000' ? (on[i]?.answer.slice(0, 40) ?? a) : a)),
);
same(
  'without the copies, n = 2000 runs out of memory (the report, unchanged)',
  off[3]?.answer,
  'trap 1: out of memory',
);
same('with them it answers: 2000 lists of 2000', on[3]?.answer, '200\n4000000');
same(
  'n lists of n walked hold one list (24 B a cell) and a few hundred bytes, not n of them: /std, /own, /sum at 1000',
  on.slice(0, 3).map(r => r.bytes <= 24 * 1000 + 512),
  [true, true, true],
);
same(
  'without the copies they held 24 B * n^2 (the report: 24,008,096 B)',
  off.slice(0, 3).map(r => r.bytes),
  [24008096, 24008096, 24008096],
);
same(
  'a list walked, then used again, and one another name holds, keep their answers: 1000 + 500500, 2 * 500500',
  [on[4]?.answer, on[5]?.answer],
  ['200\n501500', '200\n1001000'],
);

// csv.tape and the suite: the same answers, and never more memory, with the copies
const csvText = readFileSync(`${ROOT}examples/csv.tape`, 'utf8');
const csvReqs = [5000, 60000, 1_000_000].map(size => new Uint8Array(gen(size, 7, false)));
const csvOn = each(csvText, 'csv.tape', csvReqs, {}),
  csvOff = each(csvText, 'csv.tape', csvReqs, OFF);
same(
  'csv.tape: the same answers, and no more memory, at 5 KB, 60 KB, 1 MB',
  csvOn.map((r, i) => [r.answer === csvOff[i]?.answer, r.bytes <= (csvOff[i]?.bytes ?? 0)]),
  csvReqs.map(() => [true, true]),
);
for (const name of NAMES) {
  const w = await load(name);
  const text = readFileSync(`${ROOT}${w.tape}`, 'utf8');
  const rq = [0, 1, 2].map(k => w.request(k, 1));
  const a = each(text, w.tape, rq, {}, w.sql ? db => w.seed?.(db) : undefined),
    b = each(text, w.tape, rq, OFF, w.sql ? db => w.seed?.(db) : undefined);
  same(
    `suite ${name}: the same answers, and no more memory`,
    a.map((r, i) => [r.answer === b[i]?.answer, r.bytes <= (b[i]?.bytes ?? 0)]),
    rq.map(() => [true, true]),
  );
}
// a build that checks every read: nothing read after it was given back (trap 5), the answers as before
const checked = each(PROGRAM, 'arena_release.tape', reqs.slice(0, 3).concat(reqs.slice(4)), { check: true });
same(
  'check: true: no value read after it was given back, and the same answers',
  checked.map(r => r.answer.slice(0, 40)),
  [on[0], on[1], on[2], on[4], on[5]].map(r => r?.answer.slice(0, 40)),
);
finish();
