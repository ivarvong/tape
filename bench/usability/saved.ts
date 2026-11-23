// bench/usability/saved.ts: is the program the agent saved the one it tested? An agent sends its program's text to
// compile and run, and saves it with the file tools, so the two can part: an edit after the last run, or a fix made in
// the text it sent and not in the file. On 2026-11-23 that lost 3 runs in 2 rounds (edc22e6 invoice-1; 2e36c1a
// ratelimit-1 and -2, `true` fixed in the run but not in solution/). This records it, as a metric only: the agent's
// prompt and the grading stay as they are, so rounds stay comparable.
import { callTool, recs, str } from './lib.ts';
import type { File } from './lib.ts';

export type SavedCheck = {
  /** solution/ is not the last program the agent sent to compile or run (null: it sent none) */
  differsFromLastRun: boolean | null;
  /** solution/ is not the last program that compiled (null: none compiled) */
  differsFromLastCompiled: boolean | null;
  /** solution/, as saved, compiles on prod (`compile`), and the codes it is refused with when not */
  compiles: boolean;
  codes: string[];
};

/** The same program: the same files by name, each with the same text (file order does not count). */
export const sameProgram = (a: readonly File[], b: readonly File[]): boolean => {
  if (a.length !== b.length) return false;
  const byName = new Map(b.map(f => [f.name, f.text]));
  return a.every(f => byName.get(f.name) === f.text);
};

/** How the saved program stands against what was tested, given how it compiles. */
export const savedAgainst = (
  saved: readonly File[],
  lastRun: readonly File[] | null,
  lastCompiled: readonly File[] | null,
  compiled: { ok: boolean; codes: string[] },
): SavedCheck => ({
  differsFromLastRun: lastRun === null ? null : !sameProgram(saved, lastRun),
  differsFromLastCompiled: lastCompiled === null ? null : !sameProgram(saved, lastCompiled),
  compiles: compiled.ok,
  codes: compiled.codes,
});

/** solution/ compiled on prod as saved, through the MCP `compile` tool (the one the agent had). */
export const compileSaved = async (files: File[]): Promise<{ ok: boolean; codes: string[] }> => {
  const a = await callTool('compile', { files });
  const codes = recs(a['diagnostics']).map(d => str(d['code']));
  if (typeof a['error'] === 'string') codes.push(a['error']);
  return { ok: a['ok'] === true, codes };
};
