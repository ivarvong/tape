// retry.ts: a static asset fetched from a version just uploaded, asked for again while it is not there yet. A
// version at 0% can answer an asset's first requests with 401 ({"error":"unauthorized"}) or 404 until its assets have
// reached the edge (a ship failed on it once, fetching a playground module), so parity.ts and smoke.ts ask again a
// few times, waiting longer each time, before they call that a failure. Any other status is the answer at once.
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
/** What an asset not yet propagated answers. */
export const NOT_YET: ReadonlySet<number> = new Set([401, 404]);
/** The waits between tries, in ms: six tries over about 7.75 s. */
export const BACKOFF: readonly number[] = [250, 500, 1000, 2000, 4000];
export type RetryOptions = {
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};
const wait = (ms: number): Promise<void> =>
  new Promise(done => {
    setTimeout(done, ms);
  });

/** The asset's response: the first that is not 401 or 404, or the last one after every wait. */
export async function fetchAsset(
  fetcher: Fetch,
  url: string,
  init: RequestInit = {},
  { delays = BACKOFF, sleep = wait, log }: RetryOptions = {},
): Promise<Response> {
  for (let tried = 0; ; tried++) {
    const r = await fetcher(url, init);
    const next = delays[tried];
    if (!NOT_YET.has(r.status) || next === undefined) return r;
    await r.body?.cancel();
    log?.(`  ${url}: ${r.status}, asking again in ${next} ms`);
    await sleep(next);
  }
}
