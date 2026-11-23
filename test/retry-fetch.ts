// service/scripts/retry.ts, the asset fetch parity.ts and smoke.ts make of a version just uploaded, with a fake
// fetch: a 401 or a 404 is asked for again after each wait, longer each time; any other status is the answer at
// once; after the last wait the last answer is given, whatever it is; each try carries the same request.
import { BACKOFF, fetchAsset } from '../service/scripts/retry.ts';
import { finish, same } from './harness.ts';

/** A fetch that answers these statuses in turn, and what it was asked and how long it was made to wait. */
function fake(statuses: readonly number[]) {
  const asked: string[] = [];
  const waited: number[] = [];
  let k = 0;
  const fetcher = (url: string, init?: RequestInit): Promise<Response> => {
    asked.push(`${url} ${new Headers(init?.headers).get('x-pin') ?? '-'}`);
    const status = statuses[Math.min(k++, statuses.length - 1)] ?? 200;
    return Promise.resolve(new Response(status === 200 ? 'export {}' : '{"error":"unauthorized"}', { status }));
  };
  const sleep = (ms: number): Promise<void> => {
    waited.push(ms);
    return Promise.resolve();
  };
  return { fetcher, sleep, asked, waited };
}
const tried = async (statuses: readonly number[]) => {
  const f = fake(statuses);
  const r = await fetchAsset(
    f.fetcher,
    '/a/compiler.js',
    { headers: { 'x-pin': 'v1' } },
    { sleep: f.sleep, log: (): void => {} },
  );
  return { status: r.status, tries: f.asked.length, waited: f.waited, asked: [...new Set(f.asked)] };
};

same('an asset there at once: one try, no wait', await tried([200]), {
  status: 200,
  tries: 1,
  waited: [],
  asked: ['/a/compiler.js v1'],
});
same('401, then 404, then the asset: three tries, the request the same each time', await tried([401, 404, 200]), {
  status: 200,
  tries: 3,
  waited: [250, 500],
  asked: ['/a/compiler.js v1'],
});
same('a 500 is the answer at once', await tried([500, 200]), {
  status: 500,
  tries: 1,
  waited: [],
  asked: ['/a/compiler.js v1'],
});
same('a 403 is too', (await tried([403])).tries, 1);
same('never there: every wait, then the last 404', await tried([404]), {
  status: 404,
  tries: BACKOFF.length + 1,
  waited: [...BACKOFF],
  asked: ['/a/compiler.js v1'],
});
same(
  'the waits grow, and add up to a few seconds',
  [BACKOFF.every((d, i) => i === 0 || d > (BACKOFF[i - 1] ?? 0)), BACKOFF.reduce((a, b) => a + b, 0)],
  [true, 7750],
);

finish();
