// The simulator (sim.ts) on the box office (apps/tickets): the program as written passes; the two bugs the
// production fault runs found are found here from random seeds, with the rules off, and again by trying every
// script of a small workload; a script replays to the same run.
import { drive, exhaust, explore, replay, shrink } from '../sim.ts';
import type { Model, Op, Outcome } from '../sim/engine.ts';
import type { Json } from '../sim/values.ts';
import { model } from '../apps/tickets/sim.ts';
import { plants } from '../apps/tickets/plants.ts';
import { usesStripped, usesWritten } from '../fmt.ts';
import { finish, ok, problems, read, std } from './harness.ts';
import { autoOf, builtFor, wrongIn } from './simulated.ts';

const source = read('apps/tickets/tickets.tape');
// a plant is made to the program without its `uses` clauses, which are written again after it, as fmt would
const planted = (words: string): string =>
  usesWritten(
    (plants.find(x => x.name.includes(words))?.pairs ?? []).reduce(
      (t, [a, b]) => t.replace(a, b),
      usesStripped(source),
    ),
    'tickets.tape',
    std,
  );
const refusedIn = (text: string): string[] => problems(text).map(e => e.code);

const good = builtFor(source);
ok('tickets.tape builds', true);
const clean = await explore(model(good.module), { seeds: 150 });
ok('as written: 150 seeds, nothing wrong', clean.ok, clean.ok ? `${clean.actions} choices` : wrongIn(clean));

const FOUND: readonly (readonly [string, RegExp])[] = [
  ['a decline without its expiry timer', /hold \d+ is left held with no timer/],
  ['a refund without its retry timer', /refunding|asks again for ever/],
];
const logOf = (a: Outcome): string => a.log.map(e => `${e.at} ${e.what} ${e.detail}`).join('\n');
for (const [words, want] of FOUND) {
  const strict = refusedIn(planted(words));
  const loose = builtFor(planted(words), { rules: false });
  ok(`${words}: the rules refuse it`, strict.length > 0, strict.join(','));
  const r = await explore(model(loose.module), { seeds: 200 });
  const [first] = r.failures;
  ok(
    `${words}: the simulator finds it with the rules off`,
    first?.kind === 'liveness',
    first ? `seed ${first.seed}` : 'not found in 200 seeds',
  );
  if (!first) continue;
  const small = await shrink(model(loose.module), first, { budget: 120 });
  ok(
    `${words}: shrunk and still failing`,
    small.script.length <= first.script.length && want.test(small.violations.join(' ')),
    `${first.script.length} -> ${small.script.length} choices: ${small.violations[0]}`,
  );
  const again = await replay(model(loose.module), small.script, { seed: small.seed });
  ok(`${words}: the script replays to the same run`, !again.ok && logOf(again) === logOf(small));
  const fixed = await replay(model(good.module), small.script, { seed: small.seed });
  ok(`${words}: the same script passes on the program as written`, fixed.ok, fixed.ok ? '' : fixed.violations[0]);
}

// randomness is the simulator's: a program that answers with what it drew gives the same answer for the same seed
{
  const lots = builtFor(
    `fn handle(raw: View, dice: Entropy) -> Response {\n  buf() |> write_int(value: random(from: dice)) |> respond(status: 200)\n}\n`,
  );
  const draw = {
    modules: { lots: lots.module },
    entry: 'lots',
    clients: () => [
      [
        { name: 'draw', make: () => ({ line: 'GET /' }) },
        { name: 'draw', make: () => ({ line: 'GET /' }) },
      ],
    ],
  };
  const said = (r: Outcome): string =>
    r.log
      .filter(e => /answered/.test(e.what))
      .map(e => e.detail)
      .join(' | ');
  const a1 = await replay(draw, ['start c0', 'start c0'], { seed: 5 }),
    a2 = await replay(draw, ['start c0', 'start c0'], { seed: 5 }),
    b1 = await replay(draw, ['start c0', 'start c0'], { seed: 6 });
  ok(
    'the same seed draws the same numbers, another seed others',
    said(a1) === said(a2) && said(a1) !== said(b1) && said(a1).split(' | ')[0] !== said(a1).split(' | ')[1],
    said(a1),
  );
}

// Every script: one buyer holds a seat, pays, and is refunded; at most one fault, eleven choices deep.
const one = (module: WebAssembly.Module): Model => ({
  ...model(module),
  clients: () => [
    [
      {
        name: 'hold',
        make: () => ({ line: 'POST /holds', body: { key: 'k', tier: 3, buyer: 'ann', qty: 1, seconds: 5 } }),
        then: (mem, res) => {
          mem['hold'] = typeof res.json === 'object' && res.json !== null && 'id' in res.json ? res.json.id : undefined;
        },
      },
      {
        name: 'checkout',
        make: mem =>
          typeof mem['hold'] === 'number'
            ? { line: `POST /holds/${mem['hold']}/checkout`, body: { card: 'visa-4242' } }
            : null,
      },
      {
        name: 'refund',
        make: mem => (typeof mem['hold'] === 'number' ? { line: `POST /holds/${mem['hold']}/refund` } : null),
      },
    ],
  ],
});
const all = await exhaust(one(good.module), { depth: 11, faults: 1 });
ok(
  'every script of hold, pay, refund (one fault, depth 11) passes as written',
  all.ok && all.complete,
  `${all.ran} scripts${all.ok ? '' : `: ${wrongIn(all)}`}`,
);
const bad = await exhaust(one(builtFor(planted('a refund without its retry timer'), { rules: false }).module), {
  depth: 11,
  faults: 1,
});
ok(
  'the same search finds the refund left without a timer',
  !bad.ok,
  bad.ok ? `${bad.ran} scripts, none failed` : `script ${bad.ran}: ${JSON.stringify(bad.failures[0]?.script)}`,
);

// The machine's speed is not part of a run. A call that waits a few ms (POST /orders/wait/40) used to be timed by a real
// timer in the host, so a run that took longer than that between two choices went another way: the fulfillment
// example gave a different number of choices each time it was simulated. The simulator now keeps the time itself.
{
  const stall = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const order = { key: 'k1', sku: 'lamp', qty: 1, card: 'ann-4242', address: 'ann' };
  const request = (line: string, body?: Json): Op => ({ name: 'request', make: () => ({ line, body }) });
  const { model: fulfillment } = autoOf([{ name: 'fulfillment', text: read('examples/fulfillment.tape') }]);
  const clients = (): Op[][] => [[request('POST /orders/wait/40', order)], [request('GET /orders')]];
  const plan = ['start c0', 'start c1', 'deliver c0.0:1'];
  const run = (slow: boolean) =>
    drive(
      { ...fulfillment, clients },
      {
        seed: 1,
        choose: (enabled, world, script) => {
          if (slow && script.length === 1) stall(150); // real time passes while the call waits
          return plan[script.length] ?? null;
        },
      },
    );
  const [quick, slow] = [await run(false), await run(true)];
  ok(
    'a run is the same however long the machine takes between two choices (a call that waits 40 ms)',
    JSON.stringify(quick.log) === JSON.stringify(slow.log) && quick.log.some(e => /deliver c0\.0:1/.test(e.what)),
    `${quick.log.length} and ${slow.log.length} lines`,
  );
}

finish();
