// sha.ts: the commit a build is made from, as the service names it in its tape-version header: the short sha, and
// "-dirty" when the tree has changes not committed (scripts/deploy.sh deploys only a clean tree).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();
export const tapeVersion = (): string => {
  try {
    const sha = git(['rev-parse', '--short=12', 'HEAD']);
    return git(['status', '--porcelain']) === '' ? sha : `${sha}-dirty`;
  } catch {
    return 'unknown';
  }
};
/** The compiler a build embeds, as both Workers name it in their tape-compiler header: the first 16 hex of the
 * SHA-256 of compiler.ts, compiler/ and std/ (each file's path and bytes, in path order). Two builds with the same
 * hash compile alike, whatever else in the commit differs. */
export const compilerHash = (): string => {
  const root = new URL('../../', import.meta.url).pathname;
  const files = [
    'compiler.ts',
    ...['compiler', 'std'].flatMap(d =>
      readdirSync(root + d, { recursive: true, withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => relative(root, join(e.parentPath, e.name))),
    ),
  ].toSorted();
  const h = createHash('sha256');
  for (const f of files)
    h.update(`${f}\0`)
      .update(readFileSync(root + f))
      .update('\0');
  return h.digest('hex').slice(0, 16);
};
