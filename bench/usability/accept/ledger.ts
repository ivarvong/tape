// The ledger task's acceptance requests, written from tasks/ledger.md alone.
import { field, json, problem, req } from '../lib.ts';
import type { Grader } from '../lib.ts';

const account = (j: unknown, id: string, balance: number): boolean =>
  field(j, 'id') === id && field(j, 'balance') === balance;
const transfer = (j: unknown, id: string, from: string, to: string, amount: number): boolean =>
  field(j, 'transfer_id') === id &&
  field(j, 'from') === from &&
  field(j, 'to') === to &&
  field(j, 'amount') === amount &&
  field(j, 'status') === 'completed';
const t = (transfer_id: string, from: string, to: string, amount: unknown) =>
  req('POST', '/transfers', { transfer_id, from, to, amount });

export const grader: Grader = {
  task: 'ledger',
  scenarios: [
    {
      name: 'accounts, transfers and retries',
      requests: [
        req('POST', '/accounts', { id: 'alice', balance: 10000 }),
        req('POST', '/accounts', { id: 'bob', balance: 500 }),
        req('POST', '/accounts', { id: 'alice', balance: 10000 }),
        req('POST', '/accounts', { id: 'alice', balance: 5 }),
        t('t-1', 'alice', 'bob', 3000),
        t('t-1', 'alice', 'bob', 3000),
        req('GET', '/accounts/alice'),
        req('GET', '/accounts/bob'),
        t('t-1', 'alice', 'bob', 3001),
        t('t-2', 'bob', 'alice', 99999),
        req('GET', '/accounts/bob'),
        t('t-3', 'alice', 'carol', 1),
        t('t-4', 'alice', 'alice', 1),
        t('t-5', 'alice', 'bob', 0),
        t('t-6', 'alice', 'bob', -5),
        req('GET', '/transfers/t-1'),
        req('GET', '/transfers/nope'),
        req('GET', '/accounts/zed'),
        t('t-7', 'bob', 'alice', 3500),
        req('GET', '/accounts/bob'),
      ],
      checks: r => [
        json('open alice: 201', r[0], [201], j => account(j, 'alice', 10000)),
        json('open bob: 201', r[1], [201], j => account(j, 'bob', 500)),
        json('retried open: 200, unchanged', r[2], [200], j => account(j, 'alice', 10000)),
        problem('open an existing id with another balance: 409', r[3], 409),
        json('transfer: 201 and the transfer', r[4], [201], j => transfer(j, 't-1', 'alice', 'bob', 3000)),
        json('retried transfer: 200, same transfer', r[5], [200], j => transfer(j, 't-1', 'alice', 'bob', 3000)),
        json('alice after one transfer (and its retry): 7000', r[6], [200], j => account(j, 'alice', 7000)),
        json('bob after one transfer (and its retry): 3500', r[7], [200], j => account(j, 'bob', 3500)),
        problem('same transfer_id, another body: 409', r[8], 409),
        json('insufficient funds: 409 "insufficient funds"', r[9], [409], j =>
          String(field(j, 'error')).includes('insufficient funds'),
        ),
        json('a refused transfer moves nothing', r[10], [200], j => account(j, 'bob', 3500)),
        problem('an unknown account: 404', r[11], 404),
        problem('from = to: 400', r[12], 400),
        problem('amount 0: 400', r[13], 400),
        problem('a negative amount: 400', r[14], 400),
        json('GET /transfers/t-1', r[15], [200], j => transfer(j, 't-1', 'alice', 'bob', 3000)),
        problem('GET an unknown transfer: 404', r[16], 404),
        problem('GET an unknown account: 404', r[17], 404),
        json('a transfer of the whole balance: 201', r[18], [201], j => transfer(j, 't-7', 'bob', 'alice', 3500)),
        json('a balance may reach exactly 0', r[19], [200], j => account(j, 'bob', 0)),
      ],
    },
    {
      name: 'validation and a retry storm',
      requests: [
        req('POST', '/accounts', { id: 'Bad_ID', balance: 1 }),
        req('POST', '/accounts', { id: 'x', balance: -1 }),
        req('POST', '/accounts', '{"id": "x", '),
        req('POST', '/accounts', { id: 'x' }),
        req('POST', '/accounts', { id: 'a', balance: 100 }),
        req('POST', '/accounts', { id: 'b', balance: 0 }),
        t('t-9', 'a', 'b', 60),
        t('t-9', 'a', 'b', 60),
        t('t-9', 'a', 'b', 60),
        t('t-9', 'a', 'b', 60),
        req('GET', '/accounts/a'),
        req('GET', '/accounts/b'),
        t('t-10', 'a', 'b', 60),
        req('GET', '/accounts/a'),
        req('POST', '/transfers', { transfer_id: 't-11', from: 'a', to: 'b' }),
      ],
      checks: r => [
        problem('an id with capitals and _: 400', r[0], 400),
        problem('a negative balance: 400', r[1], 400),
        problem('a body that is not JSON: 400', r[2], 400),
        problem('a missing balance: 400', r[3], 400),
        json('open a', r[4], [201], j => account(j, 'a', 100)),
        json('open b with 0', r[5], [201], j => account(j, 'b', 0)),
        json('first send: 201', r[6], [201], j => transfer(j, 't-9', 'a', 'b', 60)),
        json('retry 1: 200', r[7], [200], j => transfer(j, 't-9', 'a', 'b', 60)),
        json('retry 2: 200', r[8], [200], j => transfer(j, 't-9', 'a', 'b', 60)),
        json('retry 3: 200', r[9], [200], j => transfer(j, 't-9', 'a', 'b', 60)),
        json('four sends moved 60 once (a)', r[10], [200], j => account(j, 'a', 40)),
        json('four sends moved 60 once (b)', r[11], [200], j => account(j, 'b', 60)),
        problem('then 60 more is insufficient: 409', r[12], 409),
        json('and moved nothing', r[13], [200], j => account(j, 'a', 40)),
        problem('a transfer missing amount: 400', r[14], 400),
      ],
    },
  ],
};
