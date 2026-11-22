// compiler/sqltext.ts: a migration's SQL as statements, and the chain of hashes over a list of them.
// A migration's SQL as statements: split at semicolons outside quoted text.
import type { Migration } from './ast.ts';
import { utf8 } from './common.ts';
import { sha256 } from './sha256.ts';

export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '',
    q: string | null = null;
  for (const c of sql) {
    if (q) {
      if (c === q) q = null;
      cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === ';') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  return [...out, cur].map(x => x.trim()).filter(Boolean);
}
// Each migration's hash covers it and every one before it, so a stored chain is a prefix of a new one exactly when
// their hashes agree, migration by migration.
/** A migration with the hash of it and all before it. */
export type Link = Pick<Migration, 'n' | 'name' | 'contract' | 'statements'> & { hash: string };
export const chainOf = (list: readonly Pick<Migration, 'n' | 'name' | 'contract' | 'statements'>[]): Link[] =>
  list.reduce<Link[]>(
    (acc, m) => [
      ...acc,
      {
        n: m.n,
        name: m.name,
        contract: m.contract,
        statements: m.statements,
        hash: sha256(
          utf8([acc.at(-1)?.hash ?? '', m.n, m.name, m.contract ? 'contract' : 'expand', ...m.statements].join('\n')),
        ),
      },
    ],
    [],
  );

// ---- placeholders. A query names each value it takes, `WHERE id = :id AND state = :from`, and the call gives each
// by an argument of that name. The database is given the same statement with the names numbered in the order they
// first appear (?1, ?2, …), and everything that reads a statement after the call (the checker, the rules, the
// log) reads that form.

/** A statement's placeholders, in the order they first appear, and the statement with each numbered. `names` is
 * null for a statement that numbers its own (?1), the form before names. */
export type Numbered = { sql: string; names: string[] | null; mixed: boolean };
const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
/** Where the quoted text or comment that opens at `i` ends; `i` when none opens there. */
function skipped(q: string, i: number): number {
  const c = q[i];
  if (c === "'" || c === '"') {
    let j = i + 1;
    // a doubled quote inside is the quote itself
    while (j < q.length && (q[j] !== c || q[j + 1] === c)) j += q[j] === c ? 2 : 1;
    return j + 1;
  }
  if (c === '-' && q[i + 1] === '-') {
    const end = q.indexOf('\n', i);
    return end < 0 ? q.length : end;
  }
  if (c === '/' && q[i + 1] === '*') {
    const end = q.indexOf('*/', i + 2);
    return end < 0 ? q.length : end + 2;
  }
  return i;
}
export function numbered(q: string): Numbered {
  const names: string[] = [];
  let out = '',
    positional = false;
  for (let i = 0; i < q.length;) {
    const past = skipped(q, i);
    if (past > i) {
      out += q.slice(i, past);
      i = past;
      continue;
    }
    NAME.lastIndex = i + 1;
    const name = q[i] === ':' ? NAME.exec(q)?.[0] : undefined;
    if (name === undefined) {
      positional ||= q[i] === '?';
      out += q[i] ?? '';
      i++;
      continue;
    }
    if (!names.includes(name)) names.push(name);
    out += `?${names.indexOf(name) + 1}`;
    i += 1 + name.length;
  }
  if (names.length === 0) return { sql: q, names: positional ? null : [], mixed: false };
  return { sql: out, names, mixed: positional };
}
/** A message about a statement, with each number put back as the name the program gave it. */
export const inNames = (message: string, names: readonly string[] | null): string =>
  names === null
    ? message
    : message.replaceAll(/\?(\d+)/g, (all, n: string) => {
        const name = names[Number(n) - 1];
        return name === undefined ? all : `:${name}`;
      });
