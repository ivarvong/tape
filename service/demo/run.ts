// The walkthrough against a running service, printed:
//   node service/demo/run.ts --base http://localhost:8787 --token-file <path> [--account demo-1]
// It uploads programs and places orders in three accounts (<account>, <account>-wf, <account>-agents), so give it
// an account name nothing else uses. The token is read from the file and sent only in the authorization header.
import { readFileSync } from 'node:fs';
import { demo } from './demo.ts';

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const base = flag('base'),
  tokenFile = flag('token-file');
if (base === undefined || tokenFile === undefined) {
  console.error('usage: node service/demo/run.ts --base <url> --token-file <path> [--account <name>]');
  process.exit(2);
}
const src = (name: string): string => readFileSync(`${import.meta.dirname}/../../examples/${name}.tape`, 'utf8');
const sources = {
  hello: src('hello'),
  payments: src('payments'),
  inventory: src('inventory'),
  shipping: src('shipping'),
  fulfillment: src('fulfillment'),
  price: src('tools/price'),
  notes: src('tools/notes'),
  fx: src('tools/fx'),
};
console.log(
  await demo({
    fetch,
    base: base.replace(/\/$/, ''),
    token: readFileSync(tokenFile, 'utf8').trim(),
    sources,
    account: flag('account') ?? 'demo',
  }),
);
