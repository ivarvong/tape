// fuzz/run.ts: what a campaign shares: the command line, a clock, and a way to run a module with no host.
//   --seconds <n>   how long to run (default 10)
//   --seed <n>      the first seed (default 1); seeds go up by --stride from it
//   --shard i/n     run seeds seed+i, seed+i+n, …; the campaigns are sharded across processes by fuzz/campaign.ts
//   --count <n>     stop after n cases, whatever the time (the gate's fixed slice)
//   --only <seed>   run that one seed and print what it made and what each side gave
import '../node25.ts';
import { floatOfBytes, frameAt } from '../host/memory.ts';
import { responseOf } from '../host.ts';

export type Cli = {
  seconds: number;
  seed: number;
  shard: number;
  shards: number;
  count: number;
  only: number | null;
  verbose: boolean;
};
export function cli(argv = process.argv.slice(2)): Cli {
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  const [shard = 0, shards = 1] = (val('--shard') ?? '0/1').split('/').map(Number);
  const only = val('--only');
  return {
    seconds: Number(val('--seconds') ?? 10),
    seed: Number(val('--seed') ?? 1),
    shard,
    shards,
    count: Number(val('--count') ?? Infinity),
    only: only === undefined ? null : Number(only),
    verbose: argv.includes('--verbose'),
  };
}
/** The seeds of this shard, until the time or the count runs out. */
export function* seeds(c: Cli): Generator<number> {
  if (c.only !== null) {
    yield c.only;
    return;
  }
  const end = Date.now() + c.seconds * 1000,
    progress = process.argv.includes('--progress');
  for (let i = 0; i < c.count && Date.now() < end; i++) {
    const seed = c.seed + c.shard + i * c.shards;
    // for fuzz/campaign.ts, which takes a shard that says nothing for a long time as hung on its last seed
    if (progress) console.log(`at ${seed}`);
    yield seed;
  }
}

/** A module instantiated with stand-ins for every import the host gives: the Float text functions as the host has
 * them, the rest doing nothing. */
export type Run = {
  fns: Record<string, (...a: (number | bigint)[]) => unknown>;
  memory: WebAssembly.Memory;
  global: (n: string) => bigint;
};
export function instance(module: WebAssembly.Module): Run {
  const late: { memory: WebAssembly.Memory | null; alloc: ((n: number) => unknown) | null } = {
    memory: null,
    alloc: null,
  };
  const env: Record<string, (...a: number[]) => unknown> = {
    float_text: (x: number): number => {
      const b = new TextEncoder().encode(String(x));
      const at = Number(late.alloc?.(4 + b.length) ?? 0);
      const buf = late.memory?.buffer ?? new ArrayBuffer(0);
      new DataView(buf).setUint32(at, b.length, true);
      new Uint8Array(buf, at + 4, b.length).set(b);
      return at;
    },
    float_of: (ptr: number, len: number): number =>
      floatOfBytes(new Uint8Array(late.memory?.buffer ?? new ArrayBuffer(0), ptr, len)),
  };
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const i of WebAssembly.Module.imports(module)) {
    if (i.kind !== 'function') throw new Error(`the module imports a ${i.kind} ${i.module}.${i.name}`);
    (imports[i.module] ??= {})[i.name] = env[i.name] ?? ((): void => {});
  }
  const { exports } = new WebAssembly.Instance(module, imports);
  const fns: Run['fns'] = {};
  let memory: WebAssembly.Memory | null = null;
  const globals = new Map<string, WebAssembly.Global>();
  for (const [n, v] of Object.entries(exports)) {
    if (v instanceof WebAssembly.Memory) memory = v;
    else if (v instanceof WebAssembly.Global) globals.set(n, v);
    else if (typeof v === 'function') fns[n] = (...a: (number | bigint)[]): unknown => Reflect.apply(v, null, a);
  }
  if (!memory) throw new Error('no memory');
  late.memory = memory;
  late.alloc = fns['alloc'] ?? null;
  const global = (n: string): bigint => {
    const v: unknown = globals.get(n)?.value;
    return typeof v === 'bigint' ? v : BigInt(Number(v ?? 0));
  };
  return { fns, memory, global };
}
/**
 * What handled() gave for a handle that answers 200 with its bytes as the body (the fuzzers' programs do): the body,
 * as latin1 text; a trap, an engine's stop, or an answer of another status as it is (the status and the body).
 */
export function bodyOf(out: string): string {
  if (!out.startsWith('\0tap')) return out;
  const a = responseOf(Buffer.from(out, 'latin1'));
  const body = Buffer.from(a.body).toString('latin1');
  return a.status === 200 ? body : `${a.status}\n${body}`;
}
/** handle on these bytes: its answer or its trap, then the steps it took and the memory it used. */
export function handled(r: Run, input: Uint8Array, entry = 'handle'): { out: string; steps: bigint; bytes: bigint } {
  r.fns['reset']?.();
  const floor = r.global('heap');
  let out: string;
  try {
    const at = Number(r.fns['alloc']?.(input.length));
    new Uint8Array(r.memory.buffer, at, input.length).set(input);
    const h = Number(r.fns[entry]?.(at, input.length));
    // handle's answer is its head and where its body lies (host/memory.ts frameAt); another export's is its bytes
    const d = new DataView(r.memory.buffer);
    const bytes =
      entry === 'handle'
        ? frameAt(r, h)
        : new Uint8Array(r.memory.buffer, d.getUint32(h, true), d.getUint32(h + 4, true));
    out = Buffer.from(bytes).toString('latin1');
  } catch (e) {
    const why = r.global('why');
    // a trap the module raised has its code; anything else (the engine's own stack) is shown as the engine says
    out = why ? `trap ${why}` : `engine ${e instanceof Error ? e.constructor.name + ': ' + e.message : String(e)}`;
  }
  return { out, steps: r.global('cost'), bytes: r.global('heap') - floor };
}
