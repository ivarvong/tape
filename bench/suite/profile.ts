// bench/suite/profile.ts: a V8 CPU profile of one workload and way (one.ts with TAPE_PROFILE: the timed requests
// only, sampled every 50 µs),
// summarised: self time by function, and by bucket (Wasm code, the host's files, node:sqlite, JSON, GC, the rest).
//   node bench/suite/profile.ts <workload> <js|tape-log|tape-nolog> [scale] [samples] [-- extra V8 flags]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
type Profile = { nodes: Node[]; samples: number[]; timeDeltas: number[] };

const [name = 'webhook', mode = 'tape-nolog', scale = '1', samples = '30', ...rest] = process.argv.slice(2);
const extra = rest[0] === '--' ? rest.slice(1) : rest;
const file = `${mkdtempSync(`${tmpdir()}/tape-prof-`)}/${name}-${mode}.cpuprofile`;
execFileSync(
  process.execPath,
  ['--no-warnings', ...extra, new URL('./one.ts', import.meta.url).pathname, name, mode, 'warm', scale, samples],
  { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TAPE_PROFILE: file } },
);
const isProfile = (x: unknown): x is Profile =>
  typeof x === 'object' &&
  x !== null &&
  'nodes' in x &&
  Array.isArray(x.nodes) &&
  'samples' in x &&
  Array.isArray(x.samples) &&
  'timeDeltas' in x &&
  Array.isArray(x.timeDeltas);
const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
if (!isProfile(parsed)) throw new Error(`${file}: not a V8 CPU profile`);
const p = parsed;
const byId = new Map(p.nodes.map(n => [n.id, n]));
const self = new Map<number, number>();
for (const [i, id] of p.samples.entries()) self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0));
const total = [...self.values()].reduce((a, b) => a + b, 0);

/** Which bucket a frame's self time belongs to. */
function bucket(n: Node): string {
  const { functionName: f, url } = n.callFrame;
  if (url.startsWith('wasm://')) return 'wasm';
  if (f === '(garbage collector)') return 'gc';
  if (f === '(idle)' || f === '(program)') return f;
  if (/JSON|stringify|parse/i.test(f) && !url.includes('/bench/')) return 'JSON (native)';
  if (url.includes('/host/memory.ts')) return 'host/memory.ts';
  if (url.includes('/host/run.ts')) return 'host/run.ts';
  if (url.includes('/host/log.ts')) return 'host/log.ts';
  if (url.includes('/nodesql.ts')) return 'nodesql.ts (stand-in)';
  if (url.includes('/bench/')) return 'bench (the JS twin, or the harness)';
  if (url === '' && /run|all|get|prepare|exec|iterate|columns/.test(f)) return 'node:sqlite (native)';
  if (url === '' && /decode|encode|Encod|Decod/.test(f)) return 'TextEncoder/Decoder (native)';
  if (url.startsWith('node:')) return 'node internals';
  return url === '' ? `native: ${f || '(anonymous)'}` : `other: ${url.replace(/^.*\//, '')}`;
}
const buckets = new Map<string, number>();
const fns = new Map<string, number>();
for (const [id, us] of self) {
  const n = byId.get(id);
  if (!n) continue;
  const b = bucket(n);
  buckets.set(b, (buckets.get(b) ?? 0) + us);
  const k = `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.replace(/^.*\//, '')}:${n.callFrame.lineNumber + 1}`;
  fns.set(k, (fns.get(k) ?? 0) + us);
}
const pct = (us: number): string => `${((us / total) * 100).toFixed(1).padStart(5)}%`;
console.log(
  `${name} ${mode} scale ${scale}, ${samples} requests after 10 warm-up ${(total / 1000).toFixed(0)} ms sampled${extra.length > 0 ? `, flags ${extra.join(' ')}` : ''}`,
);
console.log('by bucket (self time):');
for (const [b, us] of [...buckets].toSorted((x, y) => y[1] - x[1]).slice(0, 14)) console.log(`  ${pct(us)}  ${b}`);
console.log('top functions (self time):');
for (const [f, us] of [...fns].toSorted((x, y) => y[1] - x[1]).slice(0, 25)) console.log(`  ${pct(us)}  ${f}`);
console.log(`profile: ${file}`);
