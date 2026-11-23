// bench/suite/one.ts: one measurement in this process, printed as one JSON line. run.ts starts it, once per
// workload, way and tier (and once per sample for cold), under the V8 flags of the tier.
//   node [flags] bench/suite/one.ts <workload> <js|tape-log|tape-nolog|all> <warm|cold> <scale> [samples]
// warm: a fresh database, 10 requests to warm up, then `samples` requests (fresh keys each), each timed. `all`: the
// three ways in this one process, each on its own database, taking turns request by request (the order rotating),
// so load from other processes on the machine falls on all three alike; prints { ms: { js, tape-log, tape-nolog } }.
// cold: the first request of this process: for Tape, compiling the Wasm (new WebAssembly.Module from the bytes the
// service would store), instantiating it and running its schema, then the request; for JS, its schema, then the
// request. Requests are made before the clock starts.
import { readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { makeWay } from './common.ts';
import type { Mode } from './common.ts';
import { wasmPath } from './wasm.ts';
import { load } from './workloads.ts';

const [name = 'crud', mode = 'js', kind = 'warm', scaleText = '1', samplesText = '30'] = process.argv.slice(2);
const w = await load(name);
const scale = Number(scaleText);
const samples = Number(samplesText);
const bytes = mode === 'js' ? null : readFileSync(wasmPath(w.tape));
const MODES: Mode[] = ['js', 'tape-log', 'tape-nolog'];
const asMode = (m: string): Mode => {
  const found = MODES.find(x => x === m);
  if (found === undefined) throw new Error(`no such way ${m}`);
  return found;
};

if (kind === 'cold') {
  const req = w.request(0, scale);
  const t0 = performance.now();
  const module = bytes ? new WebAssembly.Module(bytes) : null;
  const t1 = performance.now();
  const run = makeWay(w, asMode(mode), module);
  const t2 = performance.now();
  await run(req);
  const t3 = performance.now();
  console.log(JSON.stringify({ compile: t1 - t0, setup: t2 - t1, request: t3 - t2, total: t3 - t0 }));
} else if (mode === 'all') {
  const module = new WebAssembly.Module(bytes ?? new Uint8Array());
  const runs = MODES.map(m => makeWay(w, m, m === 'js' ? null : module));
  const WARM = 10;
  const ms: number[][] = MODES.map(() => []);
  let requestBytes = 0;
  for (let k = 0; k < WARM + samples; k++) {
    const req = w.request(k, scale);
    requestBytes = req.length;
    for (let j = 0; j < runs.length; j++) {
      const i = (j + k) % runs.length;
      const t = performance.now();
      await runs[i]?.(req);
      if (k >= WARM) ms[i]?.push(performance.now() - t);
    }
  }
  console.log(JSON.stringify({ ms: Object.fromEntries(MODES.map((m, i) => [m, ms[i]])), requestBytes }));
} else {
  const module = bytes ? new WebAssembly.Module(bytes) : null;
  const run = makeWay(w, asMode(mode), module);
  const WARM = 10;
  const reqs = Array.from({ length: WARM + samples }, (_, k) => w.request(k, scale));
  const ms: number[] = [];
  let size = 0;
  // TAPE_PROFILE=file: a CPU profile of the timed requests only (not the generator, not the warm-up), to file
  const profile = process.env['TAPE_PROFILE'];
  const session = profile ? new Session() : null;
  const post = (method: string, params: object = {}): Promise<unknown> =>
    new Promise((ok, no) => {
      session?.post(method, params, (e, r) => {
        if (e) no(e);
        else ok(r);
      });
    });
  session?.connect();
  if (session) await post('Profiler.enable');
  if (session) await post('Profiler.setSamplingInterval', { interval: 50 });
  for (const [k, req] of reqs.entries()) {
    if (k === WARM && session) await post('Profiler.start');
    const t = performance.now();
    const out = await run(req);
    const took = performance.now() - t;
    if (k >= WARM) ms.push(took);
    size = out.length;
  }
  if (session && profile) {
    const stopped = await post('Profiler.stop');
    writeFileSync(
      profile,
      JSON.stringify(
        typeof stopped === 'object' && stopped !== null && 'profile' in stopped ? stopped.profile : undefined,
      ),
    );
  }
  console.log(JSON.stringify({ ms, requestBytes: reqs[0]?.length ?? 0, answerBytes: size }));
}
