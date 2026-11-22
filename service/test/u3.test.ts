// U3=236 npx vitest run test/u3.test.ts --reporter=json --outputFile=<f>: replays the mechanism K4 names for U3
// (seed 236 of local run 3, one order absent from the final state while its charge and label stood). The seed runs
// three times: (a) with the heal as it was before K4's fix (6842c9d~1) and every read of order 1 failing once with
// a 503, (b) with today's heal and the same failures, and (c) with the old heal and no failure. Skipped unless U3
// is set. The anomalies of each run are kept in the test's meta, beside U3's as recorded in run 3.
import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import type { Reply, Sender } from '../jepsen/client.ts';
import type { Final, Row } from '../jepsen/harness.ts';
import { at, fields, list, num } from './help.ts';
import { jepsen } from './jepsen-run.ts';

// the heal of 6842c9d~1: a read that failed was taken as "no such order"
async function oldHeal(send: Sender): Promise<Final> {
  await send('PUT', '/~faults', null);
  const scan = async (
    path: string,
    finish: (id: number) => Promise<Reply>,
    done: (row: Row) => boolean,
  ): Promise<Row[]> => {
    const out: Row[] = [];
    for (let id = 1, misses = 0; misses < 3; id++) {
      let row = fields((await send('GET', `${path}/${id}`)).body);
      if (num(row['id']) === 0) {
        misses++;
        continue;
      }
      misses = 0;
      for (let k = 0; k < 6 && !done(row); k++) {
        await finish(id);
        row = fields((await send('GET', `${path}/${id}`)).body);
      }
      out.push(row);
    }
    return out;
  };
  const orders = await scan(
    '/fulfill/v/1/orders',
    id => send('POST', `/fulfill/v/1/advance/${id}`, ''),
    o => o['state'] === 'done' || o['state'] === 'failed',
  );
  const sales = await scan(
    '/tickets/v/1/sales',
    id => send('POST', `/tickets/v/1/retry/${id}`, ''),
    sale => sale['state'] !== 'pending',
  );
  const rows = async (p: string): Promise<Row[]> => list((await send('GET', p)).body).map(fields);
  return {
    orders,
    sales,
    stock: await rows('/inventory/v/1/stock'),
    cards: await rows('/payments/v/1/cards'),
    labels: await rows('/shipping/v/1/labels'),
    seats: await rows('/tickets/v/1/sections'),
    faults: (await send('GET', '/~faults')).body,
  };
}
// the first read of /fulfill/v/1/orders/<id> in the heal answers 503, as a read cut by a reset would
const failFirst =
  (id: number) =>
  (send: Sender): Sender => {
    let failed = false;
    return (method, path, ...rest) => {
      if (!failed && method === 'GET' && path === `/fulfill/v/1/orders/${id}`) {
        failed = true;
        return Promise.resolve({ status: 503, body: { error: 'u3 replay: the read failed' }, headers: {} });
      }
      return send(method, path, ...rest);
    };
  };
const summary = (r: Awaited<ReturnType<typeof jepsen>>): Record<string, unknown> => ({
  anomalies: r.anomalies,
  trace_anomalies: r.traces.anomalies,
  order: r.history.find(h => h.f === 'create' && at(h.value, 'id') === 1)?.value ?? null,
  heal: r.final.heal ?? null,
  unreadable: r.final.unreadable ?? null,
  orders: r.final.orders.length,
});
it.skipIf(env.U3 === '')(
  'u3 replay',
  async ({ task }) => {
    const seed = Number(env.U3),
      id = 1;
    task.meta.u3 = {
      seed,
      old_heal_read_fails: summary(await jepsen(seed, { tag: 'u3a', heal: oldHeal, healSend: failFirst(id) })),
      new_heal_read_fails: summary(await jepsen(seed, { tag: 'u3b', healSend: failFirst(id) })),
      old_heal_no_failure: summary(await jepsen(seed, { tag: 'u3c', heal: oldHeal })),
    };
  },
  600000,
);
