// The machine's triggers, end to end (plant M of plants.ts): copied by machine.ts into a planted tree as
// test/machine-plant.test.ts. MACHINE_PLANT=checker-off: rules.ts C59 is disabled there, and tickets.tape's decline
// path writes a state its machine does not declare ('void'); the upload passes, and the triggers alone must refuse
// the write: the request fails, nothing after its last call is applied, and the sale stays pending. MACHINE_PLANT=checker-on: the same
// bad transition, with C59 in place, is refused at upload.
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import tickets from '../../examples/tickets.tape?raw';
import payments from '../../examples/payments.tape?raw';

type Answer = { status: number; body: unknown };
const parsed = (body: string): unknown => {
  try {
    const value: unknown = JSON.parse(body);
    return value;
  } catch {
    return body;
  }
};
const call = async (method: string, path: string, body?: string): Promise<Answer> => {
  const res = await exports.default.fetch(`http://tape/plant-m${path}`, {
    method,
    headers: { authorization: 'Bearer test-token' },
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, body: parsed(await res.text()) };
};
/** A field of a JSON answer, or of the row a list of rows has under a name. */
const field = (v: unknown, name: string): unknown =>
  typeof v === 'object' && v !== null ? Reflect.get(v, name) : undefined;
const rowNamed = (rows: unknown, name: string): unknown =>
  Array.isArray(rows) ? rows.find((row: unknown) => field(row, 'name') === name) : undefined;
describe('a transition the machine does not declare', () => {
  it(
    env.MACHINE_PLANT === 'checker-on' ? 'is refused at upload' : 'is refused by the triggers at run time',
    async ({ task }) => {
      expect(tickets).toContain("SET state = 'void'");
      const pay = await call('POST', '/payments', payments);
      const up = await call('POST', '/tickets', tickets);
      const upload = [pay.status, up.status, JSON.stringify(up.body).slice(0, 600)];
      task.meta.machine = { upload };
      expect(pay.status).toBe(201);
      if (env.MACHINE_PLANT === 'checker-on') {
        expect(up.status).toBe(400);
        expect(JSON.stringify(up.body)).toContain('C59');
        return;
      }
      expect(up.status).toBe(201);
      // a card with no funds: payments refuses the charge, and the decline path runs its planted write
      const buy = await call(
        'POST',
        '/tickets/v/1/buy',
        JSON.stringify({ key: 'm1', section: 'floor', qty: 2, card: 'nobody-0000' }),
      );
      const sale = await call('GET', '/tickets/v/1/sales/1');
      const sections = await call('GET', '/tickets/v/1/sections');
      task.meta.machine = {
        upload,
        buy: [buy.status, buy.body],
        sale: [sale.status, sale.body],
        sections: sections.body,
      };
      // the hold was committed before the charge was sent (a call is a commit point); everything after the call,
      // the planted write and the seats it would free, rolled back
      expect(buy.status).toBe(500);
      expect(field(buy.body, 'outcome')).toBe('partly');
      expect(JSON.stringify(buy.body)).toContain('that move is not declared');
      // the hold (committed before the charge was sent) stands; the refused move left the sale pending
      expect(field(sale.body, 'state')).toBe('pending');
      expect(field(rowNamed(sections.body, 'floor'), 'seats')).toBe(1); // 3 at the start, 2 held
    },
    60000,
  );
});
