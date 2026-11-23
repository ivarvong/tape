// smoke.ts: what a deployed Worker must answer, without the operator's token.
//   node scripts/smoke.ts <base-url> [--pin <version-id>] [--sha <tape-version>]
// With --pin every request carries Cloudflare-Workers-Version-Overrides, so it reaches that version (the Worker and
// its assets; a Durable Object runs the version the deployment gave its id, not the pinned one). With --sha every
// response must name that commit. Exits 1 on the first group that fails, printing every check.
//
// Checks: the homepage and the playground (200, the strict CSP with frame-ancestors, no-cache, indexable) and every
// file they load (200, immutable, nosniff); /playground redirects; robots.txt; an API path without a token (401 with
// the Worker's headers, tape-worker-version the pinned version); "Bearer undefined" (401); a public route nobody
// published (404); a public body over the cap (413); a bad trace link (401).
import '../../node25.ts';
import { fetchAsset } from './retry.ts';

const args = process.argv.slice(2);
const base = (args.find(a => !a.startsWith('--')) ?? '').replace(/\/$/, '');
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? null : (args[i + 1] ?? null);
};
const pin = opt('pin'),
  sha = opt('sha');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node scripts/smoke.ts <base-url> [--pin <version-id>] [--sha <tape-version>]');
  process.exit(2);
}

const ROBOTS = 'User-agent: *\nAllow: /$\nAllow: /playground/\nAllow: /a/\nDisallow: /\n';
const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
let failed = 0,
  passed = 0;
const check = (ok: boolean, what: string): void => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`  FAIL ${what}`);
  }
};
const get = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}${path}`, {
    redirect: 'manual',
    ...init,
    headers: {
      'x-tape-synthetic': 'deploy-smoke',
      ...(pin === null ? {} : { 'cloudflare-workers-version-overrides': `tape="${pin}"` }),
      ...Object.fromEntries(new Headers(init.headers ?? {})),
    },
  });
const h = (r: Response, name: string): string => r.headers.get(name) ?? '';
const versioned = (r: Response, what: string): void => {
  if (sha !== null)
    check(h(r, 'tape-version') === sha, `${what}: tape-version ${h(r, 'tape-version') || '-'}, not ${sha}`);
};
const worker = (r: Response, what: string): void => {
  versioned(r, what);
  if (pin !== null)
    check(h(r, 'tape-worker-version') === pin, `${what}: tape-worker-version ${h(r, 'tape-worker-version') || '-'}`);
  check(h(r, 'x-content-type-options') === 'nosniff', `${what}: nosniff`);
  check(h(r, 'x-frame-options') === 'DENY', `${what}: x-frame-options`);
  check(h(r, 'x-robots-tag') === 'noindex', `${what}: x-robots-tag`);
  check(h(r, 'referrer-policy') === 'no-referrer', `${what}: referrer-policy`);
  check(h(r, 'content-security-policy') === API_CSP, `${what}: CSP ${h(r, 'content-security-policy')}`);
  check(h(r, 'content-type') === 'application/json', `${what}: content-type ${h(r, 'content-type')}`);
};

async function page(path: string): Promise<void> {
  const r = await get(path),
    text = await r.text();
  check(r.status === 200, `${path}: ${r.status}`);
  check(h(r, 'content-type').startsWith('text/html'), `${path}: content-type ${h(r, 'content-type')}`);
  check(h(r, 'cache-control') === 'no-cache', `${path}: cache-control ${h(r, 'cache-control')}`);
  const csp = h(r, 'content-security-policy');
  for (const d of ["default-src 'none'", "frame-ancestors 'none'", "script-src 'self' 'wasm-unsafe-eval'"])
    check(csp.includes(d), `${path}: CSP has no ${d}`);
  check(h(r, 'x-content-type-options') === 'nosniff', `${path}: nosniff`);
  check(h(r, 'x-robots-tag') === '', `${path}: x-robots-tag ${h(r, 'x-robots-tag')} on a page to index`);
  check(/<title>[^<]*Tape[^<]*<\/title>/.test(text), `${path}: no title`);
  versioned(r, path);
  // every file the page loads
  const up = path === '/' ? '/' : path;
  const files = [...new Set([...text.matchAll(/(?:href|src)="((?:\.\.\/)?a\/[^"]+)"/g)].map(m => m[1] ?? ''))];
  check(files.length >= 5, `${path}: loads ${files.length} files`);
  const loaded = await Promise.all(
    files.map(async f => {
      const at = new URL(f, `https://x${up}`).pathname,
        a = await fetchAsset((url, init) => get(url, init), at, {}, { log: line => console.log(line) });
      await a.arrayBuffer();
      return { at, a };
    }),
  );
  for (const { at, a } of loaded) {
    check(a.status === 200, `${at}: ${a.status}`);
    check(
      h(a, 'cache-control') === 'public, max-age=31536000, immutable',
      `${at}: cache-control ${h(a, 'cache-control')}`,
    );
    check(h(a, 'x-content-type-options') === 'nosniff', `${at}: nosniff`);
  }
  console.log(`  ${path}: ${r.status}, ${files.length} files loaded`);
}

async function api(): Promise<void> {
  const none = await get('/ivar/hello');
  await none.text();
  check(none.status === 401, `/ivar/hello without a token: ${none.status}`);
  worker(none, '/ivar/hello');
  const undef = await get('/ivar/hello', { headers: { authorization: 'Bearer undefined' } });
  await undef.text();
  check(undef.status === 401, `"Bearer undefined": ${undef.status}`);
  const nobody = await get('/p/nobody-smoke/x');
  await nobody.text();
  check(nobody.status === 404, `/p/nobody-smoke/…: ${nobody.status}`);
  worker(nobody, '/p/nobody-smoke/…');
  const big = await get('/p/nobody-smoke/x', { method: 'POST', body: 'x'.repeat(65 * 1024) });
  await big.text();
  check(big.status === 413, `a 65 KB public body: ${big.status}`);
  const trace = await get(
    `/t/nobody-smoke/x/1/00000000-0000-4000-8000-000000000000?exp=${Math.floor(Date.now() / 1000) + 60}&sig=${'0'.repeat(64)}`,
  );
  await trace.text();
  check(trace.status === 401, `a bad trace link: ${trace.status}`);
  worker(trace, 'a bad trace link');
  console.log(
    `  api: 401 ${none.status}, undefined ${undef.status}, /p/ ${nobody.status}, big ${big.status}, /t/ ${trace.status}`,
  );
}

console.log(`smoke ${base}${pin === null ? '' : ` pinned to ${pin}`}${sha === null ? '' : ` at ${sha}`}`);
await page('/');
await page('/playground/');
const redirect = await get('/playground');
check(
  redirect.status >= 300 && redirect.status < 400 && h(redirect, 'location').endsWith('/playground/'),
  `/playground: ${redirect.status} ${h(redirect, 'location')}`,
);
const robots = await get('/robots.txt');
check(robots.status === 200 && (await robots.text()) === ROBOTS, `/robots.txt: ${robots.status}`);
await api();
console.log(failed === 0 ? `smoke ok: ${passed} checks` : `FAIL smoke: ${failed} of ${passed + failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
