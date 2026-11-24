// The outcome protocol (docs/service.md, encodeOutcome): a client may send a request again when nothing was kept
// (`not applied`). An `unknown` outcome may already have been applied, so a second send is a replay of the same
// idempotency key or it is a second effect. `retry-after` on unknown is the bug: it tells the client to send again
// now, and a client with no key sends a new request.
import type { Step } from './explore.ts';

export type Bounds = { keyed: boolean };
export type Flags = { retryUnknown?: boolean };
type Outcome = 'applied' | 'not applied' | 'partly' | 'unknown';
export type State = {
  phase: 'open' | 'answered' | 'done';
  outcome: Outcome | null;
  kept: boolean;
  key: boolean;
  twice: boolean;
};
export const DEFAULTS: Bounds = { keyed: false };
const clone = (s: State): State => ({ ...s });
export const init = (b: Bounds = DEFAULTS): State => ({
  phase: 'open',
  outcome: null,
  kept: false,
  key: b.keyed,
  twice: false,
});

const answer = (s: State, outcome: Outcome, kept: boolean): State => {
  const t = clone(s);
  t.phase = 'answered';
  t.outcome = outcome;
  t.kept = kept;
  return t;
};
/** What the client does with the answer. A retry of unknown without a key applies a second time when the first
 * request was kept. The correct client does not send that retry. */
const follow = (s: State, flags: Flags): Step<State>[] => {
  if (s.phase !== 'answered' || s.outcome === null) return [];
  const t = clone(s);
  t.phase = 'done';
  const retryWithoutKey = s.outcome === 'unknown' && !s.key && flags.retryUnknown === true;
  if (s.outcome === 'not applied' || (s.outcome === 'unknown' && s.key) || (s.outcome === 'partly' && s.key))
    return [[`client retries ${s.outcome} with the same request`, t]];
  if (retryWithoutKey) {
    t.twice = s.kept;
    return [[`client retries unknown with no key${s.kept ? ', and it applies again' : ''}`, t]];
  }
  return [[`client stops after ${s.outcome}`, t]];
};
export function actions(s: State, flags: Flags = {}): Step<State>[] {
  if (s.phase === 'open')
    return [
      ['service: not applied', answer(s, 'not applied', false)],
      ['service: applied', answer(s, 'applied', true)],
      ['service: partly', answer(s, 'partly', true)],
      ['service: unknown, kept', answer(s, 'unknown', true)],
      ['service: unknown, not kept', answer(s, 'unknown', false)],
    ];
  return follow(s, flags);
}
export const invariants: Readonly<Record<string, (s: State) => boolean>> = {
  // a second effect is a retry of unknown that had no key
  'unknown-without-a-key': s => s.phase !== 'done' || !s.twice,
};
