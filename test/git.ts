// test/git.ts: a git repository as a capability. examples/bump.tape talks to a real `git http-backend` through
// ply (adapters/ply.ts), and real git is the oracle for what landed. Needs ply built locally:
//   PLY=/path/to/ply node test/git.ts      (default ../ply-src; the test is skipped when it is not there)
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from '../compiler.ts';
import { instantiate, isCall, replay } from '../host.ts';
import type { Effect, Service } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { plyRepo } from '../adapters/ply.ts';
import type { Ply } from '../adapters/ply.ts';
import { finish, same as T, sleep } from './harness.ts';
const PLY = resolve(process.env.PLY ?? '../ply-src');
if (!existsSync(join(PLY, 'dist/index.ts'))) {
  console.log(`skipped: no built ply at ${PLY}`);
  process.exit(0);
}
type GitServer = { url: string; close: () => Promise<void> };
const has = (m: unknown, name: string): boolean =>
  typeof m === 'object' && m !== null && name in m && typeof Object.fromEntries(Object.entries(m))[name] === 'function';
const isPly = (m: unknown): m is Ply => ['readCommit', 'readFile', 'editFile'].every(name => has(m, name));
const serves = (m: unknown): m is { startGitServer: (root: string) => Promise<GitServer> } => has(m, 'startGitServer');
const ply: unknown = await import(pathToFileURL(join(PLY, 'dist/index.ts')).href);
const testServer: unknown = await import(pathToFileURL(join(PLY, 'test/server.ts')).href);
if (!isPly(ply) || !serves(testServer)) throw new Error(`the ply at ${PLY} is not the one this test was written for`);
const { startGitServer } = testServer;
const src = (n: string): { name: string; text: string } => ({
  name: n,
  text: readFileSync(new URL(`../${n}`, import.meta.url), 'utf8'),
});
/** The time a write's message carries. */
const timeIn = (sent: unknown): unknown => {
  const parsed: unknown = typeof sent === 'string' ? JSON.parse(sent) : null;
  return typeof parsed === 'object' && parsed !== null && 'time' in parsed ? parsed.time : undefined;
};
const enc = new TextEncoder(),
  dec = new TextDecoder();

// a bare repository with one commit, served over smart HTTP
const root = mkdtempSync(join(tmpdir(), 'tape-ply-')),
  bare = join(root, 'repo.git'),
  work = join(root, 'work');
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
git(root, 'init', '-q', '--bare', '-b', 'main', bare);
git(bare, 'config', 'http.receivepack', 'true');
git(root, 'init', '-q', '-b', 'main', work);
writeFileSync(join(work, 'VERSION'), '1.2.3\n');
writeFileSync(join(work, 'README.md'), '# demo\n');
git(work, 'add', '-A');
git(work, 'commit', '-q', '-m', 'Initial commit');
git(work, 'push', '-q', bare, 'main');
const server = await startGitServer(root),
  url = `${server.url}/repo.git`;
const head = (): string => git(bare, 'rev-parse', 'main'),
  count = (): number => Number(git(bare, 'rev-list', '--count', 'main')),
  version = (): string => git(bare, 'show', 'main:VERSION');

const r = compile([
  ...['core', 'text', 'json', 'http', 'list', 'map', 'retry', 'time', 'math'].map(n => src(`std/${n}.tape`)),
  src('examples/bump.tape'),
]);
if (r.wasm === null) throw new Error(JSON.stringify(r.errors[0]));
const module = new WebAssembly.Module(r.wasm),
  inner = plyRepo({ ply, url, author: { name: 'Tape Bot', email: 'bot@example.com' }, refs: ['main'] });
let late = 0;
let before: (() => void) | null = null;
const repo: Service = async (b, m) => {
  if (m.method === 'edit_file' && before) {
    before();
    before = null;
  }
  const out = await inner(b, m);
  if (m.method === 'edit_file' && late) {
    const ms = late;
    late = 0;
    await sleep(ms);
  }
  return out;
};
const sql = nodeSql(),
  app = instantiate(module, { sql, services: { repo }, name: 'bumper' });
const go = async (s: string): Promise<{ out: string; log: Effect[]; req: Uint8Array }> => {
  const ran = await app.runLogged(enc.encode(s), { transaction: f => sql.transaction(f) });
  return { out: dec.decode(ran.out), log: ran.effects, req: enc.encode(s) };
};
try {
  T('read a file through the capability', (await go('GET /version\n')).out, '200\n{"version":"1.2.3"}');
  const bump = await go('POST /bump\n{"key":"b1","from":"1.2.3","to":"1.2.4"}');
  T('bump: pushed, and git agrees', [bump.out, version(), count()], [`200\n{"commit":"${head()}"}`, '1.2.4', 2]);
  T('bump: the repository is sound', git(bare, 'fsck', '--strict').length, 0);
  const calls = bump.log.filter(isCall);
  T(
    'bump: the log has the read, the intent and the keyed write, and no URL',
    [calls.map(e => [e.method, 'once' in e, e.status]), JSON.stringify(bump.log).includes('127.0.0.1')],
    [
      [
        ['head', false, 'ok'],
        ['edit_file', true, 'ok'],
      ],
      false,
    ],
  );
  T(
    'bump: the commit carries the logged time',
    Number(git(bare, 'show', '-s', '--format=%at', 'main')),
    timeIn(calls[1]?.send),
  );
  T('bump: replays with no git server', dec.decode(replay(module, bump.req, bump.log)), bump.out);
  T(
    'a find that is not there is refused, nothing pushed',
    [(await go('POST /bump\n{"key":"b2","from":"9.9.9","to":"1.0.0"}')).out, count()],
    ['409\n{"error":"match_count"}', 2],
  );

  // the push lands but the answer comes too late: Timeout, then the same push again lands nothing more
  late = 3300;
  const slow = await go('POST /bump\n{"key":"b3","from":"1.2.4","to":"1.2.5"}');
  T(
    'timeout: the caller gives up at its budget',
    slow.out,
    '504\n{"error":"the push did not finish in time; the bump stays pending"}',
  );
  await sleep(500);
  T('timeout: but the commit landed', [version(), count()], ['1.2.5', 3]);
  const again = await go('POST /retry/3\n');
  T('retry: recognised as already done, exactly one commit', [again.out, count()], [`200\n{"commit":"${head()}"}`, 3]);
  T('retry: nothing left pending', (await go('POST /retry/3\n')).out.slice(0, 3), '404');

  // someone else pushes between our read of the head and our write
  before = () => {
    git(work, 'pull', '-q', bare, 'main');
    writeFileSync(join(work, 'README.md'), '# demo, changed\n');
    git(work, 'commit', '-q', '-am', 'Someone else');
    git(work, 'push', '-q', bare, 'main');
  };
  const raced = await go('POST /bump\n{"key":"b4","from":"1.2.5","to":"1.2.6"}');
  T(
    'race: the write names the head it expected, so it is refused',
    [raced.out.slice(0, 3), version(), count()],
    ['409', '1.2.5', 4],
  );
  console.log(`   (race refused with ${raced.out.slice(4)})`);

  // the capability is narrower than the repository
  const narrow = instantiate(module, {
    sql: nodeSql(),
    name: 'n',
    services: { repo: plyRepo({ ply, url, author: { name: 'x', email: 'x@example.com' }, refs: ['release'] }) },
  });
  T(
    'a branch outside the capability is forbidden',
    dec.decode(await narrow.run(enc.encode('GET /version\n'))),
    '502\n{"error":"forbidden"}',
  );
  const readonly = instantiate(module, {
    sql: nodeSql(),
    name: 'r',
    services: { repo: plyRepo({ ply, url, author: { name: 'x', email: 'x@example.com' }, write: false }) },
  });
  T(
    'a read-only capability refuses the write',
    [dec.decode(await readonly.run(enc.encode('POST /bump\n{"key":"b5","from":"1.2.5","to":"2.0.0"}'))), count()],
    ['409\n{"error":"read_only"}', 4],
  );
} finally {
  await server.close();
}
finish();
