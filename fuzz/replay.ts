// fuzz/replay.ts: replay from the effect log gives the bytes the request was answered with. Two sources of runs:
//   1. the simulator (sim.ts auto and search) on every program that takes requests, at a new seed each round: each
//      run it reaches is kept with the bytes it was given, its log and the bytes it answered;
//   2. the requests of those runs changed (a byte-order mark, bytes that are not UTF-8, astral characters, a large
//      number, a field doubled or dropped), sent live to the program with node:sqlite under it, on programs that
//      call no other program.
// Each log is stored as the service stores it (through JSON) and replayed through four builds (plain, traced,
// never releases, checked): every replay must use the whole log and answer the live run's bytes exactly.
//   node fuzz/replay.ts --seconds 60 [--seed 1] [--shard 0/8]
import { readdirSync, readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { instantiate, isEffect, replay } from '../host.ts';
import type { Effect, Observed } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { auto, search } from '../sim.ts';
import type { Model } from '../sim/engine.ts';
import { std } from '../std.ts';
import { cli, seeds } from './run.ts';
import { rng } from './rng.ts';
import type { Rng } from './rng.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const BUILDS: readonly (readonly [string, Partial<Options>])[] = [
  ['plain', {}],
  ['traced', { trace: true }],
  ['never releases', { reuse: false }],
  ['checked', { check: true }],
];
const list = (dir: string): string[] =>
  readdirSync(ROOT + dir)
    .filter(f => f.endsWith('.tape'))
    .map(f => `${dir}/${f}`);
const GROUPS: string[][] = [
  ['apps/tickets/tickets.tape', 'apps/tickets/pay.tape'],
  ['examples/orders.tape', 'examples/stock.tape'],
  ...['apps/queue/queue.tape', ...list('examples'), ...list('examples/timed')].map(f => [f]),
];
type File = { name: string; text: string };
const fileOf = (p: string): File => ({
  name: p.replace(/^.*\//, '').replace(/\.tape$/, ''),
  text: readFileSync(ROOT + p, 'utf8'),
});

const modulesCache = new Map<string, WebAssembly.Module[] | null>();
/** the four builds of one program, as the service names it */
function modulesOf(f: File): WebAssembly.Module[] | null {
  const had = modulesCache.get(f.text);
  if (had !== undefined) return had;
  const built = BUILDS.map(([, o]) => compile([...std, { name: 'program.tape', text: f.text }], o));
  const out = built.every(b => b.wasm !== null)
    ? built.flatMap(b => (b.wasm !== null ? [new WebAssembly.Module(b.wasm)] : []))
    : null;
  modulesCache.set(f.text, out);
  return out;
}
const asStored = (effects: readonly Effect[]): Effect[] => {
  const back: unknown = JSON.parse(JSON.stringify(effects));
  return Array.isArray(back) ? back.filter(isEffect) : [];
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex').slice(0, 120);
/** every build's replay of a run against what it answered: null when they all give it */
function replayed(f: File, bytes: Uint8Array, effects: readonly Effect[], out: Uint8Array): string | null {
  const ms = modulesOf(f);
  if (!ms) return null;
  const stored = asStored(effects);
  for (const [i, m] of ms.entries()) {
    let got: Uint8Array;
    try {
      got = replay(m, bytes, stored);
    } catch (e) {
      return `${BUILDS[i]?.[0]} replay of ${hex(bytes)}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    }
    if (Buffer.compare(Buffer.from(got), Buffer.from(out)) !== 0)
      return `${BUILDS[i]?.[0]} replay of ${hex(bytes)} answered ${JSON.stringify(Buffer.from(got).toString('latin1').slice(0, 160))}, live ${JSON.stringify(Buffer.from(out).toString('latin1').slice(0, 160))}`;
  }
  return null;
}

type Run = Observed & { prog: string };
async function simRuns(files: File[], seed: number): Promise<Run[]> {
  let a;
  try {
    a = auto(files, { clients: 3, ops: 8 });
  } catch {
    return [];
  }
  if (a.errors) return [];
  const runs: Run[] = [];
  const observe = (prog: string, r: Observed): void => {
    if (r.method === null && runs.length < 400) runs.push({ prog, ...r });
  };
  const model: Model = { ...a.model, observe, duplicates: false };
  await search(model, { runs: 6, from: seed, steps: 60, faults: 2, stopAtFirst: false });
  return runs;
}

const enc = new TextEncoder();
function changed(r: Rng, bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes).toString('latin1');
  const nl = text.indexOf('\n');
  const head = nl < 0 ? text : text.slice(0, nl),
    body = nl < 0 ? '' : text.slice(nl + 1);
  const pieces = [
    '﻿',
    'é',
    '\u{1F600}',
    ' ',
    '\u0000',
    '9007199254740993',
    '-0',
    '1e400',
    '"',
    '\\',
    '\\u0000',
    '\\ud800',
  ];
  const latin = (s: string): string => Buffer.from(enc.encode(s)).toString('latin1');
  let b = body;
  switch (r.int(6)) {
    case 0:
      b = latin('﻿') + b;
      break;
    case 1: {
      // a string value with something put in it
      const q = b.indexOf('"', b.indexOf(':') + 1);
      if (q >= 0) b = b.slice(0, q + 1) + latin(r.one(pieces)) + b.slice(q + 1);
      break;
    }
    case 2: {
      // a number made large or odd
      b = b.replace(
        /:\s*(-?\d+)/,
        `:${r.one(['9007199254740993', '-9007199254740992', '1e3', '2.0', '-0', '1e400', '0.1'])}`,
      );
      break;
    }
    case 3:
      b = b + String.fromCodePoint(r.one([0xff, 0xc0, 0x80, 0xed]));
      break;
    case 4: {
      // a key doubled: the last counts
      const m = /"(\w+)"\s*:\s*("[^"]*"|-?\d+|true|false)/.exec(b);
      if (m) b = b.replace('}', `,${m[0]}}`);
      break;
    }
    default: {
      const at = r.int(head.length + 1);
      return Uint8Array.from(
        Buffer.from(head.slice(0, at) + latin(r.one(pieces)) + head.slice(at) + (nl < 0 ? '' : `\n${b}`), 'latin1'),
      );
    }
  }
  return Uint8Array.from(Buffer.from(`${head}${nl < 0 ? '' : '\n'}${b}`, 'latin1'));
}
/** the program live under node:sqlite, its migrations run */
const live = new Map<string, { app: ReturnType<typeof instantiate>; sql: ReturnType<typeof nodeSql> } | null>();
function liveOf(f: File): { app: ReturnType<typeof instantiate>; sql: ReturnType<typeof nodeSql> } | null {
  const had = live.get(f.name);
  if (had !== undefined) return had;
  const ms = modulesOf(f);
  let out = null;
  // a program that calls others, or that has timers, needs their hosts: only the plain ones are sent to live
  if (ms?.[0] && !/\b(Remote|Remotes|Timer)\b/.test(f.text)) {
    const sql = nodeSql();
    out = { app: instantiate(ms[0], { sql }), sql };
  }
  live.set(f.name, out);
  return out;
}

export async function replayCase(seed: number): Promise<{ runs: number; bad: string | null }> {
  const r = rng(seed);
  const paths = GROUPS[seed % GROUPS.length] ?? [];
  const files = paths.map(fileOf);
  const runs = await simRuns(files, seed);
  let n = 0;
  for (const run of runs) {
    const f = files.find(x => x.name === run.prog);
    if (!f) continue;
    n++;
    const bad = replayed(f, run.bytes, run.effects, run.out);
    if (bad) return { runs: n, bad: `${paths.join(' + ')}: ${bad}` };
  }
  // the same requests, changed, sent live
  for (const run of runs.slice(0, 60)) {
    const f = files.find(x => x.name === run.prog);
    const l = f && liveOf(f);
    if (!f || !l) continue;
    const bytes = changed(r, run.bytes);
    let ran;
    try {
      ran = await l.app.runLogged(bytes, { transaction: g => l.sql.transaction(g) });
    } catch (e) {
      return {
        runs: n,
        bad: `${f.name}: the live run of ${hex(bytes)} threw ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
      };
    }
    n++;
    const bad = replayed(f, bytes, ran.effects, ran.out);
    if (bad) return { runs: n, bad: `${f.name} (changed request): ${bad}` };
  }
  return { runs: n, bad: null };
}

if (import.meta.main) {
  const c = cli();
  let runs = 0,
    bad = 0;
  const start = Date.now();
  for (const seed of seeds(c)) {
    const v = await replayCase(seed);
    runs += v.runs;
    if (v.bad) {
      bad++;
      console.log(`FINDING replay seed=${seed}: ${v.bad}`);
    }
  }
  const s = (Date.now() - start) / 1000;
  console.log(
    `replay: ${runs} runs replayed through ${BUILDS.length} builds, ${bad} findings, ${(runs / s).toFixed(0)} runs/s`,
  );
}
