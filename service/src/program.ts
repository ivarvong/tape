// program.ts: the Dynamic Worker for one name's data. The supervisor (Name, in index.ts) loads it with every live
// version's builds (versions.js, generated) and runs its Program class as the name's one facet, "data": a child
// Durable Object whose SQLite holds the program's tables, schema_migrations and every request's effect log, shared
// by all live versions. Before the first request it runs the migrations env.PLAN.apply lists (the latest version's
// chain, up to any contract migration that is held), as one transaction, recorded like a request. env.CALLS reaches
// other programs in the same account; env.SELF names this object, so its command keys are the same in every version.
import { DurableObject } from 'cloudflare:workers';
import {
  instantiate,
  responseOf,
  traceOf,
  migrate,
  columns,
  removedBy,
  removalError,
  dropMachines,
  installMachines,
  machineTriggersIn,
  isEffect,
  isHead,
} from './host.ts';
import { redactedText } from './host.ts';
import type {
  App,
  Effect,
  Header,
  HttpAnswer,
  HttpRequest,
  MachineSpec,
  SecretStore,
  SessionChange,
  ServiceReply,
  Sql,
  TraceEvent,
  Transaction,
} from './host.ts';
import versions from './versions.ts';
import type { VersionBuild } from './versions.ts';
import { storageKind, transientAtEdge, transientBetween } from './host.ts';
import { APPLY, encodeOutcome, isCheckHead, isEntry, isMigrationsHead, isRunHead } from './records.ts';
import { randomHex } from './web.ts';
import type {
  Apply,
  CallMeta,
  Chain,
  CheckHead,
  CheckProblem,
  Entry,
  Failed,
  Line,
  MigrateStep,
  MigrationsHead,
  Plan,
  RequestView,
  RunHead,
  StatementError,
  Step,
  StoredSecret,
  Woke,
} from './records.ts';

export type Env = {
  PLAN: Plan;
  /** this object's name: its command keys are the same in every version */
  SELF: string;
  /** other programs in the same account; and this program's own secrets, every version kept (Name.secretValues) */
  CALLS: {
    call: (to: string, meta: CallMeta, bytes: Uint8Array) => Promise<ServiceReply>;
    secrets: (all: boolean) => Promise<StoredSecret[]>;
    /** this program's HTTP request, sent by the Worker to a host on the name's list (outbound.ts) */
    http: (request: HttpRequest, withinMs: number) => Promise<HttpAnswer>;
  };
};

const LOG =
  'CREATE TABLE IF NOT EXISTS _tape_log(id TEXT PRIMARY KEY, version INTEGER NOT NULL, request BLOB NOT NULL, effects TEXT NOT NULL, at INTEGER NOT NULL)';
const dec = new TextDecoder(),
  enc = new TextEncoder();
type Fields = Readonly<Record<string, unknown>>;
const fieldsOf = (v: unknown): Fields => (typeof v === 'object' && v !== null ? { ...v } : {});
const textOf = (v: unknown): string => (typeof v === 'string' ? v : '');
const numberOf = (v: unknown): number => (typeof v === 'number' ? v : 0);
const textsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A custom section of a module that holds a JSON list. */
const section = (m: WebAssembly.Module, n: string): unknown[] => {
  const [bytes] = WebAssembly.Module.customSections(m, n);
  const list: unknown = bytes ? JSON.parse(dec.decode(bytes)) : [];
  return Array.isArray(list) ? list : [];
};
const schemaOf = (m: WebAssembly.Module): string[] => textsOf(section(m, 'schema'));
const chainOf = (m: WebAssembly.Module): Chain =>
  section(m, 'migrations')
    .map(fieldsOf)
    .map(x => ({
      n: numberOf(x.n),
      name: textOf(x.name),
      contract: x.contract === true,
      statements: textsOf(x.statements),
      hash: textOf(x.hash),
    }));
const methodsOf = (m: WebAssembly.Module): { name: string; fingerprint: string }[] =>
  section(m, 'methods')
    .map(fieldsOf)
    .map(x => ({ name: textOf(x.name), fingerprint: textOf(x.fingerprint) }));

/** A live version: its builds, and what is read from them once. `secrets`: it reads secrets (imports env.secret). */
type Version = VersionBuild & { lines: string[]; queries: string[]; chain: Chain; woken: boolean; secrets: boolean };
const V = new Map<number, Version>(
  Object.entries(versions).map(([v, b]) => [
    Number(v),
    {
      ...b,
      lines: b.source.split('\n'),
      queries: section(b.plain, 'queries').map(q => textOf(fieldsOf(q).sql)),
      chain: chainOf(b.plain),
      woken: methodsOf(b.plain).some(m => m.name === 'woken'),
      secrets: WebAssembly.Module.imports(b.plain).some(i => i.module === 'env' && i.name === 'secret'),
    },
  ]),
);
/** What a stretch of a run came to, as far as the log needs: it answered (out), or it waits on a call (pending). */
type Stretch = { out?: unknown; pending?: unknown };
const NO_STRETCH: Stretch = {};
const stretchOf = (r: unknown): Stretch => (typeof r === 'object' && r !== null ? r : NO_STRETCH);
const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const ROLLBACK = Symbol('rollback');
/** Run f in a transaction that is always rolled back. */
const rolledBack = (storage: DurableObjectStorage, f: () => void): void => {
  try {
    storage.transactionSync(() => {
      f();
      // oxlint-disable-next-line typescript/only-throw-error -- a marker, not a failure: it undoes the transaction
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
};
// workerd wants every ?N bound, even for EXPLAIN, which runs nothing
const nulls = (q: string): null[] =>
  Array.from<null>({ length: Math.max(0, ...[...q.matchAll(/\?(\d+)/g)].map(m => Number(m[1]))) }).fill(null);
const byVersion = (): number[] => [...V.keys()].toSorted((a, b) => a - b);
/** Run each statement; the ones that fail, with why. */
const tryAll = (list: readonly string[], each: (st: string) => unknown): StatementError[] =>
  list.flatMap(st => {
    try {
      each(st);
      return [];
    } catch (e) {
      return [{ statement: st, reason: messageOf(e) }];
    }
  });
// Every live version's schema statements, run before the migrations so a fresh name has the tables its migrations
// change. A statement may also need a column a migration adds; it fails here, harmlessly, and runs again (and must
// work) when its version is instantiated after the migrations.
const schemaFirst = (sql: Sql): void => {
  for (const v of byVersion()) {
    const b = V.get(v);
    if (b) tryAll(schemaOf(b.plain), st => sql.exec(st).toArray());
  }
};

/** What the answer did to the client's session, for the Worker (programs.ts): the program's own headers are never
 * tape-…, so these are the host's. The Worker turns them into a cookie on the program's own origin, and drops them
 * everywhere else. */
const sessionHeaders = (s: SessionChange): Record<string, string> => {
  if (s === null) return {};
  if ('end' in s) return { 'tape-session-end': '1' };
  const id = btoa(s.start).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return { 'tape-session-start': id };
};
// The program's Response, as the frame its generated `handle` writes (host.ts responseOf): the status, the content
// type, the headers and the body, each checked; a status or a header the host refuses is a 500 that says why.
const split = responseOf;

/** A trace event's line when it is an effect; null when it is a place in the program. */
const effectLine = (e: TraceEvent): Line[] | null => {
  if ('flags' in e) return [];
  if ('call' in e)
    return [[e.status === 'ok' ? 'ok' : 'bad', `      call ${e.call}.${e.method} within ${e.within} ms → ${e.status}`]];
  if ('wake' in e) return [['mut', `      wake ${e.wake} after ${e.after} ms → due ${new Date(e.due).toISOString()}`]];
  if ('now' in e) return [['mut', `      now -> ${e.now}`]];
  if ('random' in e) return [['mut', `      random -> ${e.random}`]];
  if ('secret' in e)
    return [['mut', `      secret ${e.secret} -> ${e.version === null ? 'none' : `version ${e.version}`}`]];
  if ('fetch' in e)
    return [
      [e.status === 'ok' ? 'ok' : 'bad', `      fetch ${e.method} ${e.fetch} within ${e.within} ms → ${e.status}`],
    ];
  if ('sql' in e)
    return [
      ['mut', `      sql ${e.sql} ${JSON.stringify(e.p)} → ${e.rows ? JSON.stringify(e.rows) : `${e.r} written`}`],
    ];
  return null;
};
// The trace as [class, text] lines: functions entered, arms taken (✓) or tried and missed (✗), effects indented.
// A replay keeps the first TRACE_SITES line events (host.ts traceOf); `cut` says how many more there were.
const traceLines = (b: Version, events: readonly TraceEvent[], cut = 0): Line[] => {
  // for each event at a site, whether the next event at that site is its match (what 1): one pass from the end,
  // where asking each event for its next by a slice and a search was quadratic in a long run's events
  const matchedAt = Array.from({ length: events.length }, () => false);
  const nextAt = new Map<number, number>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e === undefined || !('site' in e)) continue;
    matchedAt[i] = nextAt.get(e.site) === 1;
    nextAt.set(e.site, e.what);
  }
  const matched = (i: number): boolean => matchedAt[i] === true;
  const lines = events.flatMap((e, i): Line[] => {
    const line = effectLine(e);
    if (line || !('site' in e)) return line ?? [];
    const s = b.sites[e.site];
    if (s?.file !== 'program.tape') return [];
    const at = `${String(s.line).padStart(3)}  ${(b.lines[s.line - 1] ?? '').trim()}`;
    if (e.what === 2) return [['fn', s.fn]];
    if (e.what === 1) return [['ok', `  ✓ ${at}`]];
    return s.kind !== 'else' && !matched(i) ? [['mut', `  ✗ ${at}`]] : [];
  });
  return cut > 0
    ? [
        ...lines,
        [
          'mut',
          `… the trace stops here: ${cut} more arms tried were not kept (the run went on, and its effects are above)`,
        ],
      ]
    : lines;
};
const migrationLines = (steps: readonly Entry[]): Line[] =>
  steps.flatMap((m): Line[] =>
    'migrate' in m
      ? [
          [
            'fn',
            `migration ${m.migrate} "${m.name}"${m.contract ? ' contract' : ''}  ${m.hash.slice(0, 12)}  ${m.ms} ms`,
          ],
          ...m.statements.map((st): Line => ['ok', `  ✓ ${st}`]),
        ]
      : [],
  );
const failedLines = (errors: readonly StatementError[]): Line[] =>
  errors.map((e): Line => ['bad', `  ✗ ${e.statement}: ${e.reason}`]);
const migrateLines = (m: MigrateStep): Line[] => {
  const errors = m.errors ?? [],
    removed = m.removed ?? [];
  return [
    [
      'fn',
      `migration ${m.migrate} "${m.name}"${m.contract ? ' contract' : ''}  ${m.hash.slice(0, 12)}${removed.length > 0 ? `  removes ${removed.join(', ')}` : ''}`,
    ],
    ...m.statements.map((st): Line => {
      const e = errors.find(x => x.statement === st);
      return e ? ['bad', `  ✗ ${st}: ${e.reason}`] : ['ok', `  ✓ ${st}`];
    }),
  ];
};
const checkLines = (steps: readonly Entry[]): Line[] =>
  steps.flatMap((m): Line[] => {
    if ('machines' in m)
      return [
        [m.errors.length > 0 ? 'bad' : 'fn', `machines ${m.machines.join(', ')}: ${m.statements.length} triggers`],
        ...failedLines(m.errors),
        ...m.statements.map((st): Line => ['ok', `  ✓ ${st}`]),
      ];
    if ('migrate' in m) return migrateLines(m);
    if (!('prepare' in m)) return [];
    if (m.waits === true)
      return [
        [
          'mut',
          `prepare v${m.prepare}: not yet; it waits for a held contract migration, and is prepared when that runs`,
        ],
      ];
    return [
      [
        m.errors.length > 0 ? 'bad' : 'fn',
        `prepare v${m.prepare}: ${m.statements - m.errors.length} of ${m.statements} statements`,
      ],
      ...failedLines(m.errors),
    ];
  });

class StorageFault extends Error {
  readonly kind = 'reset' as const;
}
// W3C traceparent (version 00) to { trace, parent }, or null; all-zero ids are invalid
const traceOfHeader = (h: string | null): { trace: string; parent: string } | null => {
  const [, trace = '', parent = ''] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(h ?? '') ?? [];
  return trace !== '' && !/^0+$/.test(trace) && !/^0+$/.test(parent) ? { trace, parent } : null;
};
/** The effects a failed run had logged before it failed, when its log had begun. */
const effectsOf = (err: unknown): Effect[] | null => {
  const { effects } = fieldsOf(err);
  return Array.isArray(effects) && effects.length > 0 ? effects.filter(isEffect) : null;
};
/** A log as it is stored: its head, with how the run ended, then the rest. */
const withHead = (effects: readonly Effect[], more: Partial<RunHead>): Entry[] => {
  const [head, ...rest] = effects;
  return head && isHead(head) ? [{ ...head, ...more }, ...rest] : [...effects];
};
const bytesOf = (v: unknown): Uint8Array => (v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(0));
/** A stored log's entries. */
const logOf = (text: unknown): Entry[] => {
  const list: unknown = JSON.parse(textOf(text));
  return Array.isArray(list) ? list.filter(isEntry) : [];
};

/** A run's log as it is written: `keep` writes what the run has logged so far, `id` is the log's once it is written. */
type Logger = {
  id: () => string | null;
  keep: (effects: readonly Effect[], partial: boolean, failed?: Failed) => void;
};
/** What an upload check is given: the candidate version and what it would run on this data. */
export type Candidate = {
  candidate: number;
  schema: string[];
  chain: Chain;
  apply: Chain;
  queries: string[];
  machines?: MachineSpec[];
};
/** What a call served came to. */
export type ServedCall = {
  status: string;
  body: Uint8Array;
  version: number;
  id: string | null;
  next?: number | null;
};
/** One timer that was due, and how running it went. */
export type WokenRun = {
  key: number;
  version: number;
  status: string;
  due?: number | null;
  id?: string | null;
  error?: string;
  began: number;
  took: number;
};

/** The rows of this data in a state its machine does not declare, as errors. */
const strayRows = (sql: Sql, m: MachineSpec): StatementError[] => {
  const states = m.states ?? [],
    list = states.map(st => `'${st.replaceAll("'", "''")}'`).join(', ');
  return sql
    .exec(
      `SELECT "${m.column}" AS state, count(*) AS n FROM "${m.table}" WHERE "${m.column}" IS NULL OR "${m.column}" NOT IN (${list}) GROUP BY 1`,
    )
    .toArray()
    .map(r => ({
      statement: `machine ${m.table}.${m.column}`,
      reason: `${numberOf(r.n)} row${numberOf(r.n) > 1 ? 's are' : ' is'} in ${r.state === null ? 'no state (NULL)' : `"${textOf(r.state)}"`}, which machine ${m.table}.${m.column} does not declare (${states.join(', ')}); it can make no move`,
    }));
};
// The machines: every row already in a state the machines know, then their triggers installed as the wake
// would install them. A row in another state could make no declared move: the upload is refused.
const checkMachines = (sql: Sql, machines: readonly MachineSpec[]): { step: Step; errors: StatementError[] } => {
  const errors: StatementError[] = [],
    strays: StatementError[] = [];
  for (const m of machines) {
    try {
      strays.push(...strayRows(sql, m));
    } catch (e) {
      errors.push({ statement: `machine ${m.table}.${m.column}`, reason: messageOf(e) });
    }
  }
  let statements: string[] = [];
  try {
    statements = installMachines(sql, machines);
  } catch (e) {
    errors.push({ statement: `machine triggers`, reason: messageOf(e) });
  }
  const all = [...strays, ...errors];
  return { step: { machines: machines.map(m => `${m.table}.${m.column}`), statements, errors: all }, errors: all };
};
/** The migrations not yet applied, tried on this data: a step each, and the problems; it stops at the first that fails. */
const checkMigrations = (sql: Sql, candidate: number, pending: Chain): { steps: Step[]; problems: CheckProblem[] } => {
  const steps: Step[] = [],
    problems: CheckProblem[] = [];
  for (const m of pending) {
    const before = columns(sql),
      errors = tryAll(m.statements, st => sql.exec(st).toArray()),
      removed = removedBy(before, columns(sql));
    steps.push({
      migrate: m.n,
      name: m.name,
      hash: m.hash,
      contract: m.contract,
      statements: m.statements,
      removed,
      errors,
      ms: 0,
    });
    for (const e of errors)
      problems.push({
        version: candidate,
        migration: m.n,
        ...e,
        reason: `migration ${m.n} "${m.name}" fails on this data: ${e.reason}`,
      });
    if (removed.length > 0 && !m.contract)
      problems.push({ version: candidate, migration: m.n, reason: removalError(m, removed) });
    if (errors.length > 0) break;
  }
  return { steps, problems };
};
/** Every statement of a version prepared against the schema as it now stands. */
const checkPrepared = (
  sql: Sql,
  v: number,
  schema: readonly string[],
  queries: readonly string[],
): { step: Step; problems: CheckProblem[] } => {
  const schemaErrors = tryAll(schema, st => sql.exec(st).toArray()),
    errors = tryAll(queries, q => sql.exec(`EXPLAIN ${q}`, ...nulls(q)).toArray());
  return {
    step: { prepare: v, statements: schema.length + queries.length, errors: [...schemaErrors, ...errors] },
    problems: [
      ...schemaErrors.map(e => ({ version: v, ...e, reason: `schema statement fails: ${e.reason}` })),
      ...errors.map(e => ({ version: v, query: e.statement, reason: e.reason })),
    ],
  };
};
/** The migration already run on this data whose hash is not the candidate's, as a problem. */
const editedMigration = (sql: Sql, candidate: number, chain: Chain): { done: number; problem: CheckProblem | null } => {
  const done = sql.exec('SELECT version, name, hash FROM schema_migrations ORDER BY version').toArray();
  const at = done.findIndex((d, i) => chain[i] !== undefined && chain[i].hash !== d.hash),
    bad = done[at];
  if (!bad) return { done: done.length, problem: null };
  const version = numberOf(bad.version);
  return {
    done: done.length,
    problem: {
      version: candidate,
      migration: version,
      reason: `migration ${version} "${textOf(bad.name)}" ran on this data with hash ${textOf(bad.hash).slice(0, 12)}; v${candidate}'s is ${chain[at]?.hash.slice(0, 12) ?? ''}. Applied migrations are append-only: add a new one instead of editing it.`,
    },
  };
};
const failedResponse = (
  error: string,
  reason: string,
  transient: boolean,
  apply: Apply,
  headers: Record<string, string>,
): Response => {
  // retry-after only when nothing was kept. An unknown or a finished request must not ask to be sent again.
  const encoded = encodeOutcome(apply, transient);
  const status = apply.outcome === 'applied' ? 500 : apply.outcome === 'unknown' || transient ? 503 : 500;
  return new Response(JSON.stringify({ error, reason, ...encoded.body }), {
    status,
    headers: { ...headers, 'content-type': 'application/json', ...encoded.headers },
  });
};

/** Every string in a view with each secret value written `[secret <name>]`: what a run read never reaches a page,
 * a span or a log the service answers, even where the program put it (a row it wrote, a call's message). */
function scrubbed<T>(v: T, held: readonly StoredSecret[]): T {
  const read = held.filter(s => s.value.length > 0).map(s => ({ name: s.name, value: s.value }));
  if (read.length === 0) return v;
  // in place: each string of each object and array, written again
  const walk = (x: unknown): void => {
    if (Array.isArray(x))
      x.forEach((y: unknown, i) => {
        if (typeof y === 'string') x[i] = redactedText(y, read);
        else walk(y);
      });
    else if (typeof x === 'object' && x !== null && !(x instanceof Uint8Array))
      for (const [k, y] of Object.entries(x)) {
        if (typeof y === 'string') Reflect.set(x, k, redactedText(y, read));
        else walk(y);
      }
  };
  walk(v);
  return v;
}

export class Program extends DurableObject<Env> {
  readonly #apps = new Map<number, App>();
  /** this name's secrets, every version kept, as its object held them when the run in hand began */
  #held: StoredSecret[] = [];
  /** what the host reads them through: the newest version of a name, or a version a log names */
  readonly #secrets: SecretStore = {
    read: name => {
      let best: StoredSecret | null = null;
      for (const s of this.#held) if (s.name === name && (best === null || s.version > best.version)) best = s;
      return best === null ? null : { value: best.value, version: best.version };
    },
    at: (name, version) => this.#held.find(s => s.name === name && s.version === version)?.value ?? null,
  };
  /** Before a run of a version that reads secrets: what the name's object holds now (one call; none otherwise). */
  async #loadSecrets(version: number): Promise<void> {
    if (V.get(version)?.secrets !== true) return;
    this.#held = await this.env.CALLS.secrets(true);
  }
  /** { id } of the migration run this wake recorded, or { error } when the chain diverged */
  #migration: { id: string } | { error: string } | null = null;
  /** the machine triggers installed, or why they could not be */
  #machines: { installed: string[] } | { error: string } | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const { sql } = ctx.storage;
    sql.exec(LOG);
    // The machine triggers (host.ts, installMachines) are dropped while the schema statements and migrations run (a
    // migration may rebuild a table, or drop a column a trigger names), then made again from the plan: the machines
    // of every live version, with the moves the versions that do not declare them make (rules.ts, machinePlan).
    try {
      const plan = env.PLAN,
        at = Date.now();
      ctx.storage.transactionSync(() => {
        dropMachines(sql);
        schemaFirst(sql);
      });
      const applied = migrate(sql, plan.apply, { transaction: f => ctx.storage.transactionSync(f) });
      if (applied.length > 0) {
        const head: MigrationsHead = {
          migrations: true,
          at,
          took: Date.now() - at,
          trace: randomHex(16),
          span: randomHex(8),
          parent: null,
          name: env.SELF,
          build: 'migrations',
        };
        this.#migration = {
          id: this.record(plan.latest, enc.encode(`MIGRATE to v${plan.latest}`), [head, ...applied]),
        };
      }
    } catch (e) {
      this.#migration = { error: messageOf(e) };
    }
    try {
      ctx.storage.transactionSync(() => installMachines(sql, env.PLAN.machines ?? []));
      this.#machines = { installed: machineTriggersIn(sql) };
    } catch (e) {
      this.#machines = { error: `the machine triggers could not be installed: ${messageOf(e)}` };
    }
  }
  machines(): { installed: string[] } | { error: string } | null {
    return this.#machines;
  }
  /** How many migrations this data has had. */
  #migrated(): number {
    const { sql } = this.ctx.storage;
    const has = numberOf(sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'").one().n);
    return has > 0 ? numberOf(sql.exec('SELECT count(*) AS n FROM schema_migrations').one().n) : 0;
  }
  // the version's program, on this object's data; refused while its migrations are not all applied
  app(version: number): App {
    if (this.#migration && 'error' in this.#migration) throw new Error(this.#migration.error);
    if (this.#machines && 'error' in this.#machines) throw new Error(this.#machines.error);
    const made = this.#apps.get(version);
    if (made) return made; // its migrations were all there when it was made, and stay
    const b = V.get(version);
    if (!b) throw new Error(`v${version} is not live`);
    const done = this.#migrated();
    if (b.chain.length > done)
      throw new Error(
        `v${version} needs migration ${done + 1} "${b.chain[done]?.name ?? ''}", which is held: ${this.env.PLAN.held ?? 'not applied yet'}`,
      );
    const calls = this.env.CALLS;
    const services = new Proxy<Record<string, (bytes: Uint8Array, meta: CallMeta) => Promise<ServiceReply>>>(
      {},
      {
        get:
          (_, to) =>
          (bytes: Uint8Array, { method, fingerprint, key, withinMs, trace }: CallMeta) =>
            calls.call(String(to), { method, fingerprint, key, withinMs, trace }, bytes),
      },
    );
    const app = instantiate(b.plain, {
      sql: this.ctx.storage.sql,
      name: this.env.SELF,
      services,
      secrets: this.#secrets,
      http: (request, { withinMs }) => calls.http(request, withinMs),
      migrations: false,
    });
    this.#apps.set(version, app);
    return app;
  }
  record(version: number, request: Uint8Array, effects: readonly Entry[]): string {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      'INSERT INTO _tape_log VALUES (?1, ?2, ?3, ?4, ?5)',
      id,
      version,
      request,
      JSON.stringify(effects),
      Date.now(),
    );
    return id;
  }
  /** A run's log, written in its transaction: made on the first stretch, replaced on each one after. */
  #logger(version: number, bytes: Uint8Array, more: Partial<RunHead> = {}): Logger {
    let id: string | null = null;
    return {
      id: (): string | null => id,
      keep: (effects, partial, failed): void => {
        if (effects.length === 0) return;
        const list = withHead(effects, {
          ...more,
          ...(partial ? { partial: true } : {}),
          ...(failed ? { failed } : {}),
        });
        if (id === null) id = this.record(version, bytes, list);
        else this.ctx.storage.sql.exec('UPDATE _tape_log SET effects = ?2 WHERE id = ?1', id, JSON.stringify(list));
      },
    };
  }
  // The first bytes of some runs' requests (GET /:account/:name/requests reads who they were for)
  requestHeads(ids: readonly string[]): Record<string, string> {
    if (ids.length === 0) return {};
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, substr(request, 1, 4096) AS head FROM _tape_log WHERE id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
      )
      .toArray();
    return Object.fromEntries(
      rows.map(r => [textOf(r.id), typeof r.head === 'string' ? r.head : dec.decode(bytesOf(r.head))]),
    );
  }
  migration(): { id: string } | { error: string } | null {
    return this.#migration;
  }
  // The runs of one trace in this program's log (ids, oldest first), from `since` on: for a supervisor that lost
  // its record of a call, the run is still found by its trace.
  findRuns(trace: string, since = 0): { id: string; parent: string | null }[] {
    return this.ctx.storage.sql
      .exec(
        'SELECT id, effects FROM _tape_log WHERE at >= ?1 AND effects LIKE ?2 ORDER BY at',
        since,
        `%"trace":"${trace}"%`,
      )
      .toArray()
      .flatMap(r => {
        const [head] = logOf(r.effects);
        const at = head && 'trace' in head ? head : null;
        return at?.trace === trace ? [{ id: textOf(r.id), parent: at.parent ?? null }] : [];
      });
  }
  // The upload check: would this data, as it stands, take the candidate version? In one transaction that is rolled
  // back, it does what the next wake would do with the candidate live (schema statements, the migrations not yet
  // applied, schema statements again), then prepares every statement of every live version and of the candidate
  // against the schema that results. Problems name the version, the statement and the reason. The steps come back
  // as an effect log, for the supervisor to time and record (see keep).
  check({ candidate, schema, chain, apply, queries, machines = [] }: Candidate): {
    problems: CheckProblem[];
    head: CheckHead;
    steps: Step[];
  } {
    const { sql } = this.ctx.storage,
      problems: CheckProblem[] = [],
      steps: Step[] = [];
    const own: [number, string[], string[]][] = [
      ...byVersion().flatMap((v): [number, string[], string[]][] => {
        const b = V.get(v);
        return b ? [[v, schemaOf(b.plain), b.queries]] : [];
      }),
      [candidate, schema, queries],
    ];
    try {
      rolledBack(this.ctx.storage, () => {
        sql.exec(
          'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, applied_at INTEGER NOT NULL)',
        );
        dropMachines(sql);
        const { done, problem } = editedMigration(sql, candidate, chain);
        if (problem) problems.push(problem);
        // again after the migrations
        for (const [, list] of own) tryAll(list, st => sql.exec(st).toArray());
        if (!problem) {
          const tried = checkMigrations(sql, candidate, apply.slice(done));
          steps.push(...tried.steps);
          problems.push(...tried.problems);
        }
        // a candidate whose chain goes past what applies now waits for a held contract; it is prepared when that runs
        const waits = chain.length > apply.length;
        if (waits) steps.push({ prepare: candidate, statements: 0, errors: [], waits: true });
        for (const [v, list, qs] of waits ? own.slice(0, -1) : own) {
          const prepared = checkPrepared(sql, v, list, qs);
          steps.push(prepared.step);
          problems.push(...prepared.problems);
        }
        if (machines.length > 0) {
          const { step, errors } = checkMachines(sql, machines);
          steps.push(step);
          for (const e of errors) problems.push({ version: candidate, ...e, reason: `${e.statement}: ${e.reason}` });
        }
      });
    } catch (e) {
      problems.push({ version: candidate, reason: messageOf(e) });
    }
    const head: CheckHead = {
      check: true,
      candidate,
      at: Date.now(),
      trace: randomHex(16),
      span: randomHex(8),
      parent: null,
      name: this.env.SELF,
      build: 'check',
      problems,
    };
    return { problems, head, steps };
  }
  // Record a check's effect log under a live version (the trace page and OTLP links need one), once it is timed.
  keep(version: number, request: string, effects: readonly Entry[]): string {
    return this.record(version, enc.encode(request), effects);
  }
  /** The headers every answer of a run carries: its id, the next timer, and its place in the trace. */
  #headers(id: string | null, head: Effect | RunHead | undefined): Record<string, string> {
    const trace = head !== undefined && 'trace' in head && typeof head.trace === 'string' ? head.trace : '';
    const span = head !== undefined && 'span' in head && typeof head.span === 'string' ? head.span : '';
    return {
      'tape-request-id': id ?? crypto.randomUUID(),
      'tape-next-wake': String(this.nextWake() ?? ''),
      ...(trace !== '' && span !== '' ? { traceparent: `00-${trace}-${span}-01` } : {}),
    };
  }
  override async fetch(request: Request): Promise<Response> {
    const version = Number(new URL(request.url).pathname.slice(1)),
      bytes = new Uint8Array(await request.arrayBuffer());
    let app: App;
    try {
      app = this.app(version);
    } catch (e) {
      // app() reads storage before the run (the held migration, the machine). A throw here kept nothing. The
      // header is set here: a missing tape-outcome is unknown at the router, and unknown is a weaker claim than
      // this one, which the service can make.
      const encoded = encodeOutcome(APPLY.not_applied);
      const res = json({ error: messageOf(e), ...encoded.body }, 409);
      res.headers.set('tape-request-id', crypto.randomUUID());
      for (const [header, value] of Object.entries(encoded.headers)) res.headers.set(header, value);
      return res;
    }
    // tape-fault (jepsen-* only, set by the supervisor): storage_error fails the transaction as it commits, after
    // every statement ran; storage_reset fails as the transaction opens, before the run logs anything, the way
    // "Internal error in Durable Object storage caused object to be reset" does. SQLite rolls either back.
    const tapeFault = request.headers.get('tape-fault');
    const storageFault = tapeFault === 'storage_error';
    const storageReset = tapeFault === 'storage_reset';
    // The run's log is written in the transaction of its writes, so the two commit together. A run that makes calls
    // commits at each one (a stretch); its log so far, marked partial, is written with each stretch's writes, and
    // the whole log with the last. So whatever a run committed is in its log, even when it stopped mid-way (its
    // object reset while it waited on a call), and a run with no log committed nothing.
    const log = this.#logger(version, bytes);
    const parent = traceOfHeader(request.headers.get('traceparent'));
    const transaction: Transaction = f =>
      this.ctx.storage.transactionSync(() => {
        // before the run: nothing has been logged, so a failure here kept nothing
        if (storageReset) throw new StorageFault('Internal error in Durable Object storage caused object to be reset.');
        const r = f(),
          { out, pending } = stretchOf(r);
        if (storageFault && Boolean(out))
          throw new StorageFault('jepsen: injected storage error at commit; the transaction was rolled back');
        if (Boolean(out) || Boolean(pending)) log.keep(app.effects, Boolean(pending));
        return r;
      });
    try {
      await this.#loadSecrets(version);
      const ran = await app.runLogged(bytes, { transaction, trace: parent });
      const { status, body, type, headers, session } = split(ran.out);
      // A stretch that committed has a log id before this write. runLogged returning means each of those
      // transactions returned. A program rollback (rollback(out)) undoes the stretch it is in and still answers.
      const prior = log.id() !== null;
      // the whole log, with its measured took (and, for a run that rolled itself back, written only now)
      log.keep(ran.effects, false);
      const head = ran.effects[0];
      const undone = head !== undefined && isHead(head) && head.undone === true;
      const finished = undone ? (prior ? APPLY.partly : APPLY.not_applied) : APPLY.applied;
      const res = new Response(body, {
        status,
        headers: {
          ...this.#headers(log.id(), ran.effects[0]),
          ...encodeOutcome(finished).headers,
          ...(type === undefined ? {} : { 'content-type': type }),
          ...sessionHeaders(session),
        },
      });
      // the program's own headers (std/http's header), checked by responseOf: none is one the host sets
      for (const h of headers) res.headers.append(h.name, h.value);
      return res;
    } catch (err) {
      return this.#failed(err, log, version, bytes, parent);
    }
  }
  // The run failed inside its transaction (a trap, a storage error). A storage failure is transient (R-ANS-2): 503
  // with retry-after, and the same request sent again with its key may succeed. A trap is the program's: 500.
  // A failure before the log began kept nothing (the log commits with the writes): that is `not_applied`, recorded
  // when the store still accepts a row, and answered even when it does not. The service does not run the request
  // again itself. A storage reset fails the requests in flight together; retrying them in the same turn hits the
  // object while it is being reset, and a GET is not a read (a program may write on any method).
  #failed(
    err: unknown,
    log: Logger,
    version: number,
    bytes: Uint8Array,
    parent: { trace: string; parent: string } | null,
  ): Response {
    const effects = effectsOf(err),
      message = messageOf(err),
      storage = storageKind(err) !== null,
      transient = transientAtEdge(err);
    // a run that failed after a call had committed the stretches before it: the log row is that commit
    const kept = log.id() !== null;
    const failed: Failed = {
      status: !effects && kept ? 500 : transient ? 503 : 500,
      error: message,
      rolled_back: true,
      ...(storage ? { storage: true } : {}),
      ...(effects || kept ? {} : { unstarted: true }),
    };
    if (!effects) {
      // The log never began, so this request's transaction did not commit: not_applied. The other way here is the
      // final log.keep, the statement after runLogged has returned. runLogged returns only once each stretch's
      // transactionSync has returned, and that return is the commit, so those writes were kept. The answer is
      // applied and carries no retry-after: inviting the client to send the write again would apply it twice.
      // A throw inside the transaction is the other function (effects is set, and a failed commit leaves the id
      // unset because record() assigns it only after its INSERT returns).
      const apply = kept ? APPLY.applied : APPLY.not_applied;
      const noted = kept ? null : this.#unstarted(version, bytes, failed, parent);
      const error = kept
        ? `the request was applied, but its answer was not recorded: ${message}`
        : `nothing was applied: ${message}`;
      return failedResponse(error, message, transient, apply, this.#headers(noted?.id ?? log.id(), noted?.head));
    }
    const apply = kept ? APPLY.partly : APPLY.not_applied;
    log.keep(effects, false, failed);
    const error = kept
      ? `the program failed after a call; what it wrote before that call was kept, the rest was rolled back: ${message}`
      : `the program failed and its transaction was rolled back: ${message}`;
    return failedResponse(error, message, transient, apply, this.#headers(log.id(), effects[0]));
  }
  /** A failure before the log began, recorded under a new id when the store accepts it. The id is the answer's
   * either way: a store that has just reset may refuse the row, and the router's traceparent is the other link. */
  #unstarted(
    version: number,
    bytes: Uint8Array,
    failed: Failed,
    parent: { trace: string; parent: string } | null,
  ): { id: string; head: RunHead } {
    const head: RunHead = {
      build: typeof TAPE_COMPILER === 'string' ? TAPE_COMPILER : 'dev',
      flags: {},
      at: Date.now(),
      took: 0,
      trace: parent?.trace ?? randomHex(16),
      span: randomHex(8),
      parent: parent?.parent ?? null,
      name: null,
      failed,
    };
    try {
      return { id: this.record(version, bytes, [head]), head };
    } catch {
      return { id: crypto.randomUUID(), head };
    }
  }
  // A call from another program: the latest version's exported method, logged like a request.
  // A method that fails here (a trap, a version not ready) rolled back its transaction and ran nothing, so it is a
  // refusal and says why; an exception that crossed the RPC instead would reach the caller as an unknown outcome.
  // fault: storage_error (jepsen-* only, set by the supervisor): the transaction fails as it commits
  async serve(meta: CallMeta, bytes: Uint8Array | ArrayBuffer, fault: string | null = null): Promise<ServedCall> {
    const version = this.env.PLAN.latest,
      message = new Uint8Array(bytes);
    const transaction: Transaction = f =>
      this.ctx.storage.transactionSync(() => {
        const r = f();
        if (fault === 'storage_error')
          throw new StorageFault('jepsen: injected storage error at commit; the transaction was rolled back');
        return r;
      });
    try {
      const { method, fingerprint, key, withinMs, trace } = meta;
      await this.#loadSecrets(version);
      const { status, body, effects } = await this.app(version).serve(
        {
          method,
          fingerprint,
          ...(key === undefined ? {} : { key }),
          ...(withinMs === undefined ? {} : { withinMs }),
          ...(trace === undefined ? {} : { trace }),
        },
        message,
        { transaction },
      );
      return {
        status,
        body,
        version,
        id: effects ? this.record(version, message, effects) : null,
        next: this.nextWake(),
      };
    } catch (e) {
      // recorded when the run had begun its log, so the callee's trace shows the failed run instead of nothing
      const effects = effectsOf(e);
      // A refusal is final: the caller compensates for it. That holds for what the program itself did (a trap, a
      // trigger's refusal): it does the same again on the same key. A storage failure is not the program's: nothing
      // was applied, nothing was kept under the call's key, and the same call may succeed when it is sent again, so it
      // answers unreachable (sent again later, with the same key), never rejected (S2: a charge refused this way was
      // compensated, then made by a racing retry of the same key, so money left a failed order).
      const transient = transientBetween(e);
      const status = transient ? 'unreachable' : 'rejected';
      const failed: Failed = { status, error: messageOf(e), rolled_back: true };
      return {
        status,
        body: enc.encode(`${meta.method} failed: ${messageOf(e)}`),
        version,
        id: effects ? this.record(version, message, withHead(effects, { failed })) : null,
      };
    }
  }
  // R-RET-6: the log of all but the newest n requests is deleted; the count and the newest time removed
  pruneLog(n: number): { deleted: number; at: number | null } {
    const { sql } = this.ctx.storage;
    const [cut] = sql
      .exec(
        'SELECT rowid AS r FROM _tape_log WHERE rowid > (SELECT max(rowid) FROM _tape_log) - ?1 ORDER BY rowid LIMIT 1',
        n,
      )
      .toArray();
    if (!cut) return { deleted: 0, at: null };
    const at = numberOf(cut.r);
    const gone = sql.exec('SELECT count(*) AS c, max(at) AS at FROM _tape_log WHERE rowid < ?1', at).one();
    if (numberOf(gone.c) > 0) sql.exec('DELETE FROM _tape_log WHERE rowid < ?1', at);
    return { deleted: numberOf(gone.c), at: typeof gone.at === 'number' ? gone.at : null };
  }
  // R-UPG-2: op ids an older shard program stored in table ops (migration 2), which the current one does not read:
  // how many, and how many are timed op ids the current program would accept again (t at or after now - window -
  // skew, the shard's own, which migration 4 sets to its defaults on a shard made before it). Read only.
  legacyOps(now: number): { table: boolean; rows: number; timed: number; timed_recent: number; since?: number } {
    const { sql } = this.ctx.storage;
    const has =
      numberOf(sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?1", 'ops').one().n) >
      0;
    if (!has) return { table: false, rows: 0, timed: 0, timed_recent: 0 };
    const cols = sql
      .exec("SELECT name FROM pragma_table_info('placement')")
      .toArray()
      .map(r => r.name);
    const [p] = cols.includes('window_ms') ? sql.exec('SELECT window_ms, skew_ms FROM placement').toArray() : [];
    const window = typeof p?.window_ms === 'number' ? p.window_ms : 3600000,
      skew = typeof p?.skew_ms === 'number' ? p.skew_ms : 300000,
      since = now - window - skew;
    const ops = sql
        .exec('SELECT op FROM ops')
        .toArray()
        .map(r => textOf(r.op)),
      timed = ops.flatMap(op => {
        const t = /^(\d{13})_/.exec(op)?.[1];
        return t === undefined ? [] : [Number(t)];
      });
    return {
      table: true,
      rows: ops.length,
      timed: timed.length,
      timed_recent: timed.filter(t => t >= since).length,
      since,
    };
  }
  // R-RET-7: everything this data stores (before the name deletes the facet: workerd#8472)
  async wipe(): Promise<true> {
    await this.ctx.storage.deleteAll();
    return true;
  }
  // what this name's data holds: the SQLite size and the request log's share of it
  storageUse(): { bytes: number; log_rows: number; log_bytes: number } {
    const { sql } = this.ctx.storage;
    const [log] = sql
      .exec('SELECT count(*) AS rows, coalesce(sum(length(request) + length(effects)), 0) AS bytes FROM _tape_log')
      .toArray();
    return { bytes: sql.databaseSize, log_rows: numberOf(log?.rows), log_bytes: numberOf(log?.bytes) };
  }
  // Timers (wake): the earliest time one is set for, the ones set, and running the ones that are due. The program's
  // own host keeps them in _wakes, in the same transactions as its writes; the supervisor turns the earliest into
  // this name's Durable Object alarm. Only the latest version runs a woken program; when it exports no `woken`,
  // the timers wait (and arm nothing) until a version that does.
  nextWake(): number | null {
    if (V.get(this.env.PLAN.latest)?.woken !== true) return null;
    try {
      const { due } = this.ctx.storage.sql.exec('SELECT min(due) AS due FROM _wakes').one();
      return typeof due === 'number' ? due : null;
    } catch {
      return null;
    }
  }
  wakesSet(): { key: number; due: number }[] {
    try {
      return this.ctx.storage.sql
        .exec('SELECT key, due FROM _wakes ORDER BY due, key')
        .toArray()
        .map(r => ({ key: numberOf(r.key), due: numberOf(r.due) }));
    } catch {
      return [];
    }
  }
  /** Run one timer that is due. As for a request (fetch): the log is written in the transaction of each stretch's
   * writes, marked partial until the last, so a woken run cut short while it waited on a call (its object reset)
   * still has the log of what it committed: the timers it set name it as their parent, and its trace is not cut
   * off above them. */
  // faulty (jepsen-* only, drawn by the alarm): the run's first commit fails, as a storage error would
  async #wakeOne(app: App, version: number, key: number, faulty = false): Promise<WokenRun | null> {
    const began = Date.now(),
      bytes = enc.encode(JSON.stringify({ key }));
    const [row] = this.ctx.storage.sql.exec('SELECT due FROM _wakes WHERE key = ?1', key).toArray();
    const woke: Woke = { key, due: typeof row?.due === 'number' ? row.due : null };
    const log = this.#logger(version, bytes, { woke });
    let fault = faulty;
    const transaction: Transaction = f =>
      this.ctx.storage.transactionSync(() => {
        const r = f(),
          { out, pending } = stretchOf(r);
        if (fault) {
          fault = false;
          throw new StorageFault('jepsen: injected storage error at commit; the transaction was rolled back');
        }
        if (Boolean(out) || Boolean(pending)) log.keep(app.effects, Boolean(pending));
        return r;
      });
    try {
      // a storage failure keeps the timer, set for later; anything else (a trap) removes it
      const transient = (e: unknown): boolean => transientBetween(e);
      const w = await app.wake(key, { transaction, transient });
      if (!w) return null;
      log.keep(w.effects, false);
      return { key, version, status: w.status, due: woke.due, id: log.id(), began, took: Date.now() - began };
    } catch (e) {
      return { key, version, status: 'failed', error: messageOf(e), began, took: Date.now() - began };
    }
  }
  async wakeDue(faulty: readonly number[] = []): Promise<{ ran: WokenRun[]; next: number | null }> {
    const version = this.env.PLAN.latest,
      ran: WokenRun[] = [];
    if (this.nextWake() === null) return { ran, next: null };
    const app = this.app(version);
    await this.#loadSecrets(version);
    for (const key of app.due()) {
      const one = await this.#wakeOne(app, version, key, faulty.includes(key));
      if (one) ran.push(one);
    }
    return { ran, next: this.nextWake() };
  }
  // A tool call: the latest version's exported function, given only the JSON message; logged like a call served.
  tool(method: string, bytes: Uint8Array | ArrayBuffer): Promise<ServedCall> {
    const version = this.env.PLAN.latest,
      b = V.get(version),
      m = b ? methodsOf(b.plain).find(x => x.name === method) : undefined;
    if (!m)
      return Promise.resolve({ status: 'rejected', body: enc.encode(`no function ${method}`), version, id: null });
    return this.serve({ method, fingerprint: m.fingerprint, key: null, withinMs: 10000, trace: null }, bytes);
  }
  // One request as data: what came in, what went out (replayed), the log, and the trace made from it now. A run that
  // read secrets is replayed with the versions its log names, and every string of the view has each value the name
  // holds written `[secret <name>]`.
  async view(id: string): Promise<RequestView | null> {
    const [row] = this.ctx.storage.sql.exec('SELECT version FROM _tape_log WHERE id = ?1', id).toArray();
    if (!row) return null;
    await this.#loadSecrets(numberOf(row.version));
    return scrubbed(this.#view(id), V.get(numberOf(row.version))?.secrets === true ? this.#held : []);
  }
  #view(id: string): RequestView | null {
    const [row] = this.ctx.storage.sql
      .exec('SELECT version, request, effects, at FROM _tape_log WHERE id = ?1', id)
      .toArray();
    if (!row) return null;
    const effects = logOf(row.effects),
      [head, ...steps] = effects,
      version = numberOf(row.version),
      b = V.get(version),
      sent = bytesOf(row.request);
    const base = { id, version, at: numberOf(row.at), effects, source: b?.source ?? '', queries: b?.queries ?? [] };
    const asText = { ...base, request: dec.decode(sent), error: null };
    if (isCheckHead(head)) return { ...asText, ...checkView(head, steps) };
    if (isMigrationsHead(head))
      return { ...asText, status: 'ok', response: `${steps.length} migrations applied`, trace: migrationLines(steps) };
    if (!b || !isRunHead(head))
      return {
        ...asText,
        status: 410,
        response: '',
        trace: [],
        error: `v${version} is no longer live, so its trace cannot be made`,
      };
    return { ...base, ...runView(b, head, sent, effects, this.#secrets) };
  }
}

/** An upload check as a request: what it found, and its steps as a trace. */
const checkView = (head: CheckHead, steps: readonly Entry[]): Pick<RequestView, 'status' | 'response' | 'trace'> => {
  const said = (p: CheckProblem): string => {
    const where = p.query ?? p.statement;
    return `v${p.version}: ${p.reason}${where === undefined || where === '' ? '' : `: ${where}`}`;
  };
  return {
    status: head.problems.length > 0 ? 409 : 'ok',
    response:
      head.problems.length > 0
        ? head.problems.map(said).join('\n')
        : `v${head.candidate} fits the data as it stands, and every live version still prepares`,
    trace: checkLines(steps),
  };
};
const shown = (message: RunHead['message']): string =>
  typeof message === 'string' ? message : JSON.stringify(message);
/** The effects of a stored log that the host replays. */
const replayable = (effects: readonly Entry[]): Effect[] => effects.filter(isEffect);
/** A run as a request: replayed through its traced build, unless it stopped or failed. */
const runView = (
  b: Version,
  head: RunHead,
  sent: Uint8Array,
  effects: readonly Entry[],
  secrets: SecretStore,
): Pick<RequestView, 'request' | 'status' | 'response' | 'trace' | 'error' | 'partial' | 'failed'> => {
  const { method } = head,
    called = method !== undefined && method !== '',
    request = called ? `${method} ${shown(head.message)}` : dec.decode(sent),
    replay = (): ReturnType<typeof traceOf> =>
      traceOf(b.traced, called ? null : sent, replayable(effects), undefined, { secrets });
  if (head.partial === true) {
    // the run stopped while it waited on a call: its log ends at that call, and what it wrote before it committed
    let events: TraceEvent[] = [];
    try {
      ({ events } = replay());
    } catch {
      // the trace is what could be replayed: none
    }
    return {
      request,
      status: 'incomplete',
      response:
        'the run stopped while it waited on a call (its object was reset); what it wrote before that call committed, and nothing after',
      trace: traceLines(b, events),
      error: null,
      partial: true,
    };
  }
  // the run never began: there is no effect to replay, and another build's hash would refuse the log
  if (head.failed?.unstarted === true)
    return {
      request,
      status: head.failed.status,
      response: `nothing was applied: ${head.failed.error}`,
      trace: [['bad', `nothing was applied: ${head.failed.error}`]],
      error: head.failed.error,
      failed: head.failed,
    };
  const t = replay();
  // a run that failed was rolled back: its recorded outcome stands, whatever the replay of its log does
  if (head.failed)
    return {
      request,
      status: head.failed.status,
      response: `the program failed and its transaction was rolled back: ${head.failed.error}`,
      trace: traceLines(b, t.events, t.cut),
      error: head.failed.error,
      failed: head.failed,
    };
  const { status, body, headers } = answered(t.out, called);
  return {
    request,
    status,
    ...(headers.length > 0 ? { headers } : {}),
    response: dec.decode(body),
    trace: traceLines(b, t.events, t.cut),
    error: t.error,
  };
};
/** What a replayed run answered: a request's status line and body; a method's first byte says ok or rejected. */
const answered = (
  out: Uint8Array | null,
  called: boolean,
): { status: number | string; body: Uint8Array; headers: Header[] } => {
  if (!out) return { status: 500, body: new Uint8Array(0), headers: [] };
  return called ? { status: out[0] === 48 ? 'ok' : 'rejected', body: out.subarray(1), headers: [] } : split(out);
};
