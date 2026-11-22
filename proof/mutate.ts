// proof/mutate.ts [count=40] [seed=1] [--since REV] [--all]: how much of the compiler and host the checks can see.
//   --since REV   only lines changed since that commit, in compiler, host, rules, sql and sim: what is new is what
//                 has been looked at least. Runs every test (the quickest and most likely to notice first).
//   --all         every test, without --since
//   --files A,B   only files whose path starts with one of these (rules/,sql/)
//   --out FILE    also write the results as JSON
// Each mutant is one small change to compiler.ts or host.ts (an operator flipped, a constant or an opcode
// changed, a mark removed), made in a temporary copy of the repository. It is killed when any check fails, throws
// or runs out of time. Survivors are printed: each is either a change that does not matter or a hole in the checks.
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname,
  nums = process.argv.slice(2).filter(a => /^\d+$/.test(a)),
  COUNT = Number(nums[0] ?? 40),
  SEED = Number(nums[1] ?? 1);
const flag = (k: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i < 0 ? null : (process.argv[i + 1] ?? '');
  },
  SINCE = flag('since'),
  WIDE = SINCE !== null || process.argv.includes('--all'),
  FILES = flag('files')?.split(',') ?? null;
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const COPY = [
  ...readdirSync(ROOT).filter(f => /\.(ts|json|md)$/.test(f)),
  'std',
  'test',
  'host',
  'sim',
  'cli',
  'compiler',
  'interp',
  'rules',
  'sql',
  'examples',
  'proof',
  'bench',
  'adapters',
  ...(WIDE ? ['apps', 'experiments', 'testdata', 'service'] : []),
];
const OPS: readonly (readonly [RegExp, string])[] = [
  [/===/g, '!=='],
  [/!==/g, '==='],
  [/ < /g, ' <= '],
  [/ <= /g, ' < '],
  [/ > /g, ' >= '],
  [/ && /g, ' || '],
  [/ \|\| /g, ' && '],
  [/\+ 1\b/g, '+ 2'],
  [/\btrue\b/g, 'false'],
  [/\bfalse\b/g, 'true'],
  [/0x6a\b/g, '0x6b'],
  [/0x46\b/g, '0x47'],
  [/0x45\b/g, '0x50'],
  [/\bmark\(/g, '(() => {})('],
];
const CHECKS = WIDE
  ? [
      ['test/core.ts'],
      ['test/mutants.ts'],
      ['test/json.ts'],
      ['test/tickets-findings.ts'],
      ['test/generics.ts'],
      ['test/remotes.ts'],
      ['test/names.ts'],
      ['test/calls.ts'],
      ['test/git.ts'],
      ['test/timers-way-out.ts'],
      ['test/do-invariants.ts'],
      ['test/ergonomics.ts'],
      ['test/forms.ts'],
      ['test/memory.ts'],
      ['test/machines.ts'],
      ['test/rules-retries.ts'],
      ['test/sim-core.ts'],
      ['test/sim-auto.ts'],
      ['test/timers-keys.ts'],
      ['test/survivors.ts'],
      ['test/definition.ts'],
      ['test/queue.ts'],
      ['proof/verify.ts', '150'],
      ['proof/schedule.ts'],
    ]
  : [['test/core.ts'], ['test/generics.ts'], ['test/calls.ts'], ['proof/verify.ts', '150'], ['proof/schedule.ts']];
// the lines of a file added or changed since a commit
const changed = (file: string, since: string): Set<number> => {
  const out = new Set<number>();
  for (const m of execFileSync('git', ['diff', '-U0', since, '--', file], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  }).matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm))
    for (let i = 0; i < Number(m[2] ?? 1); i++) out.add(Number(m[1]) + i - 1);
  return out;
};
type Site = { file: string; line: number; at: number; len: number; to: string; from: string };
const sites: Site[] = [];
// every source file under a directory of the toolchain, in its subdirectories too
const under = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.ts'))
    .toSorted()
    .map(f => `${dir}/${f}`);
for (const file of [
  'host.ts',
  ...(WIDE ? ['host', 'compiler', 'rules', 'sql', 'sim'] : ['host', 'compiler']).flatMap(under),
]) {
  if (FILES && !FILES.some(prefix => file.startsWith(prefix))) continue;
  const only = SINCE === null ? null : changed(file, SINCE);
  for (const [i, line] of readFileSync(join(ROOT, file), 'utf8').split('\n').entries()) {
    if (only && !only.has(i)) continue;
    // comments and message text
    if (/^\s*(\/\/|\*)/.test(line) || /fail\(|throw new Error|console\./.test(line)) continue;
    const code = line.replace(/\/\/.*$/, '');
    for (const [re, to] of OPS)
      for (const m of code.matchAll(re)) sites.push({ file, line: i, at: m.index, len: m[0].length, to, from: m[0] });
  }
}
let s = SEED >>> 0 || 1;
const rnd = (n: number): number => {
  s = (Math.imul(s, 1103515245) + 12345) >>> 0;
  return Math.floor((s / 4294967296) * n);
};
const pool = [...sites];
const chosen: Site[] = Array.from({ length: Math.min(COUNT, sites.length) }, () =>
  pool.splice(rnd(pool.length), 1),
).flat();
type Ran = { bad: boolean; why: string };
const exec = (cwd: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<Ran> =>
  new Promise(done => {
    const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env } });
    let out = '';
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      done({ bad: true, why: 'timeout' });
    }, 120000);
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    p.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    p.on('close', code => {
      clearTimeout(t);
      done({ bad: code !== 0 || /^FAIL/m.test(out), why: code !== 0 ? `exit ${code}` : 'a check failed' });
    });
  });
type Scored = Site & { killedBy: string | null; why?: string; text?: string };
/** A copy of the tree to mutate; `use` gets its directory, and the copy is removed after. */
async function inCopy<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'tape-mut-'));
  try {
    for (const f of COPY)
      cpSync(join(ROOT, f), join(dir, f), { recursive: true, filter: p => !p.includes('node_modules') });
    return await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** The first check that fails in a copy, and why; null when all pass. */
async function firstFailing(dir: string): Promise<{ check: string; why: string } | null> {
  for (const c of CHECKS) {
    const r = await exec(dir, c, { VERIFY_ONLY: 'generated' });
    if (r.bad) return { check: c[0] ?? '', why: r.why };
  }
  return null;
}
const one = (m: Site): Promise<Scored> =>
  inCopy(async dir => {
    const lines = readFileSync(join(dir, m.file), 'utf8').split('\n');
    const line = lines[m.line] ?? '';
    lines[m.line] = line.slice(0, m.at) + m.to + line.slice(m.at + m.len);
    writeFileSync(join(dir, m.file), lines.join('\n'));
    const failed = await firstFailing(dir);
    if (failed) return { ...m, killedBy: failed.check, why: failed.why };
    return { ...m, killedBy: null, text: (lines[m.line] ?? '').trim().slice(Math.max(0, m.at - 60), m.at + 60) };
  });
// the checks must pass on an unchanged copy, or a kill means nothing
const broken = await inCopy(firstFailing);
if (broken) {
  console.log(`the checks fail on an unchanged copy (${broken.check}: ${broken.why}); nothing was scored`);
  process.exit(1);
}
const results: Scored[] = [];
const queue = [...chosen];
const t0 = Date.now();
const OUT = flag('out');
await Promise.all(
  Array.from({ length: Number(flag('jobs') ?? 4) }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const r = await one(m);
      results.push(r);
      // as it goes: a long run that is stopped still leaves what it found
      console.log(
        `${results.length}/${chosen.length} ${r.killedBy ? `killed by ${r.killedBy}` : 'SURVIVED'} ${r.file}:${r.line + 1} ${r.from} -> ${r.to}`,
      );
      if (OUT !== null) writeFileSync(resolve(ROOT, OUT), JSON.stringify({ partial: true, results }, null, 1));
    }
  }),
);
const killed = results.filter(r => r.killedBy !== null);
const by: Record<string, number> = {};
for (const r of killed) by[r.killedBy ?? ''] = (by[r.killedBy ?? ''] ?? 0) + 1;
console.log(
  `${sites.length} possible mutants; sampled ${results.length} (seed ${SEED}); killed ${killed.length}, survived ${results.length - killed.length}; ${Math.round((Date.now() - t0) / 1000)} s`,
);
console.log('first check to kill:', JSON.stringify(by));
for (const r of results.filter(x => x.killedBy === null))
  console.log(`SURVIVED ${r.file}:${r.line + 1}  ${r.from} -> ${r.to}   … ${r.text} …`);
if (OUT !== null)
  writeFileSync(
    resolve(ROOT, OUT),
    JSON.stringify(
      {
        since: SINCE,
        seed: SEED,
        possible: sites.length,
        sampled: results.length,
        killed: killed.length,
        by,
        survivors: results
          .filter(r => r.killedBy === null)
          .map(r => ({ file: r.file, line: r.line + 1, from: r.from, to: r.to, text: r.text })),
      },
      null,
      1,
    ) + '\n',
  );
