// tape compiler: source text -> one Wasm module. TypeScript that erases to JavaScript, no dependencies: runs in Node, workerd and
// the browser. Pipeline: lex -> parse -> (check + emit, one walk per reachable function) -> assemble.
//
// The language in one screen:
//   types      Int (i64), Bool, View (read-only bytes), Buf (owned, growable bytes; single-use), Sql and Remote
//              (capabilities), Rows[T], and user types `type T[P] { Ctor(field: Type, ...) ... }`. A type that
//              contains itself (a list, a tree) lives in the request's arena; every other type is passed as
//              plain Wasm values.
//   functions  `fn name(param: Type, ...) -> Type { let x = e ... e }`. Arguments are named (`f(at: i)`); a variable
//              whose name equals the parameter may be passed bare; a one-parameter function takes its argument bare.
//   branching  one construct, `match`, only as the last expression of a function:
//                match subject { Pattern if guard -> e ... }      patterns nest: Draft(title: Set(value: t), done: Unset)
//                match { condition -> e ... else -> e }
//                with { pattern <- e ... -> e  else -> e }       steps that can each fail; the first failure takes `else`
//   patterns   are parsers: each can fail, and binds what it proves.
//                Title(t)              a refined type (`type Title = View where …`): matches when the condition holds
//                "/todos/" ++ rest     text that starts with a literal; `rest` is matched against what follows
//                decimal(n)            any one-argument function returning Option[…]: matches on Some
//                order = Order(state: "done")   the whole value, bound once the pattern after `=` matches
//              `let Order(id, sku) = e` takes apart a value with a pattern that cannot fail (one constructor, names
//              and `_` inside); a pattern that can fail is refused, naming the part, and belongs in match or with.
//   loops      recursion. A call in tail position never grows the stack (self calls become a loop).
//   operators  + - * / %  & | ^ << >>  == != < <= > >=  and or not  v[i]  record.field  a ++ b (text joined)
//   pipes      a |> f(b: 1) is f(<f's first declared parameter>: a, b: 1); std and the built-ins take their
//              subject first. Binds tighter than comparisons, looser than arithmetic.
//   intrinsics len slice buf push append freeze size  sql_exec sql_first sql_all next  decode write_json
//   flags      `flag name: Bool = False` (or Int) declares a flag; `flags.name` reads it. The host writes every
//              flag's value into the module's memory before a request, so a read is one memory load, the value
//              cannot change during a request, and the request's log records it. A flag that is never read is
//              an error. Compiling with { pin: { name: value } } turns a flag into a constant.
//   calls      call(to: remote, method: "name", send: record, reply: Type, within: milliseconds, once: key)
//              -> Result[Type, CallError] sends a command: the other side runs it at most once per key and
//              answers a repeat with the stored reply, so a call that timed out can be sent again safely.
//              ask(to, method, send, reply, within) is the same for a read, with no key. `within` is required:
//              every call has a time budget. Each call carries a fingerprint of the method name and the two
//              record shapes; a callee whose fingerprint differs answers Err(Skew(reason)) and runs nothing.
//              The handler is run again from its effect log once the reply (or the timeout) is known, so a
//              call is also a commit point for the SQL before it.
//   undoing    rollback(out) returns `out` as the response and tells the host to undo this request's writes
//              (those since its last call to another object). The log keeps what was tried, marked undone.
//   memory     Values are immutable. Underneath, a value built from a recursive type carries one bit: shared or
//              not. It starts unshared and is marked shared, for good, whenever a second reference to it may
//              come to exist. A `match` on an unshared value that nothing else reads afterwards releases its
//              memory to the next value of the same size, so a loop that replaces a map entry per step does not
//              allocate. { reuse: false } turns all of this off: that build never releases anything, and every
//              program must give the same bytes under both.
//   files      Each file is a namespace for its functions. A call finds the function in its own file first, then
//              in any other file if exactly one defines the name; `text.until(…)` names the file (by its name
//              without `.tape`) when more than one does. Types and constructors are shared by the whole program.
//   interfaces `interface Git { read head(Ref) -> Head  write edit_file(Edit) -> Pushed }` names what a capability
//              can do. A parameter `repo: Git` is such a capability, and `repo.head(send: Ref(ref), within: 2000)`
//              is the call. A read is sent as `ask`; a write as `call`, so it must carry `once:`. The message
//              must be the record the interface names, and the result is Result[Reply, CallError].
//   serving    `export fn name(db: Sql, message: Record) -> Result[Reply, View]` is a method other objects can
//              call. Its parameters are capabilities and one record; Err's text reaches the caller as Rejected.
//   timers     wake(timer, after: ms, key: n) -> Int asks the host to call this program's `export fn woken(…,
//              message: Wake)` with Wake(key: n) after `ms`. It is in the effect log; setting a key again moves
//              its time; it is kept only if the request's writes are (a rollback or a trap drops it).
//   time       now(clock) -> Int: milliseconds since 1970. random(from: entropy) -> Int: 53 random bits. Both
//              need their capability (Clock, Entropy) as a parameter and both are in the effect log, so a replay
//              sees the same time and the same numbers.
//   JSON       decode(json: bytes, as: Type) is the platform's JSON.parse, checked against the type and written
//              straight into it; write_json(out, value) writes a record as JSON.
// Everything else (text, JSON, UTF-8) is library code written in the language (std/*.tape).
//
// The parts, in compiler/: lex.ts and parse.ts (text to a program), shadow.ts, pipes.ts, ambient.ts and rows.ts
// (what the program means before it is checked), build.ts (the checks and the Wasm), wire.ts, tidy.ts and
// invariants.ts (what build asks of them), types.ts and common.ts (what they all share). The rules are rules.ts
// and the SQL reader sql.ts.
import { emptyProgram } from './compiler/ast.ts';
import { CompileError, DEFAULTS } from './compiler/common.ts';
import type { Problem } from './compiler/common.ts';
import { parse } from './compiler/parse.ts';
import { shadow } from './compiler/shadow.ts';
import { resolvePipes } from './compiler/pipes.ts';
import { ambient } from './compiler/ambient.ts';
import { rowColumns } from './compiler/rows.ts';
import { build } from './compiler/build.ts';
import type { Built, Source } from './compiler/build.ts';
import type { Options } from './compiler/gen/module.ts';
import { forgetAddedCapabilities } from './compiler/types.ts';

import type { Program } from './compiler/ast.ts';
export { TRAP, DEFAULTS } from './compiler/common.ts';
export { KEYWORDS } from './compiler/lex.ts';
export { sha256 } from './compiler/sha256.ts';

type Sources = string | Source | readonly (string | Source)[];
const named = (sources: Sources): Source[] => {
  const one = (s: string | Source, i: number): Source =>
    typeof s === 'string' ? { name: `source${i + 1}`, text: s } : s;
  if (typeof sources === 'string' || 'text' in sources) return [one(sources, 0)];
  return sources.map(one);
};
/** A program that did not compile: what is wrong with it, the first problem first. */
export type Refused = { wasm: null; errors: Problem[] };

export type { Built, Source } from './compiler/build.ts';
export type { Options } from './compiler/gen/module.ts';

export function compile(sources: Sources, options: Partial<Options> = {}): Built | Refused {
  const opts: Options = { ...DEFAULTS, ...options };
  try {
    return build(named(sources), opts);
  } catch (e) {
    if (e instanceof CompileError) return { wasm: null, errors: e.all ?? [e.info] };
    throw e;
  } finally {
    forgetAddedCapabilities();
  }
}

// The parsed program alone, for tools that give Tape a second, independent meaning (interp.ts).
export function parseProgram(sources: Sources): Program {
  const prog = emptyProgram();
  for (const s of named(sources)) parse(s.name, s.text, prog);
  shadow(prog);
  resolvePipes(prog);
  ambient(prog);
  rowColumns(prog);
  return prog;
}
