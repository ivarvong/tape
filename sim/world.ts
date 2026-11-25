// sim/world.ts: a world of the simulator. Every program on its own SQLite, one clock, and the calls and timers the
// simulator holds until a choice says what becomes of each.
import '../node25.ts';
import { NO_TIMERS, fixedSecrets, instantiate } from '../host.ts';
import type { App, Cell, Observed, Service, ServiceOptions, ServiceReply, SqlParam, Transaction } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import type { NodeSql } from '../nodesql.ts';
import type { Json, Schema } from './values.ts';

export const FAULTS = ['lose', 'drop', 'cut', 'cutafter'];
const DECISIONS = ['deliver', ...FAULTS];

/** What one client remembers between its requests; `notes` is shared by the clients of a run. */
export type Mem = { notes: Record<string, unknown>; [field: string]: unknown };
export type Request = { line: string; via?: string | undefined; body?: Json | undefined };
export type Answer = { status: number; json: unknown; text: string };
/** One request a client makes: `make` gives it (or nothing, to skip), `then` hears the answer. */
export type Op = {
  name: string;
  make: (mem: Mem) => Request | null | undefined;
  then?: (mem: Mem, res: Answer) => void;
};
export type Model = {
  modules: Readonly<Record<string, WebAssembly.Module>>;
  /** the program the clients send to */
  entry: string;
  /** what each program's `secret(from:, name:)` reads, by program, then by name (version 1 of each) */
  secrets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Remotes no program here serves: the reply type of each method */
  stubs?: Readonly<Record<string, Readonly<Record<string, Schema | null>>>>;
  clients: (rand: () => number) => Op[][];
  start?: number;
  observe?: (program: string, run: Observed) => void;
  /** after every step: what is wrong now */
  check?: (world: World) => string[];
  /** after settling: what was left half-done */
  settled?: (world: World) => string[];
  duplicates?: boolean;
  repeat?: boolean | 'strict';
  repeatLast?: number;
  timerRuns?: number;
  queries?: Readonly<Record<string, readonly { sql: string; repeat?: true }[]>>;
  /** each program's state machines: the states reached are what a search counts as new */
  machines?: Readonly<Record<string, readonly { table: string; column: string; states?: readonly string[] }[]>>;
};

export type Run = { id: string; calls?: number };
export type Reply = { status: string; body: Uint8Array };
export type Waiting = {
  id: string;
  run: Run;
  to: string;
  bytes: Uint8Array;
  meta: ServiceOptions;
  resolve: (reply: ServiceReply) => void;
  reject: (why: Error) => void;
  sent: number;
};
export type Sent = { text: string; status: number; answer?: string };
export type Finished = Sent & { after: number };
export type Program = {
  sql: NodeSql;
  tx: { transaction: Transaction };
  app: App;
  /** how many times each timer has run */
  fired: Map<number, number>;
};
export type Line = { at: number; what: string; detail: string };
export type World = {
  seed: number;
  /** what a stood-in Remote answered, by key */
  stubbed: Map<string, Reply>;
  clock: number;
  programs: Record<string, Program>;
  pending: Waiting[];
  log: Line[];
  waking: Set<string>;
  cur: Run | null;
  faults: number;
  notes: Record<string, unknown>;
  sent: Sent[];
  /** requests answered 200, 201 or 204, with how many choices had been made: for the duplicate rule */
  finished: Finished[];
  choices: number;
  failed?: string;
  /** a failure of the simulator itself, not of a program */
  crash?: Error;
  /** the last decision made about a call */
  did?: string;
  say: (what: string, detail?: string) => void;
  rows: (program: string, query: string, ...params: SqlParam[]) => Record<string, Cell>[];
};
export type Client = { ops: Op[]; next: number; busy: boolean; mem: Mem };

export const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/** A number from a text (FNV-1a), to seed with. */
export function hash(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 16777619);
  return h >>> 0;
}
/** Let everything that can run now run. */
export const drain = (): Promise<void> =>
  new Promise(done => {
    setImmediate(done);
  });
export const isCut = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'cut' in err && err.cut === true;
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export function programOf(world: World, name: string): Program {
  const p = world.programs[name];
  if (!p) throw new Error(`no program ${name} in this world`);
  return p;
}

// What a program draws with random(from:) comes from the run's seed, so a script replays to the same run.
function dice(seed: number, name: string): () => number {
  const r = rng(hash(`${seed}/dice/${name}`));
  return () => Math.floor(r() * 2097152) * 4294967296 + Math.floor(r() * 4294967296);
}

/** The services one program sees: every other program and stand-in, each call held until its decision. */
function servicesOf(world: World, model: Model, name: string): Record<string, Service> {
  const others = [...Object.keys(model.modules), ...Object.keys(model.stubs ?? {})].filter(to => to !== name);
  const held =
    (to: string): Service =>
    (bytes, meta) =>
      new Promise((resolve, reject) => {
        const run = world.cur ?? { id: '?' };
        const n = (run.calls ?? 0) + 1;
        run.calls = n;
        world.pending.push({ id: `${run.id}:${n}`, run, to, bytes, meta, resolve, reject, sent: world.clock });
      });
  return Object.fromEntries(others.map(to => [to, held(to)]));
}

function programIn(world: World, model: Model, name: string, account: string): Program {
  const module = model.modules[name];
  if (!module) throw new Error(`no module ${name}`);
  const sql = nodeSql();
  const { observe } = model;
  const app = instantiate(module, {
    sql,
    name: `${account}/${name}`,
    services: servicesOf(world, model, name),
    random: dice(world.seed, name),
    timers: NO_TIMERS,
    secrets: fixedSecrets(model.secrets?.[name] ?? {}),
    observe: observe ? (r): void => observe(name, r) : null,
  });
  return { sql, tx: { transaction: f => sql.transaction(f) }, app, fired: new Map() };
}

/** One world: every program with its own database, one clock, and the calls and timers the simulator holds. */
export function boot(model: Model, account = 'sim', seed = 1): World {
  const world: World = {
    seed,
    stubbed: new Map(),
    clock: model.start ?? Date.parse('2026-01-01T00:00:00Z'),
    programs: {},
    pending: [],
    log: [],
    waking: new Set(),
    cur: null,
    faults: 0,
    notes: {},
    sent: [],
    finished: [],
    choices: 0,
    say: (what, detail = '') => {
      world.log.push({ at: world.clock, what, detail });
    },
    rows: (program, q, ...p) =>
      programOf(world, program)
        .sql.exec(q, ...p)
        .toArray()
        .map(r => ({ ...r })),
  };
  for (const name of Object.keys(model.modules)) world.programs[name] = programIn(world, model, name, account);
  return world;
}

export const clientsOf = (model: Model, world: World, seed: number): Client[] =>
  model.clients(rng(seed)).map(ops => ({ ops, next: 0, busy: false, mem: { notes: world.notes } }));

/** The choices open now. */
export function enabled(world: World, clients: readonly Client[], faults: number): string[] {
  const starts = clients.flatMap((c, i) => (!c.busy && c.next < c.ops.length ? [`start c${i}`] : []));
  const calls = world.pending.flatMap(p =>
    DECISIONS.filter(d => d === 'deliver' || world.faults < faults).map(d => `${d} ${p.id}`),
  );
  const wakes: string[] = [];
  let next = Infinity;
  for (const [name, { app }] of Object.entries(world.programs)) {
    wakes.push(
      ...app.due(world.clock).flatMap(key => (world.waking.has(`${name} ${key}`) ? [] : [`wake ${name} ${key}`])),
    );
    const n = app.next();
    if (n !== null && n > world.clock) next = Math.min(next, n);
  }
  return [...starts, ...calls, ...wakes, ...(next < Infinity ? [`tick ${next - world.clock}`] : [])];
}
