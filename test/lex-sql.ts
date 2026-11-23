// compiler/lex.ts opensSql (is this `{` a migration's or an invariant's SQL?) reads only the last tokens; the search
// over every token it replaced (kept here as written before 2026-11-23) is the oracle. 200,000 random token runs
// built from the tokens that matter (migration, invariant, a string, new lines, names, operators) give the same
// answer, and every program in examples/ and std/ lexes to the same tokens under both.
import { readdirSync, readFileSync } from 'node:fs';
import { lex, opensSql } from '../compiler/lex.ts';
import type { Token } from '../compiler/ast.ts';
import { finish, same } from './harness.ts';

/** opensSql before 2026-11-23, unchanged. */
function before(toks: readonly Token[]): boolean {
  const invariant = toks.findLastIndex(
    (t, k) => t.t === 'id' && t.v === 'invariant' && toks[k + 1]?.t === 'str' && (k === 0 || toks[k - 1]?.t === 'nl'),
  );
  const sameLine = invariant >= 0 && invariant >= toks.length - 9 && !toks.slice(invariant).some(t => t.t === 'nl');
  const opener = Math.max(
    toks.findLastIndex(t => t.t === 'kw' && t.v === 'migration'),
    sameLine ? toks.length - 1 : -1,
  );
  return opener >= 0 && opener >= toks.length - 4;
}

const at = { line: 1, file: 'x.tape' };
const KINDS: Token[] = [
  { t: 'kw', v: 'migration', ...at },
  { t: 'kw', v: 'fn', ...at },
  { t: 'id', v: 'invariant', ...at },
  { t: 'id', v: 'x', ...at },
  { t: 'str', v: [97], ...at },
  { t: 'nl', ...at },
  { t: 'op', v: '(', ...at },
  { t: 'int', v: 1n, ...at },
];
const kind = (i: number): Token => {
  const t = KINDS[i];
  if (!t) throw new RangeError(`no token kind ${i}`);
  return t;
};
const shown = (t: Token): string => (t.t === 'id' || t.t === 'kw' || t.t === 'op' ? t.v : t.t);
// mulberry32
let seed = 7;
const rnd = (n: number): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
// the edges by hand: `invariant "x"` 9 and 10 tokens back, a new line after it or not; `migration` 4 and 5 back
const [mig, inv, name, str, nl] = [kind(0), kind(2), kind(3), kind(4), kind(5)];
const pad = (n: number): Token[] => Array.from({ length: n }, () => name);
const edges: [string, Token[]][] = [
  ['invariant 9 back', [inv, str, ...pad(7)]],
  ['invariant 10 back', [inv, str, ...pad(8)]],
  ['invariant 9 back after a new line', [nl, inv, str, ...pad(7)]],
  ['invariant 9 back, a new line after', [inv, str, ...pad(3), nl, ...pad(3)]],
  ['invariant not at a line start', [name, inv, str, ...pad(2)]],
  ['migration 4 back', [mig, ...pad(3)]],
  ['migration 5 back', [mig, ...pad(4)]],
  ['nothing', []],
];
same(
  'the edges: the same answers as the search over every token',
  edges.map(([what, t]) => [what, opensSql(t)]),
  edges.map(([what, t]) => [what, before(t)]),
);
const differ: string[] = [];
let yes = 0;
for (let i = 0; i < 200_000; i++) {
  const toks = Array.from({ length: rnd(16) }, () => kind(rnd(KINDS.length)));
  const a = before(toks),
    b = opensSql(toks);
  if (a) yes++;
  if (a !== b && differ.length < 5) differ.push(toks.map(shown).join(' '));
}
same('random token runs: the same answer as the search over every token', differ, []);
same('and some of them open SQL (the runs reach both answers)', yes > 10_000, true);

// the lexer itself, with the old search put back by hand: the same tokens for every program here
const ROOT = new URL('../', import.meta.url).pathname;
const files = ['examples', 'std', 'apps/tickets', 'apps/trace'].flatMap(d =>
  readdirSync(ROOT + d)
    .filter(f => f.endsWith('.tape'))
    .map(f => `${d}/${f}`),
);
const sqlCount = (toks: readonly Token[]): number => toks.filter(t => t.t === 'sql').length;
let sqls = 0;
for (const f of files) {
  const toks = lex(f, readFileSync(ROOT + f, 'utf8'));
  sqls += sqlCount(toks);
  // each `{` the lexer met: the old answer at that point agrees with what the lexer did (a sql token or an op)
  const wrong = toks.flatMap((t, k) =>
    (t.t === 'sql' || (t.t === 'op' && t.v === '{')) && before(toks.slice(0, k)) !== (t.t === 'sql') ? [k] : [],
  );
  if (wrong.length > 0) same(`${f}: each { lexed as the old search says`, wrong.slice(0, 3), []);
}
same(`${files.length} programs: every { lexed as the old search says, some as SQL`, sqls > 0, true);
finish();
