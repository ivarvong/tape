// The orders task's acceptance requests, written from tasks/orders.md alone. In the hosted `run` every call to
// payments answers Unreachable, so what can be seen is the no-answer path: a pending order, a timer set to keep
// trying, a charge sent with an idempotency key and a timeout of at most 2 s, and retries that make nothing new.
import { check, field, json, problem, req, status } from '../lib.ts';
import type { Effect, Grader, Res } from '../lib.ts';

const order = (id: number, key: string, amount: number, state: string) => (j: unknown) =>
  field(j, 'id') === id &&
  field(j, 'order_key') === key &&
  field(j, 'amount_cents') === amount &&
  field(j, 'state') === state;
const calls = (r: Res | undefined): Effect[] => (r?.effects ?? []).filter(e => e.kind === 'call');
const place = (order_key: unknown, amount_cents: unknown) => req('POST', '/orders', { order_key, amount_cents });

export const grader: Grader = {
  task: 'orders',
  scenarios: [
    {
      name: 'payments does not answer',
      requests: [
        place('cart-1', 1999),
        place('cart-1', 1999),
        place('cart-2', 500),
        req('GET', '/orders/1'),
        req('GET', '/orders/2'),
        req('GET', '/orders/3'),
        place('cart-1', 1999),
        req('GET', '/orders/3'),
        req('GET', '/orders/x'),
        req('GET', '/nope'),
      ],
      checks: r => {
        const first = calls(r[0]);
        const charge = first[0];
        const retried = [...calls(r[1]), ...calls(r[6])];
        return [
          json('no answer: 202 and the order, pending', r[0], [202], order(1, 'cart-1', 1999, 'pending')),
          check('it sent payments a charge', first.length > 0, JSON.stringify(r[0]?.effects ?? []).slice(0, 200)),
          check(
            'the charge waits at most 2 s',
            charge !== undefined && Number(charge['within_ms']) > 0 && Number(charge['within_ms']) <= 2000,
            JSON.stringify(charge ?? null).slice(0, 200),
          ),
          check('the charge carries an idempotency key', charge !== undefined && charge['once'] !== undefined),
          check(
            'it set a timer to keep trying',
            (r[0]?.effects ?? []).some(e => e.kind === 'wake'),
            JSON.stringify((r[0]?.effects ?? []).map(e => e.kind)),
          ),
          json('a retry answers the same order: 200', r[1], [200], order(1, 'cart-1', 1999, 'pending')),
          check(
            'a retry charges with the same key, if it charges at all',
            charge !== undefined && retried.every(c => JSON.stringify(c['once']) === JSON.stringify(charge['once'])),
            JSON.stringify(retried.map(c => c['once'])).slice(0, 200),
          ),
          json('a second order is id 2', r[2], [202], order(2, 'cart-2', 500, 'pending')),
          json('GET /orders/1', r[3], [200], order(1, 'cart-1', 1999, 'pending')),
          json('GET /orders/2', r[4], [200], order(2, 'cart-2', 500, 'pending')),
          problem('no third order after a retry', r[5], 404),
          json('a later retry: 200, the same order', r[6], [200], order(1, 'cart-1', 1999, 'pending')),
          problem('still no third order', r[7], 404),
          status('a non-numeric id: 404', r[8], 404),
          status('an unknown route: 404', r[9], 404),
        ];
      },
    },
    {
      name: 'validation',
      requests: [
        place('k', 0),
        place('k', 1000001),
        place('', 10),
        req('POST', '/orders', { amount_cents: 10 }),
        req('POST', '/orders', '{"order_key": '),
        place('k', '10'),
        req('GET', '/orders/1'),
        place('k', 1000000),
      ],
      checks: r => [
        problem('amount 0: 400', r[0], 400),
        problem('amount over 1000000: 400', r[1], 400),
        problem('an empty order_key: 400', r[2], 400),
        problem('no order_key: 400', r[3], 400),
        problem('a body that is not JSON: 400', r[4], 400),
        problem('an amount that is a string: 400', r[5], 400),
        problem('refused orders made nothing', r[6], 404),
        json('the largest amount is accepted, id 1', r[7], [202], order(1, 'k', 1000000, 'pending')),
      ],
    },
  ],
};
