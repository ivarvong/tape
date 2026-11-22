// A model of calls between programs (RUNTIME-SPEC R-ANS-3; host.ts `serve`, program.ts; fulfillment.tape's charge
// step): caller runs (the client's twin requests to advance one order, and optionally a run that reuses the key for
// another message) read the order, call the callee under a once key, and act on the answer: ok -> compare-and-set
// charging -> done; rejected -> compensate, charging -> failed; unreachable (or no answer) -> leave the order to be
// tried again. The callee stores each call's message and reply under its key in the commit of the call's writes;
// a commit can fail (rolled back); a reply can be lost.
//
// Bugs, each the mechanism of a defect the service once had (its id in docs/defects.md):
//   s2       a commit that failed answers `rejected` (it must answer `unreachable`: the key is not spent) (S2)
//   h2       the stored reply is looked up by key alone, so another message under the key gets the first's reply (H2)
//   j4       the run that loses the compare-and-set answers 404 for an order that exists (J4)
//   m1       a key reused for another message answers `rejected`, a refusal the caller compensates for, while the
//            first message's effect stands (found by this model, 16 November 2026; the answer is now `skew`:
//            nothing ran and the two sides disagree, which a caller does not compensate for)
// Invariants: a failed order was never charged (conservation); one key is charged at most once; an `ok` answer to a
// message means that message ran; an existing order is never answered 404.
import type { Step } from './explore.ts';

export type Bounds = { runs: string[]; restarts: number };
export type Flags = { s2?: boolean; h2?: boolean; j4?: boolean; m1?: boolean };
type Answer = 'ok' | 'rejected' | 'skew' | 'unreachable';
/** A caller run: where it is, the message it sends, how often it has started again. */
type Run = [pc: 'start' | 'wait' | 'answered' | 'gaveup', message: string, restarts: number];
/** In the network: a call from a run with its message, or the callee's answer to a run. */
type Message = ['call', run: number, message: string] | ['reply', run: number, answer: Answer];
export type State = {
  order: 'charging' | 'done' | 'failed';
  /** what the callee stored under the key: the message and its reply */
  calls: ['k', message: string, reply: Answer][];
  /** the messages that ran */
  ran: string[];
  charged: number;
  runs: Run[];
  net: Message[];
  /** the first invariant broken, if any */
  x: string | null;
};
export type Outcome = 'ok' | 'fail' | 'lose';
export const DEFAULTS: Bounds = { runs: ['m1', 'm1'], restarts: 1 };
const message = (m: Message): Message => (m[0] === 'call' ? ['call', m[1], m[2]] : ['reply', m[1], m[2]]);
const clone = (s: State): State => ({
  order: s.order,
  calls: s.calls.map((c): State['calls'][number] => [...c]),
  ran: [...s.ran],
  charged: s.charged,
  runs: s.runs.map((r): Run => [...r]),
  net: s.net.map(message),
  x: s.x,
});
/** In the order Array#sort gives values with no comparator: by their text. */
const byText = (a: unknown, b: unknown): number => {
  const [x, y] = [String(a), String(b)];
  if (x === y) return 0;
  return x < y ? -1 : 1;
};
export const init = (b: Bounds = DEFAULTS): State => ({
  order: 'charging',
  calls: [],
  ran: [],
  charged: 0,
  runs: b.runs.map((m): Run => ['start', m, 0]),
  net: [],
  x: null,
});
/** A run of the state, to change in place. */
const runOf = (s: State, i: number): Run => {
  const run = s.runs[i];
  if (run === undefined) throw new Error(`the model has no run ${i}`);
  return run;
};

export function callee(from: State, m: string, o: Outcome, flags: Flags): { s: State; reply: Answer | null } {
  const s = clone(from);
  const stored = s.calls.find(c => c[0] === 'k');
  if (stored) {
    if (stored[1] === m || flags.h2 === true) return { s, reply: o === 'lose' ? null : stored[2] };
    // the key was used for another message: not run
    const refusal = flags.m1 === true ? 'rejected' : 'skew';
    return { s, reply: o === 'lose' ? null : refusal };
  }
  if (o === 'fail') return { s, reply: flags.s2 === true ? 'rejected' : 'unreachable' };
  s.charged++;
  s.ran = [...s.ran, m].toSorted(byText);
  if (s.charged > 1) s.x ??= 'charged-twice';
  s.calls.push(['k', m, 'ok']);
  return { s, reply: o === 'lose' ? null : 'ok' };
}

/** What each run can do by itself: read the order and call, or stop waiting for an answer. */
const runSteps = (s: State, b: Bounds): Step<State>[] =>
  s.runs.flatMap(([pc, m, restarts], i): Step<State>[] => {
    const t = clone(s),
      run = runOf(t, i);
    if (pc === 'start' && s.order !== 'charging') {
      run[0] = 'answered';
      return [[`run ${i}: order is ${s.order}, answered`, t]];
    }
    if (pc === 'start') {
      run[0] = 'wait';
      t.net = [...t.net, ['call', i, m] satisfies Message].toSorted(byText);
      return [[`run ${i}: call charge(${m}) under key k`, t]];
    }
    if (pc !== 'wait') return [];
    // no answer in time: the call's outcome is unknown, the run answers 503 and the client may send it again
    run[0] = restarts < b.restarts ? 'start' : 'gaveup';
    run[2]++;
    return [[`run ${i}: no answer, 503`, t]];
  });
const OUTCOMES: readonly Outcome[] = ['ok', 'fail', 'lose'];
/** A call reaching the callee, with each outcome. */
const calleeSteps = (s: State, rest: Message[], i: number, m: string, flags: Flags): Step<State>[] =>
  OUTCOMES.map((o): Step<State> => {
    const { s: t, reply } = callee({ ...s, net: rest }, m, o, flags);
    if (reply !== null) t.net = [...t.net, ['reply', i, reply] satisfies Message].toSorted(byText);
    return [`callee charge(${m}) ${o}${reply === null ? '' : ` -> ${reply}`}`, t];
  });
/** An answer reaching its run. */
const answerStep = (s: State, rest: Message[], i: number, reply: Answer, flags: Flags, b: Bounds): Step<State> => {
  const t = clone(s),
    run = runOf(t, i);
  t.net = rest.map(message);
  if (run[0] !== 'wait') return [`run ${i} ignores late ${reply}`, t];
  if (reply === 'ok' && !s.ran.includes(run[1])) t.x = 'ok-for-a-message-that-never-ran';
  if (reply === 'skew') {
    run[0] = 'answered';
    return [`run ${i}: skew, 502, the order stays`, t];
  }
  if (reply === 'unreachable') {
    run[0] = run[2] < b.restarts ? 'start' : 'gaveup';
    run[2]++;
    return [`run ${i}: unreachable, 503`, t];
  }
  const to = reply === 'ok' ? 'done' : 'failed';
  run[0] = 'answered';
  if (t.order === 'charging') t.order = to;
  else if (flags.j4 === true) t.x ??= 'phantom-404';
  return [`run ${i}: ${reply}, compare-and-set charging -> ${to} ${s.order === 'charging' ? 'won' : 'lost'}`, t];
};
export function actions(s: State, flags: Flags = {}, b: Bounds = DEFAULTS): Step<State>[] {
  if (s.x !== null) return [];
  const network = s.net.flatMap((msg, k): Step<State>[] => {
    const rest = s.net.filter((_, j) => j !== k);
    const lost = clone(s);
    lost.net = rest.map(message);
    const arrived =
      msg[0] === 'call' ? calleeSteps(s, rest, msg[1], msg[2], flags) : [answerStep(s, rest, msg[1], msg[2], flags, b)];
    return [[`lose ${msg.join(' ')}`, lost], ...arrived];
  });
  return [...runSteps(s, b), ...network];
}
export const invariants: Readonly<Record<string, (s: State) => boolean>> = {
  'failed-order-not-charged': s => !(s.order === 'failed' && s.charged > 0),
  'charged-at-most-once': s => s.x !== 'charged-twice',
  'ok-means-it-ran': s => s.x !== 'ok-for-a-message-that-never-ran',
  'existing-order-not-404': s => s.x !== 'phantom-404',
};
