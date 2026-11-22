// proof/same-behaviour.ts: is a rewritten program the same program? The old text and the new are each simulated
// with the same seeds. The simulator makes its requests from the routes (which must be the same) and from the
// answers so far, so the first answer that differs makes the two logs differ, and that line is printed.
//   node proof/same-behaviour.ts old.tape new.tape [other.tape …] [--old-others dir] [--runs 60]
// The others are the programs it calls; with --old-others, the old text runs beside dir/<name>.tape where there is
// one (for programs rewritten together).
import '../node25.ts';
import { existsSync, readFileSync } from 'node:fs';
import { auto, drive, rng } from '../sim.ts';
import { arg } from './lib.ts';

const paths = process.argv.slice(2).filter((a, i, all) => a.endsWith('.tape') && !all[i - 1]?.startsWith('--'));
const [oldPath, newPath, ...others] = paths;
if (oldPath === undefined || newPath === undefined) {
  console.error('node proof/same-behaviour.ts old.tape new.tape [other.tape …] [--old-others dir] [--runs 60]');
  process.exit(2);
}
const runs = Number(arg('runs', '60'));
const oldOthers = arg('old-others', '');
const nameOf = (path: string): string => (path.split('/').pop() ?? '').replace(/\.tape$/, '');
const text = (path: string): string => readFileSync(path, 'utf8');
const asItWas = (path: string): string =>
  oldOthers !== '' && existsSync(`${oldOthers}/${nameOf(path)}.tape`) ? `${oldOthers}/${nameOf(path)}.tape` : path;

type Seen = { routes: string; log: string[] };
// the logs of `runs` seeded runs of one text beside the other programs
async function logsOf(name: string, program: string, beside: readonly string[]): Promise<Seen[]> {
  const files = [{ name, text: program }, ...beside.map(path => ({ name: nameOf(path), text: text(path) }))];
  const out: Seen[] = [];
  for (let seed = 1; seed <= runs; seed++) {
    const model = auto(files, { clients: 4, ops: 10 });
    if (model.errors)
      throw new Error(model.errors.map(e => `${e.program}:${e.line} ${e.code} ${e.message}`).join('\n'));
    const rand = rng(seed * 7919);
    const choose = (enabled: string[], _world: unknown, script: readonly string[]): string | null | undefined =>
      script.length >= 100 || enabled.length === 0 ? null : enabled[Math.floor(rand() * enabled.length)];
    const run = await drive(model.model, { seed, faults: 3, choose });
    out.push({
      routes: model.routes.map(route => route.key + (route.body ?? '')).join(' | '),
      log: run.log.map(line => JSON.stringify([line.what, line.detail])),
    });
  }
  return out;
}

/** Where the two differ first, or how many log lines are the same. */
function compared(was: readonly Seen[], now: readonly Seen[]): { different: string } | { lines: number } {
  let lines = 0;
  for (const [i, before] of was.entries()) {
    const after = now[i] ?? { routes: '', log: [] };
    if (before.routes !== after.routes)
      return { different: `DIFFERENT routes\n  was ${before.routes}\n  now ${after.routes}` };
    const length = Math.max(before.log.length, after.log.length);
    const j = Array.from({ length }, (_, k) => k).find(k => before.log[k] !== after.log[k]);
    if (j !== undefined)
      return { different: `DIFFERENT at seed ${i + 1}, line ${j}\n  was ${before.log[j]}\n  now ${after.log[j]}` };
    lines += length;
  }
  return { lines };
}

const was = await logsOf(nameOf(newPath), text(oldPath), others.map(asItWas));
const now = await logsOf(nameOf(newPath), text(newPath), others);
const result = compared(was, now);
if ('different' in result) {
  console.log(result.different);
  process.exit(1);
}
console.log(`the same: ${runs} runs, ${result.lines} log lines`);
