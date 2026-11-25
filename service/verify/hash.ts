// node service/verify/hash.ts <program.tape>
// Prints what POST /:account/:name should report for this source when the service runs this checkout's compiler:
// the sha256 and size of the Wasm, and each migration's chain hash (first 12 hex digits, as the service prints them).
// Run it from a checkout of the deployed commit; later commits change the compiler.
import { compile } from '../../compiler.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [program] = process.argv.slice(2);
if (program === undefined) throw new Error('usage: hash.ts <program.tape>');
const root = `${import.meta.dirname}/../..`;
const std = ['core', 'text', 'json', 'http', 'list', 'map', 'retry', 'time', 'math', 'crypto'].map(n => ({
  name: `std/${n}.tape`,
  text: readFileSync(`${root}/std/${n}.tape`, 'utf8'),
}));
const r = compile([...std, { name: 'program.tape', text: readFileSync(program, 'utf8') }]);
if (r.wasm === null) {
  console.log(JSON.stringify(r.errors));
  process.exit(1);
}
console.log(
  JSON.stringify({
    hash: createHash('sha256').update(r.wasm).digest('hex'),
    bytes: r.wasm.length,
    migrations: r.migrations.map(m => [m.n, m.name, m.hash.slice(0, 12)]),
  }),
);
