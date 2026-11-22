// interp.ts: a second meaning for Tape, independent of the compiler's checker and code generator. It walks the
// parsed program directly: no types, no Wasm, no arena, nothing released or reused. Whatever this gives is what a
// program means; every compiled build must agree (proof/verify.ts, proof/interp-effects.ts). It shares the parser,
// and for sql_move the statement that reads the row back (rules/move.ts).
// Covers the language and its effects: SQL, decode and write_json of flat records, call and ask, timers, the
// clock, random numbers, flags, rollback, exported methods. Every effect is asked of a `host`, in order: given a
// recorded log as the host, a run here must ask for what the compiled run asked for and answer the same bytes.
// Not here, and thrown as Unsupported: records nested in JSON, lists in JSON, interfaces, the Git capability.
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
const answer = (r: Value): Uint8Array => {
  const out = frozen(r);
  return out instanceof Uint8Array ? out : stop(`an entry point answered ${kindOf(out)}, not bytes`);
};
// "1" and the reason: a method's refusal
const refusal = (why: Value | undefined): Uint8Array => Uint8Array.from([49, ...asBytes(why)]);

export function interpret(sources: Source[], host: Partial<Host> | null = null) {
  const prog = parseProgram(sources);
  const it: Interp = { prog, host, undone: false, effect: (name, e, env, file) => effect(it, name, e, env, file) };
  const entry = (name: string): FnDecl => prog.fns.get(name) ?? stop(`no function ${name}`);
  return {
    /** whether the last run asked for its writes to be undone (`rollback`) */
    get undone(): boolean {
      return it.undone;
    },
    /** one request: handle(raw, …capabilities) */
    handle(bytes: Uint8Array): Uint8Array {
      it.undone = false;
      const g = entry('handle');
      return answer(run(it, callable(g), given(g, bytes)));
    },
    /** one message to an exported method: the reply is "0" and the record as JSON, or "1" and the reason */
    serve(method: string, bytes: Uint8Array): Uint8Array {
      it.undone = false;
      const named = (f: FnDecl): boolean => f.exported && f.name.slice(f.name.lastIndexOf('.') + 1) === method,
        g = [...prog.fns.values()].find(named) ?? stop(`no exported function ${method}`),
        takes = g.params.find(p => ![...CAPABILITIES, 'Remote', 'Remotes'].includes(p.typeAst.name)),
        got = decoded(it, bytes, (takes ?? stop(`${method} takes no message`)).typeAst.name, g.file);
      if (got.c === 'Err') return refusal(got.f['error']);
      const r = asAdt(run(it, callable(g), given(g, got.f['value'] ?? null)));
      if (r.c !== 'Ok') return refusal(r.f['error']);
      const out = jsonInto(it, { k: 'buf', buf: [48] }, r.f['value'] ?? stop('Ok without a value'), g.file);
      return Uint8Array.from(out.buf);
    },
    /** call(name, args): one function, by the name it is known by */
    call(name: string, args: Value[]): Value {
      return frozen(run(it, callable(entry(name)), args));
    },
  };
}
