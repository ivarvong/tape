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
/**
 * At the end of a run, its accounts are deleted (DELETE /_accounts/:account, operator only): a run's programs keep
 * their timers and data after it, and jepsen-tix-c1's tickets fired about 17,000 alarms a day for days after its
 * run. The operator's token is read from --operator-token-file (default: --token-file). --keep leaves them, to look
 * at afterwards. One line per account; a failed delete is reported, never thrown, so it cannot hide a run's result.
 */
export async function removeAccounts(base: string, accounts: readonly string[]): Promise<void> {
  if (has('keep')) {
    console.log(JSON.stringify({ kept: accounts }));
    return;
  }
  const token = readFileSync(flag('operator-token-file') ?? need('token-file'), 'utf8').trim();
  for (const account of accounts) {
    try {
      const res = await fetch(`${base}/_accounts/${account}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: account }),
      });
      const body: unknown = await res.json().catch(() => null);
      const failed = typeof body === 'object' && body !== null && 'failed' in body ? body.failed : null;
      console.log(JSON.stringify({ deleted: account, status: res.status, failed }));
    } catch (e) {
      console.log(JSON.stringify({ deleted: account, error: e instanceof Error ? e.message : String(e) }));
    }
  }
}
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
