// The compiler's hash (service/scripts/sha.ts compilerHash: the tape-compiler header, and what decides that the
// service rebuilds a stored version) covers everything the compiler's output depends on: each module compiler.ts
// reaches through its imports, found from the imports themselves, and std. On a copy of those files: a change in
// sql/, rules/, compiler/, compiler.ts or std/ changes the hash; a file outside them (the host, the service, a doc)
// does not, and neither does the copy being somewhere else.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { compilerFiles, compilerHash } from '../service/scripts/sha.ts';
import { finish, ok, same } from './harness.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const files = compilerFiles();
for (const dir of ['compiler/', 'sql/', 'rules/', 'std/'])
  ok(
    `the hash covers ${dir}`,
    files.some(f => f.startsWith(dir)),
  );
ok('it covers compiler.ts', files.includes('compiler.ts'));
ok('and not the host or the service', !files.some(f => f.startsWith('host/') || f.startsWith('service/')));

/** A copy of the hashed files (and one that is not), somewhere else. */
const copy = (): string => {
  const at = `${mkdtempSync(`${tmpdir()}/tape-hash-`)}/`;
  for (const f of [...files, 'host/run.ts', 'README.md']) cpSync(ROOT + f, at + f);
  return at;
};
const base = compilerHash();
same('a copy elsewhere hashes the same', compilerHash(copy()), base);
const edited = (file: string): string => {
  const at = copy();
  writeFileSync(at + file, `${readFileSync(at + file, 'utf8')}\n// changed\n`);
  return compilerHash(at);
};
const sqlFile = files.find(f => f.startsWith('sql/')) ?? 'sql/parse.ts';
const rulesFile = files.find(f => f.startsWith('rules/')) ?? 'rules.ts';
for (const f of [sqlFile, rulesFile, 'compiler/wire.ts', 'compiler.ts', 'std/json.tape'])
  ok(`a change in ${f} changes the hash`, edited(f) !== base);
for (const f of ['host/run.ts', 'README.md']) same(`a change in ${f} does not`, edited(f), base);
finish();
