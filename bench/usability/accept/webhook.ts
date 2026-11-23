// The webhook task's acceptance requests, written from tasks/webhook.md alone.
import { field, json, problem, req, status } from '../lib.ts';
import type { Grader } from '../lib.ts';

const ev = (delivery_id: string, type: string, account: string, amount: unknown) =>
  req('POST', '/webhooks', { delivery_id, type, account, amount });
const said = (s: string) => (j: unknown) => field(j, 'status') === s;
const acct = (account: string, balance: number, events: number) => (j: unknown) =>
  field(j, 'account') === account && field(j, 'balance') === balance && field(j, 'events') === events;

export const grader: Grader = {
  task: 'webhook',
  scenarios: [
    {
      name: 'at-least-once deliveries',
      requests: [
        ev('d1', 'payment.succeeded', 'acme', 2500),
        ev('d1', 'payment.succeeded', 'acme', 2500),
        ev('d2', 'payment.refunded', 'acme', 500),
        ev('d1', 'payment.succeeded', 'acme', 9999),
        req('GET', '/accounts/acme'),
        ev('d3', 'payment.disputed', 'acme', 100),
        ev('d3', 'payment.disputed', 'acme', 100),
        req('GET', '/accounts/acme'),
        ev('d4', 'payment.refunded', 'beta', 700),
        req('GET', '/accounts/beta'),
        req('GET', '/accounts/nobody'),
        ev('d2', 'payment.refunded', 'acme', 500),
        ev('d5', 'payment.succeeded', 'acme', 1),
        req('GET', '/accounts/acme'),
      ],
      checks: r => [
        json('first delivery: processed', r[0], [200], said('processed')),
        json('same delivery again: duplicate', r[1], [200], said('duplicate')),
        json('a refund: processed', r[2], [200], said('processed')),
        json('same delivery_id, another body: duplicate', r[3], [200], said('duplicate')),
        json('acme: 2500 - 500, 2 events', r[4], [200], acct('acme', 2000, 2)),
        json('an unknown type: ignored', r[5], [200], said('ignored')),
        json('an ignored delivery again: duplicate', r[6], [200], said('duplicate')),
        json('ignored events change nothing', r[7], [200], acct('acme', 2000, 2)),
        json('a refund on a new account: processed', r[8], [200], said('processed')),
        json('a balance may go negative', r[9], [200], acct('beta', -700, 1)),
        problem('an account never named: 404', r[10], 404),
        json('a later copy of d2: duplicate', r[11], [200], said('duplicate')),
        json('a new delivery after duplicates: processed', r[12], [200], said('processed')),
        json('acme: 2001, 3 events', r[13], [200], acct('acme', 2001, 3)),
      ],
    },
    {
      name: 'validation',
      requests: [
        req('POST', '/webhooks', 'not json'),
        req('POST', '/webhooks', { delivery_id: 'x1', type: 'payment.succeeded', account: 'acme' }),
        ev('x2', 'payment.succeeded', 'acme', 0),
        ev('x3', 'payment.succeeded', 'acme', 100000001),
        ev('', 'payment.succeeded', 'acme', 5),
        ev('x4', 'payment.succeeded', 'acme', '25'),
        req('GET', '/accounts/acme'),
        req('GET', '/nope'),
        ev('x5', 'payment.succeeded', 'acme', 100000000),
        req('GET', '/accounts/acme'),
      ],
      checks: r => [
        problem('a body that is not JSON: 400', r[0], 400),
        problem('a missing amount: 400', r[1], 400),
        problem('amount 0: 400', r[2], 400),
        problem('amount over 100000000: 400', r[3], 400),
        problem('an empty delivery_id: 400', r[4], 400),
        problem('an amount that is a string: 400', r[5], 400),
        problem('refused events applied nothing (no account yet)', r[6], 404),
        status('an unknown route: 404', r[7], 404),
        json('the largest amount: processed', r[8], [200], said('processed')),
        json('and applied', r[9], [200], acct('acme', 100000000, 1)),
      ],
    },
  ],
};
