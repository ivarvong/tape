// bench/suite/check.ts: the same answers. Every generated input of each workload is answered, in order, by the JS
// twin and by the Tape program with the effect log on and off, each on a fresh database of its own; the three
// answers must be the same, byte for byte. A program's answer is a frame (host.ts responseOf). A twin of a program
// that answers requests writes `STATUS[ TYPE] LF BODY`, and the status and the body are compared; a twin of a pure
// workload (pure.ts: csv, words, trace) writes the body alone, as its bench does, and only the body is compared.
// Exit 1 if any differ.
//   node bench/suite/check.ts [workload …]
import { responseOf } from '../../host.ts';
import { dec, makeWay, tapeModule } from './common.ts';
import type { Mode } from './common.ts';
import { NAMES, load } from './workloads.ts';

const HEAD = /^[1-5][0-9][0-9]( [a-z+/]+)?$/;
/** A twin's answer: its status when it writes a head, and its body. */
const twinOf = (text: string): { status: string | null; body: string } => {
  const nl = text.indexOf('\n'),
    head = nl < 0 ? '' : text.slice(0, nl);
  return HEAD.test(head)
    ? { status: head.split(' ')[0] ?? '', body: text.slice(nl + 1) }
    : { status: null, body: text };
};
/** What is compared: `STATUS LF BODY`, or the body alone when the twin wrote no status. */
const compared = (status: string | null, body: string): string => (status === null ? body : `${status}\n${body}`);
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
  // per input, whether the twin wrote no status (MODES runs js first)
  const headless: boolean[] = [];
  for (const mode of MODES) {
    const run = makeWay(w, mode, module);
    for (const b of inputs) {
      try {
        const out = await run(b);
        if (mode === 'js') {
          const t = twinOf(dec.decode(out));
          headless.push(t.status === null);
          answers.js.push(compared(t.status, t.body));
        } else {
          const a = responseOf(out),
            alone = headless[answers[mode].length] ?? false;
          answers[mode].push(compared(alone ? null : String(a.status), dec.decode(a.body)));
        }
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
console.log(`${names.length} workloads, ${bad} differ`);
process.exit(bad > 0 ? 1 : 0);
