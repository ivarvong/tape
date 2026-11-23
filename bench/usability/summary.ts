// bench/usability/summary.ts: a run's summary.md, from its results.json. A table per job, the aggregate, and the
// friction ranking: themes (themes.ts) scored by tasks affected × minutes lost to failed compiles, with evidence.
//   node bench/usability/summary.ts <results dir>      writes <results dir>/summary.md again
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES } from './themes.ts';
import type { Theme } from './themes.ts';
import { isObj } from './lib.ts';
import type { JobResult, RunInfo } from './run.ts';

const min = (ms: number | null): string => (ms === null ? '—' : (ms / 60_000).toFixed(1));
const cell = (s: string): string => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

type Hit = {
  theme: Theme;
  tasks: Set<string>;
  lostMs: number;
  diag: Record<string, number>;
  excerpts: string[];
  feedback: { task: string; text: string; id: string | null }[];
  failedChecks: { task: string; name: string }[];
};

// A theme that names the message wins over one that takes every message of the code.
const themeOfDiag = (code: string, message: string): Theme | null =>
  THEMES.find(t => (t.codes ?? []).some(c => c.code.test(code) && c.message?.test(message) === true)) ??
  THEMES.find(t => (t.codes ?? []).some(c => c.code.test(code) && c.message === undefined)) ??
  null;

export const rank = (jobs: JobResult[]): Hit[] => {
  const hits = new Map<string, Hit>();
  const hit = (t: Theme): Hit => {
    let h = hits.get(t.id);
    if (h === undefined) {
      h = { theme: t, tasks: new Set(), lostMs: 0, diag: {}, excerpts: [], feedback: [], failedChecks: [] };
      hits.set(t.id, h);
    }
    return h;
  };
  const own = (code: string, message: string): Theme => ({
    id: `code-${code}`,
    title: `${code}: ${cut(message, 90)}`,
    change: '(no theme yet: read the excerpts)',
    codes: [{ code: new RegExp(`^${code}$`) }],
    prior: [],
  });
  for (const j of jobs) {
    // Diagnostics: the theme of each code, and time lost from each failed attempt shared among its codes.
    for (const [i, a] of j.attempts.entries()) {
      const distinct = new Map<string, string>();
      for (const d of a.messages) if (!distinct.has(d.code)) distinct.set(d.code, d.message);
      const next = j.attempts[i + 1]?.t ?? j.wallMs;
      for (const [code, message] of distinct) {
        const t = themeOfDiag(code, message) ?? own(code, message);
        const h = hit(t);
        h.tasks.add(j.task);
        h.diag[code] = (h.diag[code] ?? 0) + a.messages.filter(d => d.code === code).length;
        if (!a.compiled) h.lostMs += (next - a.t) / distinct.size;
        const ex = `${j.task}: ${code} ${cut(message, 150)}`;
        if (h.excerpts.length < 3 && !h.excerpts.some(e => e.startsWith(`${j.task}: ${code}`))) h.excerpts.push(ex);
      }
    }
    for (const f of j.feedback) {
      const text = f.text.replace(/^\[usability-bench[^\]]*\]\s*/, '');
      for (const t of THEMES.filter(th => th.feedback?.test(text) === true)) {
        const h = hit(t);
        h.tasks.add(j.task);
        h.feedback.push({ task: j.task, text, id: f.id });
      }
    }
    for (const c of j.grade.checks.filter(k => !k.pass && k.skipped !== true)) {
      for (const t of THEMES.filter(th => th.checks?.test(c.name) === true)) {
        const h = hit(t);
        h.tasks.add(j.task);
        h.failedChecks.push({ task: j.task, name: c.name });
      }
    }
  }
  // A feedback report counts as one minute: agents report what cost them time outside compiles (reading the docs for
  // something that is not there, guessing names), which the compile log does not see.
  const score = (h: Hit): number => h.tasks.size * (h.lostMs / 60_000 + h.feedback.length);
  return [...hits.values()].toSorted(
    (a, b) =>
      score(b) - score(a) ||
      b.tasks.size - a.tasks.size ||
      b.feedback.length - a.feedback.length ||
      b.failedChecks.length - a.failedChecks.length ||
      b.theme.prior.length - a.theme.prior.length,
  );
};

export const render = (info: RunInfo, jobs: JobResult[]): string => {
  const out: string[] = [];
  const put = (...ls: string[]): void => {
    out.push(...ls);
  };
  const cost = jobs.reduce((s, j) => s + j.costUsd, 0);
  const full = jobs.filter(j => j.grade.total > 0 && j.grade.passed === j.grade.total).length;
  const passed = jobs.reduce((s, j) => s + j.grade.passed, 0);
  const total = jobs.reduce((s, j) => s + j.grade.total, 0);
  const compiled = jobs.filter(j => j.firstCompileMs !== null);
  put(`# Tape usability benchmark: ${info.runId}`, '');
  put(
    `Run ${info.date} against prod ${info.mcpUrl}: \`tape-version: ${info.tapeVersion}\`, \`tape-mcp-version: ${info.tapeMcpVersion}\`. ` +
      `Agent: \`claude -p\`, model \`${info.model}\`, ${info.n} run(s) per task, ${info.parallel} at a time, ` +
      `budget $${info.budgetUsd} and ${info.timeoutMin} min per run. Bench at \`${info.benchSha}\`. Each agent had only the ` +
      'task spec, README.md, LANGUAGE.md, docs/guide.md, docs/mcp.md and docs/std.md (local copies), and the MCP tools compile, run, feedback.',
    '',
  );
  put('## Headline', '');
  put(
    `- **Tasks fully accepted: ${full} of ${jobs.length}.** Acceptance checks passed: ${passed} of ${total} (${total === 0 ? 0 : Math.round((100 * passed) / total)}%).`,
  );
  put(
    `- Compiled at all: ${compiled.length} of ${jobs.length}; median time to first compile ${min(median(compiled.map(j => j.firstCompileMs ?? 0)))} min, ` +
      `median tool calls to it ${median(compiled.map(j => j.callsToFirstCompile ?? 0)) ?? '—'}.`,
  );
  put(
    `- Compile attempts ${jobs.reduce((s, j) => s + j.compileAttempts, 0)}, of which refused ${jobs.reduce((s, j) => s + j.failedAttempts, 0)}; ` +
      `feedback reports filed ${jobs.reduce((s, j) => s + j.feedback.length, 0)}; calls rate-limited ${jobs.reduce((s, j) => s + j.rateLimited, 0)}; schema probes (a stand-in text, not counted as attempts) ${jobs.reduce((s, j) => s + (j.probes ?? 0), 0)}.`,
  );
  put(
    `- Cost $${cost.toFixed(2)} (CLI-reported list price), ${jobs.reduce((s, j) => s + j.tokens.output, 0).toLocaleString('en-US')} output tokens.`,
    '',
  );

  put('## Per task', '');
  put(
    '| task | accepted | checks | first compile (min) | calls to it | compile attempts (refused) | run calls | diagnostics | feedback | cost | wall (min) | graded from |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const j of jobs) {
    const diags = Object.entries(j.diagnostics)
      .toSorted((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c}×${n}`)
      .join(' ');
    put(
      `| ${j.id} | ${j.grade.total > 0 && j.grade.passed === j.grade.total ? 'yes' : 'no'} | ${j.grade.passed}/${j.grade.total} | ${min(j.firstCompileMs)} | ${j.callsToFirstCompile ?? '—'} | ` +
        `${j.compileAttempts} (${j.failedAttempts}) | ${j.runCalls} | ${diags === '' ? '—' : diags} | ${j.feedback.length} | $${j.costUsd.toFixed(2)} | ${min(j.wallMs)}${j.timedOut ? ' (timed out)' : ''} | ${j.solutionFrom} |`,
    );
  }
  put('', 'Transcripts (not tracked): `<results dir>/<task>/transcript.jsonl`; solutions in `<task>/solution/`.', '');

  put('## Failed acceptance checks', '');
  for (const j of jobs) {
    const failed = j.grade.checks.filter(c => !c.pass && c.skipped !== true);
    if (failed.length === 0) continue;
    put(`- **${j.id}** (${failed.length}): ${failed.map(c => cell(c.name)).join('; ')}`);
  }
  put('');

  const ranked = rank(jobs);
  put('## Friction ranking', '');
  put(
    'Score = tasks affected × (minutes lost + feedback reports). Minutes lost: the time from each refused compile to the next attempt, shared among its codes; a feedback report that names the theme counts one minute, for time spent outside compiles. ' +
      'Ties go to more tasks, then more feedback, then more failed checks, then more evidence from before.',
    '',
  );
  put(
    '| # | theme | tasks | min lost | score | diagnostics | feedback | failed checks | change |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  ranked.forEach((h, i) => {
    const diags = Object.entries(h.diag)
      .map(([c, n]) => `${c}×${n}`)
      .join(' ');
    put(
      `| ${i + 1} | ${cell(h.theme.title)} | ${h.tasks.size} | ${(h.lostMs / 60_000).toFixed(1)} | ${(h.tasks.size * (h.lostMs / 60_000 + h.feedback.length)).toFixed(1)} | ${diags || '—'} | ${h.feedback.length} | ${h.failedChecks.length} | ${cell(h.theme.change)} |`,
    );
  });
  put('');
  put('### Evidence', '');
  ranked.forEach((h, i) => {
    put(`${i + 1}. **${h.theme.title}**. Tasks: ${[...h.tasks].join(', ')}.`);
    for (const e of h.excerpts) put(`   - diagnostic, ${cell(e)}`);
    for (const f of h.feedback.slice(0, 3))
      put(`   - feedback, ${f.task}${f.id === null ? '' : ` (${f.id})`}: ${cell(cut(f.text, 220))}`);
    if (h.failedChecks.length > 0)
      put(`   - failed checks: ${cell(cut(h.failedChecks.map(c => `${c.task}: ${c.name}`).join('; '), 260))}`);
    for (const p of h.theme.prior) put(`   - before: ${cell(p)}`);
  });
  put('');

  put('## Feedback filed this run', '');
  for (const j of jobs)
    for (const f of j.feedback)
      put(
        `- ${j.id}, ${f.kind}${f.id === null ? ' (not stored)' : `, ${f.id}`}: ${cell(cut(f.text.replace(/^\[usability-bench[^\]]*\]\s*/, ''), 400))}`,
      );
  put('');

  put('## Re-running', '');
  put(
    'After a release (prod answers a new `tape-version`): `node bench/usability/run.ts` (all tasks, once each; `--n 3` for ' +
      'variance, `--tasks a,b`, `--model`, `--parallel`, `--budget-usd`, `--timeout-min`). To see whether the old solutions ' +
      'still pass on the new release without new agents: `node bench/usability/run.ts --regrade <results dir>`. To grade one ' +
      'program by hand: `node bench/usability/grade.ts <task> <file.tape>...`. To rewrite this file: `node bench/usability/summary.ts <results dir>`.',
    '',
  );
  return out.join('\n');
};

export type Saved = { info: RunInfo; jobs: JobResult[] };
const isSaved = (v: unknown): v is Saved => isObj(v) && isObj(v['info']) && Array.isArray(v['jobs']);
/** A results directory's results.json, as run.ts wrote it. */
export const loadSaved = (dir: string): Saved => {
  const v: unknown = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
  if (!isSaved(v)) throw new Error(`${dir}/results.json is not a run's results`);
  return v;
};

export const writeSummary = (dir: string, info: RunInfo, jobs: JobResult[]): void => {
  writeFileSync(join(dir, 'summary.md'), render(info, jobs));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error('usage: node bench/usability/summary.ts <results dir>');
    process.exit(2);
  }
  const saved = loadSaved(dir);
  writeSummary(dir, saved.info, saved.jobs);
  console.log(`wrote ${join(dir, 'summary.md')}`);
}
