// rules/plan.ts: the machines of a chain of versions, and what each version would do under the newest.
import type { Program } from '../compiler/ast.ts';
import type { Problem } from '../compiler/common.ts';
import { checkMachine, machineContext } from './machines.ts';
import type { MachineContext } from './machines.ts';
import { sqlModel, tablesOf } from './model.ts';

// The machines in force on one name's data, when several versions are live (service/src/index.ts). Each version
// that declares a machine allows the moves it declares; a version that does not declare it is read under it with
// the same checks (checkMachine), and the moves and starts it makes are allowed too, so a version already running
// is not stopped by a machine a later version brought. Its problems under the machine are notes (shown by ?rules),
// except C60: a write whose states cannot be told cannot be allowed, and refuses the upload that would put it
// under a machine.

/** One live version of a program. */
export type Version = { readonly version: number; readonly prog: Program };
/** A machine as every live version leaves it: what each declares, and what the others do under it. */
export type PlannedMachine = {
  table: string;
  column: string;
  start: string | null;
  starts: (string | null)[];
  states: string[];
  moves: [string, string][];
  /** the versions that declare it */
  by: number[];
};
export type VersionProblem = Problem & { readonly version: number };
export type MachinePlan = { machines: PlannedMachine[]; refusals: VersionProblem[]; notes: VersionProblem[] };

type Merged = Omit<PlannedMachine, 'starts' | 'moves'> & {
  starts: Set<string | null>;
  moves: Map<string, [string, string]>;
};
const SEP = '\u0000';

function allow(x: Merged, states: Iterable<string>): void {
  for (const st of states) if (!x.states.includes(st)) x.states.push(st);
}

/** Every machine a version declares, with the moves and states of each version that declares it. */
function declared(versions: readonly Version[]): Merged[] {
  const all = new Map<string, Merged>();
  for (const { version, prog } of versions)
    for (const m of prog.machines ?? []) {
      const key = `${m.table}.${m.column}`;
      const x: Merged = all.get(key) ?? {
        table: m.table,
        column: m.column,
        start: m.start,
        starts: new Set(),
        states: [],
        moves: new Map(),
        by: [],
      };
      all.set(key, x);
      x.start = m.start;
      x.starts.add(m.start);
      x.by.push(version);
      allow(x, m.states);
      for (const mv of m.moves) x.moves.set(`${mv.from}${SEP}${mv.to}`, [mv.from, mv.to]);
    }
  return [...all.values()];
}

/** A version that does not declare the machine, read under it: its problems, and what it does allowed too. */
function readUnder(x: Merged, { version, prog }: Version, latest: Program, plan: MachinePlan): void {
  const decl = { ...x, moves: [...x.moves.values()].map(([from, to]) => ({ from, to })) };
  const ctx: MachineContext = {
    ...machineContext(prog),
    tables: tablesOf(latest),
    schema: sqlModel(latest).schema,
    foreign: true,
  };
  const r = checkMachine(decl, ctx);
  const under = `under machine ${x.table}.${x.column} (declared by v${x.by.join(', v')})`;
  // C62 is about how a program handles the outcome of its own writes: it says nothing of the moves another
  // version makes, so it is no note here
  for (const p of r.problems)
    if (p.code !== 'C62')
      (p.code === 'C60' ? plan.refusals : plan.notes).push({ version, ...p, message: `${under}: ${p.message}` });
  if (r.problems.some(p => p.code === 'C60')) return;
  for (const k of r.moves) {
    const [from = '', to = ''] = k.split(SEP);
    x.moves.set(k, [from, to]);
    allow(x, [from, to]);
  }
  for (const st of r.starts) {
    x.starts.add(st);
    allow(x, [st]);
  }
}

/** `versions`: oldest first; the table model is the newest one's, since the data's tables are the newest chain's. */
export function machinePlan(versions: readonly Version[]): MachinePlan {
  const plan: MachinePlan = { machines: [], refusals: [], notes: [] };
  const latest = versions.at(-1);
  if (!latest) return plan;
  for (const x of declared(versions)) {
    for (const v of versions)
      if (!(v.prog.machines ?? []).some(m => m.table === x.table && m.column === x.column))
        readUnder(x, v, latest.prog, plan);
    plan.machines.push({ ...x, starts: [...x.starts], moves: [...x.moves.values()] });
  }
  return plan;
}
