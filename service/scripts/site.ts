// site.ts: the homepage and the playground, as the Worker's static assets.
//   node scripts/site.ts [out]          writes out/ (default service/.site): apps/playground's build, a robots.txt,
//                                       and its _headers with every file's tape-version
// vite.config.ts serves out/ as Vite's public directory, so `cf build` puts it in the Worker's assets: a request
// for one of its files is answered from it with the headers _headers gives (the pages never cached, with a strict
// CSP; the hashed files under a/ for ever); any other request reaches the Worker.
import '../../node25.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, write } from '../../apps/playground/build.ts';
import { tapeVersion } from './sha.ts';

/** The crawlers may read the homepage and the playground (and the files they load); nothing of the API. */
export const ROBOTS = 'User-agent: *\nAllow: /$\nAllow: /playground/\nAllow: /a/\nDisallow: /\n';

export async function site(out: string): Promise<string> {
  const version = tapeVersion();
  write(await build(), out);
  writeFileSync(resolve(out, 'robots.txt'), ROBOTS);
  // every file says which commit it is; the files under a/ are not pages to index. A path's rule is given once (a
  // second rule for the same path replaces the first), so the a/ line goes into build.ts's own rule for a/*; the
  // rules of every path a request matches are merged, so a header is given in one of them only.
  const file = resolve(out, '_headers'),
    rules = readFileSync(file, 'utf8');
  if (!rules.startsWith('/a/*\n')) throw new Error("the playground's _headers no longer starts with its rule for /a/*");
  writeFileSync(
    file,
    `/a/*\n  X-Robots-Tag: noindex\n${rules.slice('/a/*\n'.length)}/robots.txt\n  X-Content-Type-Options: nosniff\n/*\n  tape-version: ${version}\n`,
  );
  return version;
}

if (import.meta.main) {
  const out = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../.site'));
  console.log(`${out}: the site at ${await site(out)}`);
}
