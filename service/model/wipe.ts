// A model of the account delete (RUNTIME-SPEC R-RET-7; index.ts `accountRoute`, Name `wipe`): the route calls each
// name's wipe in turn, then wipes the registry if no name failed. A wipe deletes the object's storage, then stops
// the object (ctx.abort) on a timer so a later request finds a fresh object, and replies. The stop may come before
// the reply has left (in production it did); the route then gets the stop's error. A storage write is durable once
// flushed; the stop discards a write not yet flushed (assumption of the model: the output gate holds unflushed writes
// and a stopped object's are dropped; storage.sync() waits for the flush).
//
// Bugs, each the mechanism of a defect the account delete once had (docs/defects.md P2):
//   p2        the stop's error counts as a failure (the deletion of 18:53 ET, 15 November 2026)
//   nosync    the stop is scheduled without waiting for the flush (the code of 18:53 ET had both bugs)
// Invariants, once the route has answered: a name it reports deleted has no data and none can come back; a name
// it reports failed still has its data; if it reports every name deleted, the registry is gone.
import type { Step } from './explore.ts';

export type Bounds = { names: number };
export type Flags = { p2?: boolean; nosync?: boolean };
/** A name: its data (pending: deleted, not flushed), where its wipe is, and whether its stop is scheduled. */
type Name = [
  data: 'present' | 'pending' | 'gone',
  pc: 'idle' | 'deleting' | 'syncing' | 'stopping' | 'replied' | 'stopped',
  stop: boolean,
];
type Told = 'deleted' | 'failed';
export type State = {
  names: Name[];
  reg: 'present' | 'gone';
  /** the route: calling name i, waiting for it, or done */
  route: [pc: 'call' | 'wait' | 'done', name: number];
  /** what the route reports for each name it has heard from */
  told: Told[];
  net: [kind: 'ok' | 'error', name: number][];
};
export const DEFAULTS: Bounds = { names: 2 };
const clone = (s: State): State => ({
  names: s.names.map((n): Name => [...n]),
  reg: s.reg,
  route: [...s.route],
  told: [...s.told],
  net: s.net.map((m): State['net'][number] => [...m]),
});
export const init = (b: Bounds = DEFAULTS): State => ({
  names: Array.from({ length: b.names }, (): Name => ['present', 'idle', false]),
  reg: 'present',
  route: ['call', 0],
  told: [],
  net: [],
});
/** A name of the state, to change in place. */
const nameOf = (s: State, j: number): Name => {
  const name = s.names[j];
  if (name === undefined) throw new Error(`the model has no name ${j}`);
  return name;
};

/** What the route does next: wipe name i, or answer once every name has been heard from. */
const routeSteps = (s: State, b: Bounds): Step<State>[] => {
  const [pc, i] = s.route;
  if (pc !== 'call' || i > b.names) return [];
  const t = clone(s);
  if (i < b.names) {
    nameOf(t, i)[1] = 'deleting';
    t.route = ['wait', i];
    return [[`route: wipe name ${i}`, t]];
  }
  const failed = t.told.includes('failed');
  t.route = ['done', i];
  if (!failed) t.reg = 'gone';
  return [[`route: ${failed ? 'a name failed, registry kept' : 'registry wiped'}, answers`, t]];
};
/** The next step of a name's own wipe, if it has one. */
const wipeStep = (s: State, j: number, flags: Flags): Step<State>[] => {
  const [data, pc] = nameOf(s, j);
  const t = clone(s),
    n = nameOf(t, j);
  if (pc === 'deleting') {
    n[0] = 'pending';
    if (flags.nosync !== true) {
      n[1] = 'syncing';
      return [[`name ${j}: deleteAll`, t]];
    }
    n[1] = 'stopping';
    n[2] = true;
    return [[`name ${j}: deleteAll, stop scheduled`, t]];
  }
  if (pc === 'syncing' && data === 'gone') {
    n[1] = 'stopping';
    n[2] = true;
    return [[`name ${j}: sync done, stop scheduled`, t]];
  }
  if (pc !== 'stopping') return [];
  n[1] = 'replied';
  t.net.push(['ok', j]);
  return [[`name ${j}: reply ok`, t]];
};
/** What the platform does to a name: flush its write, or stop it when its stop is due. */
const platformSteps = (s: State, j: number): Step<State>[] => {
  const [data, pc, stop] = nameOf(s, j);
  const out: Step<State>[] = [];
  if (data === 'pending') {
    const u = clone(s);
    nameOf(u, j)[0] = 'gone';
    out.push([`name ${j}: storage flushed`, u]);
  }
  if (stop && pc !== 'stopped') {
    const u = clone(s),
      m = nameOf(u, j);
    if (m[0] === 'pending') m[0] = 'present'; // an unflushed write is dropped with the object
    if (m[1] === 'stopping') u.net.push(['error', j]); // the stop overtook the reply
    m[1] = 'stopped';
    m[2] = false;
    out.push([`name ${j}: stopped${pc === 'stopping' ? ' before its reply' : ''}`, u]);
  }
  return out;
};
/** The route hears from the name it waits for. */
const heardSteps = (s: State, flags: Flags): Step<State>[] => {
  const [pc, i] = s.route;
  return s.net.flatMap(([kind, j], k): Step<State>[] => {
    if (pc !== 'wait' || j !== i) return [];
    const t = clone(s),
      told: Told = kind === 'ok' || flags.p2 !== true ? 'deleted' : 'failed';
    t.net = t.net.filter((_, x) => x !== k);
    t.told[j] = told;
    t.route = ['call', i + 1];
    return [[`route: name ${j} ${kind} -> ${told}`, t]];
  });
};
export function actions(s: State, flags: Flags = {}, b: Bounds = DEFAULTS): Step<State>[] {
  return [
    ...routeSteps(s, b),
    ...s.names.flatMap((_, j) => [...wipeStep(s, j, flags), ...platformSteps(s, j)]),
    ...heardSteps(s, flags),
  ];
}
// judged once the route has answered and nothing more can happen to the names (no write pending, no stop due)
const settled = (s: State): boolean =>
  s.route[0] === 'done' && s.names.every(([d, , stop]) => d !== 'pending' && !stop);
export const invariants: Readonly<Record<string, (s: State) => boolean>> = {
  'deleted-means-gone': s => !settled(s) || s.told.every((t, j) => t !== 'deleted' || s.names[j]?.[0] === 'gone'),
  'failed-means-kept': s => !settled(s) || s.told.every((t, j) => t !== 'failed' || s.names[j]?.[0] === 'present'),
  'all-deleted-means-registry-gone': s => !settled(s) || !s.told.every(t => t === 'deleted') || s.reg === 'gone',
};
