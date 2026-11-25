// compiler/gen/answer.ts: `handle` answers a Response (std/http.tape), and the host reads bytes. The function the
// host calls by the name `handle` is generated here: serve_handle(…handle's parameters) -> Buf calls the program's
// handle and writes the Response it gives in the frame host.ts responseOf reads (std/http.tape `framed`, private to
// its file): the head, and where the body lies, which the host reads there (host/memory.ts frameAt), not a copy. Only this generated function writes a frame, and `handle` cannot give a Buf, so no byte a program
// writes (a body copied from a request, a row) reaches the host as a status or a header.
import { eachExpr } from '../ast.ts';
import type { Call, Expr, FnDecl, Program } from '../ast.ts';
import { CompileError } from '../common.ts';
import type { Problem } from '../common.ts';
import { parse } from '../parse.ts';
import { isStd, stdName } from '../shadow.ts';
import { key } from '../types.ts';

/** The file the generated function is in: a name no program's file has, as `serve <method>` is for a method's. */
const FILE = 'serve handle';

/** The fix for a `handle` that gives a Buf, the answer before 25 November 2026. */
export const BUF_ANSWER_HINT =
  'A Buf is not an answer: the host writes the status and the headers from a Response, so no byte of a body can become one. Write the body, then give it its status last: `buf() |> append(view: …) |> respond(status: 200)`, `… |> respond_as(status: 200, content: Html)`; `json(status: 200, value: …)` for a value as JSON, `empty(status: 204)` for no body, `redirect(to: …)` to send the client on. Then `fn handle(…) -> Response`.';

/** C14: `handle` gives something other than std's Response. */
function refuse(prog: Program, h: FnDecl): never {
  const got = key(h.retAst);
  const mine = prog.types.get('Response');
  const shadowed = mine !== undefined && mine.file !== 'std/http.tape';
  throw new CompileError({
    code: 'C14',
    file: h.file,
    line: h.retAst.line,
    message: `handle gives ${shadowed && got === 'Response' ? `${mine.file}'s Response` : `a ${got}`}; it answers std's Response`,
    hint: shadowed
      ? `${mine.file} defines a type Response, which shadows std's in the program's files: rename it, and handle answers std's (\`respond\`, \`json\`, \`empty\`, \`redirect\`).`
      : got === 'Buf'
        ? BUF_ANSWER_HINT
        : 'Answer with `respond`, `respond_as`, `json`, `empty` or `redirect` (std/http.tape), and write `fn handle(…) -> Response`.',
  });
}

// ---- C96: a status the host would refuse, written as a literal

/** std/http.tape's functions that take a status, and whether each takes a body (a problem writes its own) */
const STATUSED: ReadonlyMap<string, boolean> = new Map([
  ['respond', true],
  ['respond_as', true],
  ['json', true],
  ['empty', false],
  ['problem', false],
  ['problem_with', false],
]);
/** the functions whose status is an error's: 400 to 599 */
const ERRORS = new Set(['problem', 'problem_with']);
const NO_BODY = new Set([204n, 205n, 304n]);
/** The std/http.tape function a call in a program's file names, or null for any other. */
function stdHttp(prog: Program, name: string): string | null {
  const bare = name.startsWith('http.') ? name.slice(5) : name;
  if (!STATUSED.has(bare)) return null;
  const defs = prog.defs.get(bare) ?? [];
  const std = defs.find(d => d.file === 'std/http.tape');
  return std && (bare !== name || defs.length === 1) ? bare : null;
}
/** The value a call gives the parameter `name` (first: whether it is the callee's first, which a pipe passes). */
const argOf = (e: Call, name: string, first: boolean): Expr | undefined =>
  (e.args.find(a => a.label === name) ?? (first ? e.args.find(a => a.piped === true || a.label === null) : undefined))
    ?.value;
/**
 * The statuses written as literals that the host refuses (host.ts responseOf): outside 200 to 599, and a 204, 205
 * or 304 with a body that is not a bare `buf()`; and a problem's that is not an error, 200 to 399. A status that is a value is checked by the host when it answers.
 */
export function statusLiterals(prog: Program): Problem[] {
  const found: Problem[] = [];
  for (const f of prog.fns.values()) {
    if (isStd(f.file)) continue;
    eachExpr(f.body, e => {
      if (e.k !== 'call') return;
      const fn = stdHttp(prog, e.name);
      const status = fn === null ? undefined : argOf(e, 'status', fn === 'empty');
      const s = status?.k === 'int' ? status.v : status?.k === 'neg' && status.e.k === 'int' ? -status.e.v : null;
      if (fn === null || s === null) return;
      const at = { file: f.file, line: e.line, code: 'C96' };
      if (ERRORS.has(fn) && s >= 200n && s < 400n)
        found.push({
          ...at,
          message: `${fn} answers an error, and status ${s} is not one`,
          hint: `A problem is a client's error (400 to 499) or the program's (500 to 599): \`${fn}(status: 400, …)\` for a request it cannot take, 404 for what is not there, 409 for a conflict. An answer that succeeded is \`json(status: ${s}, value: …)\` or \`respond(status: ${s})\`.`,
        });
      if (s < 200n || s > 599n)
        found.push({
          ...at,
          message: `status ${s} is outside 200 to 599`,
          hint: 'A final HTTP status is from 200 to 599 (1xx are interim, and only the host sends them); the host refuses any other and answers 500. Write the status that says what happened: 200, 201, 204, 303, 400, 404, 409, 500…',
        });
      const body = STATUSED.get(fn) === true ? argOf(e, 'body', true) : undefined;
      const bare = body?.k === 'call' && body.name === 'buf' && body.args.length === 0;
      if (NO_BODY.has(s) && body !== undefined && !bare)
        found.push({
          ...at,
          message: `a ${s} answer has no body, and this one writes one`,
          hint: `A 204, 205 or 304 has no body (RFC 9110), and the host refuses one: write \`empty(status: ${s})\`.`,
        });
    });
  }
  return found;
}

/**
 * The function the host calls as `handle`, added to the program; its name in the build, or null when the program
 * has no `handle` (a callee with only methods, or examples compiled alone).
 */
export function answer(prog: Program): string | null {
  const h = prog.fns.get('handle');
  if (!h) return null;
  const want = stdName(prog, 'types', 'Response');
  if (!prog.types.has(want))
    throw new CompileError({
      code: 'C30',
      file: h.file,
      line: h.line,
      message: 'handle answers a Response, and std/http.tape, which defines it, is not compiled with the program',
      hint: 'Compile the program with std (std.ts lists its files), as `tape` and the service do.',
    });
  if (key(h.retAst) !== want || prog.types.get(want)?.file !== 'std/http.tape') refuse(prog, h);
  const params = h.params.map(pm => `${pm.name}: ${key(pm.typeAst)}`).join(', ');
  const pass = h.params.map(pm => `${pm.name}: ${pm.name}`).join(', ');
  // `handle` in the generated file is the program's (the first file's, the one the host serves), whichever other
  // files define one; std's framed by its file's name, so a program's own `framed` is not the one called
  prog.byFile.set(FILE, new Map([['handle', 'handle']]));
  parse(FILE, `fn serve_handle(${params}) -> Buf {\n  http.framed(answer: handle(${pass}))\n}\n`, prog);
  return prog.byFile.get(FILE)?.get('serve_handle') ?? null;
}
