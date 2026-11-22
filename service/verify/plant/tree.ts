// tree.ts: a copy of the repository to plant a bug in. The copy is the working tree without node_modules (linked
// instead), .git and build output; an edit is exact text that must be found once (or, with `all`, at least once).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFlat } from '../../../fmt.ts';
import type { Edit } from './plants.ts';

export const ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
export const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
/** How often an edit's text is in its file under a tree. */
/** A file of a tree as an edit reads it: a Tape program flat (fmt.ts), so an edit does not depend on where its
 * lines are broken; anything else as it stands. */
const textOf = (path: string): string => (path.endsWith('.tape') ? readFlat(path) : readFileSync(path, 'utf8'));
export const matches = (dir: string, e: Edit): number =>
  existsSync(`${dir}/${e.file}`) ? textOf(`${dir}/${e.file}`).split(e.find).length - 1 : 0;
export const fits = (dir: string, e: Edit): boolean => (e.all === true ? matches(dir, e) >= 1 : matches(dir, e) === 1);
export const copyTree = (id: string): string => {
  const dir = `/tmp/plant/${id}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('bash', [
    '-c',
    `tar --exclude=./node_modules --exclude=./service/node_modules --exclude=./.git --exclude=./service/.cloudflare -C ${ROOT} -cf - . | tar -xf - -C ${dir}`,
  ]);
  for (const d of ['node_modules', 'service/node_modules'])
    if (existsSync(`${ROOT}/${d}`)) symlinkSync(`${ROOT}/${d}`, `${dir}/${d}`);
  return dir;
};
export const apply = (dir: string, id: string, edits: readonly Edit[]): void => {
  for (const e of edits) {
    if (!fits(dir, e)) throw new Error(`${id}: the edit matches ${matches(dir, e)} times in ${e.file}`);
    const path = `${dir}/${e.file}`,
      text = textOf(path);
    writeFileSync(
      path,
      e.all === true ? text.replaceAll(e.find, () => e.replace) : text.replace(e.find, () => e.replace),
    );
  }
};
export type Ran = { code: number | null; log: string };
/** A command run to its end: its exit code and the end of what it printed. */
export const sh = (
  cmd: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): Promise<Ran> =>
  new Promise(done => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const keep = (d: unknown): void => {
      log = `${log}${String(d)}`.slice(-6000);
    };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    p.on('close', code => {
      done({ code, log });
    });
  });
/** A vitest JSON report, if the run wrote one. */
export const reportAt = (path: string): unknown => {
  if (!existsSync(path)) return null;
  const report: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return report;
};
