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

/** How a run that failed ended: its transaction was rolled back.
 * `unstarted`: the failure came before the log began, so no stretch committed. */
export type Failed = {
  status: number | string;
  error: string;
  rolled_back: true;
  storage?: true;
  unstarted?: true;
};

// What a request did to stored data. The retry line is part of the state, so a response cannot name an outcome and
// leave out what the client should do. `partly` is the fourth state the three names sit beside: the stretches before
// the run's last call were kept and the rest was rolled back (R-ANS-2).
const RETRY = {
  applied: 'the request finished; sending it again can apply it a second time',
  not_applied: 'nothing was kept; sending it again cannot apply it twice',
  partly:
    "writes before the last call were kept; sending it again can repeat that part, so only with the program's own idempotency key",
  unknown:
    "the service cannot tell whether it was kept; sending it again can apply it a second time, so only with the program's own idempotency key",
} as const;
/** What this request did, as far as the service can tell. Exactly one of these. */
export type Apply =
  | { outcome: 'applied'; retry: typeof RETRY.applied }
  | { outcome: 'not_applied'; retry: typeof RETRY.not_applied }
  | { outcome: 'partly'; retry: typeof RETRY.partly }
  | { outcome: 'unknown'; retry: typeof RETRY.unknown };
export const APPLY = {
  applied: { outcome: 'applied', retry: RETRY.applied },
  not_applied: { outcome: 'not_applied', retry: RETRY.not_applied },
  partly: { outcome: 'partly', retry: RETRY.partly },
  unknown: { outcome: 'unknown', retry: RETRY.unknown },
} as const satisfies { [K in Apply['outcome']]: Extract<Apply, { outcome: K }> };
/** The body fields and headers of one outcome. `retry` says whether sending the request again is safe. `retry-after`
 * is only on a transient `not_applied`: that header says a retry may succeed, and it is not set on `unknown` (the
 * request may already have been kept) or on a `not_applied` that will not change (a trap, a retired version). */
export type EncodedOutcome = {
  outcome: Apply['outcome'];
  retry: string;
  transient?: true;
};
export function encodeOutcome(
  apply: Apply,
  transient = false,
): { body: EncodedOutcome; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'tape-outcome': apply.outcome };
  const retryAfter = transient && apply.outcome === 'not_applied';
  if (retryAfter) headers['retry-after'] = '1';
  switch (apply.outcome) {
    case 'applied':
      return { body: { outcome: 'applied', retry: apply.retry }, headers };
    case 'not_applied':
      return {
        body: { outcome: 'not_applied', retry: apply.retry, ...(retryAfter ? { transient: true } : {}) },
        headers,
      };
    case 'partly':
      return { body: { outcome: 'partly', retry: apply.retry }, headers };
    case 'unknown':
      return { body: { outcome: 'unknown', retry: apply.retry }, headers };
    default: {
      // The data object is given the host and records, not the compiler, so this is the never the shared
      // unreachable would throw on. A new outcome is a type error here.
      const missed: never = apply;
      return missed;
    }
  }
}
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

const TAGS = ['build', 'q', 'call', 'secret', 'now', 'random', 'wake', 'migrate', 'prepare', 'machines'];
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
/** A secret as the name's object gives it to its program's run (Name.secretValues): never logged, never answered. */
export type StoredSecret = { name: string; version: number; value: Uint8Array };
/** The operator's answers about secrets: never a value. */
export type SecretSet =
  | { account: string; name: string; secret: string; version: number; bytes: number; at: number }
  | { error: string; status: 409 };
export type SecretGone = { account: string; name: string; secret: string; deleted: number };
export type SecretListed = { name: string; version: number; at: number; bytes: number; kept: number[] };

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
