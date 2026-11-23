// test/gate-lock.ts: proof/all.ts takes the machine's gate lock (proof/lock.ts), so two gates started together run
// one after the other: on a machine where several agents ran the gate at once the load went past 30 and the
// fault-injection seams test failed for that alone. Every run here uses a lock of its own (TAPE_STATE, a fresh
// directory), never the machine's.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish, ok, same, sleep } from './harness.ts';

const root = new URL('..', import.meta.url).pathname,
  node = process.execPath;
const state = (): string => mkdtempSync(join(tmpdir(), 'tape-gate-lock-'));
type Ran = { out: string; code: number | null; ended: number };
/** A node process; its output, exit code and when it ended. */
function start(
  args: string[],
  env: Record<string, string>,
): { child: ChildProcess; done: Promise<Ran>; out: () => string } {
  const child = spawn(node, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', (b: Buffer) => {
    out += b.toString('utf8');
  });
  child.stderr?.on('data', (b: Buffer) => {
    out += b.toString('utf8');
  });
  const done = new Promise<Ran>(resolve => {
    child.on('close', code => {
      resolve({ out, code, ended: Date.now() });
    });
  });
  return { child, done, out: () => out };
}
const until = async (what: () => boolean, ms: number): Promise<boolean> => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    if (what()) return true;
    // oxlint-disable-next-line no-await-in-loop -- polling
    await sleep(50);
  }
  return what();
};
/** A process that holds the lock for `ms` through proof/lock.ts, and prints when it took and let go of it. */
const HOLDER = (ms: number): string =>
  `import { acquire } from ${JSON.stringify(`${root}proof/lock.ts`)};
const release = await acquire(undefined, line => console.log(line));
console.log('took', Date.now());
await new Promise(r => setTimeout(r, ${ms}));
console.log('let go', Date.now());
release();`;
const times = (out: string, word: string): number => Number(new RegExp(`^${word} (\\d+)$`, 'm').exec(out)?.[1]);

// 1. Two runs started together: one takes the lock, the other says it waits and takes it only once the first let go.
{
  const env = { TAPE_STATE: state() };
  const a = start(['--input-type=module', '-e', HOLDER(1500)], env),
    b = start(['--input-type=module', '-e', HOLDER(1500)], env);
  const [ra, rb] = await Promise.all([a.done, b.done]);
  const [first, second] = times(ra.out, 'took') < times(rb.out, 'took') ? [ra, rb] : [rb, ra];
  same('two together: both exit 0', [ra.code, rb.code], [0, 0]);
  ok(
    'two together: the second said it waits, naming the first',
    /^waiting for the gate lock \(held by pid \d+, since \d{4}-\d\d-\d\dT/m.test(second.out) &&
      !/waiting/.test(first.out),
    `${first.out} | ${second.out}`,
  );
  ok(
    'two together: the second took the lock after the first let go',
    times(second.out, 'took') >= times(first.out, 'let go'),
    `first let go ${times(first.out, 'let go')}, second took ${times(second.out, 'took')}`,
  );
  same('two together: the lock is gone after', existsSync(`${env.TAPE_STATE}/gate.lock`), false);
}

// 2. proof/all.ts itself waits while a live process holds the lock, takes it when that process is gone (a stale
// lock), and lets go of it when it ends; --no-lock does not wait.
{
  const env = { TAPE_STATE: state() };
  const holder = spawn(node, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const pid = holder.pid ?? 0;
  writeFileSync(`${env.TAPE_STATE}/gate.lock`, JSON.stringify({ pid, since: '2026-11-22T00:00:00.000Z', cwd: '/x' }));
  const none = ['proof/all.ts', '--only', 'no part has this name'];
  const bypass = await start([...none, '--no-lock'], env).done;
  same('--no-lock: runs while the lock is held', [bypass.code, /waiting/.test(bypass.out)], [0, false]);
  const gate = start(none, env);
  ok(
    'all.ts: waits, naming the holder and since when',
    await until(
      () => gate.out().includes(`waiting for the gate lock (held by pid ${pid}, since 2026-11-22T00`),
      20_000,
    ),
    gate.out(),
  );
  await sleep(1500);
  same('all.ts: still waiting 1.5 s later', gate.child.exitCode, null);
  holder.kill('SIGKILL');
  const r = await gate.done;
  same(
    'all.ts: once the holder is gone it takes the stale lock and runs',
    [r.code, /is stale \(pid \d+/.test(r.out)],
    [0, true],
  );
  same('all.ts: the lock is gone after', existsSync(`${env.TAPE_STATE}/gate.lock`), false);
}

// 3. A lock left by a process that is gone is taken at once.
{
  const env = { TAPE_STATE: state() };
  const dead = spawn(node, ['-e', '0'], { stdio: 'ignore' });
  await new Promise<void>(done => {
    dead.on('close', () => {
      done();
    });
  });
  writeFileSync(`${env.TAPE_STATE}/gate.lock`, JSON.stringify({ pid: dead.pid, since: 'then', cwd: '/x' }));
  const t0 = Date.now();
  const r = await start(['proof/all.ts', '--only', 'no part has this name'], env).done;
  same('stale: taken at once', [r.code, /is stale/.test(r.out), /waiting/.test(r.out)], [0, true, false]);
  ok('stale: within 10 s', Date.now() - t0 < 10_000, `${Date.now() - t0} ms`);
}
finish();
