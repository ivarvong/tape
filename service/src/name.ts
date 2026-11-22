// name.ts: the Durable Object for one account/name: its versions, the calls it served, and the supervisor of its
// data: one facet, shared by every live version and migrated forward by the latest.
import { DurableObject } from 'cloudflare:workers';
// ?erased (erased.ts): the file's text with its types taken out and './x.ts' read as './x.js', which is what the
// Loader runs. The module names below end in .js because the Loader takes no other.
import hostSrc from '../../host.ts?erased';
import hostCall from '../../host/call.ts?erased';
import hostLog from '../../host/log.ts?erased';
import hostMemory from '../../host/memory.ts?erased';
import hostRun from '../../host/run.ts?erased';
import hostSchema from '../../host/schema.ts?erased';
import programSrc from './program.ts?erased';
import recordsSrc from './records.ts?erased';
import type { CallEffect } from '../../host/log.ts';
import { failing, machinesFor, rulesNow } from './build.ts';
import type { Note, Refusal, Reported, Stored, VersionRow } from './build.ts';
import { FAULTY, HOP_KINDS, decide, hopOf, planOf as faultPlanOf } from './faults.ts';
import type { Fault, Plan as FaultPlan } from './faults.ts';
import { diverged, planOf, sqlProblems } from './plan.ts';
import type { Program, ServedCall } from './program.ts';
import type {
  CallMeta,
  Chain,
  CheckProblem,
  Invoked,
  Joined,
  JoinedCall,
  Plan,
  Routed,
  Run,
  ServedRow,
} from './records.ts';
import { MAX_SHARDS } from './kv.ts';
import { fresh, recordOf } from './spans.ts';
import type { RouterRecord } from './spans.ts';
import { entryOf as entryIn, policyOf } from './tools.ts';
import type { Policy, ToolEntry } from './tools.ts';
import * as view from './view.ts';
import type { Links } from './view.ts';
import { messageOf, randomHex, reply } from './web.ts';

/** host.ts imports these by name */
const HOST_PARTS = {
  'host/call.js': hostCall,
  'host/log.js': hostLog,
  'host/memory.js': hostMemory,
  'host/run.js': hostRun,
  'host/schema.js': hostSchema,
};

// RUNTIME-SPEC R-RET-6: the trace records of the newest TRACE_KEEP requests of each object are kept; a prune runs
// after every PRUNE_EVERY requests, so an object holds at most TRACE_KEEP + PRUNE_EVERY of them.
export const TRACE_KEEP = 100000,
  PRUNE_EVERY = 16,
  KEEP_MIN = 10,
  KEEP_MAX = 10000000;
export const WIPED_ERROR = 'this name was deleted';

type Row = Record<string, SqlStorageValue>;
const int = (v: unknown): number => (typeof v === 'number' ? v : 0);
const intOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** A list stored as JSON text. */
const listIn = (text: unknown): unknown[] => {
  const v: unknown = JSON.parse(str(text) === '' ? '[]' : str(text));
  return Array.isArray(v) ? v : [];
};
const fieldsOf = (v: unknown): Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null ? { ...v } : {};
const chainIn = (text: unknown): Chain =>
  listIn(text)
    .map(fieldsOf)
    .map(m => ({
      n: int(m.n),
      name: str(m.name),
      contract: m.contract === true,
      statements: Array.isArray(m.statements) ? m.statements.filter(x => typeof x === 'string') : [],
      hash: str(m.hash),
    }));
/** Run a statement that may already have been run: adding a column that is there. */
const attempt = (run: () => unknown): void => {
  try {
    run();
  } catch {
    // there already
  }
};

/** An upload: the program's builds, its source and the hash of its plain build. */
export type Upload = Stored & { source: string; hash: string };
/** A version as it is listed. */
export type Listed = {
  version: number;
  hash: string;
  bytes: number;
  created_at: number;
  live: boolean;
  migrations: number;
  source?: string;
  rules?: 'passes' | { fails: Reported[]; note: string };
};
/** What changing the live versions came to. */
type Restarted = {
  live: number[];
  migration: { id: string } | { error: string } | null;
  held: string | null;
  machines?: { installed: string[] } | { error: string };
};
type Checked = { version: number; id: string } | null;
export type Uploaded =
  | (Refusal & {
      problems?: (string | CheckProblem | (Note & { reason?: string }))[];
      problem?: string;
      hint?: string;
      check?: Checked;
    })
  | ({
      version: number;
      created_at: number;
      check: Checked;
      live_failing_rules?: ReturnType<typeof failing>;
    } & Restarted);
/** What an invocation gives its record once it is answered. */
type Outcome = {
  log_id?: string | null;
  facet_began?: number;
  facet_took?: number;
  status?: number;
  error?: string | null;
};
export type InvokeOptions = {
  /** the caller's W3C trace context, which the run's span joins */
  traceparent?: string | null;
  /** an injected fault (jepsen-* accounts only) */
  fault?: string | null;
  /** from a router: the trace and the span of its call */
  call?: { trace: string; span: string } | null;
};
const NOTE_OLD =
  'uploaded before the compiler refused this, or before another live version declared a machine it does not keep to; it keeps running as it was built (the machine triggers allow what it does while it is live), and a new version must pass';
const brokenBy = (problems: readonly { version: number }[], candidate: number): number[] => [
  ...new Set(problems.map(p => p.version).filter(v => v !== candidate)),
];
const are = (list: readonly unknown[]): string => (list.length > 1 ? 'are' : 'is');

const enc = new TextEncoder();
const htmlPage = (html: string): Response =>
  new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, max-age=300' },
  });
const textPage = (text: string): Response =>
  new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
const routeIn = (text: unknown): RouterRecord => recordOf(JSON.parse(str(text)));
const planIn = (text: unknown): FaultPlan | null => faultPlanOf(JSON.parse(str(text)));
const policyIn = (text: unknown): Policy => policyOf(JSON.parse(str(text)));

/** A routed request as it is listed. */
export type RequestListed = {
  call_span: string;
  at: number;
  version: number | null;
  log_id: string | null;
  route: RouterRecord;
  head: string | null;
};
/** A KV cluster's retention: the op window, the clock allowance and the trace records kept, per shard. */
export type Retention = { window: number; skew: number; keep: number };
/** A KV cluster as its account's ~kv object holds it. */
export type Cluster = {
  cluster: string;
  shards: number;
  state: string;
  created_at: number;
  window_ms: number | null;
  skew_ms: number | null;
  trace_keep: number | null;
};
const clusterOf = (r: Row): Cluster => ({
  cluster: str(r.cluster),
  shards: int(r.shards),
  state: str(r.state),
  created_at: int(r.created_at),
  window_ms: intOrNull(r.window_ms),
  skew_ms: intOrNull(r.skew_ms),
  trace_keep: intOrNull(r.trace_keep),
});
type Legacy = Awaited<ReturnType<Program['legacyOps']>>;
/** What upgrading a shard came to. */
export type Upgrade =
  | (Refusal & { legacy?: Legacy; problems?: unknown; to?: number; retired?: number[] })
  | { state: 'current'; version: number }
  | { state: 'ready'; from: number; from_hash: string; legacy: Legacy }
  | { state: 'upgraded'; from: number; from_hash: string; to: number; retired: number[]; legacy: Legacy };
export type ToolAnswer = ServedCall;

const machineRefusal = (refusals: readonly Note[], candidate: number, account: string, name: string): Uploaded => {
  const broken = brokenBy(refusals, candidate),
    others = broken.length > 0;
  return {
    status: 409,
    problems: refusals.map(({ version, code, line, message }) => ({ version, code, line, message, reason: message })),
    error: others
      ? `it would break v${broken.join(', v')}, which ${are(broken)} still live: its machine triggers would refuse writes the checker cannot read`
      : 'it writes a column another live version declares a machine for, in a way the checker cannot read',
    hint: others
      ? `Retire v${broken.join(', v')} first (DELETE /${account}/${name}/v/:version), or declare the machine later.`
      : 'Write the state as a literal or a parameter that is a literal at every call site, or declare the same machine in this version.',
  };
};
const dataRefusal = (
  found: readonly CheckProblem[],
  candidate: number,
  check: Checked,
  account: string,
  name: string,
): Uploaded => {
  const broken = brokenBy(found, candidate),
    others = broken.length > 0;
  return {
    status: 409,
    check,
    problems: [...found],
    error: others
      ? `it would break v${broken.join(', v')}, which ${are(broken)} still live`
      : 'it does not fit the data as it stands',
    hint: others
      ? `Retire v${broken.join(', v')} first (DELETE /${account}/${name}/v/:version), or change the migration so ${broken.length > 1 ? 'their' : 'its'} statements still work.`
      : 'Change the migration or the schema so they run on the data as it is.',
  };
};

export class Name extends DurableObject {
  // The object's own tables are made on first use of #sql, not in the constructor: an object that is only asked a
  // question (is this name registered? is it published?) stores nothing, so a tokenless request for a name nobody
  // made leaves no storage behind (hardening.test.ts).
  #made = false;
  #make(): void {
    const { sql } = this.ctx.storage;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS _tape_served(trace TEXT, parent TEXT, version INTEGER NOT NULL, key TEXT, status TEXT NOT NULL, log_id TEXT, at INTEGER NOT NULL)',
    );
    // when the call reached this object and how long it took to answer, measured across the facet call: inside a
    // Worker the clock stands still while code runs, so the callee's own log cannot time itself
    for (const col of ['began INTEGER', 'took INTEGER', 'method TEXT'])
      attempt(() => sql.exec(`ALTER TABLE _tape_served ADD COLUMN ${col}`));
    sql.exec('CREATE INDEX IF NOT EXISTS _tape_served_by_trace ON _tape_served(trace, parent)');
    // A request a router sent here (spans.ts): one _tape_invoked row per time this object took the call, with its
    // supervisor span and the window of the facet call (the run's duration: the run's own clock stands still), and
    // the router's record of the request in _tape_routed. Both are written before the reply leaves.
    // (made on first use: #routedTables)
    sql.exec(
      'CREATE TABLE IF NOT EXISTS _tape_versions(version INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, source TEXT NOT NULL, plain BLOB NOT NULL, traced BLOB NOT NULL, sites TEXT NOT NULL, created_at INTEGER NOT NULL)',
    );
    sql.exec('CREATE TABLE IF NOT EXISTS _tape_chain(version INTEGER PRIMARY KEY, migrations TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS _tape_retired(version INTEGER PRIMARY KEY, at INTEGER NOT NULL)');
    // timers: which account/name this object is (an alarm arrives with neither), and the woken runs it started
    sql.exec('CREATE TABLE IF NOT EXISTS _tape_self(account TEXT NOT NULL, name TEXT NOT NULL)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS _tape_woken(key INTEGER NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, log_id TEXT, error TEXT, due INTEGER, began INTEGER NOT NULL, took INTEGER NOT NULL)',
    );
  }
  get #sql(): SqlStorage {
    if (!this.#made) {
      this.#make();
      this.#made = true;
    }
    return this.ctx.storage.sql;
  }
  /** Does this object hold the table? Reads only: it makes nothing. */
  #has(table: string): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", table).toArray()
        .length > 0
    );
  }
  /** Is any version live? */
  #alive(): boolean {
    return this.live().length > 0;
  }
  // The earliest timer the data holds becomes this object's alarm (one per object), unless an earlier one is set.
  async arm(account: string, name: string, next: number | string | null | undefined): Promise<void> {
    if (next === null || next === undefined || next === '' || !Number.isFinite(Number(next))) return;
    if (int(this.#sql.exec('SELECT count(*) AS n FROM _tape_self').one().n) === 0)
      this.#sql.exec('INSERT INTO _tape_self VALUES (?1, ?2)', account, name);
    const at = Math.max(Number(next), Date.now()),
      set = await this.ctx.storage.getAlarm();
    if (set === null || at < set) await this.ctx.storage.setAlarm(at);
  }
  // The alarm: the data runs every timer that is due (the latest version's `woken`), and the next one is armed.
  // A run cut short (this object reset meanwhile) left its timer in place, and the alarm is retried, so each timer
  // is run at least once; a run that traps is recorded here and not retried.
  override async alarm(): Promise<void> {
    const [self] = this.#sql.exec('SELECT account, name FROM _tape_self').toArray();
    if (!self || !this.#alive()) return;
    const account = str(self.account),
      name = str(self.name);
    const { ran, next } = await this.data(account, name).wakeDue();
    for (const r of ran)
      this.#sql.exec(
        'INSERT INTO _tape_woken VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
        r.key,
        r.version,
        r.status,
        r.id ?? null,
        r.error ?? null,
        r.due ?? null,
        r.began,
        r.took,
      );
    this.#sql.exec('DELETE FROM _tape_woken WHERE rowid <= (SELECT max(rowid) FROM _tape_woken) - 200');
    await this.arm(account, name, next);
  }
  // The timers set, the alarm, and the latest woken runs.
  async wakes(
    account: string,
    name: string,
  ): Promise<{ set: { key: number; due: number }[]; alarm: number | null; runs: Row[] }> {
    const set = this.#alive() ? await this.data(account, name).wakesSet() : [];
    const runs = this.#sql
      .exec(
        'SELECT key, version, status, log_id, error, due, began, took FROM _tape_woken ORDER BY rowid DESC LIMIT 20',
      )
      .toArray();
    return { set, alarm: await this.ctx.storage.getAlarm(), runs };
  }
  // Publication, the operator's opt-in (PUT /_public/:account/:name): a published name answers /p/:account/:name/…
  // to anyone, without a token, with its latest live version; the program sees `public` on the request line.
  #publicMade = false;
  #publicTable(): void {
    if (!this.#publicMade)
      this.#sql.exec(
        'CREATE TABLE IF NOT EXISTS _tape_public(one INTEGER PRIMARY KEY CHECK (one = 1), published INTEGER NOT NULL CHECK (published IN (0, 1)), at INTEGER NOT NULL)',
      );
    this.#publicMade = true;
  }
  setPublic(published: boolean): { published: boolean; since: string | null; latest: number | null } {
    this.#publicTable();
    this.#sql.exec(
      'INSERT INTO _tape_public(one, published, at) VALUES (1, ?1, ?2) ON CONFLICT(one) DO UPDATE SET published = excluded.published, at = excluded.at',
      published ? 1 : 0,
      Date.now(),
    );
    return this.publication();
  }
  publication(): { published: boolean; since: string | null; latest: number | null } {
    // an object never made has no versions and is not published: answered without making its tables
    if (!this.#has('_tape_versions')) return { published: false, since: null, latest: null };
    this.#publicTable();
    const [row] = this.#sql.exec('SELECT published, at FROM _tape_public').toArray();
    const published = row?.published === 1;
    return {
      published,
      since: published ? new Date(int(row.at)).toISOString() : null,
      latest: this.live().at(-1) ?? null,
    };
  }
  chains(): Map<number, Chain> {
    return new Map(
      this.#sql
        .exec('SELECT version, migrations FROM _tape_chain')
        .toArray()
        .map(r => [int(r.version), chainIn(r.migrations)]),
    );
  }
  live(): number[] {
    return this.#sql
      .exec(
        'SELECT version FROM _tape_versions WHERE version NOT IN (SELECT version FROM _tape_retired) ORDER BY version',
      )
      .toArray()
      .map(r => int(r.version));
  }
  // The plan changes only by an upload or a retirement, both in this object and both through restart(), which
  // drops it; between them every request reads it from memory.
  #plan: Required<Plan> | null = null;
  plan(): Required<Plan> {
    this.#plan ??= {
      ...planOf(this.live(), this.chains()),
      machines: this.machines().machines.map(({ by: _by, ...m }) => m),
    };
    return this.#plan;
  }
  // The machine plan of the live versions (and a candidate's, at upload: { version, hash, source }).
  machines(candidate: VersionRow | null = null): ReturnType<typeof machinesFor> {
    const live = this.live();
    const rows = this.#sql
      .exec(
        `SELECT version, hash, source FROM _tape_versions WHERE version IN (${live.join(',') || 'NULL'}) ORDER BY version`,
      )
      .toArray()
      .map(r => ({ version: int(r.version), hash: str(r.hash), source: str(r.source) }));
    return machinesFor(candidate ? [...rows, candidate] : rows);
  }
  async upload(account: string, name: string, up: Upload): Promise<Uploaded> {
    const { source, hash, plain, traced, sites, schema, queries, migrations, base } = up;
    const problems = sqlProblems(this.ctx.storage, schema, queries);
    if (problems.length > 0) return { status: 400, error: 'its SQL does not fit its schema', problems };
    const chains = this.chains(),
      last = int(this.#sql.exec('SELECT max(version) AS v FROM _tape_versions').one().v);
    const bad = last > 0 ? diverged(chains.get(last) ?? [], migrations, last) : null;
    if (bad !== null)
      return { status: 409, error: 'its migrations do not continue the ones already shipped', problem: bad };
    // The data itself decides the rest. In a transaction that is rolled back, the data facet does what the next
    // wake would do with this version live (schema, the migrations not yet applied, schema again) and prepares every
    // live version's statements, and this one's, against the schema that results. The run is recorded like a
    // request, under the latest live version, so it has a trace page and OTLP spans whether it passes or not.
    const live = this.live(),
      candidate = last + 1,
      began = Date.now();
    const { apply } = planOf([...live, candidate], new Map(chains).set(candidate, migrations));
    // Machines (rules.ts, C57-C61): the triggers this version would put in force, with the moves every live version
    // makes. A version under a machine it does not declare, whose writes of that column cannot be read, could be
    // stopped by the triggers: refused, before anything runs, naming the version.
    const plan = this.machines({ version: candidate, hash, source });
    if (plan.refusals.length > 0) return machineRefusal(plan.refusals, candidate, account, name);
    const data = this.data(account, name),
      {
        problems: found,
        head,
        steps,
      } = await data.check({
        candidate,
        schema: base,
        chain: migrations,
        apply,
        queries,
        machines: plan.machines.map(({ by: _by, ...m }) => m),
      });
    const latest = live.at(-1);
    const check =
      latest === undefined
        ? null
        : {
            version: latest,
            id: await data.keep(latest, `CHECK v${candidate}`, [
              { ...head, at: began, took: Date.now() - began },
              ...steps,
            ]),
          };
    if (found.length > 0) return dataRefusal(found, candidate, check, account, name);
    const [row] = this.#sql
      .exec(
        'INSERT INTO _tape_versions(hash, source, plain, traced, sites, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING version, created_at',
        hash,
        source,
        plain,
        traced,
        JSON.stringify(sites),
        Date.now(),
      )
      .toArray();
    const version = int(row?.version);
    this.#sql.exec('INSERT INTO _tape_chain VALUES (?1, ?2)', version, JSON.stringify(migrations));
    // the versions still live beside this one that the compiler would refuse today: they keep running, and say so
    const others = this.versions({ source: true }).map(v => ({
      version: v.version,
      hash: v.hash,
      source: v.source ?? '',
      live: v.live,
    }));
    const older = failing(others, version, this.machines().notes);
    await this.enrol(account, name, 'program');
    return {
      version,
      created_at: int(row?.created_at),
      check,
      ...(await this.restart(account, name)),
      ...(older.length > 0 ? { live_failing_rules: older } : {}),
    };
  }
  // Retiring a version takes it out of the data's code, which may release a held contract migration.
  async retire(account: string, name: string, version: number): Promise<Refusal | ({ retired: number } & Restarted)> {
    if (!this.live().includes(version)) return { status: 404, error: 'no such live version' };
    this.#sql.exec('INSERT INTO _tape_retired VALUES (?1, ?2)', version, Date.now());
    return { retired: version, ...(await this.restart(account, name)) };
  }
  // New code for the data facet: stop it, start it with the live versions, and let it migrate before anything else.
  async restart(account: string, name: string): Promise<Restarted> {
    this.#plan = null;
    this.ctx.facets.abort('data', new Error('the live versions changed'));
    const plan = this.plan();
    if (plan.latest === 0) return { live: plan.live, migration: null, held: plan.held };
    const data = this.data(account, name),
      migration = await data.migration();
    await this.arm(account, name, await data.nextWake());
    const machines = plan.machines.length > 0 ? await data.machines() : null;
    return { live: plan.live, migration, held: plan.held, ...(machines ? { machines } : {}) };
  }
  // { rules: true }: each version with what the compiler deployed now says of its source (rulesNow): `rules: "passes"`,
  // or the problems that would refuse it today. { source: true }: with its source (internal).
  // A live version is also read under the machines other live versions declare (machinePlan): what it does there
  // that they do not declare is listed with its rules, and allowed by the triggers while it is live.
  versions({ rules = false, source = false }: { rules?: boolean; source?: boolean } = {}): Listed[] {
    const retired = new Set(
        this.#sql
          .exec('SELECT version FROM _tape_retired')
          .toArray()
          .map(r => int(r.version)),
      ),
      chains = this.chains();
    const notes = rules ? this.machines().notes : [];
    const fails = (version: number, hash: string, text: string): Reported[] => [
      ...rulesNow(hash, text),
      ...(retired.has(version)
        ? []
        : notes.filter(n => n.version === version).map(({ code, line, message }) => ({ code, line, message }))),
    ];
    return this.#sql
      .exec(
        `SELECT version, hash, length(plain) AS bytes, created_at${rules || source ? ', source' : ''} FROM _tape_versions ORDER BY version`,
      )
      .toArray()
      .map((r): Listed => {
        const version = int(r.version),
          hash = str(r.hash),
          failed = rules ? fails(version, hash, str(r.source)) : [];
        return {
          version,
          hash,
          bytes: int(r.bytes),
          created_at: int(r.created_at),
          live: !retired.has(version),
          migrations: (chains.get(version) ?? []).length,
          ...(source ? { source: str(r.source) } : {}),
          ...(rules ? { rules: failed.length > 0 ? { fails: failed, note: NOTE_OLD } : 'passes' } : {}),
        };
      });
  }
  // The name's storage: its own SQLite (versions, calls, traces) and its data's (tables and request log)
  async storageUse(
    account: string,
    name: string,
  ): Promise<{
    name: { bytes: number; versions: number };
    data: { bytes: number; log_rows: number; log_bytes: number } | null;
  }> {
    const own = {
      bytes: this.#sql.databaseSize,
      versions: int(this.#sql.exec('SELECT count(*) AS n FROM _tape_versions').one().n),
    };
    return { name: own, data: own.versions > 0 ? await this.data(account, name).storageUse() : null };
  }
  // One build of one version, for the cached Wasm entrypoint.
  wasm(version: number, kind: string | undefined): Uint8Array | null {
    const [row] = this.#sql
      .exec(`SELECT ${kind === 'traced' ? 'traced' : 'plain'} AS wasm FROM _tape_versions WHERE version = ?1`, version)
      .toArray();
    return row?.wasm instanceof ArrayBuffer ? new Uint8Array(row.wasm) : null;
  }
  /** The code of the name's data: program.ts and the host, with every live version's builds as modules. */
  async #code(account: string, name: string, plan: Required<Plan>): Promise<WorkerLoaderWorkerCode> {
    const read = async (v: number, kind: string): Promise<ArrayBuffer> =>
      (await this.ctx.exports.Wasm.fetch(`http://wasm/${account}/${name}/${v}/${kind}`)).arrayBuffer();
    const rows = this.#sql
      .exec(`SELECT version, source, sites FROM _tape_versions WHERE version IN (${plan.live.join(',') || 'NULL'})`)
      .toArray()
      .map(r => ({ v: int(r.version), source: str(r.source), sites: listIn(r.sites) }));
    const modules: Record<string, WorkerLoaderModule> = {};
    for (const r of rows) {
      modules[`v${r.v}.plain.wasm`] = { wasm: await read(r.v, 'plain') };
      modules[`v${r.v}.traced.wasm`] = { wasm: await read(r.v, 'traced') };
      modules[`v${r.v}.sites.json`] = { json: r.sites };
      modules[`v${r.v}.tape`] = { text: r.source };
    }
    const imports = rows.map(
      ({ v }) =>
        `import p${v} from './v${v}.plain.wasm'; import t${v} from './v${v}.traced.wasm'; import s${v} from './v${v}.sites.json'; import c${v} from './v${v}.tape';`,
    );
    const entries = rows.map(({ v }) => `${v}: { plain: p${v}, traced: t${v}, sites: s${v}, source: c${v} }`);
    return {
      compatibilityDate: '2026-11-13',
      mainModule: 'program.js',
      globalOutbound: null,
      env: {
        CALLS: this.ctx.exports.Calls({ props: { account, from: name } }),
        SELF: `${account}/${name}`,
        PLAN: plan,
      },
      modules: {
        'program.js': programSrc,
        'records.js': recordsSrc,
        'host.js': hostSrc,
        ...HOST_PARTS,
        'versions.js': `${imports.join('\n')}\nexport default { ${entries.join(', ')} };`,
        ...modules,
      },
    };
  }
  // The name's data, with every live version's builds loaded. The Loader caches the code by its live set.
  data(account: string, name: string): Fetcher<Program> {
    const plan = this.plan();
    return this.ctx.facets.get<Program>('data', () => ({
      class: this.env.LOADER.get(`${account}/${name}/data@${plan.live.join(',')}`, () =>
        this.#code(account, name, plan),
      ).getDurableObjectClass<Program>('Program'),
    }));
  }
  // the tables of routed requests (see the constructor), made the first time this object needs them
  #routedMade = false;
  #routedTables(): void {
    if (this.#routedMade) return;
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS _tape_invoked(call_span TEXT NOT NULL, trace TEXT NOT NULL, version INTEGER, log_id TEXT, name_span TEXT NOT NULL, began INTEGER NOT NULL, took INTEGER, facet_began INTEGER, facet_took INTEGER, status INTEGER, error TEXT, fault TEXT, at INTEGER NOT NULL)',
    );
    attempt(() => this.#sql.exec('ALTER TABLE _tape_invoked ADD COLUMN clock_lag INTEGER'));
    this.#sql.exec('CREATE INDEX IF NOT EXISTS _tape_invoked_by_call ON _tape_invoked(call_span)');
    this.#sql.exec('CREATE INDEX IF NOT EXISTS _tape_invoked_by_trace ON _tape_invoked(trace)');
    this.#sql.exec('CREATE INDEX IF NOT EXISTS _tape_invoked_by_log ON _tape_invoked(log_id)');
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS _tape_routed(call_span TEXT PRIMARY KEY, trace TEXT NOT NULL, route TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID',
    );
    this.#sql.exec('CREATE INDEX IF NOT EXISTS _tape_routed_by_trace ON _tape_routed(trace)');
    this.#sql.exec('CREATE INDEX IF NOT EXISTS _tape_routed_by_at ON _tape_routed(at)');
    this.#routedMade = true;
  }
  // traceparent: the caller's W3C trace context, which the run's span joins; fault: an injected fault (jepsen-*):
  // reset_callee_before, reset_callee_after, storage_error. call: { trace, span } from a router (spans.ts): this
  // object then records its own span (a child of the router's call span) and the facet call's window, before it
  // replies, whatever the outcome; the run's span is a child of this one.
  async invoke(
    account: string,
    name: string,
    version: number,
    bytes: Uint8Array | ArrayBuffer,
    options: InvokeOptions = {},
  ): Promise<Response> {
    if (this.#upgrading)
      return reply(
        {
          error: `${name} is being upgraded to the current program; the request did not run: send it again`,
          outcome: 'not applied',
          upgrading: true,
        },
        503,
      );
    this.#inflight++;
    try {
      return await this.#invoke(account, name, version, bytes, options);
    } finally {
      this.#inflight--;
      if (this.#inflight === 0) this.#drained?.();
    }
  }
  /** The record of one routed call: opened when it arrives, noted when it is answered. Without a router, nothing.
   * The row is written when the call arrives and completed when it is answered: a call in flight when this object
   * is reset (by a deploy, an eviction, another request's injected fault) keeps the row it began with. */
  #record(
    call: InvokeOptions['call'],
    version: number,
    began: number,
    faulty: string | null,
    lag: number,
  ): { span: string | null; opened: () => void; note: (f: Outcome) => void } {
    if (!call) return { span: null, opened: () => {}, note: () => {} };
    this.#routedTables();
    const span = randomHex(8);
    return {
      span,
      opened: () => {
        this.#sql.exec(
          'INSERT INTO _tape_invoked(call_span, trace, version, name_span, began, fault, at, clock_lag) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
          call.span,
          call.trace,
          version,
          span,
          began,
          faulty,
          Date.now(),
          lag,
        );
      },
      note: f => {
        this.#sql.exec(
          'UPDATE _tape_invoked SET log_id = ?2, took = ?3, facet_began = ?4, facet_took = ?5, status = ?6, error = ?7 WHERE name_span = ?1',
          span,
          f.log_id ?? null,
          Date.now() - began,
          f.facet_began ?? null,
          f.facet_took ?? null,
          f.status ?? null,
          f.error ?? null,
        );
      },
    };
  }
  async #invoke(
    account: string,
    name: string,
    asked: number,
    bytes: Uint8Array | ArrayBuffer,
    { traceparent = null, fault = null, call = null }: InvokeOptions,
  ): Promise<Response> {
    // the span begins when the call is running here, by a current clock (spans.ts fresh): this object may have
    // been busy with other calls, and its clock as old as its last I/O
    const clock = await fresh();
    const faulty = FAULTY.test(account) ? fault : null;
    // version 0: the latest live version, chosen here, so a cluster's upgrade (kvUpgrade) switches every request
    // at one point in this object's order, whatever version of the router sent it
    const version = asked === 0 ? this.plan().latest : asked;
    const { span, opened, note } = this.#record(call, version, clock.now, faulty, clock.lag);
    if (!this.plan().live.includes(version)) {
      const retired = this.versions().some(v => v.version === version),
        error = retired ? `v${version} is retired` : 'no such version';
      opened();
      note({ status: retired ? 410 : 404, error });
      return reply({ error }, retired ? 410 : 404);
    }
    if (faulty === 'reset_callee_before') this.reset('jepsen: the shard was reset before it ran the request');
    opened();
    if (faulty === 'reset_callee_opened') {
      await this.ctx.storage.sync();
      this.reset('jepsen: the object was reset after it opened its record of the call, before the run');
    }
    const parent = call && span !== null ? `00-${call.trace}-${span}-01` : traceparent;
    const headers: Record<string, string> = {
      ...(parent === null || parent === '' ? {} : { traceparent: parent }),
      ...(faulty === 'storage_error' ? { 'tape-fault': 'storage_error' } : {}),
    };
    const facetBegan = Date.now();
    let res: Response;
    try {
      res = await this.data(account, name).fetch(`http://program/${version}`, { method: 'POST', body: bytes, headers });
    } catch (e) {
      // the facet stopped (reset, evicted) before it answered: what it committed is kept, its log is not written
      note({
        facet_began: facetBegan,
        facet_took: Date.now() - facetBegan,
        error: `the run stopped before it answered: ${messageOf(e)}`,
      });
      throw e;
    }
    const facetTook = Date.now() - facetBegan;
    // the run committed (the facet answers after its transaction): reset before this object records it
    if (faulty === 'reset_callee_ran')
      this.reset('jepsen: the object was reset after the run committed, before it recorded the run');
    await this.arm(account, name, res.headers.get('tape-next-wake'));
    note({
      log_id: res.headers.get('tape-request-id'),
      facet_began: facetBegan,
      facet_took: facetTook,
      status: res.status,
      error: res.headers.get('tape-applied') === 'false' ? 'the run failed and was rolled back' : null,
    });
    if (faulty === 'reset_callee_after') {
      await res.arrayBuffer();
      await this.ctx.storage.sync(); // this object's record of the run is durable, as it would be after a reply
      this.reset('jepsen: the shard was reset after it committed, before it replied');
    }
    await this.pruneTick(account, name);
    if (span === null) return res;
    const out = new Response(res.body, res);
    out.headers.set('tape-supervisor-span', span);
    return out;
  }
  // The router's record of one request (spans.ts), stored before the router answers.
  routed(callSpan: string, route: RouterRecord): true {
    this.#routedTables();
    this.#sql.exec(
      'INSERT INTO _tape_routed(call_span, trace, route, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(call_span) DO UPDATE SET route = excluded.route',
      callSpan,
      route.trace,
      JSON.stringify(route),
      Date.now(),
    );
    return true;
  }
  // ---- Retention of trace records (RUNTIME-SPEC R-RET-6). The tables pruned here and the data's _tape_log are read
  // only by the trace, log and OTLP routes and the request view, never to answer a request (test/retention.test.ts
  // checks the readers), so a prune changes no answer.
  #keepMade = false;
  #keepTable(): void {
    if (this.#keepMade) return;
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS _tape_keep(one INTEGER PRIMARY KEY CHECK (one = 1), n INTEGER NOT NULL, pruned_before INTEGER)',
    );
    this.#keepMade = true;
  }
  keep(): { n: number; pruned_before: number | null } {
    this.#keepTable();
    const [r] = this.#sql.exec('SELECT n, pruned_before FROM _tape_keep').toArray();
    return { n: intOrNull(r?.n) ?? TRACE_KEEP, pruned_before: intOrNull(r?.pruned_before) };
  }
  setKeep(n: number): Refusal | { n: number; pruned_before: number | null } {
    if (!Number.isInteger(n) || n < KEEP_MIN || n > KEEP_MAX)
      return { status: 400, error: `trace_keep is an integer from ${KEEP_MIN} to ${KEEP_MAX}` };
    this.#keepTable();
    this.#sql.exec('INSERT INTO _tape_keep(one, n) VALUES (1, ?1) ON CONFLICT(one) DO UPDATE SET n = excluded.n', n);
    this.#ticks = PRUNE_EVERY;
    return this.keep();
  }
  #ticks = 0;
  async pruneTick(account: string, name: string): Promise<void> {
    this.#ticks++;
    if (this.#ticks < PRUNE_EVERY) return;
    this.#ticks = 0;
    await this.prune(account, name);
  }
  /** Delete all but the newest n rows of a table, by insertion order: how many went, and the newest time removed.
   * Rowids only grow (no row is deleted but here), so the newest n are those above max - n. */
  #pruneByRowid(table: string, n: number): { deleted: number; at: number | null } {
    const [cut] = this.#sql
      .exec(
        `SELECT rowid AS r FROM ${table} WHERE rowid > (SELECT max(rowid) FROM ${table}) - ?1 ORDER BY rowid LIMIT 1`,
        n,
      )
      .toArray();
    if (!cut) return { deleted: 0, at: null };
    const gone = this.#sql.exec(`SELECT count(*) AS c, max(at) AS at FROM ${table} WHERE rowid < ?1`, cut.r).one();
    if (int(gone.c) === 0) return { deleted: 0, at: null };
    this.#sql.exec(`DELETE FROM ${table} WHERE rowid < ?1`, cut.r);
    return { deleted: int(gone.c), at: int(gone.at) };
  }
  // the router's records by count as well, newest n by (at, call_span): a record whose call never reached this
  // object (reset before it ran) has no invocation, so it cannot be pruned by the invocations' age (the first
  // version of this prune did that, and lost such a record's trace: caught by the seams run, VERIFY 24)
  #pruneRouted(n: number): { deleted: number; at: number | null } {
    const [edge] = this.#sql
      .exec('SELECT at, call_span FROM _tape_routed ORDER BY at DESC, call_span DESC LIMIT 1 OFFSET ?1', n)
      .toArray();
    if (!edge) return { deleted: 0, at: null };
    const gone = this.#sql
      .exec(
        'SELECT count(*) AS c, max(at) AS at FROM _tape_routed WHERE (at, call_span) <= (?1, ?2)',
        edge.at,
        edge.call_span,
      )
      .one();
    this.#sql.exec('DELETE FROM _tape_routed WHERE (at, call_span) <= (?1, ?2)', edge.at, edge.call_span);
    return { deleted: int(gone.c), at: int(gone.at) };
  }
  // Deletes the trace records of all but the newest n requests: rows by insertion order (rowid), the router's
  // records older than the oldest invocation kept, and the data's log (Program.pruneLog). pruned_before is the time
  // of the newest record removed, which the trace routes report.
  async prune(account: string, name: string): Promise<{ deleted: number; pruned_before: number | null }> {
    this.#routedTables();
    this.#keepTable();
    const { n } = this.keep();
    const cuts = [
      this.#pruneByRowid('_tape_invoked', n),
      this.#pruneByRowid('_tape_served', n),
      this.#pruneRouted(n),
      ...(this.#alive() ? [await this.data(account, name).pruneLog(n)] : []),
    ].filter(c => c.deleted > 0);
    if (cuts.length > 0)
      this.#sql.exec(
        'INSERT INTO _tape_keep(one, n, pruned_before) VALUES (1, ?1, ?2) ON CONFLICT(one) DO UPDATE SET pruned_before = max(coalesce(pruned_before, 0), excluded.pruned_before)',
        n,
        Math.max(...cuts.map(c => c.at ?? 0)),
      );
    return { deleted: cuts.reduce((sum, c) => sum + c.deleted, 0), pruned_before: this.keep().pruned_before };
  }
  // ---- An account's names (RUNTIME-SPEC R-RET-7), at <account>/~registry
  registryTable(): void {
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS _tape_names(name TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID',
    );
  }
  registerName(name: string, kind: string): true {
    this.registryTable();
    this.#sql.exec('INSERT INTO _tape_names VALUES (?1, ?2, ?3) ON CONFLICT(name) DO NOTHING', name, kind, Date.now());
    return true;
  }
  // ---- The published names of every account (PUBLISHED, one object): the public route asks only this object, so a
  // tokenless request for a name nobody published reaches no account's objects and stores nothing.
  setPublished(key: string, published: boolean): true {
    this.#sql.exec('CREATE TABLE IF NOT EXISTS _tape_published(key TEXT PRIMARY KEY) WITHOUT ROWID');
    if (published) this.#sql.exec('INSERT INTO _tape_published VALUES (?1) ON CONFLICT(key) DO NOTHING', key);
    else this.#sql.exec('DELETE FROM _tape_published WHERE key = ?1', key);
    return true;
  }
  /** Is account/name published? Reads only. */
  isPublished(key: string): boolean {
    return (
      this.#has('_tape_published') &&
      this.ctx.storage.sql.exec('SELECT 1 FROM _tape_published WHERE key = ?1', key).toArray().length > 0
    );
  }
  registered(): { name: string; kind: string; at: number }[] {
    this.registryTable();
    return this.#sql
      .exec('SELECT name, kind, at FROM _tape_names ORDER BY name')
      .toArray()
      .map(r => ({ name: str(r.name), kind: str(r.kind), at: int(r.at) }));
  }
  #registered = false;
  async enrol(account: string, name: string, kind: string): Promise<void> {
    if (this.#registered || name === '~registry') return;
    await this.ctx.exports.Name.getByName(`${account}/~registry`).registerName(name, kind);
    this.#registered = true;
  }
  size(): number {
    return this.#sql.databaseSize;
  }
  // Removes everything this object stores: its data (the facet's own rows first, then the facet), its alarm, and
  // its own SQLite; the object is then stopped, so nothing of it stays in memory.
  async wipe(account: string, name: string): Promise<{ name: string; bytes_before: number }> {
    const before = this.#sql.databaseSize;
    if (this.#alive()) {
      try {
        await this.data(account, name).wipe();
      } catch {
        // deleted below either way
      }
    }
    // no facet: nothing to delete
    attempt(() => {
      this.ctx.facets.delete('data');
    });
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // The deletion is made durable, then the object is stopped, so nothing of it stays in memory and a later
    // request finds a fresh object. In production the stop can overtake this reply, so the caller gets the stop's
    // error, WIPED_ERROR, which means done (the deletion of 18:53 ET, 15 November 2026: docs/defects.md P2).
    await this.ctx.storage.sync();
    setTimeout(() => {
      // already stopped: nothing to do
      attempt(() => {
        this.ctx.abort(WIPED_ERROR);
      });
    }, 0);
    return { name, bytes_before: before };
  }
  /** A run of this name's data with its calls joined, or null when its log is gone. */
  async #runOf(account: string, name: string, id: string): Promise<Joined | null> {
    const v = this.#alive() ? await this.data(account, name).view(id) : null;
    return v ? { account, name, ...v, calls: await this.joinCalls(account, name, v, 0) } : null;
  }
  /** One time this object took a routed call, with the run it led to: by its log id, or (the object stopped while
   * the call was in flight) by the span the run's log names as its parent, if its writes committed. */
  async #invokedOf(account: string, name: string, row: Row): Promise<Invoked> {
    const base = {
      call_span: str(row.call_span),
      trace: str(row.trace),
      version: intOrNull(row.version),
      log_id: strOrNull(row.log_id),
      name_span: str(row.name_span),
      began: int(row.began),
      took: intOrNull(row.took),
      facet_began: intOrNull(row.facet_began),
      facet_took: intOrNull(row.facet_took),
      status: intOrNull(row.status),
      error: strOrNull(row.error),
      fault: strOrNull(row.fault),
      clock_lag: intOrNull(row.clock_lag),
    };
    if (base.log_id !== null && base.log_id !== '') {
      const run = await this.#runOf(account, name, base.log_id);
      return {
        ...base,
        run,
        missing: run ? null : `the run's log ${base.log_id} is gone (its version is no longer live)`,
        recovered: false,
      };
    }
    if (base.took !== null || !this.#alive()) return { ...base, run: null, missing: null, recovered: false };
    const runs = await this.data(account, name).findRuns(base.trace, base.began - 60000),
      found = runs.find(x => x.parent === base.name_span);
    if (found) return { ...base, run: await this.#runOf(account, name, found.id), missing: null, recovered: true };
    return {
      ...base,
      run: null,
      missing:
        "this object stopped while the call was in flight (reset or evicted), and the run left no log: a run's log commits with its writes (at each call it makes, and at the end), so it committed nothing",
      recovered: false,
    };
  }
  // One routed request as data: the router's record (or null), and each time this object took the call, with the
  // run it made (joined with its calls) when there is one.
  async request(account: string, name: string, callSpan: string): Promise<Routed | null> {
    this.#routedTables();
    const [r] = this.#sql.exec('SELECT route FROM _tape_routed WHERE call_span = ?1', callSpan).toArray();
    const rows = this.#sql.exec('SELECT * FROM _tape_invoked WHERE call_span = ?1 ORDER BY rowid', callSpan).toArray();
    if (!r && rows.length === 0) return null;
    return {
      account,
      name,
      call_span: callSpan,
      route: r ? routeIn(r.route) : null,
      invoked: await Promise.all(rows.map(row => this.#invokedOf(account, name, row))),
      orphans: [],
      woken: [],
    };
  }
  // The routed requests stored here (_tape_routed), newest first, from `since` (ms) on, at most `limit`; each with
  // the run it reached (its log id and version, from _tape_invoked) and the first bytes of that run's request, and
  // the woken runs (_tape_woken) in the same window. Read by GET /:account/:name/requests.
  async requests(
    account: string,
    name: string,
    since: number,
    limit: number,
  ): Promise<{ requests: RequestListed[]; woken: Row[] }> {
    this.#routedTables();
    const rows = this.#sql
      .exec(
        'SELECT r.call_span, r.route, r.at, i.version, i.log_id FROM _tape_routed AS r LEFT JOIN _tape_invoked AS i ON i.rowid = (SELECT rowid FROM _tape_invoked WHERE call_span = r.call_span ORDER BY at DESC LIMIT 1) WHERE r.at >= ?1 ORDER BY r.at DESC, r.call_span DESC LIMIT ?2',
        since,
        limit,
      )
      .toArray();
    const ids = rows.map(r => str(r.log_id)).filter(id => id !== '');
    const heads: Record<string, string> =
      ids.length > 0 && this.#alive() ? await this.data(account, name).requestHeads(ids) : {};
    const woken = this.#sql
      .exec(
        'SELECT key, version, status, log_id, error, due, began, took FROM _tape_woken WHERE began >= ?1 ORDER BY rowid DESC LIMIT ?2',
        since,
        limit,
      )
      .toArray();
    return {
      requests: rows.map(r => ({
        call_span: str(r.call_span),
        at: int(r.at),
        version: intOrNull(r.version),
        log_id: strOrNull(r.log_id),
        route: routeIn(r.route),
        head: heads[str(r.log_id)] ?? null,
      })),
      woken,
    };
  }
  // Every routed request this object holds under one trace id.
  async traced(account: string, name: string, trace: string): Promise<Routed[]> {
    this.#routedTables();
    const spans = this.#sql
      .exec(
        'SELECT call_span, min(at) AS at FROM (SELECT call_span, at FROM _tape_routed WHERE trace = ?1 UNION ALL SELECT call_span, at FROM _tape_invoked WHERE trace = ?1) GROUP BY call_span ORDER BY at',
        trace,
      )
      .toArray();
    const found = await Promise.all(spans.map(s => this.request(account, name, str(s.call_span))));
    const list = found.filter(r => r !== null);
    if (this.#alive()) await this.#adopt(account, name, trace, list);
    return list;
  }
  // Runs of this trace that no record here leads to: their supervisor's record was lost with the object. With
  // one request in the trace here they belong to it; otherwise each stands alone. Either way they are marked.
  async #adopt(account: string, name: string, trace: string, list: Routed[]): Promise<void> {
    const alone = (): Routed => ({ account, name, call_span: null, route: null, invoked: [], orphans: [], woken: [] });
    const linked = new Set(list.flatMap(r => r.invoked.flatMap(i => (i.run ? [i.run.id] : []))));
    const data = this.data(account, name),
      orphans = (await data.findRuns(trace)).filter(x => !linked.has(x.id));
    for (const o of orphans) {
      const run = await this.#runOf(account, name, o.id);
      if (!run) continue;
      const [head] = run.effects,
        [first] = list;
      // a woken run (a timer's) is a later child of the run that set the timer, in the same trace: it keeps its parent
      if (head && 'woke' in head && head.woke !== undefined) {
        const to = first ?? alone();
        if (!first) list.push(to);
        to.woken = [...(to.woken ?? []), run];
      } else if (first && list.length === 1) first.orphans = [...(first.orphans ?? []), run];
      else list.push({ ...alone(), orphans: [run] });
    }
  }
  async requestLog(account: string, name: string, callSpan: string, format: string, links?: Links): Promise<Response> {
    const r = await this.request(account, name, callSpan);
    if (!r) return reply({ error: 'no such request' }, 404);
    if (format === 'json') return reply(r);
    if (format === 'otlp') return reply(view.requestOtlp([r]));
    return format === 'html' ? htmlPage(view.requestHtml(r, links)) : textPage(view.requestText(r));
  }
  async traceLog(account: string, name: string, trace: string, format: string): Promise<Response> {
    const list = await this.traced(account, name, trace);
    return format === 'json' ? reply({ trace, requests: list }) : reply(view.requestOtlp(list));
  }
  // the call span a run was routed under, if any (a run from an older log, a woken run or a tool call has none)
  routedOf(logId: string): string | null {
    this.#routedTables();
    const [row] = this.#sql.exec('SELECT call_span FROM _tape_invoked WHERE log_id = ?1', logId).toArray();
    return strOrNull(row?.call_span);
  }
  // ---- KV (kv.js). At <account>/~kv: the account's clusters, one row each, never changed once ready.
  #kvMade = false;
  kvTables(): void {
    if (this.#kvMade) return;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS _kv_clusters(cluster TEXT PRIMARY KEY, shards INTEGER NOT NULL CHECK (shards BETWEEN 1 AND ${MAX_SHARDS}), state TEXT NOT NULL CHECK (state IN ('creating', 'ready')), created_at INTEGER NOT NULL) WITHOUT ROWID`,
    );
    // R-RET-2, R-RET-6: a cluster's retention, fixed when it is made (NULL for a cluster made before)
    for (const col of ['window_ms INTEGER', 'skew_ms INTEGER', 'trace_keep INTEGER'])
      attempt(() => this.#sql.exec(`ALTER TABLE _kv_clusters ADD COLUMN ${col}`));
    this.#kvMade = true;
  }
  // The cluster as it stands, made 'creating' with this size and retention if it did not exist (created: true).
  kvClaim(cluster: string, shards: number, r: Partial<Retention> = {}): (Cluster & { created: boolean }) | null {
    this.kvTables();
    const [made] = this.#sql
      .exec(
        "INSERT INTO _kv_clusters(cluster, shards, state, created_at, window_ms, skew_ms, trace_keep) VALUES (?1, ?2, 'creating', ?3, ?4, ?5, ?6) ON CONFLICT(cluster) DO NOTHING RETURNING cluster, shards, state, created_at, window_ms, skew_ms, trace_keep",
        cluster,
        shards,
        Date.now(),
        r.window ?? 3600000,
        r.skew ?? 300000,
        r.keep ?? 100000,
      )
      .toArray();
    if (made) return { ...clusterOf(made), created: true };
    const was = this.kvCluster(cluster);
    return was && { ...was, created: false };
  }
  kvReady(cluster: string): void {
    this.kvTables();
    this.#sql.exec("UPDATE _kv_clusters SET state = 'ready' WHERE cluster = ?1", cluster);
  }
  kvCluster(cluster: string): Cluster | null {
    this.kvTables();
    const [row] = this.#sql
      .exec(
        'SELECT cluster, shards, state, created_at, window_ms, skew_ms, trace_keep FROM _kv_clusters WHERE cluster = ?1',
        cluster,
      )
      .toArray();
    return row ? clusterOf(row) : null;
  }
  kvClusters(): Cluster[] {
    this.kvTables();
    return this.#sql
      .exec(
        'SELECT cluster, shards, state, created_at, window_ms, skew_ms, trace_keep FROM _kv_clusters ORDER BY cluster',
      )
      .toArray()
      .map(clusterOf);
  }
  // At <account>/kv-<cluster>-<i>: v1 is the shard program, uploaded once, then its placement, set once. Concurrent
  // creates share one run; a later one finds the work done.
  #kvInit: Promise<Refusal | { shard: number; shards: number }> | null = null;
  kvInit(
    account: string,
    name: string,
    built: Upload,
    shard: number,
    shards: number,
    retention: Retention | null = null,
  ): Promise<Refusal | { shard: number; shards: number }> {
    this.#kvInit ??= this.#kvInitOnce(account, name, built, shard, shards, retention).finally(() => {
      this.#kvInit = null;
    });
    return this.#kvInit;
  }
  async #kvInitOnce(
    account: string,
    name: string,
    built: Upload,
    shard: number,
    shards: number,
    retention: Retention | null,
  ): Promise<Refusal | { shard: number; shards: number }> {
    const [v1] = this.versions();
    if (!v1) {
      const row = await this.upload(account, name, built);
      if ('error' in row) return { status: row.status, error: `the shard program was refused: ${row.error}` };
    } else if (v1.hash !== built.hash)
      return {
        status: 409,
        error: `${name} v1 is not the shard program (hash ${v1.hash.slice(0, 12)}, want ${built.hash.slice(0, 12)})`,
      };
    if (retention) this.setKeep(retention.keep);
    const kept = retention ? `&window=${retention.window}&skew=${retention.skew}` : '';
    const res = await this.invoke(account, name, 1, enc.encode(`PUT /placement/${shard}?shards=${shards}${kept}\n`)),
      body = await res.text();
    return res.status === 200
      ? { shard, shards }
      : { status: res.status === 409 ? 409 : 500, error: `placement ${shard}/${shards}: ${res.status} ${body}` };
  }
  // RUNTIME-SPEC R-UPG: this shard moved to the current shard program. While it runs, every request is refused
  // before it runs (503, not applied) and the ones already running are waited for, so the steps see no request
  // between them: the check that no op id stored by the old program could be resent and not found (R-UPG-2), the
  // upload (its migrations, checked against the data first, only add), then every older version retired.
  // (blockConcurrencyWhile cannot do this: the upload's calls to this object's data facet wait on it.)
  // dry: the check only, nothing held.
  #upgrading = false;
  #inflight = 0;
  #drained: (() => void) | null = null;
  async kvUpgrade(
    account: string,
    name: string,
    built: Upload,
    { dry = false }: { dry?: boolean } = {},
  ): Promise<Upgrade> {
    if (this.#upgrading) return { status: 409, error: `an upgrade of ${name} is already running` };
    const plan = this.plan(),
      latest = this.versions().find(v => v.version === plan.latest);
    if (!latest) return { status: 404, error: `${name} has no live version` };
    if (latest.hash === built.hash && plan.live.length === 1) return { state: 'current', version: latest.version };
    const from = { from: latest.version, from_hash: latest.hash };
    const held = (legacy: Legacy): Upgrade => ({
      status: 409,
      error: `${legacy.timed_recent} op ids stored by v${latest.version} in table ops are timed and recent enough (t at or after ${legacy.since}) that the current program would accept a resend, and not find it. Upgrade once they are older (R-UPG-2).`,
      legacy,
    });
    if (dry) {
      const legacy = await this.data(account, name).legacyOps(Date.now());
      return legacy.timed_recent > 0 ? held(legacy) : { state: 'ready', ...from, legacy };
    }
    this.#upgrading = true;
    try {
      while (this.#inflight > 0)
        await new Promise<void>(done => {
          this.#drained = done;
        });
      const legacy = await this.data(account, name).legacyOps(Date.now());
      if (legacy.timed_recent > 0) return held(legacy);
      const moved = await this.#moveTo(account, name, built, latest, plan.live);
      return 'error' in moved ? moved : { state: 'upgraded', ...from, ...moved, legacy };
    } finally {
      this.#upgrading = false;
    }
  }
  /** Upload the current program when the latest is not it, then retire every other live version. */
  async #moveTo(
    account: string,
    name: string,
    built: Upload,
    latest: Listed,
    live: readonly number[],
  ): Promise<{ to: number; retired: number[] } | (Refusal & { problems?: unknown; to?: number; retired?: number[] })> {
    let to = latest.version;
    if (latest.hash !== built.hash) {
      const row = await this.upload(account, name, built);
      if ('error' in row)
        return {
          status: row.status,
          error: `the current shard program was refused: ${row.error}`,
          problems: row.problems,
        };
      to = row.version;
    }
    const retired: number[] = [];
    for (const v of live) {
      if (v === to) continue;
      const r = await this.retire(account, name, v);
      if ('error' in r) return { status: 500, error: `v${v}: ${r.error}`, to, retired };
      retired.push(v);
    }
    return { to, retired };
  }
  // One request joined with its calls: for each, what the callee recorded under this trace and this span.
  async joined(account: string, name: string, version: number, id: string): Promise<Joined | null> {
    const run = await this.#runOf(account, name, id);
    return run?.version === version ? run : null;
  }
  /** What a callee recorded for the calls this run's span made; null: nested too deep to ask; a string: why not. */
  async #servedBy(
    account: string,
    callee: string,
    head: { trace: string; span: string },
    depth: number,
  ): Promise<ServedRow[] | string | null> {
    if (depth >= 4) return null;
    try {
      return await this.ctx.exports.Name.getByName(`${account}/${callee}`).served(
        account,
        callee,
        head.trace,
        head.span,
        depth + 1,
      );
    } catch (e) {
      return messageOf(e);
    }
  }
  // A run's calls, each with what its callee recorded under the run's trace and span (served: null when the callee
  // has none), recursively: a callee's run carries its own calls, to a depth of 4. Each callee is asked once and
  // its rows are matched to the calls in order, so two calls to one callee never share a row.
  async joinCalls(account: string, name: string, v: Run, depth: number): Promise<JoinedCall[]> {
    const [head] = v.effects,
      self = `${account}/${name}`,
      calls = v.effects.filter((e): e is CallEffect => 'call' in e);
    const { trace, span } = head && 'span' in head ? head : {};
    if (calls.length === 0 || trace === undefined || span === undefined || span === '') return [];
    const callees = [...new Set(calls.map(e => e.call))];
    const rowsBy = new Map(
      await Promise.all(
        callees.map(async (c): Promise<[string, ServedRow[] | string | null]> => [
          c,
          await this.#servedBy(account, c, { trace, span }, depth),
        ]),
      ),
    );
    return calls.map(e => {
      const rows = rowsBy.get(e.call) ?? null;
      if (rows === null) return { e, served: null, why: 'nested deeper than 4 calls: not joined' };
      if (typeof rows === 'string') return { e, served: null, why: `the callee could not be asked: ${rows}` };
      const at = rows.findIndex(r => ('once' in e ? r.key === `${self}/${e.method}/${e.once}` : r.method === e.method));
      return { e, served: rows.splice(at, at < 0 ? 0 : 1)[0] ?? null };
    });
  }
  async log(
    account: string,
    name: string,
    version: number,
    id: string,
    format: string,
    links?: Links,
  ): Promise<Response> {
    // a run a router sent here is shown with the router's spans: the whole request
    const callSpan = format === 'log' ? null : this.routedOf(id);
    if (callSpan !== null && callSpan !== '') return this.requestLog(account, name, callSpan, format, links);
    const j = await this.joined(account, name, version, id);
    if (!j) return reply({ error: 'no such version or request' }, 404);
    if (format === 'log') return reply({ id, at: j.at, request: j.request, effects: j.effects });
    if (format === 'otlp') return reply(view.otlp(j));
    return format === 'html' ? htmlPage(view.html(j, links)) : textPage(view.text(j));
  }
  // A call from another program in this account: the latest version answers, and the answer is recorded.
  async serve(
    account: string,
    name: string,
    meta: CallMeta,
    bytes: Uint8Array | ArrayBuffer,
    fault: string | null = null,
  ): Promise<{ status: string; body: Uint8Array }> {
    if (!this.#alive()) return { status: 'rejected', body: enc.encode(`there is no program named ${name}`) };
    const faulty = FAULTY.test(account) ? fault : null;
    if (faulty === 'reset_callee_before') this.reset('jepsen: the callee was reset before it ran');
    const began = (await fresh()).now,
      { status, body, id, version, next } = await this.data(account, name).serve(
        meta,
        bytes,
        faulty === 'storage_error' ? faulty : null,
      ),
      at = Date.now();
    // the run committed: reset before the row that joins it to the caller's trace is written
    if (faulty === 'reset_callee_ran')
      this.reset('jepsen: the callee was reset after its run committed, before it recorded the call');
    await this.arm(account, name, next);
    // The served row joins the caller's trace to this run. It is written before the reply (the output gate holds the
    // reply until it is durable), so a call that answered always has its row; it was once written after the reply,
    // and an eviction in that turn lost the callee's part of the trace without a word.
    this.#sql.exec(
      'INSERT INTO _tape_served(trace, parent, version, key, status, log_id, at, began, took, method) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)',
      meta.trace?.trace ?? null,
      meta.trace?.parent ?? null,
      version,
      meta.key ?? null,
      status,
      id,
      at,
      began,
      at - began,
      meta.method,
    );
    if (faulty === 'reset_callee_after') {
      await this.ctx.storage.sync();
      this.reset('jepsen: the callee was reset after it committed, before it replied');
    }
    await this.pruneTick(account, name);
    return { status, body };
  }
  // Fault injection (faults.ts), for accounts named jepsen-*: this object, at <account>/~faults, keeps the plan,
  // how many calls each site has made, and every fault it handed out.
  // ctx.abort() does not stop the code that called it: in production the invocation ran on, and a run begun after an
  // injected reset committed on the object's old instance (H1: a replay of a write with no commit in the trace, and
  // versions no trace explains). A reset stops here, as a real one does: nothing after it runs.
  reset(why: string): never {
    const e = new Error(why);
    this.ctx.abort(String(e));
    throw e;
  }
  faultTables(): void {
    this.#sql.exec('CREATE TABLE IF NOT EXISTS _tape_faults(plan TEXT)');
    this.#sql.exec('CREATE TABLE IF NOT EXISTS _tape_fault_sites(site TEXT PRIMARY KEY, n INTEGER NOT NULL)');
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS _tape_fault_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, n INTEGER NOT NULL, kind TEXT NOT NULL, ms INTEGER NOT NULL, at INTEGER NOT NULL)',
    );
  }
  setFaults(plan: FaultPlan | null): { plan: FaultPlan | null } {
    this.faultTables();
    this.#sql.exec('DELETE FROM _tape_faults');
    // a plan of points counts each hop's calls from when it is set
    this.#sql.exec("DELETE FROM _tape_fault_sites WHERE site LIKE '*%'");
    if (plan) this.#sql.exec('INSERT INTO _tape_faults VALUES (?1)', JSON.stringify(plan));
    return { plan };
  }
  /** The plan stored here, or null. */
  #faultPlan(): FaultPlan | null {
    const [row] = this.#sql.exec('SELECT plan FROM _tape_faults').toArray();
    return row ? planIn(row.plan) : null;
  }
  fault(site: string, withinMs?: number | null): Fault | null {
    this.faultTables();
    const plan = this.#faultPlan();
    if (!plan) return null;
    const count = (s: string): number =>
      int(
        this.#sql
          .exec('INSERT INTO _tape_fault_sites VALUES (?1, 0) ON CONFLICT(site) DO UPDATE SET n = n + 1 RETURNING n', s)
          .one().n,
      );
    const hop = hopOf(site),
      n = count(site),
      at = plan.points ? count(`*${hop}`) : null;
    // a plan without router: true leaves a program's router alone (the KV router always takes faults)
    if (site.startsWith('router>') && plan.router !== true) return null;
    const f = decide(plan, site, n, withinMs, at);
    // a kind that has no meaning at this hop is not injected
    if (!f || !HOP_KINDS[hop].includes(f.kind) || (f.kind === 'lookup_error' && !site.startsWith('kv>'))) return null;
    this.#sql.exec(
      'INSERT INTO _tape_fault_log(site, n, kind, ms, at) VALUES (?1, ?2, ?3, ?4, ?5)',
      site,
      n,
      f.kind,
      f.ms,
      Date.now(),
    );
    return f;
  }
  faultLog(): { plan: FaultPlan | null; counts: Record<string, number>; faults: Row[] } {
    this.faultTables();
    // counts: the calls each hop has made since the plan was set (a plan of points only)
    const counts = Object.fromEntries(
      this.#sql
        .exec("SELECT substr(site, 2) AS hop, n + 1 AS n FROM _tape_fault_sites WHERE site LIKE '*%'")
        .toArray()
        .map(r => [str(r.hop), int(r.n)]),
    );
    return {
      plan: this.#faultPlan(),
      counts,
      faults: this.#sql.exec('SELECT seq, site, n, kind, ms, at FROM _tape_fault_log ORDER BY seq').toArray(),
    };
  }
  // Tools: this object, at <account>/~tools, keeps the account's policy and its tools' manifest entries.
  toolTables(): void {
    this.#sql.exec('CREATE TABLE IF NOT EXISTS _tape_policy(policy TEXT NOT NULL)');
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS _tape_tools(tool TEXT PRIMARY KEY, version INTEGER NOT NULL, entries TEXT NOT NULL)',
    );
  }
  setPolicy(policy: Policy): { policy: Policy } {
    this.toolTables();
    this.#sql.exec('DELETE FROM _tape_policy');
    this.#sql.exec('INSERT INTO _tape_policy VALUES (?1)', JSON.stringify(policy));
    return { policy };
  }
  policy(): Policy | null {
    this.toolTables();
    const [row] = this.#sql.exec('SELECT policy FROM _tape_policy').toArray();
    return row ? policyIn(row.policy) : null;
  }
  register(tool: string, version: number, entries: readonly ToolEntry[]): void {
    this.toolTables();
    this.#sql.exec(
      'INSERT INTO _tape_tools VALUES (?1, ?2, ?3) ON CONFLICT(tool) DO UPDATE SET version = excluded.version, entries = excluded.entries',
      tool,
      version,
      JSON.stringify(entries),
    );
  }
  tools(): ToolEntry[] {
    this.toolTables();
    return this.#sql
      .exec('SELECT entries FROM _tape_tools ORDER BY tool')
      .toArray()
      .flatMap(r => listIn(r.entries).flatMap(entryIn));
  }
  // One call of a tool function: the latest version's method, logged like any call this program serves.
  async tool(account: string, name: string, method: string, bytes: Uint8Array | ArrayBuffer): Promise<ToolAnswer> {
    if (!this.#alive())
      return { status: 'rejected', body: enc.encode(`there is no tool ${name}`), version: 0, id: null };
    const answer = await this.data(account, name).tool(method, bytes);
    return answer;
  }
  // What this program recorded for the calls one caller's span made: each row, with its request's view when it ran.
  // (an ask has no key, so the method is its own column; rows from before that column are keyed calls)
  served(account: string, name: string, trace: string, parent: string, depth = 1): Promise<ServedRow[]> {
    const rows = this.#sql
      .exec(
        'SELECT version, key, status, log_id, at, began, took, method FROM _tape_served WHERE trace = ?1 AND parent = ?2 ORDER BY rowid',
        trace,
        parent,
      )
      .toArray();
    return Promise.all(
      rows.map(async (r): Promise<ServedRow> => {
        const logId = strOrNull(r.log_id),
          key = strOrNull(r.key);
        const v = logId === null || logId === '' ? null : await this.data(account, name).view(logId);
        return {
          version: int(r.version),
          key,
          method: strOrNull(r.method) ?? key?.split('/').at(-2),
          status: str(r.status),
          at: int(r.at),
          began: intOrNull(r.began),
          took: intOrNull(r.took),
          log_id: logId,
          view: v ? { ...v, calls: await this.joinCalls(account, name, v, depth) } : null,
        };
      }),
    );
  }
}
