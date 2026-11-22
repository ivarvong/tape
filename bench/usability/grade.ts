// bench/usability/grade.ts: runs a task's hidden acceptance requests against a program, through prod's MCP `run`.
//   node bench/usability/grade.ts <task> <file.tape>...     prints each check, exits 0 when every check passes
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as invoice from './accept/invoice.ts';
import * as ledger from './accept/ledger.ts';
import * as orders from './accept/orders.ts';
import * as ratelimit from './accept/ratelimit.ts';
import * as sales from './accept/sales.ts';
import * as shortener from './accept/shortener.ts';
import * as todo from './accept/todo.ts';
import * as webhook from './accept/webhook.ts';
import { run } from './lib.ts';
import type { Check, File, Grader, Scenario } from './lib.ts';

export const TASKS = ['todo', 'ledger', 'ratelimit', 'webhook', 'orders', 'shortener', 'sales', 'invoice'] as const;

export type Graded = {
  task: string;
  compiled: boolean;
  diagnostics: string[];
  checks: (Check & { scenario: string })[];
  passed: number;
  total: number;
  skipped: number;
};

const GRADERS: Record<(typeof TASKS)[number], Grader> = {
  todo: todo.grader,
  ledger: ledger.grader,
  ratelimit: ratelimit.grader,
  webhook: webhook.grader,
  orders: orders.grader,
  shortener: shortener.grader,
  sales: sales.grader,
  invoice: invoice.grader,
};
const isTask = (t: string): t is (typeof TASKS)[number] => (TASKS as readonly string[]).includes(t);

export const grade = async (task: string, files: File[]): Promise<Graded> => {
  if (!isTask(task)) throw new Error(`no task ${task}`);
  const g = GRADERS[task];
  const out: Graded = {
    task,
    compiled: files.length > 0,
    diagnostics: [],
    checks: [],
    passed: 0,
    total: 0,
    skipped: 0,
  };
  const one = async (s: Scenario, depth: number): Promise<void> => {
    const a = files.length > 0 ? await run(files, s.requests) : null;
    if (a !== null && !a.compiled) {
      out.compiled = false;
      out.diagnostics = a.diagnostics.map(d => `${d.code} ${d.file}:${d.line} ${d.message.slice(0, 120)}`);
      if (a.error !== undefined) out.diagnostics.push(a.error);
    }
    // A program that does not compile (or no program) fails every check of the scenario, but the checks are still
    // counted so a task's total does not depend on its solution.
    const rs = a?.results ?? [];
    for (const c of s.checks(rs)) out.checks.push({ ...c, scenario: s.name });
    if (depth === 0 && s.followup !== undefined && rs.length > 0) {
      const next = s.followup(rs);
      if (next !== null) await one(next, 1);
    }
  };
  for (const s of g.scenarios) await one(s, 0);
  out.total = out.checks.filter(c => c.skipped !== true).length;
  out.passed = out.checks.filter(c => c.pass && c.skipped !== true).length;
  out.skipped = out.checks.filter(c => c.skipped === true).length;
  return out;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [task, ...paths] = process.argv.slice(2);
  if (task === undefined || !(TASKS as readonly string[]).includes(task)) {
    console.error(`usage: node bench/usability/grade.ts <${TASKS.join('|')}> <file.tape>...`);
    process.exit(2);
  }
  const files = paths.map(p => ({ name: basename(p), text: readFileSync(p, 'utf8') }));
  const g = await grade(task, files);
  for (const d of g.diagnostics) console.log(`  diag ${d}`);
  for (const c of g.checks)
    console.log(
      `${c.skipped === true ? 'skip' : c.pass ? ' ok ' : 'FAIL'}  ${c.scenario}: ${c.name}${c.pass ? '' : `  (${c.detail ?? ''})`}`,
    );
  console.log(`${task}: ${g.passed}/${g.total} checks${g.skipped > 0 ? `, ${g.skipped} skipped` : ''}`);
  process.exit(g.passed === g.total ? 0 : 1);
}
