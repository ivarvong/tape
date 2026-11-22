// proof/sim-transcript.ts: what the simulator's host answers to a fixed list of requests, written down so the
// real service can be asked the same (service/test/sim-fidelity.test.ts, in workerd).
// The simulator runs programs on host.ts over node:sqlite with calls made in one process. The service runs the
// same host.ts source, but over a Durable Object's SQLite, with calls as RPC between objects. This transcript is
// the check that the two agree where they should: 120 requests to apps/tickets with pay, one at a time, every call
// delivered, the clock still. Times in answers differ by nature and are masked on both sides.
//   node proof/sim-transcript.ts            write service/test/fixtures/sim-transcript.json
//   node proof/sim-transcript.ts --check    exit 1 if the file is not what this would write (it has gone stale)
import '../node25.ts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { auto, drive } from '../sim.ts';
const root = new URL('../', import.meta.url).pathname,
  read = (p: string) => readFileSync(root + p, 'utf8');
const files = [
  { name: 'tickets', text: read('apps/tickets/tickets.tape') },
  { name: 'pay', text: read('apps/tickets/pay.tape') },
];
// no anonymous callers (the service decides who is asking by its own token); holds long enough not to expire
const a = auto(files, { clients: 4, ops: 30, anyone: false, fix: { seconds: 3000 } });
if (a.errors) throw new Error(JSON.stringify(a.errors[0]));
let turn = 0;
const r = await drive(
  { ...a.model, repeat: false },
  {
    seed: 11,
    faults: 0,
    choose: acts => {
      const starts = acts.filter(x => x.startsWith('start '));
      return acts.find(x => x.startsWith('deliver ')) ?? (starts.length > 0 ? starts[turn++ % starts.length] : null);
    },
  },
);
if (!r.ok) throw new Error(`the run itself failed: ${r.violations[0]}`);
// a number of 12 digits or more is a time
export const mask = (text: string): string => text.replaceAll(/\b\d{12,}\b/g, '<time>');
const requests = r.world.sent
  .filter(x => !/^GET \/(hold|me|)\n/.test(x.text) && !x.text.startsWith('POST /hold\n'))
  .map(x => {
    const [line = '', ...rest] = x.text.split('\n');
    const [method, path] = line.split(' ');
    return { method, path, body: rest.join('\n'), status: x.status, answer: mask(x.answer ?? '') };
  });
const out =
  JSON.stringify(
    {
      made_by: 'node proof/sim-transcript.ts',
      sources: createHash('sha256')
        .update(files.map(f => f.text).join('\0'))
        .digest('hex')
        .slice(0, 16),
      requests,
    },
    null,
    1,
  ) + '\n';
const path = root + 'service/test/fixtures/sim-transcript.json',
  by: Record<number, number> = {};
for (const q of requests) by[q.status] = (by[q.status] ?? 0) + 1;
if (process.argv.includes('--check')) {
  const same = existsSync(path) && readFileSync(path, 'utf8') === out;
  console.log(
    same
      ? `the transcript is current: ${requests.length} requests`
      : 'STALE: service/test/fixtures/sim-transcript.json is not what the programs now answer; run node proof/sim-transcript.ts and the service suite',
  );
  process.exit(same ? 0 : 1);
}
writeFileSync(path, out);
console.log(
  `${requests.length} requests written; answered ${Object.entries(by)
    .map(([s, n]) => `${s}: ${n}`)
    .join(', ')}`,
);
