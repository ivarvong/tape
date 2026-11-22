// interp/effects.ts: the calls that reach outside the program. Each is asked of the host, with what a log records
// of it: the statement and its parameters, the call and its message, the timer and its key.
import { type Arg, type Call, unreachable } from '../compiler/ast.ts';
import { movePlan, tablesOf } from '../rules.ts';
import { type Interp, callable, ev, find, meets, run, stop } from './eval.ts';
import { type CallRequest, type Host, MAX_WAKE_MS, type SqlParam } from './host.ts';
import { Unsupported, decode, row, writeJson } from './json.ts';
import {
  type Adt,
  type Buf,
  type Env,
  type Value,
  adt,
  asAdt,
  asBuf,
  asBytes,
  asFamily,
  asInt,
  asRemote,
} from './value.ts';
import { asRows, exact } from './value.ts';

const EFFECTS = [
  ...(['sql_exec', 'sql_first', 'sql_all', 'sql_move', 'decode', 'write_json', 'next'] as const),
  ...(['wake', 'now', 'random', 'call', 'ask', 'rollback', 'remote'] as const),
];
type Effect = (typeof EFFECTS)[number];
const utf8 = new TextDecoder();
const fail = (err: Error): never => {
  throw err;
};
/** One effect call being run: its arguments are read by label, as values, literals or type names. */
type Site = { it: Interp; name: Effect; e: Call; env: Env; file: string };
const argOf = (s: Site, label: string): Arg | undefined => s.e.args.find(a => a.label === label);
const value = (s: Site, label: string): Value =>
  ev(s.it, (argOf(s, label) ?? stop(`${s.name} is missing argument ${label}`)).value, s.env, s.file);
const first = (s: Site): Value => ev(s.it, (s.e.args[0] ?? stop(`${s.name} takes an argument`)).value, s.env, s.file);
const literal = (s: Site, label: string): string => {
  const a = argOf(s, label)?.value;
  return a?.k === 'str' ? utf8.decode(Uint8Array.from(a.bytes)) : stop(`${s.name}: ${label} should be a text literal`);
};
const typeName = (s: Site, label: string): string => {
  const a = argOf(s, label)?.value;
  return a?.k === 'ctor' ? a.name : stop(`${s.name}: argument ${label} should be a type name`);
};
// what the host is asked through; a host without it cannot follow the program
const host = <K extends keyof Host>(it: Interp, k: K): Host[K] =>
  (it.host ?? fail(new Unsupported(k)))[k] ?? fail(new Unsupported(k));

// ---- JSON
export const decoded = (it: Interp, bytes: Uint8Array, name: string, file: string): Adt =>
  decode(it.prog, bytes, name, (t, v) => meets(it, t, v, file));
/** v written into `out` as JSON, its text by the program's own write_json_string */
export const jsonInto = (it: Interp, out: Buf, v: Value, file: string): Buf =>
  writeJson(it.prog, out, asAdt(v), (o, text) => {
    const g = find(it, 'write_json_string', file) ?? stop('std/json.tape is not among the sources');
    run(it, callable(g), [o, text]);
  });
const json = (it: Interp, v: Value, file: string): Uint8Array =>
  Uint8Array.from(jsonInto(it, { k: 'buf', buf: [] }, v, file).buf);

// ---- SQL
const sqlParam = (x: Value): SqlParam =>
  x instanceof Uint8Array ? utf8.decode(x) : typeof x === 'boolean' ? (x ? 1 : 0) : exact(asInt(x), 'sql');
// p1, p2, … in order
const sqlParams = (s: Site): SqlParam[] => {
  const out: SqlParam[] = [];
  for (let i = 1; argOf(s, `p${i}`); i++) out.push(sqlParam(value(s, `p${i}`)));
  return out;
};
// sql_move changed no row: the row read back by its key alone is Raced when it is there, NoRow when it is not
function readBack(s: Site, text: string, p: SqlParam[], type: string): Value {
  const plan = movePlan(text, s.it.prog.machines, tablesOf(s.it.prog));
  if (plan.error !== undefined) return stop(`sql_move: ${plan.error}`);
  const key = plan.params.map(n => p[n - 1] ?? stop(`sql_move: no parameter ?${n}`)),
    [now] = host(s.it, 'rows')(plan.select, key);
  return now ? adt('Raced', { now: row(s.it.prog, type, now) }) : adt('NoRow');
}
function sql(s: Site): Value {
  const text = literal(s, 'query'),
    p = sqlParams(s);
  if (s.name === 'sql_exec') return BigInt(host(s.it, 'exec')(text, p));
  const type = typeName(s, 'row'),
    rows = host(s.it, 'rows')(text, p),
    [one] = rows;
  if (s.name === 'sql_all') return { k: 'rows', rows: rows.map(r => row(s.it.prog, type, r)), at: 0 };
  if (s.name === 'sql_first') return one ? adt('Some', { value: row(s.it.prog, type, one) }) : adt('None');
  return one ? adt('Moved', { value: row(s.it.prog, type, one) }) : readBack(s, text, p, type);
}

// ---- calls to other objects
function remoteCall(s: Site): Value {
  const to = asRemote(value(s, 'to')) ?? fail(new Unsupported('a call through an interface'));
  const request: CallRequest = {
    to: to.remote,
    method: literal(s, 'method'),
    send: json(s.it, value(s, 'send'), s.file),
    within: Number(asInt(value(s, 'within'))),
  };
  if (s.name === 'call') {
    const once = value(s, 'once');
    request.once = utf8.decode(once instanceof Uint8Array ? once : json(s.it, once, s.file));
  }
  const { status, reply } = host(s.it, 'call')(request);
  const refused = (why: string, reason?: Uint8Array): Value =>
    adt('Err', { error: adt(why, reason ? { reason } : {}) });
  switch (status) {
    case 'ok': {
      // a reply that is not what the caller expects is Skew, with what was wrong with it
      const got = decoded(s.it, reply, typeName(s, 'reply'), s.file);
      return got.c === 'Ok' ? got : refused('Skew', asBytes(got.f['error']));
    }
    case 'timeout':
      return refused('Timeout');
    case 'unreachable':
      return refused('Unreachable');
    case 'rejected':
      return refused('Rejected', reply);
    case 'skew':
      return refused('Skew', reply);
    default:
      return unreachable(status, 'call status');
  }
}

// ---- timers, and the rest
function wake(s: Site): Value {
  const key = exact(asInt(value(s, 'key')), 'wake'),
    after = Math.min(Math.max(0, Number(asInt(value(s, 'after')))), MAX_WAKE_MS);
  return BigInt(host(s.it, 'wake')(key, after));
}
function remote(s: Site): Value {
  const of = asFamily(value(s, 'of')),
    index = exact(asInt(value(s, 'index')), 'remote');
  return index < 0 ? stop('remote takes an index from 0') : { k: 'remote', remote: `${of.family}-${index}` };
}
function next(s: Site): Value {
  const r = asRows(first(s)),
    at = r.rows[r.at];
  return at === undefined ? adt('End') : adt('Next', { value: at, rest: { k: 'rows', rows: r.rows, at: r.at + 1 } });
}
function effectOf(s: Site): Value {
  switch (s.name) {
    case 'sql_exec':
    case 'sql_first':
    case 'sql_all':
    case 'sql_move':
      return sql(s);
    case 'decode':
      return decoded(s.it, asBytes(value(s, 'json')), typeName(s, 'as'), s.file);
    case 'write_json':
      return jsonInto(s.it, asBuf(value(s, 'out')), value(s, 'value'), s.file);
    case 'next':
      return next(s);
    case 'wake':
      return wake(s);
    case 'now':
      return BigInt(host(s.it, 'now')());
    case 'random':
      return BigInt(host(s.it, 'random')());
    case 'rollback':
      s.it.undone = true;
      return first(s);
    case 'remote':
      return remote(s);
    case 'call':
    case 'ask':
      return remoteCall(s);
    default:
      return unreachable(s.name, 'effect');
  }
}
/** A call that names no function of the program: one of the effects, or something the interpreter does not have. */
export function effect(it: Interp, name: string, e: Call, env: Env, file: string): Value {
  const known = EFFECTS.find(x => x === name);
  return known ? effectOf({ it, name: known, e, env, file }) : fail(new Unsupported(name));
}
