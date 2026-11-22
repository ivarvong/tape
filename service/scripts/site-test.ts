// site-test.ts: the site the Worker serves as static assets (scripts/site.ts), checked as the host will read it.
//   node service/scripts/site-test.ts
// _headers gives each path one rule (a second rule for a path replaces the first: the hashed files once lost their
// immutable cache that way); the pages are never cached and carry the strict CSP with frame-ancestors; the hashed
// files are cached for ever and not indexed; every file names its commit; robots.txt lets crawlers read the homepage
// and the playground and nothing else.
import '../../node25.ts';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { site } from './site.ts';

const out = mkdtempSync(join(tmpdir(), 'tape-site-'));
const fail = (why: string): never => {
  console.log(`FAIL ${why}`);
  process.exit(1);
};
try {
  const version = await site(out);
  const rules = new Map<string, string[]>();
  let path = '';
  for (const line of readFileSync(join(out, '_headers'), 'utf8').split('\n')) {
    if (line === '') continue;
    if (!line.startsWith(' ')) {
      if (rules.has(line)) fail(`_headers has two rules for ${line}`);
      path = line;
      rules.set(path, []);
    } else rules.get(path)?.push(line.trim().toLowerCase());
  }
  const has = (p: string, header: string): void => {
    if (!(rules.get(p) ?? []).includes(header.toLowerCase())) fail(`_headers: ${p} has no "${header}"`);
  };
  has('/a/*', 'Cache-Control: public, max-age=31536000, immutable');
  has('/a/*', 'X-Robots-Tag: noindex');
  has('/a/*', 'X-Content-Type-Options: nosniff');
  for (const p of ['/', '/playground/']) {
    has(p, 'Cache-Control: no-cache');
    has(p, 'X-Content-Type-Options: nosniff');
    const csp = (rules.get(p) ?? []).find(h => h.startsWith('content-security-policy:')) ?? '';
    for (const d of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "script-src 'self'"])
      if (!csp.includes(d)) fail(`_headers: ${p}'s CSP has no ${d}`);
    if (/unsafe-inline|unsafe-eval'|\*/.test(csp.replace("'wasm-unsafe-eval'", '')))
      fail(`_headers: ${p}'s CSP is loose`);
    if ((rules.get(p) ?? []).some(h => h.startsWith('x-robots-tag'))) fail(`${p} must be indexable`);
  }
  has('/*', `tape-version: ${version}`);
  // a header given in two rules a request matches is sent twice, joined: only /* may hold tape-version
  for (const [p, hs] of rules)
    if (p !== '/*' && hs.some(h => h.startsWith('tape-version'))) fail(`${p} repeats tape-version`);
  const robots = readFileSync(join(out, 'robots.txt'), 'utf8');
  if (robots !== 'User-agent: *\nAllow: /$\nAllow: /playground/\nAllow: /a/\nDisallow: /\n')
    fail(`robots.txt is ${JSON.stringify(robots)}`);
  const files = readdirSync(join(out, 'a'));
  if (files.some(f => !/\.[0-9a-f]{16}\.(js|css|wasm|svg)$/.test(f))) fail('a file under a/ is not named by its hash');
  console.log(`site ok: ${rules.size} header rules, ${files.length} hashed files, tape-version ${version}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
