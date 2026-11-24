// fuzz/programs.ts: the program differential. Each seed is a generated program (fuzz/gen.ts) and a few inputs; the
// reference interpreter says what each input means, and every build must give it: the same answer or the same
// trap. Between the builds the steps taken and the memory used must agree too (the interpreter counts neither).
//   node fuzz/programs.ts --seconds 60 [--seed 1] [--shard 0/8] [--only <seed>] [--budget]
// --budget also builds each program with a small step budget, so runs stop on steps (trap 2) at the same place.
// Prints one line per finding (`FINDING programs seed=<n> …`) and a last line `programs: <n> programs, …`.
// The engine's tiers are compared by fuzz/campaign.ts, which runs the same seeds under --liftoff-only and
// --no-liftoff and compares the digests this prints with --digest.
import { createHash } from 'node:crypto';
import { compileAlso } from '../compiler.ts';
import type { Options, Source } from '../compiler.ts';
import { interpret, Trap, Unsupported } from '../interp.ts';
import { std } from '../std.ts';
import { parts } from './gen.ts';
import { cli, handled, instance, seeds } from './run.ts';
import type { Run } from './run.ts';
import { rng } from './rng.ts';

export const BUILDS: readonly (readonly [string, Partial<Options>])[] = [
  ['plain', {}],
  ['traced', { trace: true }],
  ['inline off', { inline: false, localSteps: false }],
  ['reuse off', { reuse: false }],
  ['checked', { check: true }],
  ['no owning copies', { owningCopies: false }],
];
// the builds whose memory use must be the plain build's: the others release less (reuse off, no owning copies) or
// keep released memory aside (checked)
const SAME_BYTES = new Set(['plain', 'traced', 'inline off']);
const enc = new TextEncoder();
const INPUTS = [
  '',
  'hello',
  '12',
  '-3.75',
  'a=1&k=v',
  'thé 日本',
  '{"a":1,"b":"x"}',
  '9223372036854775807',
  ' 1e3 ',
  '\u0000ÿ',
];
export function inputsOf(seed: number): Uint8Array[] {
  const r = rng(seed ^ 0x5eed);
  const out = [enc.encode(r.one(INPUTS)), enc.encode(r.one(INPUTS))];
  const bytes = Uint8Array.from({ length: r.int(12) }, () => r.int(256));
  out.push(bytes);
  return out;
}

/** how often each trap was seen, for the coverage line */
export const TRAPS = new Map<string, number>();
export type Verdict = {
  kind: 'ok' | 'refused' | 'differs' | 'crash' | 'unsupported';
  detail: string;
  digest: string;
  traps: number;
};
const lat = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

/** One program: every build against the interpreter, on its inputs. */
export function check(text: string, inputs: Uint8Array[], extra: Partial<Options> = {}, entries = ['handle']): Verdict {
  const sources: Source[] = [...std, { name: 'gen.tape', text }];
  const fail = (kind: Verdict['kind'], detail: string, traps = 0): Verdict => ({ kind, detail, digest: '', traps });
  // one parse and one set of checks for every build (compiler/build.ts builds; test/builds.ts holds it to separate
  // compiles)
  let made;
  try {
    // a step budget of 500,000 unless one is given: a run past it is compared between the builds alone
    const opts = { reductionLimit: 500_000, ...extra, exports: entries };
    made = compileAlso(
      sources,
      opts,
      BUILDS.slice(1).map(([, o]) => ({ ...o, ...opts })),
    );
  } catch (e) {
    return fail('crash', `compiler threw: ${e instanceof Error ? e.stack : String(e)}`);
  }
  if (!Array.isArray(made)) {
    const [e] = made.errors;
    return fail('refused', `${e?.code} line ${e?.line}: ${e?.message}`);
  }
  const runs: [string, Run][] = [];
  for (const [i, b] of made.entries()) {
    const name = BUILDS[i]?.[0] ?? '?';
    try {
      runs.push([name, instance(new WebAssembly.Module(b.wasm))]);
    } catch (e) {
      return fail('crash', `WebAssembly refused build ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // the interpreter weighs recursion as the build does, so it stops where the build stops (trap 9)
  const it = interpret(sources, null, made[0].levels);
  const hash = createHash('sha256');
  let traps = 0;
  for (const entry of entries)
    for (const input of inputs) {
      const got = runs.map(([name, r]) => [name, handled(r, input, entry)] as const);
      // a run the builds stopped on steps is one the interpreter, which counts none, would run to its end, at a
      // thousandth of the speed: it is not asked (the builds are still held to each other)
      let want: string | null = null;
      if (!got.some(([, g]) => g.out === 'trap 2'))
        try {
          const out = it.call(entry, [input]);
          want = out instanceof Uint8Array ? lat(out) : `not bytes: ${typeof out}`;
        } catch (e) {
          if (e instanceof Trap) want = `trap ${e.code}`;
          else if (e instanceof Unsupported) return fail('unsupported', e.message, traps);
          // the interpreter's own stack: no meaning to compare; the builds must still agree with each other
          else if (e instanceof RangeError && e.message.includes('call stack')) want = null;
          else return fail('crash', `interpreter threw: ${e instanceof Error ? e.stack : String(e)}`, traps);
        }
      const [, first] = got[0] ?? [];
      if (!first) throw new Error('no builds');
      if (first.out.startsWith('trap')) {
        traps++;
        TRAPS.set(first.out, (TRAPS.get(first.out) ?? 0) + 1);
      }
      // the depth budget (trap 9) stops a run well before the engine's own stack ends (LANGUAGE.md section 10), so a
      // run the engine stopped is a finding; a run stopped on steps (trap 2) is one the interpreter, which counts
      // none, cannot say
      const stopped = got.find(([, g]) => g.out.startsWith('engine'));
      if (stopped)
        return fail(
          'differs',
          `${entry} on ${JSON.stringify(lat(input))}: ${stopped[0]} ${stopped[1].out.slice(0, 200)}`,
          traps,
        );
      const engine = false;
      const steps = got.some(([, g]) => g.out === 'trap 2');
      for (const [name, g] of got) {
        if (want !== null && !engine && !steps && g.out !== want)
          return fail(
            'differs',
            `${entry} on ${JSON.stringify(lat(input))}: interpreter ${JSON.stringify(want.slice(0, 300))}, ${name} ${JSON.stringify(g.out.slice(0, 300))}`,
            traps,
          );
        if (
          !engine &&
          (g.steps !== first.steps || (g.bytes !== first.bytes && SAME_BYTES.has(name)) || g.out !== first.out)
        )
          return fail(
            'differs',
            `${entry} on ${JSON.stringify(lat(input))}: plain ${JSON.stringify(first.out.slice(0, 200))} steps ${first.steps} bytes ${first.bytes}, ${name} ${JSON.stringify(g.out.slice(0, 200))} steps ${g.steps} bytes ${g.bytes}`,
            traps,
          );
      }
      hash.update(`${first.out}\u0000${first.steps}\u0000${first.bytes}\u0001`);
    }
  return { kind: 'ok', detail: '', digest: hash.digest('hex').slice(0, 16), traps };
}

if (import.meta.main) {
  const c = cli(),
    budget = process.argv.includes('--budget'),
    digest = process.argv.includes('--digest');
  const count = { ok: 0, refused: 0, differs: 0, crash: 0, unsupported: 0 };
  let traps = 0,
    runs = 0;
  const start = Date.now();
  for (const seed of seeds(c)) {
    const { text, entries } = parts(seed, 1 + (seed % 3));
    const inputs = inputsOf(seed);
    const v = check(text, inputs, budget ? { reductionLimit: 50 + (seed % 400) } : {}, entries);
    count[v.kind]++;
    traps += v.traps;
    runs += inputs.length * entries.length;
    if (c.only !== null) console.log(text);
    if (v.kind !== 'ok' && (v.kind !== 'unsupported' || c.verbose))
      console.log(
        `FINDING programs seed=${seed}${budget ? ' --budget' : ''} ${v.kind}: ${v.detail.replaceAll('\n', '\\n')}`,
      );
    if (digest && v.kind === 'ok') console.log(`digest ${seed} ${v.digest}`);
  }
  const s = (Date.now() - start) / 1000;
  console.log(
    `programs: ${count.ok + count.refused + count.differs + count.crash + count.unsupported} programs, ${count.ok} agree (${runs} runs, ${traps} traps: ${[
      ...TRAPS,
    ]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${k.slice(5)}:${n}`)
      .join(
        ' ',
      )}), ${count.refused} refused, ${count.differs} differ, ${count.crash} crash, ${count.unsupported} unsupported, ${((count.ok + count.refused + count.differs + count.crash) / s).toFixed(1)} programs/s`,
  );
}
