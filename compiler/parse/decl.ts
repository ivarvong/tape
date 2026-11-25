// compiler/parse/decl.ts: what a file declares at its top level, each read into the program.
import type { Method, Program, Token, TokenOf, TypeDecl, Variant } from '../ast.ts';
import { fail, stemOf } from '../common.ts';
import { SHADOWABLE, claim, clashHint, isStd } from '../shadow.ts';
import { storedText } from '../fieldless.ts';
import { splitSql } from '../sqltext.ts';
import { BUILTIN_TYPES, INTRINSICS } from '../types.ts';
import { type Cursor, textOf } from './cursor.ts';
import { binary, block, fields, params, type } from './expr.ts';

// `[A, B]`: the type parameters of a type or a function
const typeParams = (c: Cursor): string[] => {
  const names = c.eat('op', '[') ? c.list(x => x.expect('Id').v) : [];
  if (names.length > 0) c.expect('op', ']');
  return names;
};

export function migration(c: Cursor, prog: Program): void {
  const n = c.expect('int'),
    name = textOf(c.expect('str').v),
    contract = !!c.eat('id', 'contract'),
    body = c.expect('sql'),
    next = prog.migrations.length + 1;
  if (Number(n.v) !== next)
    fail(
      n,
      'C47',
      `migration ${n.v} is out of order: the next one is ${next}`,
      'Migrations are numbered 1, 2, 3, … in the order they are written, and never renumbered.',
    );
  // Whether a migration removes something is decided where it runs, by what it does to the tables (host.ts
  // migrate, and the service's upload check against the data itself), not here by how its statements begin.
  prog.migrations.push({ n: Number(n.v), name, contract, statements: splitSql(body.v), ...c.at(n) });
}
export function flag(c: Cursor, prog: Program): void {
  const HOW = 'A flag is `flag name: Bool = False` or `flag name: Int = 200`.';
  const n = c.expect('id');
  c.expect('op', ':', HOW);
  const ty = c.expect('Id');
  c.expect('op', '=', 'Every flag has a default, used until the host sets a value.');
  const neg = !!c.eat('op', '-'),
    d = c.next(),
    wants = ty.v === 'Bool' ? 'True or False' : ty.v === 'Int' ? 'a number' : 'the type Bool or Int';
  const value =
    ty.v === 'Int' && d.t === 'int'
      ? neg
        ? -d.v
        : d.v
      : ty.v === 'Bool' && d.t === 'Id' && (d.v === 'True' || d.v === 'False') && !neg
        ? d.v === 'True'
        : fail(d, 'C37', `flag ${n.v} needs ${wants} as its default`, HOW);
  if (prog.flags.some(x => x.name === n.v))
    fail(
      n,
      'C37',
      `flag ${n.v} is already declared`,
      'Declare each flag once: remove one of the two, or give it another name.',
    );
  prog.flags.push({ name: n.v, type: ty.v, default: value, ...c.at(n) });
}

// ---- types
const claimType = (c: Cursor, prog: Program, n: TokenOf<'Id'>): string =>
  claim(prog, 'types', n.v, c.file) ??
  fail(n, 'C01', `type ${n.v} is already defined`, clashHint('type', n.v, prog.types.get(n.v)?.file));
// `Ctor(field: Type, …)`, and `final` after it: an outcome asking again does not change (C79, checked by C80).
// `final` is not a keyword.
function variant(c: Cursor): Variant {
  const name = c.expect('Id'),
    fs = fields(c),
    final = c.eat('id', 'final') ? { final: true as const } : {};
  c.eat('op', ',');
  c.skipNl();
  return { name: name.v, fields: fs, ...c.at(name), ...final };
}
// each constructor of a type is claimed under its name, or the name it goes by when std has one of that name
function claimConstructors(c: Cursor, prog: Program, decl: TypeDecl): void {
  decl.variants.forEach((v, vi) => {
    const bool = v.name === 'True' || v.name === 'False';
    const known =
      (bool ? null : claim(prog, 'ctors', v.name, c.file)) ??
      fail(
        v,
        'C03',
        `constructor ${v.name} is already defined`,
        bool ? "True and False are Bool's." : clashHint('constructor', v.name, prog.ctors.get(v.name)?.decl.file),
      );
    v.name = known;
    prog.ctors.set(known, { decl, vi });
  });
}
/**
 * `type Name[A] { Ctor(…) … }`, or a refined type: `type Name = Base where condition`, with `else "message"` for
 * what decode's 400 says when the condition does not hold. `isPrivate`: `private type`.
 */
export function typeDecl(c: Cursor, prog: Program, isPrivate: boolean): void {
  const n = c.expect('Id'),
    tparams = typeParams(c);
  if (BUILTIN_TYPES.has(n.v)) fail(n, 'C01', `type ${n.v} is already defined`, `${n.v} is built in.`);
  if (c.eat('op', '=')) {
    // the base type's values for which the condition holds
    const base = type(c);
    c.expect('id', 'where', 'A refined type is `type Name = Base where condition`, with `self` as the value.');
    const name = claimType(c, prog, n),
      pred = binary(c, 1);
    // `else "lowercase letters, digits and -"`: one text, with no holes, said as it is
    const said = c.eat('kw', 'else')
      ? c.expect(
          'str',
          undefined,
          'A refined type\'s message is one text with no holes: `type Slug = View where … else "lowercase letters, digits and -"`.',
        )
      : null;
    const message = said ? new TextDecoder().decode(Uint8Array.from(said.v)) : undefined;
    prog.types.set(name, {
      name,
      params: [],
      variants: [],
      refine: { base, pred, ...(message === undefined ? {} : { message }) },
      ...c.at(n),
    });
    return;
  }
  c.expect('op', '{');
  c.skipNl();
  const variants: Variant[] = [];
  while (!c.is('op', '}')) variants.push(variant(c));
  c.next();
  const name = claimType(c, prog, n);
  if (variants.length === 0)
    fail(
      n,
      'C02',
      `type ${n.v} has no constructors`,
      'A type has at least one constructor: `type ' +
        n.v +
        ' { ' +
        n.v +
        '(field: Int) }`, or `{ A  B }` for one without fields.',
    );
  const decl: TypeDecl = { name, params: tparams, variants, ...c.at(n), private: isPrivate };
  prog.types.set(name, decl);
  claimConstructors(c, prog, decl);
}

// ---- functions
/** `fn name[A](x: T, …) -> R uses a, b { … }`; `exported`: written after `export`; `isPrivate`: after `private`.
 * `uses` is a word only there: the capabilities the function reaches by name (compiler/ambient.ts clauses). */
export function fnDecl(c: Cursor, prog: Program, exported: boolean, isPrivate = false): void {
  if (exported) c.expect('kw', 'fn', '`export` goes before `fn`.');
  const n = c.expect('id'),
    tparams = typeParams(c),
    ps = params(c);
  c.expect('op', '->', 'Every function states its result type: `-> Type`.');
  const retAst = type(c),
    uses = c.eat('id', 'uses') ? c.list(x => x.expect('id').v) : null,
    body = block(c),
    mine = prog.byFile.get(c.file) ?? new Map<string, string>(),
    // a name another file has already taken is known as `file.name`
    unique = prog.fns.has(n.v) ? `${stemOf(c.file)}.${n.v}` : n.v,
    builtIn = INTRINSICS.has(n.v),
    mayShadow = SHADOWABLE.has(n.v);
  prog.byFile.set(c.file, mine);
  if (mine.has(n.v) || prog.fns.has(unique) || (builtIn && (isStd(c.file) || !mayShadow)))
    fail(
      n,
      'C04',
      `function ${n.v} is already defined`,
      builtIn
        ? `${n.v} is built in${mayShadow ? '' : ', and the rules read what each call of it does, so a program cannot redefine it'}: choose another name.`
        : 'A file defines each name once. Another file may reuse it.',
    );
  mine.set(n.v, unique);
  prog.defs.set(n.v, [...(prog.defs.get(n.v) ?? []), { key: unique, file: c.file }]);
  prog.fns.set(unique, {
    name: unique,
    params: ps,
    retAst,
    body,
    ...c.at(n),
    exported,
    tparams,
    ...(isPrivate ? { private: true } : {}),
    ...(uses ? { uses } : {}),
  });
}

// ---- invariants, machines, interfaces
/**
 * `invariant "name" { SELECT … }`: the rows it returns are what is wrong, so it must return none: after every
 * commit, or with `settled` once nothing is in flight and no timer is set. Checked against the schema like any
 * query; the module lists them, and the simulator (sim.ts) and host.ts's invariants() run them.
 */
export function invariant(c: Cursor, prog: Program, t: Token): void {
  const name = textOf(c.expect('str').v),
    settled = !!c.eat('id', 'settled'),
    // `with pay`: the SELECT also reads another program's tables, as pay.ledger. Only the simulator, which has
    // both programs' rows, can run it; a program alone cannot see the other's data.
    others = c.eat('kw', 'with') ? c.list(x => x.expect('id').v) : [],
    sql = c.expect('sql').v.replaceAll(/\s+/g, ' ').trim();
  (prog.invariants ??= []).push({ name, settled, with: others, sql, ...c.at(t) });
}
/**
 * `machine table.column: State { Pending -> Paid … }`: the states a row's column may take, the constructors of the
 * fieldless sum `State`, and the moves between them. The column holds each state as its constructor's text
 * (compiler/fieldless.ts: `Pending` is 'pending'), and so do the machine's `states`, `start` and moves, which the
 * rules read against the SQL (C57-C61) and the host makes SQLite triggers of (host.ts, machineTriggers). The first
 * state named is where every row starts.
 */
export function machine(c: Cursor, prog: Program): void {
  const HOW =
    'A machine is `machine table.column: State { From -> To }`, where `type State { From To }` names every state.';
  const table = c.expect('id', undefined, HOW);
  c.expect('op', '.', HOW);
  const column = c.expect('id', undefined, HOW);
  if (c.is('op', '{'))
    fail(
      c.peek(),
      'P01',
      `machine ${table.v}.${column.v} names no type for its states`,
      `Name the type whose constructors are its states, and write each move with them: \`type ${pascal(column.v)} { Pending Paid }\` and \`machine ${table.v}.${column.v}: ${pascal(column.v)} { Pending -> Paid }\`. The column holds each state as its constructor's name in snake_case ('pending', 'paid'), so the SQL keeps its texts.`,
    );
  c.expect('op', ':', HOW);
  const named = c.expect('Id', undefined, HOW),
    moves: { from: string; to: string; line: number }[] = [],
    ctors: string[] = [],
    state = (): string => {
      const ctor = c.expect('Id', undefined, "A state is a constructor of the machine's type: `Pending -> Paid`.").v;
      if (!ctors.includes(ctor)) ctors.push(ctor);
      return storedText(ctor);
    };
  c.expect('op', '{');
  c.skipNl();
  while (!c.is('op', '}')) {
    const line = c.peek().line,
      from = state();
    c.expect('op', '->', 'Each line is one move: `From -> To`.');
    moves.push({ from, to: state(), line });
    c.skipNl();
  }
  c.next();
  const states = ctors.map(storedText);
  prog.machines.push({
    table: table.v,
    column: column.v,
    type: named.v,
    ctors,
    start: states[0] ?? null,
    states,
    moves,
    ...c.at(table),
  });
}
const pascal = (s: string): string => s.replaceAll(/(?:^|_)([a-z])/g, (_, x: string) => x.toUpperCase());
// one method of an interface: `read head(Ref) -> Head`
function method(c: Cursor): [string, Method, Token] {
  const kind = c.expect('id');
  if (kind.v !== 'read' && kind.v !== 'write')
    return fail(
      kind,
      'P06',
      `expected \`read\` or \`write\` but found ${kind.v}`,
      'Each method says whether it only reads (safe to repeat) or writes (carries a key): `read head(Ref) -> Head`.',
    );
  const name = c.expect('id');
  c.expect('op', '(');
  const send = type(c);
  c.expect('op', ')');
  c.expect('op', '->');
  return [name.v, { kind: kind.v, send, reply: type(c) }, name];
}
export function interfaceDecl(c: Cursor, prog: Program): void {
  const n = c.expect('Id'),
    methods = new Map<string, Method>();
  c.expect('op', '{');
  c.skipNl();
  while (!c.is('op', '}')) {
    const [name, m, at] = method(c);
    if (methods.has(name))
      fail(
        at,
        'C04',
        `method ${name} is already defined`,
        'An interface lists each method once: remove one of them, or give it another name.',
      );
    methods.set(name, m);
    c.skipNl();
  }
  c.next();
  if (prog.interfaces.has(n.v) || prog.types.has(n.v) || BUILTIN_TYPES.has(n.v))
    fail(
      n,
      'C01',
      `${n.v} is already defined`,
      `${n.v} is a type, an interface or a built-in type already: give this interface another name.`,
    );
  prog.interfaces.set(n.v, { name: n.v, methods, ...c.at(n) });
}
