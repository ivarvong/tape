// compiler/gen/text.ts: text with holes, "Hello, \(name) #\(n)". The holes are evaluated in the order written, then
// one Buf takes the text between them and each value: a View is copied in, an Int is written in decimal by
// std/text.tape's write_int. It is the code of `buf |> append(…) |> write_int(…)`, and nothing more.
import type { Expr } from '../ast.ts';
import { fail } from '../common.ts';
import { VIEW, key } from '../types.ts';
import type { Type } from '../types.ts';
import { inLocals } from './fn.ts';
import type { Ctx } from './fn.ts';

type Interp = Extract<Expr, { k: 'interp' }>;

/** The calls that write the parts of `e` into the Buf `into` gives. */
export function written(c: Ctx, e: Interp, into: Expr): Expr {
  const at = { line: e.line, file: e.file };
  const call = (name: string, first: string, out: Expr, label: string, value: Expr): Expr => ({
    k: 'call',
    name,
    args: [
      { label: first, value: out, ...at },
      { label, value, ...at },
    ],
    ...at,
  });
  let out = into;
  for (const part of e.parts) {
    if (part.k === 'str') {
      out = call('append', 'buf', out, 'view', part);
      continue;
    }
    const held = inLocals(c, part, null);
    const t = c.B.strip(held.type);
    const value: Expr = { k: 'held', held, line: part.line, file: part.file };
    if (t.name === 'View') out = call('append', 'buf', out, 'view', value);
    else if (t.name !== 'Int')
      fail(
        part,
        'C19',
        `a ${key(t)} value cannot stand in a text literal`,
        'A hole takes text (View) or a number (Int). Turn anything else into text first, or write it into a Buf.',
      );
    else if (!c.B.fns.has('write_int'))
      fail(
        part,
        'C30',
        'the program has no function write_int',
        'A number in a text literal needs std/text.tape: compile it together with your file.',
      );
    else out = call('write_int', 'out', out, 'value', value);
  }
  return out;
}

/** The literal as a value: a new Buf, written and frozen. */
export function emitInterp(c: Ctx, e: Interp): Type {
  const at = { line: e.line, file: e.file };
  const filled = written(c, e, { k: 'call', name: 'buf', args: [], ...at });
  return c.emit({ k: 'call', name: 'freeze', args: [{ label: 'buf', value: filled, ...at }], ...at }, VIEW, false);
}
