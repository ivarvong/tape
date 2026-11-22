// sha.ts: the commit a build is made from, as the service names it in its tape-version header: the short sha, and
// "-dirty" when the tree has changes not committed (scripts/deploy.sh deploys only a clean tree).
import { execFileSync } from 'node:child_process';

const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();
export const tapeVersion = (): string => {
  try {
    const sha = git(['rev-parse', '--short=12', 'HEAD']);
    return git(['status', '--porcelain']) === '' ? sha : `${sha}-dirty`;
  } catch {
    return 'unknown';
  }
};
