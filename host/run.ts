// host/run.ts: a module linked to its host. Every call the module makes of the host is answered from the effect
// log when it is there, and otherwise performed and appended, so a request can be run again from its log.
//
// Calls. A handler cannot wait inside Wasm, so a call works by running the handler again: at a call whose reply is
// not in the log, the run stops, the host makes the call with its time budget, appends the outcome (ok, timeout,
// unreachable, rejected) to the log and runs the handler from the start, answering every earlier effect from the
// log. `transaction` (for example f => ctx.storage.transactionSync(f)) wraps each stretch between calls, so the
// SQL before a call is committed before the call is made. `deadlineMs` is the time left for the whole request: no
// call gets more than what remains of it, and each service is told its budget so it can pass it on. A handler that
// returns rollback(out) has that stretch's writes undone: the host throws out of `transaction`, so the storage
// rolls back, and still answers with `out`; the log's first entry says `undone`.
import { Pending, REAL_TIMERS, perform } from './call.ts';
import type { Service, Timers } from './call.ts';
import { STATUS, begin, clockUs, hex, isCall, isHead, isNow, isRandom, isSql, isWake, pack, unpack } from './log.ts';
import type { CallEffect, Cell, Effect, Flags, From, Head, Span, Sql, Status, TraceEvent, WakeEffect } from './log.ts';
import {
  answerAt,
  block,
  copyIn,
  copyOut,
  decodeJson,
  readParams,
  replyBlock,
  textAt,
  writeFlags,
  writeRows,
} from './memory.ts';
import type { FlagDecl, Mem, Query, Shape } from './memory.ts';
import { direct } from './schema.ts';
import type { Transaction } from './schema.ts';
import { cellText } from './log.ts';

const enc = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const TRAPS: Readonly<Record<number, string>> = {
  1: 'out of memory',
  2: 'reduction budget exceeded',
  3: 'index out of bounds',
  4: 'division by zero or overflow',
  5: 'a value was read after its memory was released (a compiler bug)',
};
/** the longest a timer may be set for: 30 days */
export const MAX_WAKE_MS = 30 * 24 * 3600 * 1000;

/** A custom section of a module, as the JSON it holds; [] when the module has none of that name. */
export function section(module: WebAssembly.Module, n: string): unknown {
  const [s] = WebAssembly.Module.customSections(module, n);
  return s ? JSON.parse(new TextDecoder().decode(s)) : [];
}
/**
 * A custom section that is a list. The compiler wrote it (compiler/gen/assemble.ts), and the host takes its
 * word for what the entries are: this is the one place it does.
 */
export function listed<T>(module: WebAssembly.Module, n: string): T[] {
  const all = section(module, n);
  // oxlint-disable-next-line typescript/no-unsafe-return -- the compiler's own sections, see above
  return Array.isArray(all) ? all : [];
}

export type HostParam = { name: string; type: string };
export type Method = { name: string; fingerprint: string; params: HostParam[] };
type CallDecl = { method: string; keyed: boolean; fingerprint: string };
export type HeapRow = { fn: string; bytes: number; count: number; from: Map<string, number> };
export type Heap = { total: number; by: Map<string, HeapRow> };
export type Observed = {
  target: string;
  method: string | null;
  bytes: Uint8Array;
  effects: Effect[];
  out: Uint8Array;
  undone: boolean;
};
export type LinkOptions = {
  sql?: Sql;
  /** false: nothing is logged (not for handlers that make calls) */
  log?: boolean;
  /** a log to answer from: nothing is performed */
  recorded?: Effect[] | null;
  trace?: TraceEvent[] | null;
  services?: Readonly<Record<string, Service>>;
  name?: string | null;
  /** receives every finished log */
  sink?: ((log: Effect[]) => void) | null;
  heap?: Heap | null;
  /** 53 random bits, when the caller has its own source (the simulator's, so a script replays) */
  random?: (() => number) | null;
  timers?: Timers | undefined;
  /** every run that reached its answer, with the log it ran against (proof/interp-effects.ts) */
  observe?: ((run: Observed) => void) | null;
};
type Target = { name: string; params: readonly HostParam[]; method?: string };
/** A rollback: the stretch's writes are undone, and the handler's answer is still given. */
class Undo extends Error {
  readonly out: Uint8Array<ArrayBuffer>;
  constructor(out: Uint8Array<ArrayBuffer>) {
    super('rollback');
    this.out = out;
  }
}

/** A module, its host, and the run in hand. */
type Linked = {
  readonly Q: Query[];
  readonly S: Shape[];
  readonly F: FlagDecl[];
  readonly E: HostParam[];
  readonly BUILD: string;
  readonly C: CallDecl[];
  readonly M: Method[];
  readonly o: Required<Omit<LinkOptions, 'sql' | 'timers'>> & { sql: Sql | undefined; timers: Timers };
  readonly live: boolean;
  readonly mem: Mem;
  readonly raw: Record<string, WebAssembly.ExportValue>;
  readonly flagNow: Flags;
  target: Target;
  remotes: string[];
  families: string[];
  span: Span | null;
  used: number;
  undone: boolean;
  effects: Effect[];
  pos: number;
};

const sqlOf = (L: Linked): Sql => L.o.sql ?? fail('this module was linked without a database');
function fail(message: string): never {
  throw new Error(message);
}
const globalOf = (L: Linked, name: string): number => {
  const g = L.raw[name];
  return g instanceof WebAssembly.Global ? Number(g.value) : 0;
};

/** One effect: answered from the log when it is there, otherwise performed and appended. */
function effect<T extends Effect>(
  L: Linked,
  is: (e: Effect) => e is T,
  same: (e: T) => boolean,
  asked: () => string,
  run: () => T,
): T {
  const e = L.effects[L.pos];
  if (e !== undefined) {
    if (!is(e) || !same(e))
      throw new Error(
        `replay diverged at effect ${L.pos}: the program asked for ${asked()}, the recording has ${JSON.stringify(e)}`,
      );
    L.pos++;
    return e;
  }
  if (!L.live)
    throw new Error(`replay diverged at effect ${L.pos}: the program asked for ${asked()}, the recording has nothing`);
  const made = run();
  L.effects.push(made);
  L.pos++;
  return made;
}

// env.sql. The text run is the compiler's q.run (q.sql with each Int and Bool parameter read as CAST(?n AS INTEGER),
// since the SQL API binds every JavaScript number as REAL); a module built before q.run existed runs q.sql as it did
function sqlCall(L: Linked, id: number, ptr: number, mode: number): number {
  const q = L.Q[id] ?? fail(`no query ${id}`);
  const p = readParams(L.mem, q, ptr);
  const exec = (): { r: number } | { rows: Cell[][] } => {
    const cur = sqlOf(L).exec(q.run ?? q.sql, ...p);
    return mode === 0 ? { r: cur.rowsWritten } : { rows: cur.raw().toArray() };
  };
  const answer = (e: { r?: number; rows?: Cell[][] }): number =>
    mode === 0 ? (e.r ?? 0) : writeRows(L.mem, q, e.rows ?? []);
  if (L.live && !L.o.log) return answer(exec());
  const same = JSON.stringify(p);
  const e = effect(
    L,
    isSql,
    x => x.q === id && JSON.stringify(x.p) === same,
    () => `query ${id} ${same}`,
    () => ({ q: id, p, ...exec() }),
  );
  L.o.trace?.push({
    sql: id,
    p,
    ...(mode === 0 ? { r: e.r } : { rows: e.rows }),
    ...(e.undone ? { undone: true as const } : {}),
  });
  return answer(e);
}

// env.call(remote, call id, ptr, len, within, once): the reply from the log, or stop this run so the host can
// make the call.
function callOut(
  L: Linked,
  remote: number,
  id: number,
  ptr: number,
  len: number,
  within: number,
  once: string | number,
): number {
  const c = L.C[id] ?? fail(`no call ${id}`);
  const to = L.remotes[remote] ?? fail(`no remote ${remote}`);
  const send = copyOut(L.mem, ptr, len);
  const same = JSON.stringify(pack(send));
  const matches = (e: CallEffect): boolean =>
    e.call === to &&
    e.method === c.method &&
    e.within === within &&
    (!c.keyed || e.once === once) &&
    JSON.stringify(e.send) === same;
  const e = effect(
    L,
    isCall,
    matches,
    () => `a call to ${to}.${c.method} within ${within} ms`,
    () => {
      throw new Pending({
        to,
        send,
        within,
        method: c.method,
        fingerprint: c.fingerprint,
        ...(c.keyed ? { once } : {}),
      });
    },
  );
  L.o.trace?.push({ call: to, method: c.method, within, status: e.status });
  return replyBlock(L.mem, STATUS.indexOf(e.status), unpack(e.reply));
}

// env.member(family, index): the Remote named <family>-<index>, added to this run's remotes. The same index gives
// the same Remote, and a replay asks in the same order, so the numbers agree.
function member(L: Linked, family: number, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`member: index ${index} is not a whole number from 0`);
  const name = `${L.families[family]}-${index}`;
  const at = L.remotes.indexOf(name);
  return at >= 0 ? at : L.remotes.push(name) - 1;
}

// env.allocated(size), in a { profile: true } build: charge the bytes to the Tape function that asked, read
// from the Wasm frames of the stack. `reserve` is a Buf growing; no Tape frame means the host allocated
// (rows, decoded JSON, a call's reply).
function allocated(heap: Heap, size: number): void {
  const frames = [...(new Error().stack ?? '').matchAll(/at (.+?) \(wasm:\/\//g)]
    .map(m => m[1] ?? '')
    .map(n => n.replace(/^.*\./, n.includes('[') ? n : '$&'))
    .filter(n => n !== 'alloc');
  const own = frames.filter(n => n !== 'reserve' && !n.startsWith('&'));
  const fn = own[0] ?? '(host)';
  const k = frames[0] === 'reserve' ? `${fn} (Buf growth)` : fn;
  const row = heap.by.get(k) ?? { fn: k, bytes: 0, count: 0, from: new Map<string, number>() };
  heap.by.set(k, row);
  const bytes = (size + 7) & -8;
  row.bytes += bytes;
  row.count++;
  heap.total += bytes;
  const caller = own[1] ?? '(host)';
  row.from.set(caller, (row.from.get(caller) ?? 0) + bytes);
}

/** 53 random bits. */
function randomBits(L: Linked): number {
  if (L.o.random) return L.o.random();
  const [hi = 0, lo = 0] = crypto.getRandomValues(new Uint32Array(2));
  return (hi & 0x1fffff) * 4294967296 + lo;
}

// env.ask(kind): the time (0) or 53 random bits (1), logged so a replay sees the same values.
function ask(L: Linked, kind: number): number {
  const logged = !(L.live && !L.o.log);
  if (kind === 0) {
    const e = logged
      ? effect(
          L,
          isNow,
          () => true,
          () => 'the time',
          () => ({ now: Date.now() }),
        )
      : { now: Date.now() };
    if (logged) L.o.trace?.push(e);
    return e.now;
  }
  const fresh = (): { random: number } => ({ random: randomBits(L) });
  const e = logged
    ? effect(
        L,
        isRandom,
        () => true,
        () => 'a random number',
        fresh,
      )
    : fresh();
  if (logged) L.o.trace?.push(e);
  return e.random;
}

// env.wake(key, after): a timer. The host calls this program's `woken` with Wake(key) once `after` ms have
// passed. Logged ({ wake, after, due }) so a replay sees the same answer; when it is first set, it is written to
// _wakes in the request's own transaction, so it is kept exactly when the request's writes are. Setting a key
// again moves its time. The run that set it is remembered, so the woken run joins that trace.
function wake(L: Linked, key: number, after: number): number {
  if (!Number.isSafeInteger(key)) throw new RangeError(`wake: key ${key} is not an integer within ±2^53`);
  const ms = Math.min(Math.max(0, after), MAX_WAKE_MS);
  const set = (): WakeEffect => {
    const e = { wake: key, after: ms, due: Date.now() + ms };
    if (L.live)
      sqlOf(L).exec(
        'INSERT INTO _wakes(key, due, trace, span) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET due = excluded.due, trace = excluded.trace, span = excluded.span',
        key,
        e.due,
        L.span?.trace ?? null,
        L.span?.span ?? hex(8),
      );
    return e;
  };
  const e =
    L.live && !L.o.log
      ? set()
      : effect(
          L,
          isWake,
          x => x.wake === key,
          () => `a timer with key ${key}`,
          set,
        );
  L.o.trace?.push(e);
  return e.after;
}

/** What the module imports of its host. */
function envOf(get: () => Linked): Record<string, (...args: never[]) => unknown> {
  // env.call_key(remote, call id, ptr, len, within, key ptr, key len): env.call with the command's key as text (a
  // record key arrives as its JSON). Modules built before keys were text import env.call, with an Int key.
  const keyed = (
    remote: number,
    id: number,
    ptr: number,
    len: number,
    within: number,
    kptr: number,
    klen: number,
  ): number => callOut(get(), remote, id, ptr, len, within, get().C[id]?.keyed ? textAt(get().mem, kptr, klen) : 0);
  const json = (ptr: number, len: number, id: number): number => {
    const L = get();
    const got = decodeJson(L.mem, L.S[id] ?? { variants: [] }, ptr, len);
    L.o.trace?.push('at' in got ? { json: 'decoded' } : { json: got.issue });
    return 'at' in got ? got.at : -block(L.mem, got.issue);
  };
  return {
    sql: (id: number, ptr: number, mode: number) => sqlCall(get(), id, ptr, mode),
    json,
    call: (remote: number, id: number, ptr: number, len: number, within: number, once: number) =>
      callOut(get(), remote, id, ptr, len, within, once),
    call_key: keyed,
    member: (family: number, index: number) => member(get(), family, index),
    ask: (kind: number) => ask(get(), kind),
    wake: (key: number, after: number) => wake(get(), key, after),
    allocated: (size: number) => {
      const { heap } = get().o;
      if (heap) allocated(heap, size);
    },
    trace: (site: number, what: number) => {
      get().o.trace?.push({ site, what });
    },
  };
}

// The first effect: which build ran, under which flag values; a method's log also holds the message it was sent,
// so the callee's log alone is enough to replay or trace it (pass null for the bytes).
function startOf(L: Linked, given: Uint8Array | null): Uint8Array {
  const fresh = (): Head => ({
    build: L.BUILD,
    flags: { ...L.flagNow },
    ...(L.target.method === undefined || !given ? {} : { method: L.target.method, message: pack(given) }),
    ...L.span,
  });
  const head = effect(
    L,
    isHead,
    () => true,
    () => 'the start of a request',
    fresh,
  );
  if (!L.live) {
    const m = head.method === undefined ? undefined : L.M.find(x => x.name === head.method);
    L.target = m ? { name: `serve_${m.name}`, params: m.params, method: m.name } : { name: 'handle', params: L.E };
  }
  if (!given && head.message === undefined)
    throw new Error(
      "no request bytes were given, and this log does not hold them (only a method's log records its message)",
    );
  if (head.build !== L.BUILD)
    throw new Error(
      `this log was recorded by build ${head.build}; this module is build ${L.BUILD}. Replay it through the build that made it.`,
    );
  if (!L.live) writeFlags(L.mem, L.F, head.flags, L.flagNow);
  return given ?? unpack(head.message ?? '');
}

/** The arguments the entry function takes: the request's bytes, and the number of each Remote. */
function argsOf(L: Linked, bytes: Uint8Array): number[] {
  return L.target.params.flatMap(p => {
    if (p.type === 'View') return [copyIn(L.mem, bytes), bytes.length];
    if (p.type === 'Remote') return [L.remotes.indexOf(p.name)];
    if (p.type === 'Remotes') return [L.families.indexOf(p.name)];
    if (['Sql', 'Clock', 'Entropy', 'Timer'].includes(p.type)) return [];
    throw new Error(
      `handle's parameter ${p.name} is a ${p.type}; the host can pass a View (the request), Sql, Remote, Remotes, Clock, Entropy and Timer`,
    );
  });
}

/** One run of the handler from the start of the request, against the log so far. */
function attempt(L: Linked, given: Uint8Array | null): Uint8Array<ArrayBuffer> {
  L.pos = 0;
  const logged = !(L.live && !L.o.log);
  const bytes = logged ? startOf(L, given) : (given ?? fail('no request bytes were given'));
  if (L.o.trace && L.F.length > 0) L.o.trace.push({ flags: { ...L.flagNow } });
  const call = (name: string, args: number[]): unknown => {
    const f = L.raw[name];
    return typeof f === 'function' ? f(...args) : fail(`the module exports no function ${name}`);
  };
  call('reset', []);
  const floor = globalOf(L, 'heap');
  if (!(L.target.name in L.raw))
    throw new Error(
      L.target.name === 'handle'
        ? `this program has no handle function; it serves: ${L.M.map(m => m.name).join(', ')}`
        : `no method ${L.target.name}`,
    );
  L.remotes = L.target.params.filter(p => p.type === 'Remote').map(p => p.name);
  L.families = L.target.params.filter(p => p.type === 'Remotes').map(p => p.name);
  const args = argsOf(L, bytes);
  let h = 0;
  try {
    h = Number(call(L.target.name, args));
  } catch (err) {
    if (err instanceof Pending) throw err;
    const why = globalOf(L, 'why');
    throw new Error(why ? `trap ${why}: ${TRAPS[why]}` : err instanceof Error ? err.message : String(err), {
      cause: err,
    });
  }
  return finished(L, bytes, h, floor);
}

// A rollback(out), or a trap, undoes the writes of the stretch it ends: those after the run's last call (the earlier
// stretches were committed before their calls). Each SQL write there, and each timer set there (its row in _wakes is
// in the same transaction), is marked `undone` in the live run's log, so the log, its trace and every view of it say
// it did not stay. A read is not marked; a clock read or a random draw undoes nothing.
const WRITE = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i;
function markUndone(L: Linked, effects: readonly Effect[]): void {
  if (!L.live) return;
  let from = 0;
  effects.forEach((e, i) => {
    if (isCall(e)) from = i + 1;
  });
  for (const e of effects.slice(from)) if ((isSql(e) && WRITE.test(L.Q[e.q]?.sql ?? '')) || isWake(e)) e.undone = true;
}

/** The run's answer, with what it used written into its log. */
function finished(L: Linked, bytes: Uint8Array, h: number, floor: number): Uint8Array<ArrayBuffer> {
  // how much memory this run used: the same number on every run and every replay of the same request
  L.used = globalOf(L, 'heap') - floor;
  L.undone = globalOf(L, 'undo') !== 0;
  const [head] = L.effects;
  if (head && isHead(head) && L.live) {
    head.bytes = L.used;
    if (L.undone) head.undone = true;
  }
  const out = answerAt(L.mem, h);
  const { target, undone } = L;
  L.o.observe?.({
    target: target.name,
    method: target.method ?? null,
    bytes,
    effects: structuredClone(L.effects),
    out,
    undone,
  });
  if (undone) markUndone(L, L.effects);
  return out;
}

// ---- the app: what a host does with a linked module

export type RunOptions = {
  transaction?: Transaction;
  /** the time left for the whole request */
  deadlineMs?: number;
  method?: Method | null;
  /** runs in the last stretch's transaction, with the answer */
  done?: (out: Uint8Array) => void;
  trace?: From;
};
export type Ran = { out: Uint8Array<ArrayBuffer>; effects: Effect[] };
type Step = { out: Uint8Array<ArrayBuffer> } | { pending: Pending };

function handle(L: Linked, bytes: Uint8Array | null): Uint8Array<ArrayBuffer> {
  if (L.live) {
    L.effects = [];
    L.target = { name: 'handle', params: L.E };
    L.span = begin(null, L.o.name);
  }
  try {
    const out = attempt(L, bytes);
    if (L.live && L.effects.length > 0) L.o.sink?.(L.effects);
    if (L.undone && L.live) throw new Undo(out);
    return out;
  } catch (err) {
    throw err instanceof Pending
      ? new Error(`this handler calls ${err.to}: use await app.run(bytes)`, { cause: err })
      : err;
  }
}

/** One stretch of a run, in its transaction: up to the answer, or to a call whose reply is not in the log yet. */
function stretch(
  L: Linked,
  bytes: Uint8Array,
  mine: Effect[],
  to: Target,
  me: Span,
  o: Required<Pick<RunOptions, 'transaction' | 'done'>>,
): Step {
  try {
    return o.transaction((): Step => {
      [L.effects, L.target, L.span] = [mine, to, me];
      try {
        const out = attempt(L, bytes);
        if (L.undone) throw new Undo(out);
        o.done(out);
        return { out };
      } catch (err) {
        if (err instanceof Pending) return { pending: err };
        throw err;
      }
    });
  } catch (err) {
    if (err instanceof Undo) return { out: err.out };
    // a run that failed (a trap, a storage error) rolled back; its log so far goes with the error, so the host
    // can record that it ran and what it did before the failure
    if (!(err instanceof Pending)) markUndone(L, mine);
    const [head] = mine;
    if (head && isHead(head)) timeTook(head, me);
    if (
      typeof err === 'object' &&
      err !== null &&
      !('effects' in err && err.effects !== null && err.effects !== undefined)
    )
      Object.assign(err, { effects: mine });
    throw err;
  }
}

/** A run's head, told how long the run took: in ms, and in µs from the fine clock when the run began on it. */
function timeTook(head: Head, me: Span): void {
  head.took = Date.now() - me.at;
  if (me.at_us !== undefined) head.took_us = clockUs() - me.at_us;
}

// Requests to one object interleave at calls, so each run keeps its own log and installs it for each stretch.
function runLogged(L: Linked, bytes: Uint8Array, options: RunOptions = {}): Promise<Ran> {
  const { transaction = direct, deadlineMs = Infinity, method = null, done = () => {}, trace: from = null } = options;
  const mine: Effect[] = [];
  const me = begin(from, L.o.name);
  const end = Date.now() + deadlineMs;
  const to: Target = method
    ? { name: `serve_${method.name}`, params: method.params, method: method.name }
    : { name: 'handle', params: L.E };
  const caller = { services: L.o.services, name: L.o.name, timers: L.o.timers };
  const next = async (): Promise<Ran> => {
    const s = stretch(L, bytes, mine, to, me, { transaction, done });
    if ('out' in s) {
      const [head] = mine;
      if (head && isHead(head)) timeTook(head, me);
      if (mine.length > 0) L.o.sink?.(mine);
      return { out: s.out, effects: mine };
    }
    mine.push(await perform(caller, s.pending, { trace: me.trace, parent: me.span }, end - Date.now()));
    return next();
  };
  return next();
}

export type ServeRequest = {
  method: string;
  fingerprint: string;
  key?: string | null;
  withinMs?: number;
  trace?: From;
};
export type Served = { status: string; body: Uint8Array; effects?: Effect[] };
const answerOf = (out: Uint8Array): { status: Status; body: Uint8Array } => ({
  status: out[0] === 48 ? 'ok' : 'rejected',
  body: out.subarray(1),
});

// A key names one command: sent again with the same message it is answered from the stored reply; with another
// message nothing runs, and the answer is skew, not rejected: the first message may have run, so the caller must
// not take this as a refusal it can compensate for (finding M1 of the calls model; a key reused for a different
// command is a bug in the caller, which a replay would hide). A row stored before messages were kept (message
// NULL) is replayed.
function storedReply(L: Linked, key: string, method: string, message: string): Served | null {
  const [seen] = sqlOf(L).exec('SELECT status, body, message FROM _calls WHERE key = ?1', key).raw().toArray();
  if (!seen) return null;
  const [status, body, before] = seen;
  if (typeof before === 'string' && before !== message)
    return {
      status: 'skew',
      body: enc.encode(
        `the key ${key} was used before for another ${method} message (${before.length > 200 ? `${before.slice(0, 200)}…` : before}); a key names one command, so this one (${message.length > 200 ? message.slice(0, 200) + '…' : message}) did not run (the first may have)`,
      ),
    };
  return { status: cellText(status), body: enc.encode(cellText(body)) };
}

// One call from another object: check the two sides agree on the method, answer a repeated key from the stored
// reply, otherwise run the method and store its reply in the same transaction as its writes.
async function serve(
  L: Linked,
  req: ServeRequest,
  bytes: Uint8Array,
  { transaction = direct }: { transaction?: Transaction } = {},
): Promise<Served> {
  const { method, fingerprint, key = null, withinMs = Infinity, trace = null } = req;
  const m = L.M.find(x => x.name === method);
  const skew = (text: string): Served => ({ status: 'skew', body: enc.encode(text) });
  if (!m) return skew(`no method ${method} here; this build serves: ${L.M.map(x => x.name).join(', ') || 'nothing'}`);
  if (m.fingerprint !== fingerprint)
    return skew(`${method} is defined differently on the two sides (caller ${fingerprint}, callee ${m.fingerprint})`);
  const message = utf8.decode(bytes);
  const stored = key === null ? null : storedReply(L, key, method, message);
  if (stored) return stored;
  const store = (out: Uint8Array): void => {
    if (key === null) return;
    const a = answerOf(out);
    sqlOf(L).exec(
      'INSERT INTO _calls(key, status, body, message) VALUES (?1, ?2, ?3, ?4)',
      key,
      a.status,
      utf8.decode(a.body),
      message,
    );
  };
  const ran = await runLogged(L, new Uint8Array(bytes), {
    transaction,
    deadlineMs: withinMs,
    method: m,
    done: store,
    trace,
  });
  return { ...answerOf(ran.out), effects: ran.effects };
}

type Declared = { name: string; settled: boolean; with?: string[]; sql: string };
export type Broken = { name: string; settled: boolean; rows: Record<string, Cell>[] };
const declaredIn = (module: WebAssembly.Module): Declared[] => listed<Declared>(module, 'invariants');

// The program's invariants that do not hold now (rows: up to 5 of what is wrong). settled: true also runs the ones
// that hold only once nothing is in flight and no timer is set. One that reads another program's tables is the
// simulator's to run.
function invariants(L: Linked, module: WebAssembly.Module, settled: boolean): Broken[] {
  return declaredIn(module).flatMap(v => {
    if ((v.settled && !settled) || (v.with?.length ?? 0) > 0) return [];
    const rows = sqlOf(L).exec(v.sql).toArray();
    return rows.length > 0 ? [{ name: v.name, settled: v.settled, rows: rows.slice(0, 5).map(r => ({ ...r })) }] : [];
  });
}

export type Woken = { key: number; status: Status; body: Uint8Array; effects: Effect[] };
const isCut = (err: unknown): boolean => typeof err === 'object' && err !== null && 'cut' in err && Boolean(err.cut);

// Run `woken` for one due key, as a child span of the run that set it. Its row goes in the same transaction as
// the run's last writes, so a run cut short (the object reset while it waited on a call) is woken again: at
// least once, and each run continues from the data, like any request. A run that traps or rolls back is not
// retried by the timer; its row is removed and the failure is in its log. Null when the key is not due.
async function wakeDue(
  L: Linked,
  key: number,
  { transaction = direct, now = Date.now() }: { transaction?: Transaction; now?: number } = {},
): Promise<Woken | null> {
  const m = L.M.find(x => x.name === 'woken') ?? fail('this program exports no woken');
  const sql = sqlOf(L);
  const [row] = sql.exec('SELECT due, trace, span FROM _wakes WHERE key = ?1', key).toArray();
  const due = Number(row?.['due']);
  if (!row || due > now) return null;
  const span = cellText(row['span']);
  const gone = (): void => {
    sql.exec('DELETE FROM _wakes WHERE key = ?1 AND span = ?2', key, span);
  };
  try {
    const trace = typeof row['trace'] === 'string' ? { trace: row['trace'], parent: span } : null;
    const ran = await runLogged(L, enc.encode(JSON.stringify({ key })), { transaction, method: m, done: gone, trace });
    if (L.undone) transaction(gone);
    const [head] = ran.effects;
    if (head && isHead(head)) head.woke = { key, due };
    return { key, ...answerOf(ran.out), effects: ran.effects };
  } catch (err) {
    // a run cut short keeps its timer: it is woken again
    if (!isCut(err)) transaction(gone);
    throw err;
  }
}

/** Timers. due: the keys whose time has come, oldest first. next: the earliest time set, or null. */
function dueKeys(L: Linked, now: number): number[] {
  if (!L.M.some(x => x.name === 'woken')) return [];
  const rows = sqlOf(L).exec('SELECT key FROM _wakes WHERE due <= ?1 ORDER BY due, key', now).toArray();
  return rows.map(r => Number(r['key']));
}
function nextDue(L: Linked): number | null {
  if (!L.M.some(x => x.name === 'woken')) return null;
  const due = sqlOf(L).exec('SELECT min(due) AS due FROM _wakes').toArray()[0]?.['due'];
  return due === null || due === undefined ? null : Number(due);
}

function linked(module: WebAssembly.Module, options: LinkOptions): Linked {
  const F = listed<FlagDecl>(module, 'flags');
  const E = listed<HostParam>(module, 'entry');
  const { sql, log = true, recorded = null, trace = null, services = {}, name = null } = options;
  const { sink = null, heap = null, random = null, timers = REAL_TIMERS, observe = null } = options;
  const holder: { L: Linked | null } = { L: null };
  const raw = new WebAssembly.Instance(module, {
    env: envOf(() => holder.L ?? fail('the module called its host while it was being linked')),
  }).exports;
  const memory = raw['memory'];
  const alloc = raw['alloc'];
  if (!(memory instanceof WebAssembly.Memory) || typeof alloc !== 'function')
    return fail('not a Tape module: it exports no memory or no alloc');
  const L: Linked = {
    Q: listed<Query>(module, 'queries'),
    S: listed<Shape>(module, 'shapes'),
    F,
    E,
    BUILD: String(section(module, 'build')),
    C: listed<CallDecl>(module, 'calls'),
    M: listed<Method>(module, 'methods'),
    o: { sql, log, recorded, trace, services, name, sink, heap, random, timers, observe },
    live: !recorded,
    mem: { memory, alloc: size => Number(alloc(size)) },
    raw,
    flagNow: Object.fromEntries(F.map(f => [f.name, f.default])),
    target: { name: 'handle', params: E },
    remotes: [],
    families: [],
    span: null,
    used: 0,
    undone: false,
    effects: recorded ?? [],
    pos: 0,
  };
  holder.L = L;
  return L;
}

/** A module linked to its host. */
export function link(module: WebAssembly.Module, options: LinkOptions = {}) {
  const L = linked(module, options);
  return {
    get bytesUsed(): number {
      return L.used;
    },
    get undone(): boolean {
      return L.undone;
    },
    get effects(): Effect[] {
      return L.effects;
    },
    get remotes(): string[] {
      return L.remotes;
    },
    get flagValues(): Flags {
      return { ...L.flagNow };
    },
    replayed: (): number => L.pos,
    exports: L.raw,
    build: L.BUILD,
    flags: L.F,
    setFlags: (values: Flags): void => writeFlags(L.mem, L.F, values, L.flagNow),
    handle: (bytes: Uint8Array | null): Uint8Array<ArrayBuffer> => handle(L, bytes),
    /** handle inside a transaction: f => ctx.storage.transactionSync(f). rollback(out) undoes the writes and still answers. */
    handleIn(transaction: Transaction, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
      try {
        return transaction(() => handle(L, bytes));
      } catch (err) {
        if (err instanceof Undo) return err.out;
        // a trap: the transaction rolled back what this run wrote
        markUndone(L, L.effects);
        throw err;
      }
    },
    runLogged: (bytes: Uint8Array, o?: RunOptions): Promise<Ran> => runLogged(L, bytes, o),
    run: async (bytes: Uint8Array, o?: RunOptions): Promise<Uint8Array<ArrayBuffer>> =>
      (await runLogged(L, bytes, o)).out,
    serve: (req: ServeRequest, bytes: Uint8Array, o?: { transaction?: Transaction }): Promise<Served> =>
      serve(L, req, bytes, o),
    invariants: ({ settled = false }: { settled?: boolean } = {}): Broken[] => invariants(L, module, settled),
    declared: (): Declared[] => declaredIn(module),
    due: (now = Date.now()): number[] => dueKeys(L, now),
    next: (): number | null => nextDue(L),
    wake: (key: number, o?: { transaction?: Transaction; now?: number }): Promise<Woken | null> => wakeDue(L, key, o),
  };
}
export type App = ReturnType<typeof link>;
