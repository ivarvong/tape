// compiler/gen/served.ts: an exported function is served through three generated functions: decode the message,
// run, encode the reply. The reply starts with one byte: 0 for Ok, 1 for Err.
import type { FnDecl, Param, Program, TypeAst } from '../ast.ts';
import { CompileError } from '../common.ts';
import { parse } from '../parse.ts';
import { CAPABILITIES, key } from '../types.ts';

/** An exported function as the host reaches it: the name it was written with, its message and its reply. */
export type Served = FnDecl & { message: TypeAst; reply: TypeAst; caps: Param[]; method: string };

const c42 = (f: FnDecl, message: string, hint: string): never => {
  throw new CompileError({ code: 'C42', file: f.file, line: f.line, message, hint });
};

/** The exported function with what it serves read from its signature: capabilities, then exactly one message. */
function served(f: FnDecl): { fn: Served; param: Param } {
  const caps = f.params.filter(pm => CAPABILITIES.includes(pm.typeAst.name));
  const rest = f.params.filter(pm => !caps.includes(pm));
  const ret = f.retAst;
  const [message, error] = ret.args;
  const param = rest.length === 1 ? rest[0] : undefined;
  if (!param)
    return c42(
      f,
      `exported function ${f.name} takes capabilities and exactly one message`,
      'For example `export fn reserve(db: Sql, message: Reserve) -> Result[Reserved, View]`.',
    );
  if (ret.name !== 'Result' || ret.args.length !== 2 || !message || !error || key(error) !== 'View')
    return c42(
      f,
      `exported function ${f.name} must return Result[Reply, View]`,
      'Ok carries the reply record; Err carries the reason, which the caller receives as Rejected(reason).',
    );
  // the method's name is the one it was written with; a name std also defines (put, get, …) is qualified
  // inside the build (program.put), and the generated functions call it by that name
  const method = f.name.slice(f.name.lastIndexOf('.') + 1);
  return { fn: Object.assign(f, { message: param.typeAst, reply: message, caps, method }), param };
}

function source(f: Served, m: Param): string {
  const mn = f.method;
  const sig = f.caps.map(pm => `, ${pm.name}: ${key(pm.typeAst)}`).join('');
  const pass = f.caps.map(pm => `${pm.name}, `).join('');
  return `fn serve_${mn}(wire_bytes: View${sig}) -> Buf {
  serve_${mn}_run(${pass}wire_message: decode(json: wire_bytes, as: ${key(m.typeAst)}))
}
fn serve_${mn}_run(wire_message: Result[${key(m.typeAst)}, View]${sig}) -> Buf {
  match wire_message {
    Ok(value: wire_ok) -> serve_${mn}_reply(wire_reply: ${f.name}(${pass}${m.name}: wire_ok))
    Err(error: wire_err) -> append(buf: push(buf: buf(), byte: 49), view: wire_err)
  }
}
fn serve_${mn}_reply(wire_reply: Result[${key(f.reply)}, View]) -> Buf {
  match wire_reply {
    Ok(value: wire_ok) -> write_json(out: push(buf: buf(), byte: 48), value: wire_ok)
    Err(error: wire_err) -> append(buf: push(buf: buf(), byte: 49), view: wire_err)
  }
}
`;
}

/** Adds the three functions of every exported function to the program; gives the exported functions back. */
export function serve(prog: Program): Served[] {
  return [...prog.fns.values()]
    .filter(f => f.exported)
    .map(f => {
      const { fn, param } = served(f);
      parse(`serve ${fn.method}`, source(fn, param), prog);
      return fn;
    });
}
