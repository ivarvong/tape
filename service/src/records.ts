// records.ts: what the service stores and passes between its parts, as types. A request's log is the program's
// effect log (host/log.ts); a migration run and an upload check are recorded in the same table, as logs of their
// own steps. Types only: program.ts runs in a Dynamic Worker that is given no module but the host.
import type { Effect, Head, MachineSpec, Migrated } from '../../host.ts';
import type { CallEffect } from '../../host/log.ts';
import type { RouterRecord } from './spans.ts';

/** One line of a trace as it is shown: its class (fn, ok, bad, mut), then its text. (A list, not a pair: a pair
 * does not keep its length across an RPC.) */
export type Line = string[];
export type StatementError = { statement: string; reason: string };
/** Why data would not take a version: the version, and the migration, statement or query that fails. */
export type CheckProblem = { version: number; migration?: number; statement?: string; query?: string; reason: string };

/** How a run that failed ended: its transaction was rolled back. */
export type Failed = { status: number | string; error: string; rolled_back: true; storage?: true };
/** The timer a woken run answered. */
export type Woke = { key: number; due: number | null };
/** A run's first entry as the service stores it: the host's, and how the run ended when it did not finish. */
export type RunHead = Omit<Head, 'woke'> & { woke?: Woke; partial?: true; failed?: Failed };
/** The first entry of a migration run. */
export type MigrationsHead = {
  migrations: true;
  at: number;
  took: number;
  trace: string;
  span: string;
  parent: null;
  name: string;
  build: 'migrations';
};
/** The first entry of an upload check. */
export type CheckHead = {
  check: true;
  candidate: number;
  at: number;
  took?: number;
  trace: string;
  span: string;
  parent: null;
  name: string;
  build: 'check';
  problems: CheckProblem[];
};
/** A migration as an upload check tried it. */
export type MigrateStep = Migrated & { errors?: StatementError[] };
export type PrepareStep = { prepare: number; statements: number; errors: StatementError[]; waits?: true };
export type MachinesStep = { machines: string[]; statements: string[]; errors: StatementError[] };
export type Step = MigrateStep | PrepareStep | MachinesStep;
/** One entry of a stored log. */
export type Entry = Exclude<Effect, Head> | RunHead | MigrationsHead | CheckHead | Step;

const TAGS = ['build', 'q', 'call', 'now', 'random', 'wake', 'migrate', 'prepare', 'machines'];
/** Is this value, read from a stored log, one of its entries? Told by the field that names its kind. */
export const isEntry = (v: unknown): v is Entry => typeof v === 'object' && v !== null && TAGS.some(tag => tag in v);
export const isCheckHead = (e: Entry | undefined): e is CheckHead => e !== undefined && 'check' in e;
export const isMigrationsHead = (e: Entry | undefined): e is MigrationsHead => e !== undefined && 'migrations' in e;
export const isRunHead = (e: Entry | undefined): e is RunHead =>
  e !== undefined && 'build' in e && !('check' in e) && !('migrations' in e);
export const isMigrateStep = (e: Entry): e is MigrateStep => 'migrate' in e;
export const isPrepareStep = (e: Entry): e is PrepareStep => 'prepare' in e;
export const isMachinesStep = (e: Entry): e is MachinesStep => 'machines' in e;

/** One request as data: what came in, what went out (replayed), its log, and the trace made from it. */
export type RequestView = {
  id: string;
  version: number;
  at: number;
  effects: Entry[];
  source: string;
  queries: string[];
  request: string;
  status: number | string;
  response: string;
  trace: Line[];
  error: string | null;
  partial?: true;
  failed?: Failed;
};

/** The plan for a name's data: the live versions, and what the latest one's chain applies now. */
export type Plan = {
  /** the newest live version; 0 when none is live */
  latest: number;
  live: number[];
  apply: Chain;
  held: string | null;
  machines?: MachineSpec[];
};
export type Chain = { n: number; name: string; contract: boolean; statements: string[]; hash: string }[];
/** What a call carries besides its message. */
export type CallMeta = {
  method: string;
  fingerprint: string;
  key: string | null | undefined;
  withinMs: number | undefined;
  trace: { trace: string; parent: string } | null | undefined;
};

/** A call a run made, with what its callee recorded for it (null: nothing), or why it was not asked. */
export type JoinedCall = { e: CallEffect; served: ServedRow | null; why?: string };
/** What a callee recorded for one call it served: its run (view), or that it answered from a stored reply. */
export type ServedRow = {
  version: number;
  key: string | null;
  method: string | undefined;
  status: string;
  at: number;
  began: number | null;
  took: number | null;
  /** began and took in µs, when whoever recorded the row measured them so (absent: use the ms fields) */
  began_us?: number | null;
  took_us?: number | null;
  log_id: string | null;
  view: Run | null;
};
/** A run with the calls it made. */
export type Run = RequestView & { calls?: JoinedCall[] };
/** A run of a named program, with its calls. */
export type Joined = Run & { account: string; name: string; calls: JoinedCall[] };
/** One time a name's object took a routed call (_tape_invoked), with the run it led to. */
export type Invoked = {
  call_span: string;
  trace: string;
  version: number | null;
  log_id: string | null;
  name_span: string;
  began: number;
  took: number | null;
  facet_began: number | null;
  facet_took: number | null;
  status: number | null;
  error: string | null;
  fault: string | null;
  clock_lag: number | null;
  run: Joined | null;
  missing: string | null;
  recovered: boolean;
};
/** A routed request: the router's record, each time the object took the call, and the runs found for it. */
export type Routed = {
  account: string;
  name: string;
  call_span: string | null;
  route: RouterRecord | null;
  invoked: Invoked[];
  orphans?: Joined[];
  woken?: Joined[];
};
