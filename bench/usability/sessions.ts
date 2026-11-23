// bench/usability/sessions.ts: when a session says nothing of Tape, and what the runner does about it. Prod's MCP
// server limits calls per address per minute; a session that met the limit either never had the tools (its tape
// server did not connect) or had a compile or run refused for it, and either way its counts are the limiter's, not
// Tape's. The runner starts such a session again after a wait, and a job still spoiled after the last try is left out
// of summary.md's numbers (and listed there with the reason).
import { analyse, connected } from './transcript.ts';

/** Why a session's counts say nothing of Tape, or null when they do. */
export const spoiledBy = (lines: string[]): string | null => {
  if (!connected(lines)) return 'the tape server did not connect (or connected with no tools)';
  const limited = analyse(lines, 0).limitedTools;
  return limited > 0 ? `${limited} compile or run call${limited === 1 ? ' was' : 's were'} rate-limited` : null;
};

/** The wait before try `k` (1, 2, …) after a spoiled session: base·2^(k−1), plus up to one more base at random, so
 * jobs spoiled together (a limit hits every running job at once) do not all come back together. */
export const backoffMs = (k: number, random: () => number = Math.random, base = 65_000): number =>
  base * 2 ** (k - 1) + Math.floor(random() * base);

/** The caps of --max-concurrent-per-model (`haiku=3,sonnet=4`): a model runs at most its cap at a time, whatever
 * --parallel says. Haiku makes more calls a minute than Sonnet and met prod's limit at 4 (2026-11-23), so it is
 * capped at 3 unless the flag says otherwise. A key caps every model whose name contains it (`haiku` caps
 * `claude-haiku-5-5` too). */
export const DEFAULT_CAPS = 'haiku=3';
export const parseCaps = (spec: string): Map<string, number> => {
  const caps = new Map<string, number>();
  for (const part of spec.split(',')) {
    if (part.trim() === '') continue;
    const [name, n] = part.split('=');
    const cap = Number(n);
    if (name === undefined || name.trim() === '' || !Number.isInteger(cap) || cap < 1)
      throw new Error(`--max-concurrent-per-model: "${part}" is not model=count (a whole number, 1 or more)`);
    caps.set(name.trim(), cap);
  }
  return caps;
};
/** How many jobs of this model run at once. */
export const concurrencyFor = (model: string, parallel: number, caps: Map<string, number>): number => {
  let n = parallel;
  for (const [name, cap] of caps) if (model.includes(name)) n = Math.min(n, cap);
  return n;
};
