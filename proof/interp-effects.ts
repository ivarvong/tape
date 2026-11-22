// proof/interp-effects.ts: the compiled build against the reference interpreter, effects included.
//
// The simulator drives every program that takes requests. Each run that reaches its answer is kept: the bytes it
// was given, the log of effects it ran against, the bytes it answered. The reference interpreter (interp.ts) is
// then given the same bytes, with that log as its host. It must ask for the same effects in the same order (the
// same statement with the same parameters, the same call with the same message, key and budget, the same timer),
// use all of the log, and answer the same bytes. The interpreter shares the parser with the compiler and nothing
// after it: not the checker, the code generator, the memory or the host.
//
//   node proof/interp-effects.ts [--seeds 12] [--only name]
//
// A run the interpreter cannot follow (a form it does not have) is counted and named, not passed over.
import '../node25.ts';
import { readdirSync } from 'node:fs';
import { isCall, isHead, isNow, isRandom, isSql, isWake } from '../host.ts';
import type { Effect, Observed } from '../host.ts';
import { pack, unpack } from '../host/log.ts';
import { Trap, Unsupported, interpret } from '../interp.ts';
import type { CallRequest, Host } from '../interp.ts';
import { auto, search } from '../sim.ts';
import type { Model } from '../sim/engine.ts';
import { std } from '../std.ts';
import { arg, program, record, root } from './lib.ts';

const seeds = Number(arg('seeds', '12'));
const only = arg('only', '');
const list = (dir: string): string[] =>
  readdirSync(root + dir)
    .filter(f => f.endsWith('.tape'))
    .map(f => `${dir}/${f}`);
const groups = [
  ['apps/tickets/tickets.tape', 'apps/tickets/pay.tape'],
  ['examples/fulfillment.tape', 'examples/inventory.tape', 'examples/payments.tape', 'examples/shipping.tape'],
  ['examples/orders.tape', 'examples/stock.tape'],
  ...['apps/queue/queue.tape', ...list('examples'), ...list('examples/timed'), ...list('testdata/compare')].map(f =>
    Array.of(f),
  ),
].filter(g => only === '' || g.some(f => f.includes(only)));

class Differ extends Error {}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const shown = (bytes: Uint8Array): string => {
  const p = pack(bytes);
  return typeof p === 'string' ? p : JSON.stringify(p);
};
type Queries = readonly { sql: string }[];

// the log as a host: each thing asked for must be the next thing recorded
function hostOf(effects: readonly Effect[], queries: Queries): Host & { left: () => number } {
  const [head] = effects;
  let pos = head && isHead(head) ? 1 : 0;
  const take = <T extends Effect>(what: string, is: (e: Effect) => e is T, fits: (e: T) => boolean): T => {
    const e = effects[pos];
    if (!e) throw new Differ(`the interpreter asks for ${what}, and the log has ended`);
    if (!is(e) || !fits(e))
      throw new Differ(`the interpreter asks for ${what}; the log has ${JSON.stringify(e).slice(0, 200)}`);
    pos++;
    return e;
  };
  const statement = (text: string, p: readonly (number | string)[]) =>
    take(`${text} ${JSON.stringify(p)}`, isSql, e => queries[e.q]?.sql === text && same(e.p, p));
  const called = (req: CallRequest) =>
    take(
      `a call to ${req.to}.${req.method} within ${req.within}${'once' in req ? ` once ${req.once}` : ''} sending ${shown(req.send)}`,
      isCall,
      e =>
        e.call === req.to &&
        e.method === req.method &&
        e.within === req.within &&
        (!('once' in req) || e.once === req.once) &&
        same(e.send, pack(req.send)),
    );
  return {
    flags: head && isHead(head) ? head.flags : {},
    exec: (text, p) => statement(text, p).r ?? 0,
    rows: (text, p) =>
      (statement(text, p).rows ?? []).map(r =>
        r.map(c => (c instanceof Uint8Array || c instanceof ArrayBuffer || typeof c === 'bigint' ? null : c)),
      ),
    call(req) {
      const e = called(req);
      return { status: e.status, reply: unpack(e.reply) };
    },
    wake: (key, after) => take(`a timer ${key} after ${after}`, isWake, e => e.wake === key && e.after === after).after,
    now: () => take('the time', isNow, () => true).now,
    random: () => take('a random number', isRandom, () => true).random,
    left: () => effects.length - pos,
  };
}

type Run = Observed & { prog: string };
type File = { name: string; text: string };
type Row = {
  runs: number;
  agree: number;
  effects: number;
  unsupported: Record<string, number>;
  differ: { request: string; method: string | null; what: string }[];
  differs: number;
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One run given to the interpreter: an error (Differ, Unsupported, Trap) when it does not come out the same. */
function follow(r: Run, file: File, text: string, queries: Queries): void {
  const host = hostOf(r.effects, queries);
  const it = interpret([...std, { name: `${file.name}.tape`, text }], host);
  const got = r.method === null ? it.handle(r.bytes) : it.serve(r.method, r.bytes);
  if (host.left() > 0) throw new Differ(`the log has ${host.left()} more effects than the interpreter asked for`);
  if (!same([...got], [...r.out]))
    throw new Differ(
      `answers differ: compiled ${shown(r.out).slice(0, 160)} | interpreted ${shown(got).slice(0, 160)}`,
    );
  if (it.undone !== r.undone) throw new Differ(`rollback: compiled ${r.undone}, interpreted ${it.undone}`);
}

// the runs of one set of programs, each given to the interpreter; `text` is the program text it reads
function compare(
  files: readonly File[],
  model: Model,
  runs: ReadonlyMap<string, Run>,
  text: (f: File) => string = f => f.text,
): Row {
  const row: Row = { runs: runs.size, agree: 0, effects: 0, unsupported: {}, differ: [], differs: 0 };
  for (const r of runs.values()) {
    const file = files.find(f => f.name === r.prog);
    // a stand-in remote has no program text
    if (!file) continue;
    try {
      follow(r, file, text(file), model.queries?.[r.prog] ?? []);
      row.agree++;
      row.effects += r.effects.length - 1;
    } catch (e) {
      if (e instanceof Unsupported) row.unsupported[e.message] = (row.unsupported[e.message] ?? 0) + 1;
      else {
        const kind = e instanceof Trap ? 'trap' : 'interpreter error';
        const what = e instanceof Differ ? e.message : `${kind}: ${messageOf(e)}`;
        if (row.differ.length < 3) row.differ.push({ request: shown(r.bytes).slice(0, 160), method: r.method, what });
        row.differs++;
      }
    }
  }
  return row;
}

/** An effect without what differs from run to run: times and trace ids. */
const stable = (e: Effect): unknown => {
  const {
    took: _took,
    sent: _sent,
    trace: _trace,
    span: _span,
    parent: _parent,
    at: _at,
    due: _due,
    ...rest
  } = { took: 0, sent: 0, trace: '', span: '', parent: '', at: 0, due: 0, ...e };
  return rest;
};
async function runsOf(files: readonly File[]): Promise<{ model: Model; runs: Map<string, Run> } | null> {
  const a = ((): ReturnType<typeof auto> | null => {
    try {
      return auto(files, { clients: 4, ops: 10 });
    } catch {
      return null;
    }
  })();
  if (!a || a.errors) return null;
  const runs = new Map<string, Run>();
  const observe = (prog: string, r: Observed): void => {
    const key = JSON.stringify([prog, r.method, pack(r.bytes), r.effects.map(stable)]);
    if (!runs.has(key)) runs.set(key, { prog, ...r });
  };
  const model: Model = { ...a.model, observe, duplicates: false };
  await search(model, { runs: seeds, steps: 120, faults: 3 });
  return { model, runs };
}

const out: (Row & { programs: string })[] = [];
let failed = 0;
for (const g of groups) {
  const files = g.map(program);
  const name = g.join(' + ');
  const got = await runsOf(files);
  if (!got) continue;
  const row = { programs: name, ...compare(files, got.model, got.runs) };
  if (row.differs > 0) failed++;
  out.push(row);
  const un = Object.entries(row.unsupported);
  const notFollowed = un.length > 0 ? `; not followed: ${un.map(([k, n]) => `${k} (${n})`).join(', ')}` : '';
  const differing =
    row.differs > 0
      ? `\n       ${row.differ.map(d => `${d.method ?? ''} ${d.request.split('\n')[0]}: ${d.what}`).join('\n       ')}`
      : '';
  console.log(
    `${row.differs > 0 ? 'DIFFER' : 'ok    '} ${name}: ${row.agree} of ${row.runs} runs agree (${row.effects} effects)${notFollowed}${differing}`,
  );
}

// Can it fail? The interpreter is given a program one edit away from the one that was compiled; each edit must
// show as a difference: a statement, an answer, a call's key, a timer.
type Planted = readonly [path: string, from: string | null, to: string | null, what: string];
const PLANTS: Planted[] = [
  ['examples/orders.tape', "SET state = 'confirmed' WHERE", "SET state = 'refused' WHERE", 'a statement'],
  [
    'examples/orders.tape',
    'Moved(value) -> shown(status: 201, order: value)',
    'Moved(value) -> shown(status: 200, order: value)',
    'an answer',
  ],
  ['examples/orders.tape', 'once: ForOrder(order: id)', 'once: ForOrder(order: id + 1)', "a call's key"],
  ['examples/hello.tape', null, null, 'a number'],
];
/** A program's text with the edit made; with no edit named: the first number in a statement, one higher. */
function edited(path: string, text: string, from: string | null, to: string | null): string {
  const next =
    from === null || to === null
      ? text.replace(/(\+ |= )(\d+)(?=[^"\n]*")/, (_, a: string, n: string) => `${a}${Number(n) + 1}`)
      : text.replace(from, to);
  if (next === text) throw new Error(`the planted edit does not apply to ${path}`);
  return next;
}
const plants: { program: string; edit: string; seen: boolean; differs: number; of: number }[] = [];
for (const [path, from, to, what] of only === '' ? PLANTS : []) {
  const first = program(path);
  const files = [first, ...(path.endsWith('orders.tape') ? [program('examples/stock.tape')] : [])];
  const got = await runsOf(files);
  if (!got) throw new Error(`${path} has no model`);
  const row = compare(files, got.model, got.runs, f =>
    f.name === first.name ? edited(path, f.text, from, to) : f.text,
  );
  const seen = row.differs > 0;
  plants.push({ program: path, edit: what, seen, differs: row.differs, of: row.runs });
  if (!seen) failed++;
  console.log(
    `${seen ? 'ok    ' : 'MISSED'} planted in the interpreter's copy of ${path} (${what}): ${row.differs} of ${row.runs} runs differ`,
  );
}
const total = (of: (o: Row) => number): number => out.reduce((n, o) => n + of(o), 0);
const not = total(o => Object.values(o.unsupported).reduce((a, b) => a + b, 0));
console.log(
  `\n${total(o => o.agree)} of ${total(o => o.runs)} distinct runs agree across ${out.length} program sets, ${total(o => o.effects)} effects; ${not} not followed by the interpreter; ${total(o => o.differs)} differ`,
);
if (only === '' && seeds >= 6)
  record('interp-effects', {
    seeds,
    runs: total(o => o.runs),
    agree: total(o => o.agree),
    effects: total(o => o.effects),
    not_followed: not,
    differ: total(o => o.differs),
    plants,
    programs: out,
  });
process.exit(failed > 0 ? 1 : 0);
