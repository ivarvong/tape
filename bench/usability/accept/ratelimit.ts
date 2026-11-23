// The rate limiter task's acceptance requests, written from tasks/ratelimit.md alone. Every request of a scenario
// runs within one `run` call, well inside one 60 s window.
import { field, json, problem, req, status } from '../lib.ts';
import type { Grader } from '../lib.ts';

const allowed = (remaining: number) => (j: unknown) =>
  field(j, 'allowed') === true && field(j, 'remaining') === remaining;
const refused = (j: unknown): boolean => {
  const after = field(j, 'retry_after_ms');
  return (
    field(j, 'allowed') === false &&
    field(j, 'remaining') === 0 &&
    typeof after === 'number' &&
    Number.isInteger(after) &&
    after >= 1 &&
    after <= 60000
  );
};
const hit = (key: string) => req('POST', `/check/${key}`);

export const grader: Grader = {
  task: 'ratelimit',
  scenarios: [
    {
      name: 'default limit, independent keys, a set limit',
      requests: [
        hit('k1'),
        hit('k1'),
        hit('k1'),
        hit('k1'),
        hit('k1'),
        hit('k1'),
        hit('k1'),
        hit('k2'),
        req('GET', '/limits/k1'),
        req('GET', '/limits/k2'),
        req('GET', '/limits/fresh'),
        req('PUT', '/limits/k3', { limit: 2 }),
        hit('k3'),
        hit('k3'),
        hit('k3'),
        req('PUT', '/limits/k1', { limit: 10 }),
        hit('k1'),
        hit('bad!key'),
        req('PUT', '/limits/k4', { limit: 0 }),
        req('GET', '/other'),
      ],
      checks: r => [
        json('1st check: remaining 4', r[0], [200], allowed(4)),
        json('2nd check: remaining 3', r[1], [200], allowed(3)),
        json('3rd check: remaining 2', r[2], [200], allowed(2)),
        json('4th check: remaining 1', r[3], [200], allowed(1)),
        json('5th check: remaining 0', r[4], [200], allowed(0)),
        json('6th check: 429 with retry_after_ms', r[5], [429], refused),
        json('7th check: still 429', r[6], [429], refused),
        json('another key is independent', r[7], [200], allowed(4)),
        // "used" counts the window's checks; whether refused ones count is not fixed by the spec, so 5 to 7.
        json('GET /limits/k1: limit 5, used 5..7', r[8], [200], j => {
          const used = Number(field(j, 'used'));
          return field(j, 'key') === 'k1' && field(j, 'limit') === 5 && used >= 5 && used <= 7;
        }),
        json('GET /limits/k2: used 1', r[9], [200], j => field(j, 'limit') === 5 && field(j, 'used') === 1),
        json(
          'GET /limits of an unseen key: used 0',
          r[10],
          [200],
          j => field(j, 'limit') === 5 && field(j, 'used') === 0,
        ),
        json('PUT /limits answers the limit', r[11], [200], j => field(j, 'key') === 'k3' && field(j, 'limit') === 2),
        json('limit 2: remaining 1', r[12], [200], allowed(1)),
        json('limit 2: remaining 0', r[13], [200], allowed(0)),
        json('limit 2: third is 429', r[14], [429], refused),
        status('raise k1 to 10', r[15], 200),
        json('a raised limit applies in the current window', r[16], [200], j => field(j, 'allowed') === true),
        problem('a key with ! is 400', r[17], 400),
        problem('limit 0 is 400', r[18], 400),
        status('an unknown route is 404', r[19], 404),
      ],
    },
    {
      name: 'keys and bodies',
      requests: [
        hit('a'.repeat(64)),
        hit('a'.repeat(65)),
        hit('svc.api:user_42-x'),
        req('PUT', '/limits/k', '{"limit": '),
        req('PUT', '/limits/k', { limit: 10001 }),
        req('PUT', '/limits/k', { limit: '3' }),
        req('PUT', '/limits/k', { limit: 1 }),
        hit('k'),
        hit('k'),
      ],
      checks: r => [
        json('a 64-character key is fine', r[0], [200], allowed(4)),
        problem('a 65-character key is 400', r[1], 400),
        json('a key with . : _ - is fine', r[2], [200], allowed(4)),
        problem('a body that is not JSON is 400', r[3], 400),
        problem('limit 10001 is 400', r[4], 400),
        problem('a limit that is a string is 400', r[5], 400),
        status('limit 1', r[6], 200),
        json('limit 1: first allowed, remaining 0', r[7], [200], allowed(0)),
        json('limit 1: second is 429', r[8], [429], refused),
      ],
    },
  ],
};
