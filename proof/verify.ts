// proof/verify.ts: what is checked, how, and with what result. node proof/verify.ts [programs=1500]
// Each row names a property, the method, how many cases ran and whether they all held. "Exhaustive" rows cover
// every case within the stated bound; "sampled" rows are random and prove nothing beyond the cases run.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { compile } from '../compiler.ts';
import type { Options, Source } from '../compiler.ts';
import { bare, call, handleBare, trapOf } from '../test/harness.ts';
import type { Bare } from '../test/harness.ts';
import type { Log } from './replay-logs.ts';
import { std } from '../std.ts';
import { interpret, Trap, Unsupported } from '../interp.ts';
import { program } from './gen.ts';
import { gen as csvGen } from '../bench/csv-gen.ts';
const src = (n: string) => ({ name: n, text: readFileSync(new URL(`../${n}`, import.meta.url), 'utf8') });
const pure = std.filter(s => !/json|http/.test(s.name));
const BUILDS: readonly (readonly [string, Partial<Options>])[] = [
  ['default', {}],
  ['never releases', { reuse: false }],
  ['checked', { check: true }],
];
const rows: { property: string; method: string; cases: number; ok: boolean; note: string }[] = [];
const dec = new TextDecoder();
/** The three builds of a program, each instantiated bare; null when it does not compile. */
const builds = (sources: Source[], options: Partial<Options> = {}): Bare[] | null => {
  const built = BUILDS.map(([, o]) => compile(sources, { ...o, ...options }));
  return built.every(b => b.wasm !== null)
    ? built.flatMap(b => (b.wasm === null ? [] : [bare(new WebAssembly.Module(b.wasm))]))
    : null;
};
const row = (property: string, method: string, cases: number, bad: number, note = '') => {
  rows.push({ property, method, cases, ok: bad === 0, note: bad > 0 ? `${bad} FAILED ${note}` : note });
};
const show = (v: unknown): string => (v instanceof Uint8Array ? dec.decode(v) : String(v));
const wasmCall = (ex: Bare, fn: string, args: bigint[]): string => {
  call(ex.fns, 'reset');
  try {
    return show(call(ex.fns, fn, ...args));
  } catch (e) {
    return trapOf(ex, e);
  }
};
const meant = (it: ReturnType<typeof interpret>, fn: string, args: bigint[] | Uint8Array<ArrayBuffer>[]): string => {
  try {
    return show(it.call(fn, args));
  } catch (e) {
    if (e instanceof Trap) return `trap ${e.code}`;
    throw e;
  }
};

// 1. generated programs: the interpreter against three builds
{
  const N = Number(process.argv[2] ?? 1500);
  let cases = 0,
    bad = 0,
    traps = 0,
    rejected = 0,
    first = '',
    firstBad = '';
  for (let seed = 1; seed <= N; seed++) {
    const text = program(seed),
      sources = [...pure, { name: 'gen.tape', text }];
    // a small step budget: a build that corrupts a value can loop, and must fail fast instead of hanging the run
    const exs = builds(sources, { exports: ['f'], reductionLimit: 200_000 });
    if (!exs) {
      rejected++;
      const [no] = compile(sources, { exports: ['f'] }).errors;
      if (!first) first = `seed ${seed}: generator made a program the compiler rejects: ${no?.code} ${no?.message}`;
      continue;
    }
    const it = interpret(sources);
    for (const n of [0n, 3n, 7n]) {
      const want = meant(it, 'f', [n]),
        got = exs.map(ex => wasmCall(ex, 'f', [n]));
      cases++;
      if (want.startsWith('trap')) traps++;
      if (got.some(g => g !== want)) {
        bad++;
        if (!firstBad) firstBad = `seed ${seed} n=${n}: meant ${want}, builds gave ${got.join(' / ')}`;
      }
    }
  }
  row(
    "A compiled program gives the interpreter's answer or the same trap",
    `sampled: ${N} generated programs x 3 inputs x 3 builds`,
    cases,
    bad + rejected,
    `${traps} of the cases trap${rejected ? `; ${rejected} programs rejected: ${first}` : ''}${bad ? `; ${bad} disagreements, first: ${firstBad}` : ''}`,
  );
}
// 2. real programs with no host effects: interpreter against the builds on generated inputs
{
  const inputs = {
    csv: Array.from({ length: 40 }, (_, i) => csvGen(200 + 700 * i, i + 1, i % 2 === 0)),
    words: Array.from({ length: 40 }, (_, i) =>
      Buffer.from(
        Array.from(
          { length: 30 + 9 * i },
          (_w, j) => ['the', 'a', 'Tape', 'log', 'x', 'replay', '42', '--'][(i * 7 + j * 13) % 8],
        ).join(' '),
      ),
    ),
    stats: Array.from({ length: 40 }, (_, i) =>
      Buffer.from(Array.from({ length: i }, (_n, j) => (i * 31 + j * 17) % 97).join(',')),
    ),
    git: Array.from({ length: 40 }, (_, i) => {
      const p = `tree ${'ab'.repeat(20)}\n${'parent ' + 'cd'.repeat(20) + '\n'}author A <a@b.c> ${i} +0000\n\nsubject ${i}\n`;
      return Buffer.from(
        i % 5 === 4 ? `blob ${i}\0${'z'.repeat(i)}` : i % 5 === 3 ? `commit 3\0bad` : `commit ${p.length}\0${p}`,
      );
    }),
  };
  for (const [name, list] of Object.entries(inputs)) {
    const sources = [...std, src(`examples/${name}.tape`)],
      it = interpret(sources);
    const exs = builds(sources) ?? [];
    let bad = 0,
      first = '';
    for (const input of list) {
      let want;
      try {
        want = meant(it, 'handle', [new Uint8Array(input)]);
      } catch (e) {
        if (e instanceof Unsupported) {
          want = null;
          first = `interpreter does not cover ${e.message}`;
          bad++;
          break;
        }
        throw e;
      }
      const got = exs.map(ex => handleBare(ex, input));
      if (got.some(g => g !== want)) {
        bad++;
        if (!first) first = `meant ${want.slice(0, 60)}, builds gave ${got.map(g => g.slice(0, 40)).join(' / ')}`;
      }
    }
    row(
      `examples/${name}.tape gives the interpreter's answer`,
      `sampled: ${list.length} inputs x 3 builds`,
      list.length,
      bad,
      first,
    );
  }
}
// 2b. logs as the service stores them: recorded here from three programs, then replayed through three builds
if (process.env.VERIFY_ONLY !== 'generated') {
  const { logOf, replayLogs } = await import('./replay-logs.ts'),
    { instantiate } = await import('../host.ts'),
    { nodeSql } = await import('../nodesql.ts');
  const enc = new TextEncoder(),
    plans = {
      todo: [
        'POST /todos\n{"key":"k1","title":"a"}',
        'POST /todos\n{"key":"k2","title":""}',
        'PATCH /todos/1\n{"done":true}',
        'GET /todos?done=true\n',
        'DELETE /todos/1\n',
        'GET /todos/9\n',
      ],
      ledger: [
        'POST /transfers\n{"key":"t1","from":"alice","to":"bob","amount":30}',
        'POST /transfers\n{"key":"t2","from":"alice","to":"carol","amount":5}',
        'POST /transfers\n{"key":"t3","from":"bob","to":"alice","amount":500}',
        'GET /accounts\n',
      ],
      shortener: [
        'POST /links\n{"key":"a","url":"https://example.com/a"}',
        'POST /links\n{"key":"a","url":"https://example.com/a"}',
        'POST /links\n{"key":"b","url":"x"}',
        'GET /1\n',
      ],
    };
  let logs = 0,
    bad = 0,
    note = '';
  for (const [name, requests] of Object.entries(plans)) {
    const source = src(`examples/${name}.tape`).text,
      sql = nodeSql(),
      app = instantiate(new WebAssembly.Module(compile([...std, { name: 'program.tape', text: source }]).wasm), {
        sql,
      }),
      recorded: Log[] = [];
    for (const r of requests) {
      const ran = await app.runLogged(enc.encode(r), { transaction: f => sql.transaction(f) });
      // the first request of each plan is one the program accepts and writes for: if it is refused, the plan has gone
      // stale against the program (as it had, 15 to 19 November 2026) and what follows would check nothing
      if (recorded.length === 0 && !/^20\d/.test(dec.decode(ran.out))) {
        bad++;
        note ||= `${name}: its first request is refused (${dec.decode(ran.out).slice(0, 60).replaceAll('\n', ' ')}): the plan no longer fits the program`;
      }
      // as it is stored: through JSON and back
      recorded.push(
        logOf(JSON.parse(JSON.stringify({ id: `${name}-${recorded.length}`, request: r, effects: ran.effects }))),
      );
    }
    const res = replayLogs(source, recorded);
    logs += res.logs;
    bad += res.logs - res.agreed;
    if (res.failed[0] && !note) note = JSON.stringify(res.failed[0]);
    // a log with one SQL answer removed must not replay
    const cut = replayLogs(
      source,
      recorded.slice(0, 1).map(log => ({ ...log, effects: log.effects.slice(0, -1) })),
    );
    if (cut.failed.length !== 1) {
      bad++;
      note ||= `${name}: a shortened log replayed`;
    }
  }
  row(
    'Stored logs replay with no database, to the same bytes in every build',
    "examples: logs recorded here in the service's shape; a shortened log must fail",
    logs,
    bad,
    note,
  );
}
// 3. the call protocol: every schedule of delivery outcomes, on the real host and programs
if (process.env.VERIFY_ONLY !== 'generated') {
  const { explore, OUTCOMES } = await import('./schedule.ts'),
    a = await explore(),
    b = await explore({ keys: false });
  // fewer than 400 schedules means the scenario no longer reaches its calls: that is a failure, not a pass
  row(
    'Two orders for one lamp: one confirmed, one refused, none pending, stock 0, all replay',
    `exhaustive: every mix of ${OUTCOMES.join(' / ')} at each call, 2 orders + 3 retry rounds`,
    a.schedules,
    a.violations.length + (a.schedules < 400 ? 1 : 0),
    a.violations[0]
      ? JSON.stringify(a.violations[0])
      : a.schedules < 400
        ? 'the scenario no longer reaches its calls'
        : `${a.calls} calls`,
  );
  row(
    'The same explorer finds the fault when idempotency keys are removed',
    'exhaustive, same bound; a violation is the expected result',
    b.schedules,
    b.violations.length > 0 ? 0 : 1,
    `${b.violations.length} schedules violate`,
  );
}
// 3. the suites, including the memory proof suite and (when ply is built) the git capability against real git
for (const t of process.env.VERIFY_ONLY === 'generated'
  ? []
  : ['core', 'calls', 'generics', 'remotes', 'memory', 'git']) {
  let out;
  try {
    out = execFileSync(process.execPath, [new URL(`../test/${t}.ts`, import.meta.url).pathname], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = `${typeof e === 'object' && e !== null && 'stdout' in e ? String(e.stdout) : ''}\nFAIL (exit)`;
  }
  const oks = (out.match(/^ok/gm) ?? []).length,
    fails = (out.match(/^FAIL/gm) ?? []).length;
  row(`test/${t}.ts`, /skipped/.test(out) ? 'skipped' : 'examples and properties, see the file', oks, fails);
}
const wide = Math.max(...rows.map(r => r.property.length));
const how = Math.max(...rows.map(r => r.method.length));
for (const r of rows)
  console.log(
    `${r.ok ? 'ok  ' : 'FAIL'} ${r.property.padEnd(wide)}  ${r.method.padEnd(how)}  ${String(r.cases).padStart(6)} cases  ${r.note}`,
  );
console.log(
  '\nTrusted and not checked here: the parser (shared by the interpreter and the compiler), the Wasm engine, SQLite, host.ts for programs with effects, and each adapter.',
);
process.exit(rows.every(r => r.ok) ? 0 : 1);
