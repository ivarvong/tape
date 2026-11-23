// sha.ts: the commit a build is made from, as the service names it in its tape-version header: the short sha, and
// "-dirty" when the tree has changes not committed (scripts/deploy.sh deploys only a clean tree).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();
export const tapeVersion = (): string => {
  try {
    const sha = git(['rev-parse', '--short=12', 'HEAD']);
    return git(['status', '--porcelain']) === '' ? sha : `${sha}-dirty`;
  } catch {
    return 'unknown';
  }
};
const ROOT = new URL('../../', import.meta.url).pathname;
// The relative modules a source file imports (import … from, export … from, import '…', import('…')), resolved from
// its directory, any ?query dropped. Bare and node: imports are the platform's and are left out.
const IMPORT = /\bfrom\s*'([^']+)'|\bimport\s*'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/g;
const importsOf = (root: string, file: string): string[] =>
  [...readFileSync(root + file, 'utf8').matchAll(IMPORT)]
    .map(m => m[1] ?? m[2] ?? m[3] ?? '')
    .filter(spec => spec.startsWith('./') || spec.startsWith('../'))
    .map(spec => relative(root, resolve(root, dirname(file), spec.replace(/\?.*$/, ''))));

/** What the compiler's output depends on: every module compiler.ts reaches through its imports (so compiler/, sql/,
 * rules/ and whatever else it comes to use, found, not listed), and std/, which every build compiles with. Paths
 * from the root, in order. */
export function compilerFiles(root: string = ROOT): string[] {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.endsWith('.ts')) for (const next of importsOf(root, file)) walk(next);
  };
  walk('compiler.ts');
  const std = readdirSync(root + 'std', { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => relative(root, join(e.parentPath, e.name)));
  return [...seen, ...std].toSorted();
}
/** The compiler a build embeds, as the tape Worker and its hosted runner name it in their tape-compiler header: the
 * first 16 hex of the SHA-256 of compilerFiles (each file's path and bytes, in path order). Two builds with the same
 * hash compile alike, whatever else in the commit differs; the service rebuilds a stored version made under another
 * (service/src/name.ts, #fresh). */
export const compilerHash = (root: string = ROOT): string => {
  const h = createHash('sha256');
  for (const f of compilerFiles(root))
    h.update(`${f}\0`)
      .update(readFileSync(root + f))
      .update('\0');
  return h.digest('hex').slice(0, 16);
};
