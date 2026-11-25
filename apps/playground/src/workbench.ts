// apps/playground/src/workbench.ts: the programs of one example, compiled with the repository's compiler, each
// linked by host.ts to a database of its own, and wired to each other as the service wires them (a Remote named
// `stock` reaches the program named stock). A request runs as it would on a Durable Object, and what it did is
// kept: every run's effect log, the calls it made and what each callee recorded, and from those the request's
// OTLP/JSON, made by the service's own otlp() (service/src/view.ts) from the same records the service joins.
//
// No DOM here and no sql.js: the page passes a database maker (sqlite.ts over sql.js); test.ts passes nodesql.ts.
import { compile } from '../../../compiler.ts';
import type { Built, Refused, Source } from '../../../compiler.ts';
import type { Problem } from '../../../compiler/common.ts';
import { framed, instantiate, isCall, isHead, responseOf, traceOf } from '../../../host.ts';
import type { Header } from '../../../host.ts';
import type { App, Cell, Effect, Flags, Service, ServiceOptions, ServiceReply } from '../../../host.ts';
import { isEffect } from '../../../host/log.ts';
import type { CallEffect, Sql } from '../../../host/log.ts';
import type { Transaction } from '../../../host/schema.ts';
import type { Served } from '../../../host/run.ts';
import { otlp } from '../../../service/src/view.ts';
import type { Otlp } from '../../../service/src/view.ts';
import type { Entry, Failed, Joined, JoinedCall, Run, RunHead, ServedRow } from '../../../service/src/records.ts';
import { valueOf } from '../../../sim/values.ts';
import type { Fault } from '../examples.ts';
import { effectLine, queryNames, traceLines } from './lines.ts';
import type { Line } from './lines.ts';

// the log's and the trace's lines are made in lines.ts, which needs no Wasm (mcp/ uses it in a Worker)
export { effectLine, queryNames, traceLines };
export type { Line };

export type Db = { exec: Sql['exec']; transaction: Transaction };
export type Program = { name: string; text: string };
/** A problem the compiler (or the host, linking it) found, in one program. */
export type Diagnostic = Problem & { program: string };

/** One run of one program: its log, what it answered, the trace made from its log, and the calls it made. */
export type RunView = {
  program: string;
  span: string;
  method: string | null;
  status: number | string;
  response: string;
  error: string | null;
  effects: Effect[];
  log: Line[];
  trace: Line[];
  calls: CallView[];
};
export type CallView = {
  e: CallEffect;
  to: string;
  standIn: boolean;
  fault: Fault;
  run: RunView | null;
  why: string | null;
};

/** A request (or a timer) and everything it caused. */
export type Exchange = {
  n: number;
  program: string;
  request: string;
  status: number;
  type: string;
  /** the headers the program set (std/http's header), as the host checked them */
  headers: Header[];
  body: string;
  ms: number;
  root: RunView;
  otlp: Otlp;
};

type Slot = {
  name: string;
  text: string;
  built: Built | null;
  errors: Problem[];
  ms: number;
  module: WebAssembly.Module | null;
  traced: { text: string; built: Built; module: WebAssembly.Module } | null;
  /** each statement the build runs, numbered as the database is given it, to the names the program gave its values */
  names: Map<string, string[]>;
  version: number;
  db: Db | null;
  dataKey: string;
  app: App | null;
  flags: Flags;
};

/** What a call reached, as the page saw it: the callee's answer and log, timed by the page's clock. */
type Record_ = {
  caller: string;
  to: string;
  parent: string | null;
  key: string | null;
  method: string;
  began: number;
  took: number | null;
  fault: Fault;
  standIn: boolean;
  served: Served | null;
  bytes: Uint8Array;
  message: string;
};

const enc = new TextEncoder(),
  dec = new TextDecoder();
/** The page's clock: milliseconds since 1970 with sub-millisecond precision, for span times. */
export const clock = (): number => performance.timeOrigin + performance.now();
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The log a trapped run wrote before it failed, which the host puts on the error (host/run.ts, stretch). */
const loggedOf = (e: unknown): Effect[] =>
  typeof e === 'object' && e !== null && 'effects' in e && Array.isArray(e.effects) ? e.effects.filter(isEffect) : [];
/** A name read from SQLite's own tables (sqlite_master, pragma_table_info), which is always text. */
const nameOf = (r: Record<string, Cell>): string => {
  const n = r['name'];
  if (typeof n !== 'string') throw new TypeError('SQLite gave a name that is not text');
  return n;
};
const never = (): Promise<never> => new Promise(() => {});

/** A seeded source of numbers in [0, 1), for stand-in replies (the simulator's generator). */
const seeded = (seed: number): (() => number) => {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 48271) % 2147483647;
    return (s - 1) / 2147483646;
  };
};

export class Workbench {
  readonly std: readonly Source[];
  readonly newDb: () => Db;
  readonly account: string;
  readonly slots = new Map<string, Slot>();
  /** faults for the next request, by program or stand-in name */
  faults: Record<string, Fault> = {};
  readonly exchanges: Exchange[] = [];
  #records: Record_[] = [];
  #standIn = new Map<string, ServiceReply>();
  #dice = seeded(7);

  /** where each program's random(from:) draws from: the host's own source when not given (tests give a seeded one) */
  readonly random: ((program: string) => () => number) | null;

  constructor(
    std: readonly Source[],
    newDb: () => Db,
    {
      account = 'playground',
      random = null,
    }: { account?: string; random?: ((program: string) => () => number) | null } = {},
  ) {
    this.std = std;
    this.newDb = newDb;
    this.account = account;
    this.random = random;
  }

  /** Set the example's programs: every slot fresh, with an empty database, each compiled here. */
  load(programs: readonly Program[]): Diagnostic[] {
    this.declare(programs.map(p => p.name));
    return programs.flatMap(p => this.edit(p.name, p.text));
  }

  /** Set the example's programs by name, compiled later (accept): every slot fresh, with an empty database. */
  declare(names: readonly string[]): void {
    this.slots.clear();
    this.exchanges.length = 0;
    this.#records = [];
    this.#standIn.clear();
    for (const name of names)
      this.slots.set(name, {
        name,
        text: '',
        built: null,
        errors: [],
        ms: 0,
        module: null,
        traced: null,
        version: 0,
        db: null,
        dataKey: '',
        app: null,
        flags: {},
        names: new Map(),
      });
  }

  /** A program's text changed: compile it here, and accept the result. */
  edit(name: string, text: string): Diagnostic[] {
    const slot = this.slots.get(name);
    if (!slot) throw new Error(`no program ${name}`);
    if (slot.text === text && slot.built) return [];
    const t0 = performance.now();
    const r = compile([...this.std, { name: `${name}.tape`, text }]);
    return this.accept(name, text, r, performance.now() - t0);
  }

  /**
   * A program's text, compiled (here or on another thread): when it compiled, link it, keeping its data when its
   * schema, migrations and machines are what they were.
   */
  accept(name: string, text: string, r: Built | Refused, ms: number): Diagnostic[] {
    const slot = this.slots.get(name);
    if (!slot) throw new Error(`no program ${name}`);
    slot.text = text;
    slot.ms = ms;
    if (!r.wasm) {
      slot.errors = r.errors;
      return r.errors.map(e => ({ ...e, program: name }));
    }
    slot.errors = [];
    slot.built = r;
    slot.names = queryNames(text);
    slot.module = new WebAssembly.Module(r.wasm);
    slot.traced = null;
    slot.version++;
    return this.#link(slot).map(e => ({ ...e, program: name }));
  }

  #link(slot: Slot): Problem[] {
    const r = slot.built,
      module = slot.module;
    if (!r || !module) return [];
    const key = JSON.stringify([r.schema, r.migrations, r.machines]);
    if (!slot.db || key !== slot.dataKey) slot.db = this.newDb();
    slot.dataKey = key;
    try {
      const app = instantiate(module, {
        sql: slot.db,
        name: `${this.account}/${slot.name}`,
        services: this.#services(slot.name),
        ...(this.random ? { random: this.random(slot.name) } : {}),
      });
      const known = new Set(app.flags.map(f => f.name));
      app.setFlags(Object.fromEntries(Object.entries(slot.flags).filter(([k]) => known.has(k))));
      slot.app = app;
      return [];
    } catch (e) {
      // its schema or migrations do not apply to the data it has: start it with none, and say so
      slot.db = this.newDb();
      slot.app = null;
      const problem = {
        code: 'host',
        file: `${slot.name}.tape`,
        line: 1,
        message: messageOf(e),
        hint: 'The data was reset; send the request again.',
      };
      try {
        slot.app = instantiate(module, {
          sql: slot.db,
          name: `${this.account}/${slot.name}`,
          services: this.#services(slot.name),
        });
        return [problem];
      } catch (again) {
        return [
          { ...problem, message: messageOf(again), hint: 'The program cannot be linked to an empty database either.' },
        ];
      }
    }
  }

  /** Empty every program's database. */
  reset(): void {
    for (const slot of this.slots.values()) {
      slot.db = null;
      this.#link(slot);
    }
    this.#records = [];
    this.#standIn.clear();
    this.exchanges.length = 0;
  }

  setFlag(program: string, name: string, value: number | boolean): void {
    const slot = this.slots.get(program);
    if (!slot) throw new Error(`no program ${program}`);
    slot.flags[name] = value;
    slot.app?.setFlags({ [name]: value });
  }

  /** The remotes a program's calls name that no program of this example serves. */
  standIns(): string[] {
    const named = new Set<string>();
    for (const s of this.slots.values())
      for (const call of Object.keys(s.built?.json.replies ?? {})) {
        const to = call.split('.')[0] ?? '';
        if (to !== '' && !this.slots.has(to)) named.add(to);
      }
    return [...named];
  }

  // ---- calls between programs

  #services(caller: string): Record<string, Service> {
    return new Proxy({}, { get: (_t, to) => (typeof to === 'string' ? this.#service(caller, to) : undefined) });
  }

  #service(caller: string, to: string): Service {
    return async (bytes: Uint8Array, meta: ServiceOptions): Promise<ServiceReply> => {
      const fault = this.faults[to] ?? 'deliver',
        target = this.slots.get(to);
      const rec: Record_ = {
        caller,
        to,
        parent: meta.trace?.parent ?? null,
        key: meta.key ?? null,
        method: meta.method,
        began: clock(),
        took: null,
        fault,
        standIn: !target,
        served: null,
        bytes: new Uint8Array(bytes),
        message: dec.decode(bytes),
      };
      this.#records.push(rec);
      if (fault === 'lose') return never();
      let reply: ServiceReply;
      if (target) {
        if (!target.app || !target.db) {
          rec.took = clock() - rec.began;
          return { status: 'unreachable', body: enc.encode(`${to} does not compile`) };
        }
        const db = target.db;
        rec.served = await target.app.serve(
          {
            method: meta.method,
            fingerprint: meta.fingerprint,
            key: meta.key ?? null,
            withinMs: meta.withinMs,
            trace: meta.trace ?? null,
          },
          bytes,
          { transaction: f => db.transaction(f) },
        );
        reply = { status: rec.served.status, body: rec.served.body };
      } else reply = this.#standInReply(caller, to, meta, fault);
      rec.took = clock() - rec.began;
      return fault === 'drop' ? never() : reply;
    };
  }

  /** A stand-in's answer: a value of the reply type, or a refusal; the same once key gets the same answer. */
  #standInReply(caller: string, to: string, meta: ServiceOptions, fault: Fault): ServiceReply {
    const remembered = meta.key ? this.#standIn.get(`${to}/${meta.key}`) : undefined;
    if (remembered) return remembered;
    const built = this.slots.get(caller)?.built;
    const schema = built?.json.replies[`${to}.${meta.method}`] ?? undefined;
    // a refusal is a value of the error type the call names (a Skew when the stand-in has none to make)
    const refusal = built?.json.refusals[`${to}.${meta.method}`] ?? undefined;
    const made = (s: typeof schema): Uint8Array =>
      enc.encode(JSON.stringify(valueOf(s, this.#dice, { ids: [1, 2, 3], dict: {}, keys: [], said: {}, blank: 0 })));
    const reply: ServiceReply =
      fault === 'reject'
        ? refusal
          ? { status: 'rejected', body: made(refusal) }
          : { status: 'skew', body: enc.encode(`declined by the playground's stand-in for ${to}`) }
        : { status: 'ok', body: made(schema) };
    if (meta.key) this.#standIn.set(`${to}/${meta.key}`, reply);
    return reply;
  }

  // ---- running

  /** Send one request (`METHOD /path` and a body) to a program. */
  async send(program: string, request: string): Promise<Exchange> {
    const slot = this.slots.get(program);
    if (!slot?.app || !slot.db || slot.errors.length > 0) {
      const first = slot?.errors[0];
      throw new Error(
        `${program}.tape does not compile${first ? ` (line ${first.line}: ${first.code})` : ''}: fix it, then send the request again`,
      );
    }
    const app = slot.app,
      db = slot.db,
      bytes = enc.encode(request),
      began = clock();
    let out: Uint8Array,
      effects: Effect[],
      failed: Failed | null = null;
    try {
      const ran = await app.runLogged(bytes, { transaction: f => db.transaction(f) });
      out = ran.out;
      effects = ran.effects;
    } catch (e) {
      // a trap: its writes were rolled back; the log so far is on the error (host/run.ts, stretch)
      const logged = loggedOf(e);
      effects = logged;
      failed = { status: 500, error: messageOf(e), rolled_back: true };
      out = framed({ status: 500, body: messageOf(e) });
    }
    const took = clock() - began;
    return this.#exchange(slot, request, bytes, out, effects, failed, began, took);
  }

  /** The timers that are set, by program: key and due time. */
  timers(): { program: string; key: number; due: number }[] {
    return [...this.slots.values()].flatMap(s => {
      if (!s.db || !s.built?.methods.some(m => m.name === 'woken')) return [];
      try {
        return s.db
          .exec('SELECT key, due FROM _wakes ORDER BY due, key')
          .toArray()
          .map(r => ({ program: s.name, key: Number(r['key']), due: Number(r['due']) }));
      } catch {
        return [];
      }
    });
  }

  /** Run one timer now, as if its time had come: the program's `woken`, as a child of the run that set it. */
  async fire(program: string, key: number, due: number): Promise<Exchange | null> {
    const slot = this.slots.get(program);
    if (!slot?.app || !slot.db) return null;
    const db = slot.db,
      began = clock(),
      request = `woken ${JSON.stringify({ key })}`;
    try {
      const w = await slot.app.wake(key, { transaction: f => db.transaction(f), now: Math.max(due, Date.now()) });
      if (!w) return null;
      const out = new Uint8Array([w.status === 'ok' ? 48 : 49, ...w.body]);
      return this.#exchange(slot, request, null, out, w.effects, null, began, clock() - began);
    } catch (e) {
      const logged = loggedOf(e);
      return this.#exchange(
        slot,
        request,
        null,
        framed({ status: 500, body: messageOf(e) }),
        logged,
        { status: 500, error: messageOf(e), rolled_back: true },
        began,
        clock() - began,
      );
    }
  }

  #exchange(
    slot: Slot,
    request: string,
    bytes: Uint8Array | null,
    out: Uint8Array,
    effects: Effect[],
    failed: Failed | null,
    began: number,
    took: number,
  ): Exchange {
    const woken = bytes === null && failed === null;
    const res = woken
      ? { status: out[0] === 48 ? 200 : 500, type: 'application/json', headers: [], body: out.subarray(1) }
      : responseOf(out);
    const root = this.#view(slot, bytes, out, effects, woken ? 'woken' : null, failed);
    const joined = this.#joined(slot, request, res.status, dec.decode(res.body), effects, failed, began, took);
    const ex: Exchange = {
      n: this.exchanges.length + 1,
      program: slot.name,
      request,
      status: res.status,
      type: res.type ?? 'text/plain',
      headers: res.headers,
      body: dec.decode(res.body),
      ms: took,
      root,
      // the root span is the host's own measure of the run (its head's at_us and took_us)
      otlp: otlp(joined),
    };
    this.exchanges.push(ex);
    return ex;
  }

  /** The calls a run made, each with what the page recorded for it, in the run's order. */
  #callsOf(effects: readonly Effect[]): { e: CallEffect; rec: Record_ | null }[] {
    const [head] = effects;
    const span = head && isHead(head) ? head.span : undefined;
    const mine = this.#records.filter(r => r.parent === span);
    return effects.filter(isCall).map((e, i) => ({ e, rec: mine[i] ?? null }));
  }

  #why(rec: Record_ | null): string | null {
    if (!rec) return 'the page has no record of this call';
    if (rec.standIn)
      return `${rec.to} is stood in for: no program in this example serves it, so the playground answered with a value of the reply type${rec.fault === 'deliver' ? '' : ` (${rec.fault})`}`;
    if (rec.fault === 'lose') return `lost by the playground (fault: lose): ${rec.to} never ran it`;
    return null;
  }

  #view(
    slot: Slot,
    bytes: Uint8Array | null,
    out: Uint8Array,
    effects: Effect[],
    method: string | null,
    failed: Failed | null,
  ): RunView {
    const [head] = effects;
    const calls = this.#callsOf(effects).map(({ e, rec }): CallView => {
      const callee = rec && !rec.standIn ? this.slots.get(rec.to) : undefined;
      const fx = rec?.served?.effects;
      const run =
        callee && rec?.served && fx && fx.length > 0
          ? this.#view(
              callee,
              null,
              new Uint8Array([rec.served.status === 'ok' ? 48 : 49, ...rec.served.body]),
              fx,
              rec.method,
              null,
            )
          : null;
      const why = run
        ? null
        : rec?.served && !rec.standIn
          ? `${rec.to} answered from the reply it stored for this key: it did not run again`
          : this.#why(rec);
      return { e, to: e.call, standIn: rec?.standIn ?? false, fault: rec?.fault ?? 'deliver', run, why };
    });
    const answer =
      method === null
        ? responseOf(out)
        : { status: out[0] === 48 ? 'ok' : out[0] === 49 ? 'rejected' : 'skew', body: out.subarray(1) };
    return {
      program: slot.name,
      span: head && isHead(head) ? (head.span ?? '') : '',
      method,
      status: failed ? 500 : answer.status,
      response: failed ? failed.error : dec.decode(answer.body),
      error: failed?.error ?? null,
      effects,
      log: effects.map(e => effectLine(slot.built, e, slot.names)),
      trace: this.#trace(slot, bytes, effects),
      calls,
    };
  }

  // The trace: the request run again from its log through a build that reports every function entered and every
  // arm tried. Compiled when first asked for, then kept until the program changes.
  /** A build of a program with tracing on, made elsewhere (the page's worker), for its current text. */
  acceptTraced(name: string, text: string, r: Built | Refused): void {
    const slot = this.slots.get(name);
    if (slot && slot.text === text && r.wasm) slot.traced = { text, built: r, module: new WebAssembly.Module(r.wasm) };
  }
  needsTrace(name: string): boolean {
    const slot = this.slots.get(name);
    return slot !== undefined && slot.built !== null && slot.traced?.text !== slot.text;
  }

  #trace(slot: Slot, bytes: Uint8Array | null, effects: Effect[]): Line[] {
    if (!slot.built || effects.length === 0) return [];
    if (slot.traced?.text !== slot.text) {
      const t = compile([...this.std, { name: `${slot.name}.tape`, text: slot.text }], { trace: true });
      slot.traced = t.wasm ? { text: slot.text, built: t, module: new WebAssembly.Module(t.wasm) } : null;
    }
    if (!slot.traced) return [];
    const t = traceOf(slot.traced.module, bytes, effects);
    const lines = traceLines(slot.traced.built, `${slot.name}.tape`, slot.text.split('\n'), t.events).map(l => ({
      ...l,
      program: slot.name,
    }));
    if (t.error !== null) lines.push({ kind: 'bad', text: t.error, program: slot.name });
    return lines;
  }

  // ---- OTLP: the service's records, made from the page's

  /**
   * A run's log as the service stores it. Its times are the host's: a run's head has at/took and at_us/took_us,
   * a call sent/took and sent_us/took_us (host/log.ts, clockUs), from the same clock as the page's (performance.now
   * in this page), so they are used as they are. `began` and `took` (the page's, around the run) only fill a head
   * that has no times of its own.
   */
  #timed(effects: readonly Effect[], began: number, took: number, failed: Failed | null): Entry[] {
    return effects.map((e, i): Entry => {
      if (i === 0 && isHead(e)) {
        const h = e;
        const head: RunHead = { ...h, at: typeof h.at === 'number' ? h.at : began, took: h.took ?? took };
        if (failed) head.failed = failed;
        return head;
      }
      return e;
    });
  }

  #run(
    slot: Slot,
    request: string,
    status: number | string,
    response: string,
    effects: Effect[],
    failed: Failed | null,
    began: number,
    took: number,
  ): Run & { calls: JoinedCall[] } {
    const timed = this.#timed(effects, began, took, failed);
    const plainCalls = this.#callsOf(effects);
    const calls = timed.flatMap((e, i): JoinedCall[] => {
      if (!('call' in e)) return [];
      const orig = effects[i],
        rec = plainCalls.find(c => c.e === orig)?.rec ?? null;
      const served = this.#servedRow(rec),
        why = served ? null : this.#why(rec);
      return [{ e, served, ...(why === null ? {} : { why }) }];
    });
    const [head] = effects;
    return {
      id: head && isHead(head) ? (head.span ?? '') : '',
      version: slot.version,
      at: began,
      effects: timed,
      source: slot.text,
      queries: (slot.built?.queries ?? []).map(q => q.sql),
      request,
      status,
      response,
      trace: [],
      error: failed?.error ?? null,
      ...(failed ? { failed } : {}),
      calls,
    };
  }

  #servedRow(rec: Record_ | null): ServedRow | null {
    if (!rec?.served || rec.standIn) return null;
    const callee = this.slots.get(rec.to);
    if (!callee) return null;
    const fx = rec.served.effects ?? [];
    const took = rec.took ?? 0,
      [first] = fx;
    return {
      version: callee.version,
      key: rec.key,
      method: rec.method,
      status: rec.served.status,
      at: rec.began,
      began: rec.began,
      took,
      // what the supervisor measured across the call, which the host does not record: the page is the supervisor
      began_us: Math.round(rec.began * 1000),
      took_us: Math.round(took * 1000),
      log_id: first !== undefined && isHead(first) ? (first.span ?? null) : null,
      view:
        fx.length > 0
          ? this.#run(
              callee,
              `${rec.method} ${rec.message}`,
              rec.served.status,
              dec.decode(rec.served.body),
              fx,
              null,
              rec.began,
              took,
            )
          : null,
    };
  }

  #joined(
    slot: Slot,
    request: string,
    status: number,
    response: string,
    effects: Effect[],
    failed: Failed | null,
    began: number,
    took: number,
  ): Joined {
    return {
      ...this.#run(slot, request, status, response, effects, failed, began, took),
      account: this.account,
      name: slot.name,
    };
  }

  /** Every table of a program's database, with its rows (the host's own tables last). */
  tables(program: string): { name: string; columns: string[]; rows: Cell[][] }[] {
    const db = this.slots.get(program)?.db;
    if (!db) return [];
    const names = db
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIKE '\\_%' ESCAPE '\\', name",
      )
      .toArray()
      .map(nameOf);
    return names.map(name => {
      const rows = db.exec(`SELECT * FROM "${name.replaceAll('"', '""')}" LIMIT 200`).toArray();
      const columns = db.exec(`SELECT name FROM pragma_table_info(?1)`, name).toArray().map(nameOf);
      return { name, columns, rows: rows.map(r => columns.map(c => r[c] ?? null)) };
    });
  }
}
