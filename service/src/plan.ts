// plan.ts: what a name's data runs, decided from its live versions and their migration chains.
import type { Chain, Plan } from './records.ts';

export type Chains = ReadonlyMap<number, Chain>;

// The plan for a name's data: the live versions (uploaded, not retired), and the latest one's migrations to apply,
// up to the first contract migration some other live version predates: that one is held until they are retired.
/** `latest` is 0 when no version is live. */
export const planOf = (live: readonly number[], chains: Chains): Omit<Plan, 'machines'> => {
  const latest = live.at(-1) ?? 0,
    chain = chains.get(latest) ?? [];
  const behind = (at: number): number[] => live.filter(v => v !== latest && (chains.get(v) ?? []).length <= at);
  const i = chain.findIndex((m, at) => m.contract && behind(at).length > 0),
    held = chain[i];
  if (!held) return { latest, live: [...live], apply: chain, held: null };
  const waiting = behind(i);
  return {
    latest,
    live: [...live],
    apply: chain.slice(0, i),
    held: `migration ${held.n} "${held.name}" is a contract and waits until v${waiting.join(', v')} ${waiting.length > 1 ? 'are' : 'is'} retired (DELETE /:account/:name/v/:version)`,
  };
};
// Where a chain stops being a prefix of another, or null.
export const diverged = (old: Chain, next: Chain, v: number): string | null => {
  const i = old.findIndex((m, at) => next[at]?.hash !== m.hash),
    was = old[i],
    now = next[i];
  if (!was) return null;
  return now
    ? `migration ${was.n} "${was.name}" was changed after v${v} shipped it (hash ${was.hash.slice(0, 12)}, now ${now.hash.slice(0, 12)}); applied migrations are append-only: add migration ${old.length + 1} instead`
    : `migration ${was.n} "${was.name}" is missing; a later version must keep every migration an earlier one shipped`;
};

const ROLLBACK = Symbol('rollback');
// workerd wants every ?N bound, even for EXPLAIN, which runs nothing
const nulls = (q: string): null[] =>
  Array.from<null>({ length: Math.max(0, ...[...q.matchAll(/\?(\d+)/g)].map(m => Number(m[1]))) }).fill(null);
const failure = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Every statement of the schema runs and every query prepares (EXPLAIN) against it, then all of it is rolled back.
export const sqlProblems = (
  storage: DurableObjectStorage,
  schema: readonly string[],
  queries: readonly string[],
): string[] => {
  const problems: string[] = [];
  const attempt = (run: () => unknown, said: (why: string) => string): void => {
    try {
      run();
    } catch (e) {
      problems.push(said(failure(e)));
    }
  };
  try {
    storage.transactionSync(() => {
      for (const s of schema)
        attempt(
          () => storage.sql.exec(s).toArray(),
          why => `schema: ${why}: ${s}`,
        );
      for (const q of queries)
        attempt(
          () => storage.sql.exec(`EXPLAIN ${q}`, ...nulls(q)).toArray(),
          why => `${why}: ${q}`,
        );
      // oxlint-disable-next-line typescript/only-throw-error -- a marker, not a failure: it undoes the transaction
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return problems;
};
