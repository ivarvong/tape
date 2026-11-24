// bench/suite/check.ts: the same answers. Every generated input of each workload is answered, in order, by the JS
// twin and by the Tape program with the effect log on and off, each on a fresh database of its own; the three
// answers must be byte for byte the same. Exit 1 if any differ.
//   node bench/suite/check.ts [workload …]
import { dec, makeWay, tapeModule } from './common.ts';
import type { Mode } from './common.ts';
import { NAMES, load } from './workloads.ts';

const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [...NAMES];
const MODES: readonly Mode[] = ['js', 'tape-log', 'tape-nolog'];
let bad = 0;
for (const name of names) {
  const w = await load(name);
  if (w.twin === false) {
    console.log(`${name}: no JS twin, skipped`);
    continue;
  }
  const module = tapeModule(w.tape);
  const inputs = w.inputs();
  const answers: Record<Mode, string[]> = { js: [], 'tape-log': [], 'tape-nolog': [] };
  for (const mode of MODES) {
    const run = makeWay(w, mode, module);
    for (const b of inputs) {
      try {
        answers[mode].push(dec.decode(await run(b)));
      } catch (e) {
        answers[mode].push(`THREW ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  const differ = inputs.flatMap((b, i) => {
    const want = answers.js[i];
    const off = (['tape-log', 'tape-nolog'] as const).filter(m => answers[m][i] !== want);
    return off.length === 0
      ? []
      : [
          `  #${i} ${JSON.stringify(dec.decode(b.subarray(0, 120)))}\n    js   ${want?.slice(0, 300)}\n    tape ${answers[off[0] ?? 'tape-log'][i]?.slice(0, 300)}`,
        ];
  });
  bad += differ.length;
  console.log(`${name}: ${inputs.length} inputs, ${differ.length} differ`);
  for (const d of differ.slice(0, 4)) console.log(d);
}
process.exit(bad > 0 ? 1 : 0);
