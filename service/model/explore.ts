// An exhaustive explorer of a protocol model: breadth-first over every interleaving of the model's actions from its
// initial state, each distinct state once (states are plain JSON; the model keeps them canonical). Every state is
// checked against every invariant; the first violation is returned with the shortest path of actions to it.
// Breadth-first, so the path is a shortest counterexample. No sampling: a bound too large to finish is reported
// as incomplete (truncated: true), never as a pass.
export type Step<S> = [label: string, state: S];
export type Model<S> = {
  init: S;
  actions: (s: S) => Step<S>[];
  invariants: Readonly<Record<string, (s: S) => boolean>>;
  maxStates?: number;
};
export type Violation<S> = { invariant: string; path: string[]; state: S };
export type Explored<S> = {
  states: number;
  transitions: number;
  depth: number;
  violation: Violation<S> | null;
  truncated: boolean;
};
/** The states seen so far: each one's number by its JSON, and how it was first reached. */
type Seen = { index: Map<string, number>; parent: number[]; label: string[] };
const add = (seen: Seen, k: string, from: number, l: string): number => {
  seen.index.set(k, seen.parent.length);
  seen.parent.push(from);
  seen.label.push(l);
  return seen.parent.length - 1;
};
const pathTo = (seen: Seen, to: number): string[] => {
  const out: string[] = [];
  for (let i = to, from = seen.parent[i] ?? -1; from >= 0; i = from, from = seen.parent[i] ?? -1)
    out.unshift(seen.label[i] ?? '');
  return out;
};
const judge = <S>(model: Model<S>, seen: Seen, s: S, i: number): Violation<S> | null => {
  for (const [name, ok] of Object.entries(model.invariants))
    if (!ok(s)) return { invariant: name, path: pathTo(seen, i), state: s };
  return null;
};
/** How a level of the search ended: a violation, the bound, or the next level's states. */
type Level<S> = { violation: Violation<S> | null; truncated: boolean; next: [S, number][]; transitions: number };
const level = <S>(model: Model<S>, seen: Seen, frontier: readonly [S, number][], maxStates: number): Level<S> => {
  const next: [S, number][] = [];
  let transitions = 0;
  for (const [s, i] of frontier) {
    for (const [l, t] of model.actions(s)) {
      transitions++;
      const k = JSON.stringify(t);
      if (seen.index.has(k)) continue;
      const j = add(seen, k, i, l);
      const violation = judge(model, seen, t, j);
      if (violation) return { violation, truncated: false, next, transitions };
      if (seen.index.size >= maxStates) return { violation: null, truncated: true, next, transitions };
      next.push([t, j]);
    }
  }
  return { violation: null, truncated: false, next, transitions };
};
export function explore<S>(model: Model<S>): Explored<S> {
  const seen: Seen = { index: new Map(), parent: [], label: [] },
    maxStates = model.maxStates ?? 2_000_000;
  let frontier: [S, number][] = [[model.init, add(seen, JSON.stringify(model.init), -1, '')]],
    transitions = 0,
    depth = 0;
  const first = judge(model, seen, model.init, 0);
  if (first) return { states: 1, transitions, depth, violation: first, truncated: false };
  while (frontier.length > 0) {
    const l = level(model, seen, frontier, maxStates);
    transitions += l.transitions;
    if (l.violation || l.truncated)
      return { states: seen.index.size, transitions, depth: depth + 1, violation: l.violation, truncated: l.truncated };
    frontier = l.next;
    depth++;
  }
  return { states: seen.index.size, transitions, depth, violation: null, truncated: false };
}
