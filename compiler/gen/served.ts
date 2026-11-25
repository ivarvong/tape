// compiler/gen/served.ts: an exported function is served through three generated functions: decode the message,
// run, encode the reply. The reply starts with one byte: 0 for Ok and the reply as JSON, 1 for Err and the error as
// JSON (the value of the method's own error type, which the caller decodes as the reason of Rejected), 2 for a
// message that does not decode and why (the two sides disagree: the host answers skew, never rejected).
import type { FnDecl, Param, Program, TypeAst } from '../ast.ts';
import { CompileError } from '../common.ts';
import { parse } from '../parse.ts';
import { isStd } from '../shadow.ts';
import { CAPABILITIES, key } from '../types.ts';

/** An exported function as the host reaches it: the name it was written with, its message, its reply and its error. */
export type Served = FnDecl & { message: TypeAst; reply: TypeAst; error: TypeAst; caps: Param[]; method: string };

const c42 = (f: FnDecl, message: string, hint: string): never => {
  throw new CompileError({ code: 'C42', file: f.file, line: f.line, message, hint });
};

/** `ChargeError` for a method `charge`: the name a fix suggests for its error type. */
const errorName = (method: string): string =>
  `${method
    .split('_')
    .map(w => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join('')}Error`;

/**
 * Whether a type can be a method's error: one the program declares (not std's, not a refinement, no type
 * parameters), with constructors. A caller matches on them, so they are what the method can refuse for.
 */
export function isErrorType(prog: Program, t: { name: string; args: readonly unknown[] }): boolean {
  const d = t.args.length === 0 ? prog.types.get(t.name) : undefined;
  return !!d && !isStd(d.file) && !d.refine && d.params.length === 0 && d.variants.length > 0;
}

/** C98: an error type that is not one the program declares, with the fix that declares one. */
export function refuseErrorType(at: { file: string; line: number }, type: string, what: string, method: string): never {
  const e = errorName(method);
  throw new CompileError({
    code: 'C98',
    file: at.file,
    line: at.line,
    message: `${what} is ${type}; it is a type of the program's own whose constructors are the reasons it refuses`,
    hint: `Declare what it refuses for, \`type ${e} { OutOfStock(left: Int)  NoSuchItem }\`, and give it: \`Err(error: OutOfStock(left: 2))\`. A caller names it, \`error: ${e}\`, and matches \`Err(error: Rejected(reason: OutOfStock(left)))\`, a match that names each constructor. A View says nothing a caller can match on, and a caller's match on its text breaks when the text changes.`,
  });
}

/** The exported function with what it serves read from its signature: capabilities, then exactly one message. */
function served(prog: Program, f: FnDecl): { fn: Served; param: Param } {
  const caps = f.params.filter(pm => CAPABILITIES.includes(pm.typeAst.name));
  const rest = f.params.filter(pm => !caps.includes(pm));
  const ret = f.retAst;
  const [message, error] = ret.args;
  const param = rest.length === 1 ? rest[0] : undefined;
  if (!param)
    return c42(
      f,
      `exported function ${f.name} takes capabilities and exactly one message`,
      'For example `export fn reserve(db: Sql, message: Reserve) -> Result[Reserved, ReserveError]`.',
    );
  if (ret.name !== 'Result' || ret.args.length !== 2 || !message || !error)
    return c42(
      f,
      `exported function ${f.name} must return Result[Reply, Error]`,
      "Ok carries the reply record; Err a value of the method's own error type, which the caller receives as Rejected(reason).",
    );
  // the method's name is the one it was written with; a name std also defines (put, get, …) is qualified
  // inside the build (program.put), and the generated functions call it by that name
  const method = f.name.slice(f.name.lastIndexOf('.') + 1);
  // woken is run by the host's timers, never by a program: its error is the host's to log, and may be text
  const woken = method === 'woken' && key(error) === 'View';
  if (!woken && !isErrorType(prog, error))
    refuseErrorType(
      { file: f.file, line: error.line || f.line },
      key(error),
      `the error of exported function ${f.name}`,
      method,
    );
  return {
    fn: Object.assign(f, { message: param.typeAst, reply: message, error, caps, method }),
    param,
  };
}

function source(f: Served, m: Param): string {
  const mn = f.method;
  const sig = f.caps.map(pm => `, ${pm.name}: ${key(pm.typeAst)}`).join('');
  const pass = f.caps.map(pm => `${pm.name}, `).join('');
  const refusal =
    key(f.error) === 'View'
      ? 'append(buf: push(buf: buf(), byte: 49), view: wire_err)'
      : 'write_json(out: push(buf: buf(), byte: 49), value: wire_err)';
  return `fn serve_${mn}(wire_bytes: View${sig}) -> Buf {
  serve_${mn}_run(${pass}wire_message: decode(json: wire_bytes, as: ${key(m.typeAst)}))
}
fn serve_${mn}_run(wire_message: Result[${key(m.typeAst)}, View]${sig}) -> Buf {
  match wire_message {
    Ok(value: wire_ok) -> serve_${mn}_reply(wire_reply: ${f.name}(${pass}${m.name}: wire_ok))
    Err(error: wire_err) -> append(buf: push(buf: buf(), byte: 50), view: wire_err)
  }
}
fn serve_${mn}_reply(wire_reply: Result[${key(f.reply)}, ${key(f.error)}]) -> Buf {
  match wire_reply {
    Ok(value: wire_ok) -> write_json(out: push(buf: buf(), byte: 48), value: wire_ok)
    Err(error: wire_err) -> ${refusal}
  }
}
`;
}

/** Adds the three functions of every exported function to the program; gives the exported functions back. */
export function serve(prog: Program): Served[] {
  return [...prog.fns.values()]
    .filter(f => f.exported)
    .map(f => {
      const { fn, param } = served(prog, f);
      parse(`serve ${fn.method}`, source(fn, param), prog);
      return fn;
    });
}
