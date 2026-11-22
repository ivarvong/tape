// cli.ts: what the runner scripts share. Their flags, the operator's token (read from a file, sent only in the
// authorization header, never printed), the rule that only jepsen- accounts take faults, and the example programs.
import { readFileSync } from 'node:fs';
import type { Sources } from './harness.ts';

const args = process.argv.slice(2);
export const has = (name: string): boolean => args.includes(`--${name}`);
/** The value after --name, if the flag was given. */
export const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
};
export const need = (name: string): string => {
  const value = flag(name);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
};
export const tokenFromFile = (): string => readFileSync(need('token-file'), 'utf8').trim();
/** An account, or a prefix of accounts, that may take faults. */
export const faultable = (account: string, what = 'prefix'): string => {
  if (!account.startsWith('jepsen-'))
    throw new Error(`the ${what} must start with jepsen-: only those accounts take faults`);
  return account;
};
/** Flags that used to change a run's config: every seed now runs the one config. */
export const refuse = (names: readonly string[], config: string): void => {
  for (const name of names) if (has(name)) throw new Error(`--${name} is gone: every seed runs ${config}`);
};
const example = (name: string): string => readFileSync(`${import.meta.dirname}/../../examples/${name}.tape`, 'utf8');
export const sources = (): Sources => ({
  tickets: example('tickets'),
  payments: example('payments'),
  inventory: example('inventory'),
  shipping: example('shipping'),
  fulfillment: example('fulfillment'),
});
/** How many of each there are. */
export const counted = (all: readonly string[]): Record<string, number> =>
  Object.fromEntries([...Map.groupBy(all, x => x)].map(([k, v]) => [k, v.length]));
