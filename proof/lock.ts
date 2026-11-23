// proof/lock.ts: one gate at a time on a machine. Several agents running `node proof/all.ts` at once drove the load
// past 30 and the fault-injection seams test failed for that alone, so proof/all.ts (and service/scripts/gate.sh,
// which runs it) takes this lock first and a second run waits for the first to end.
// The lock is a file, <TAPE_STATE or ~/.local/state/tape>/gate.lock, made with O_EXCL and holding the holder's pid,
// when it took the lock and where it ran. A lock whose pid is gone (a run killed with SIGKILL, a machine that slept
// through a crash) is stale and the next run takes it; the run that takes it says so.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

export const lockPath = (): string => `${process.env['TAPE_STATE'] ?? `${homedir()}/.local/state/tape`}/gate.lock`;
export type Holder = { pid: number; since: string; cwd: string };

const codeOf = (e: unknown): unknown => (typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined);
function holderOf(path: string): Holder | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof v !== 'object' || v === null || !('pid' in v) || !('since' in v) || !('cwd' in v)) return null;
    const { pid, since, cwd } = v;
    return typeof pid === 'number' && typeof since === 'string' && typeof cwd === 'string' ? { pid, since, cwd } : null;
  } catch {
    return null;
  }
}
/** Whether a process with that pid is running and is node (a pid reused by something else is not the holder). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (codeOf(e) !== 'EPERM') return false;
  }
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.status !== 0 || ps.stdout === '' ? ps.error !== undefined : /node/.test(ps.stdout);
}
const ageMs = (path: string): number => {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};
/** Takes the file at path (O_EXCL) with the holder written in it; false when it exists. */
function create(path: string, holder: Holder): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if (codeOf(e) === 'EEXIST') return false;
    throw e;
  }
  writeSync(fd, `${JSON.stringify(holder)}\n`);
  closeSync(fd);
  return true;
}
/** Removes a stale lock: under a second, short-lived lock, and only if the file still names the stale holder, so two
 * waiters that both saw it stale cannot remove a lock one of them has just taken. */
function reap(path: string, stale: Holder | null): void {
  const guard = `${path}.reap`;
  if (ageMs(guard) > 10_000) rmSync(guard, { force: true });
  if (!create(guard, { pid: process.pid, since: new Date().toISOString(), cwd: process.cwd() })) return;
  try {
    const now = holderOf(path);
    if (JSON.stringify(now) === JSON.stringify(stale)) rmSync(path, { force: true });
  } finally {
    rmSync(guard, { force: true });
  }
}
const pause = (ms: number): Promise<void> =>
  new Promise(done => {
    setTimeout(done, ms);
  });

/** Waits for the lock and takes it; gives back what releases it (also done on exit). `say` hears each wait. */
export async function acquire(
  path = lockPath(),
  say: (line: string) => void = line => console.log(line),
): Promise<() => void> {
  mkdirSync(dirname(path), { recursive: true });
  const me: Holder = { pid: process.pid, since: new Date().toISOString(), cwd: process.cwd() };
  let told = '';
  for (;;) {
    me.since = new Date().toISOString();
    if (create(path, me)) break;
    const h = holderOf(path);
    if (h === null) {
      // being written this moment, or a file that is not a lock: the latter is stale after a few seconds
      if (ageMs(path) > 5000) {
        say(`the gate lock ${path} holds no holder: taking it`);
        reap(path, null);
      }
    } else if (!alive(h.pid)) {
      say(`the gate lock is stale (pid ${h.pid}, since ${h.since}, is gone): taking it`);
      reap(path, h);
      continue;
    } else if (told !== `${h.pid} ${h.since}`) {
      told = `${h.pid} ${h.since}`;
      say(`waiting for the gate lock (held by pid ${h.pid}, since ${h.since}, in ${h.cwd}); --no-lock runs anyway`);
    }
    // oxlint-disable-next-line no-await-in-loop -- waiting is the point
    await pause(500);
  }
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    if (holderOf(path)?.pid === process.pid) rmSync(path, { force: true });
  };
  process.on('exit', release);
  return release;
}
