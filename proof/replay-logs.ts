// proof/replay-logs.ts: real traffic as a test. Give it a program's source and effect logs downloaded from the
// service (GET /:account/:name/log/:version/:id, each a JSON file { id, at, request, effects }), and it replays
// every request, with no database and no network, through three builds of that source: the default one, the one
// that never releases memory (which defines what the program means), and the checked one (which traps on any
// touch of released memory). A request passes when all three finish from the log alone and give the same bytes.
//   node proof/replay-logs.ts program.tape logs/            (a directory of *.json, or the files themselves)
// The source must be compiled by the same compiler and standard library that made the logs: each log names its
// build, and a log from another build is reported, not replayed. Check out the deployed commit to replay it.
// What this cannot show: that production answered with these bytes. The log does not hold the response.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { isEffect, isHead, replay } from '../host.ts';
import type { Effect, Head } from '../host.ts';
import { std } from '../std.ts';
const BUILDS: readonly (readonly [string, Partial<Options>])[] = [
  ['default', {}],
  ['never releases', { reuse: false }],
  ['checked', { check: true }],
];
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A stored log: the request as text or bytes, and what the run did. */
export type Log = { id: string | null; request: string | number[]; effects: Effect[] };
const field = (v: unknown, name: string): unknown =>
  typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v))[name] : undefined;
const bytesIn = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : []);
/** A log as it was stored (JSON): the request is text, bytes, or { bytes }. */
export function logOf(stored: unknown): Log {
  const id = field(stored, 'id');
  const request = field(stored, 'request');
  const effects = field(stored, 'effects');
  return {
    id: typeof id === 'string' ? id : null,
    request: typeof request === 'string' ? request : bytesIn(field(request, 'bytes') ?? request),
    effects: Array.isArray(effects) ? effects.filter(isEffect) : [],
  };
}
/** The bytes the request was: a method's log holds the message it was sent. */
function requestOf(log: Log, head: Head): Uint8Array {
  if (typeof log.request !== 'string') return Uint8Array.from(log.request);
  return enc.encode(head.method !== undefined && typeof head.message === 'string' ? head.message : log.request);
}
const replayed = (module: WebAssembly.Module, bytes: Uint8Array, effects: Effect[]): string => {
  try {
    return dec.decode(replay(module, bytes, effects));
  } catch (e) {
    return `ERROR ${e instanceof Error ? e.message : String(e)}`;
  }
};

export type Replayed = {
  build: string;
  logs: number;
  replayed: number;
  agreed: number;
  otherBuild: number;
  notRequests: number;
  firstOther?: string;
  failed: { id: string | null; results: string[] }[];
};
export function replayLogs(source: string, logs: readonly Log[]): Replayed {
  // named as the service names them
  const built = BUILDS.map(([, o]) => compile([...std, { name: 'program.tape', text: source }], o));
  const modules = built.flatMap(b => (b.wasm === null ? [] : [new WebAssembly.Module(b.wasm)]));
  const [first] = built;
  if (!first || first.wasm === null) throw new Error(`the source does not compile here: ${first?.errors[0]?.message}`);
  const out: Replayed = {
    build: first.build,
    logs: logs.length,
    replayed: 0,
    agreed: 0,
    otherBuild: 0,
    notRequests: 0,
    failed: [],
  };
  for (const log of logs) {
    const [head] = log.effects;
    // a migration run or an upload check
    if (!head || !isHead(head)) out.notRequests++;
    else if (head.build === out.build) {
      const bytes = requestOf(log, head);
      const got = modules.map(m => replayed(m, bytes, log.effects));
      out.replayed++;
      if (got.every(g => g === got[0] && !g.startsWith('ERROR'))) out.agreed++;
      else out.failed.push({ id: log.id, results: got.map((g, i) => `${BUILDS[i]?.[0]}: ${g.slice(0, 120)}`) });
    } else {
      out.otherBuild++;
      out.firstOther ??= head.build;
    }
  }
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [sourcePath, ...where] = process.argv.slice(2);
  if (sourcePath === undefined || where.length === 0) {
    console.error('usage: node proof/replay-logs.ts program.tape <log.json | directory>...');
    process.exit(2);
  }
  const files = where.flatMap(w =>
    statSync(w).isDirectory()
      ? readdirSync(w)
          .filter(f => f.endsWith('.json'))
          .map(f => join(w, f))
      : [w],
  );
  const r = replayLogs(
    readFileSync(sourcePath, 'utf8'),
    files.map(f => logOf(JSON.parse(readFileSync(f, 'utf8')))),
  );
  console.log(
    `build ${r.build}: ${r.logs} logs; ${r.replayed} replayed, ${r.agreed} agree across ${BUILDS.length} builds; ${r.otherBuild} from another build${r.firstOther ? ` (${r.firstOther})` : ''}; ${r.notRequests} not requests`,
  );
  for (const f of r.failed.slice(0, 5)) console.log(`FAIL ${f.id}\n  ${f.results.join('\n  ')}`);
  process.exit(r.failed.length > 0 || (r.otherBuild > 0 && r.replayed === 0) ? 1 : 0);
}
