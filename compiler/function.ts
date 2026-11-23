// compiler/function.ts: one function of a program, checked and written as Wasm. Everything it knows about the
// program it is in comes from the build (build.ts), which makes one compiler of functions and calls it for each
// function the exports reach. The parts are in compiler/gen/: expressions (expr), calls and function values
// (call), patterns and match (pattern, match), the compiler's own functions (intrinsic), JSON in (decode), calls
// out of the program (callout) and SQL (sql).
import type { FnDecl } from './ast.ts';
import { TRAP, fail, sleb, uleb, vec } from './common.ts';
import type { Compiled } from './gen/assemble.ts';
import { compileEntry } from './gen/call.ts';
import { emit } from './gen/expr.ts';
import { compileMath } from './gen/float.ts';
import { close, declare, ev, need, open, site, trapIf } from './gen/fn.ts';
import type { Build, Ctx } from './gen/fn.ts';
import type { Type } from './types.ts';

/** The parameters as names in scope, each in the Wasm parameters of its type; one that is only read is borrowed. */
function declareParams(c: Ctx): void {
  let slot = 0;
  c.f.params.forEach((pm, i) => {
    const type =
      pm.type ??
      fail(
        c.f,
        'C99',
        `the type of ${pm.name} is not known`,
        'This is a compiler bug, not a mistake in the program: please report it with the program that shows it.',
      );
    const v = declare(
      c,
      pm.name,
      type,
      c.B.slotsOf(type).map(() => slot++),
      c.f,
    );
    v.param = true;
    if (c.B.reads(c.f, i)) v.mode = 'borrowed';
  });
}

/** A recursive function counts each entry, and stops when the count passes the limit. */
function countEntry(c: Ctx): void {
  const { B, f } = c;
  // a copy of a generic function is recursive when the function it was made from is
  if (!B.opts.reductions || !(B.recursive.has(f.name) || (f.base !== undefined && B.recursive.has(f.base)))) return;
  const more = [0x23, B.G_COST, 0x42, 1, 0x7c, 0x24, B.G_COST];
  c.code.push(...more, 0x23, B.G_COST, 0x42, ...sleb(B.opts.reductionLimit), 0x56);
  trapIf(c, TRAP.REDUCTIONS);
}

/** The locals as Wasm wants them: runs of one type, each with its length. */
function localRuns(locals: readonly number[]): number[] {
  const runs: [number, number][] = [];
  for (const vt of locals) {
    const last = runs.at(-1);
    if (last?.[1] === vt) last[0]++;
    else runs.push([1, vt]);
  }
  return vec(runs.map(([n, vt]) => [...uleb(n), vt]));
}

function compileFn(B: Build, f: FnDecl): Compiled {
  const { trampoline, math } = f;
  if (trampoline) return compileEntry(B, { ...f, trampoline });
  if (math !== undefined) return compileMath(B, math);
  const params = f.params.flatMap(pm =>
    B.slotsOf(
      pm.type ??
        fail(
          f,
          'C99',
          `the type of ${pm.name} is not known`,
          'This is a compiler bug, not a mistake in the program: please report it with the program that shows it.',
        ),
    ),
  );
  const ret: Type =
    f.ret ??
    fail(
      f,
      'C99',
      `the result type of ${f.name} is not known`,
      'This is a compiler bug, not a mistake in the program: please report it with the program that shows it.',
    );
  const c: Ctx = {
    B,
    f,
    code: [],
    locals: [],
    nparams: params.length,
    depth: 0,
    env: new Map(),
    consumed: new Set(),
    binderMode: 'borrowed',
    consuming: false,
    emit: (e, expected, tail) => emit(c, e, expected, tail),
  };
  declareParams(c);
  const results = B.slotsOf(ret);
  // the body is a loop, so a call of the function by itself as its result starts it again
  open(c, 0x03, results);
  ev(c, site(c, 'fn', f), 2);
  countEntry(c);
  need(c, c.emit(f.body, ret, true), ret, f, `the result of ${f.name}`);
  close(c);
  for (const v of c.env.values())
    if (v.param && B.isLinear(v.type) && !c.consumed.has(v))
      fail(f, 'C27', `the Buf ${v.name} is never used`, 'Return it, pass it on, or `freeze` it.');
  c.code.push(0x0b);
  return { sig: B.sig(params, results), body: [...localRuns(c.locals), ...c.code] };
}

/** functionCompiler(build) -> compileFn(f) -> { sig, body }; `counters` shared by compilers of one program */
export function functionCompiler(build: Omit<Build, 'counters'>, counters: Build['counters']): (f: FnDecl) => Compiled {
  const B: Build = { ...build, counters };
  return f => compileFn(B, f);
}
