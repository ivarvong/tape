// interp.ts: a second meaning for Tape, independent of the compiler's checker and code generator. It walks the
// parsed program directly: no types, no Wasm, no arena, nothing released or reused. Whatever this gives is what a
// program means; every compiled build must agree (proof/verify.ts, proof/interp-effects.ts). It shares the parser,
// and for sql_move the statement that reads the row back (rules/move.ts).
// Covers the language and its effects: SQL, decode and write_json, call and ask, timers, the
// clock, random numbers, flags, rollback, exported methods. Every effect is asked of a `host`, in order: given a
// recorded log as the host, a run here must ask for what the compiled run asked for and answer the same bytes.
// Not here, and thrown as Unsupported: interfaces, the Git capability.
// In interp/: value.ts (what a value is), eval.ts (expressions and patterns), effects.ts, json.ts, host.ts.
import type { FnDecl } from './compiler/ast.ts';
import { parseProgram } from './compiler.ts';
import { decoded, effect, jsonInto } from './interp/effects.ts';
import { type Interp, callable, run, stop } from './interp/eval.ts';
import type { Host, Source } from './interp/host.ts';
import { Unsupported } from './interp/json.ts';
import { type Value, asAdt, asBytes, kindOf } from './interp/value.ts';

export { MAX_WAKE_MS, Trap } from './interp/host.ts';
export type { CallRequest, CallStatus, Host, Source, SqlParam } from './interp/host.ts';
export { Unsupported } from './interp/json.ts';
export type { Value } from './interp/value.ts';

const CAPABILITIES: readonly string[] = ['Sql', 'Clock', 'Entropy', 'Timer'];
// what the host passes for each parameter of an entry point: the request, and a token for each capability
const given = (g: FnDecl, message: Value | null): Value[] =>
  g.params.map((p): Value => {
    const t = p.typeAst.name;
    if (t === 'Remote') return { k: 'remote', remote: p.name };
    if (t === 'Remotes') return { k: 'family', family: p.name };
    if (CAPABILITIES.includes(t)) return { k: 'capability', capability: t };
    if (t === 'Git') throw new Unsupported('the Git capability');
    return message ?? stop(`the host cannot pass a ${t} for ${p.name}`);
  });
// a Buf comes back as its bytes
const frozen = (r: Value): Value =>
  typeof r === 'object' && !(r instanceof Uint8Array) && r.k === 'buf' ? Uint8Array.from(r.buf) : r;
// Content's constructors in their order in std/http.tape: the frame's content byte
const CONTENT = ['Html', 'Json', 'Text', 'Css', 'Svg', 'Csv', 'Atom', 'Rss', 'Xml', 'Problem'];
/** a program's own constructor of std's name moves std's aside as `std.Name` */
const stdCtor = (c: string): string => (c.startsWith('std.') ? c.slice(4) : c);
const u32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
/**
 * handle's Response in the frame host.ts responseOf reads, as the function the compiler generates around handle
 * writes it (std/http.tape framed): written here from the value, not by running that code.
 */
function framedOf(r: Value): Uint8Array {
  const { status, content, headers, body } = asAdt(r).f;
  const tag = CONTENT.indexOf(stdCtor(asAdt(content).c));
  if (tag < 0) stop(`a Response's content is ${kindOf(content)}`);
  const st = new Uint8Array(8);
  new DataView(st.buffer).setBigInt64(
    0,
    typeof status === 'bigint' ? status : stop('a status that is not an Int'),
    true,
  );
  const heads: number[][] = [];
  for (let at = headers; ;) {
    const cell = asAdt(at);
    if (stdCtor(cell.c) !== 'Cons') break;
    const { name, value } = asAdt(cell.f['head']).f;
    heads.unshift([...u32(asBytes(name).length), ...asBytes(name), ...u32(asBytes(value).length), ...asBytes(value)]);
    at = cell.f['tail'];
  }
  return Uint8Array.from([0, 0x74, 0x61, 0x70, 1, ...st, tag, ...u32(heads.length), ...heads.flat(), ...asBytes(body)]);
}
// "2" and why: a message the method could not decode (the host answers skew)
const undecoded = (why: Value | undefined): Uint8Array => Uint8Array.from([50, ...asBytes(why)]);

/**
 * `levels`: the depth budget's weights of the build to agree with (Built.levels): with them a run stops where the
 * build's does (trap 9); without them recursion is not counted.
 */
export function interpret(
  sources: Source[],
  host: Partial<Host> | null = null,
  levels: Readonly<Record<string, number>> | null = null,
) {
  const prog = parseProgram(sources);
  const it: Interp = {
    prog,
    host,
    undone: false,
    effect: (name, e, env, file) => effect(it, name, e, env, file),
    levels,
    depth: 0,
  };
  const entry = (name: string): FnDecl => prog.fns.get(name) ?? stop(`no function ${name}`);
  return {
    /** whether the last run asked for its writes to be undone (`rollback`) */
    get undone(): boolean {
      return it.undone;
    },
    /** one request: handle(raw, …capabilities) */
    handle(bytes: Uint8Array): Uint8Array {
      it.undone = false;
      it.depth = 0;
      const g = entry('handle');
      return framedOf(run(it, callable(g), given(g, bytes)));
    },
    /** one message to an exported method: "0" and the reply as JSON, "1" and the error as JSON (woken's text as it
     * is), or "2" and why the message did not decode */
    serve(method: string, bytes: Uint8Array): Uint8Array {
      it.undone = false;
      it.depth = 0;
      const named = (f: FnDecl): boolean => f.exported && f.name.slice(f.name.lastIndexOf('.') + 1) === method,
        g = [...prog.fns.values()].find(named) ?? stop(`no exported function ${method}`),
        takes = g.params.find(p => ![...CAPABILITIES, 'Remote', 'Remotes'].includes(p.typeAst.name)),
        got = decoded(it, bytes, (takes ?? stop(`${method} takes no message`)).typeAst, g.file);
      if (got.c === 'Err') return undecoded(got.f['error']);
      const r = asAdt(run(it, callable(g), given(g, got.f['value'] ?? null)));
      if (r.c !== 'Ok') {
        const error = r.f['error'] ?? stop('Err without an error');
        return g.retAst.args[1]?.name === 'View'
          ? Uint8Array.from([49, ...asBytes(error)])
          : Uint8Array.from(jsonInto(it, { k: 'buf', buf: [49] }, error, g.file).buf);
      }
      const out = jsonInto(it, { k: 'buf', buf: [48] }, r.f['value'] ?? stop('Ok without a value'), g.file);
      return Uint8Array.from(out.buf);
    },
    /** call(name, args): one function, by the name it is known by */
    call(name: string, args: Value[]): Value {
      it.depth = 0;
      return frozen(run(it, callable(entry(name)), args));
    },
  };
}
