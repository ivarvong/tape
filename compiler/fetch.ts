// compiler/fetch.ts: C100, a fetch that changes something carries a key.
//
// std/http.tape's fetch sends its key as Idempotency-Key. A request whose reply did not come (Timeout) may have been
// received, so the way on is to send it again, which is safe only when the other side can tell the second for the
// first: C54 and C55's reasoning for a program's own writes, for a write on another service. GET and HEAD are reads
// and need none. So a fetch whose method is not written `Get` or `Head` writes its key as `Some(…)`: `key: None`,
// or a key that is a value (which may be None), is refused here. The host refuses a method other than GET or HEAD
// with no key at run time too, for a method that is a value.
import { type Call, type Expr, type Program, eachExpr } from './ast.ts';
import type { Problem } from './common.ts';

/** Is this call std/http.tape's fetch (not a function of the program's own of that name)? */
function isStdFetch(prog: Program, e: Call): boolean {
  const bare = e.name.startsWith('http.') ? e.name.slice(5) : e.name;
  if (bare !== 'fetch') return false;
  const defs = prog.defs.get('fetch') ?? [];
  return defs.some(d => d.file === 'std/http.tape') && (bare !== e.name || defs.length === 1);
}
const argOf = (e: Call, name: string): Expr | undefined => e.args.find(a => a.label === name)?.value;

export function fetchKeys(prog: Program): Problem[] {
  const found: Problem[] = [];
  for (const f of prog.fns.values()) {
    if (f.file.startsWith('std/')) continue;
    eachExpr(f.body, e => {
      if (e.k !== 'call' || !isStdFetch(prog, e)) return;
      const method = argOf(e, 'method'),
        key = argOf(e, 'key');
      if (method?.k === 'ctor' && (method.name === 'Get' || method.name === 'Head')) return;
      if (key?.k === 'ctor' && key.name === 'Some') return;
      const named = method?.k === 'ctor' && ['Post', 'Put', 'Patch', 'Delete', 'Options'].includes(method.name);
      const what = named ? `${method.name.toUpperCase()} request` : 'request whose method is not written Get or Head';
      found.push({
        file: f.file,
        line: e.line,
        code: 'C100',
        message: `this ${what} carries no \`key: Some(…)\`: sent again after a Timeout, the other side cannot tell it for a repeat`,
        hint: 'Every method but GET and HEAD writes `key: Some(value: …)`, a key that names this request (an order id, a key the client sent): the host sends it as Idempotency-Key, so the request can be sent again after a Timeout. A read is `method: Get`.',
      });
    });
  }
  return found;
}
