// compiler/parse.ts: tokens to a program: its types, functions, schema, machines, invariants and flags.
// parse(file, text, prog) reads one file's declarations into prog. The productions are in compiler/parse/:
// expr.ts (expressions, patterns, blocks) and decl.ts (declarations), each a function from the cursor (cursor.ts).
import type { Program, Token } from './ast.ts';
import { fail } from './common.ts';
import { Cursor, shown, textOf } from './parse/cursor.ts';
import { flag, fnDecl, interfaceDecl, invariant, machine, migration, typeDecl } from './parse/decl.ts';

// one declaration, whose first token has been read. `private`, `invariant`, `machine` and `interface` are names
// with a meaning here and nowhere else: they are not keywords.
function declaration(c: Cursor, prog: Program, t: Token): void {
  const word = t.t === 'kw' || t.t === 'id' ? t.v : null,
    kw = t.t === 'kw';
  if (kw && word === 'schema') prog.schema.push(textOf(c.expect('str').v));
  else if (kw && word === 'migration') migration(c, prog);
  else if (kw && word === 'flag') flag(c, prog);
  else if (kw && word === 'type') typeDecl(c, prog, false);
  // `private type`: its constructors build values only in this file (C66)
  else if (!kw && word === 'private' && c.eat('kw', 'type')) typeDecl(c, prog, true);
  else if (kw && (word === 'fn' || word === 'export')) fnDecl(c, prog, word === 'export');
  else if (!kw && word === 'invariant' && c.is('str')) invariant(c, prog, t);
  else if (!kw && word === 'machine') machine(c, prog);
  else if (!kw && word === 'interface') interfaceDecl(c, prog);
  else
    fail(
      t,
      'P05',
      `expected \`fn\`, \`type\`, \`interface\` or \`schema\` but found ${shown(t)}`,
      'A file is declarations: `fn`, `export fn`, `type`, `interface`, `migration`, `schema`, `flag`, `machine`, `invariant`. A statement goes inside a function.',
    );
}
export function parse(file: string, text: string, prog: Program): void {
  const c = new Cursor(file, text);
  c.skipNl();
  while (!c.is('eof')) {
    declaration(c, prog, c.next());
    c.skipNl();
  }
}
