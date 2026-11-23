// host/examples.ts: the doc examples of a build, called (doctest.ts builds them, one exported function each). It
// imports nothing, so it runs wherever a module can be instantiated: in Node for `tape test`, and in tape-mcp's
// Dynamic Worker for its test tool (a Worker cannot compile Wasm itself). An example runs pure code: each import
// the module has traps, so an example that needs a capability (Sql, Clock, ...) says so.

/** What one example's function gave: it held (true), it gave something else (false), or it trapped (why). */
export type Called = boolean | { trapped: string };

const TRAPS = [
  '',
  'out of memory',
  'too many steps',
  'out of bounds',
  'division by zero',
  'use after release',
  'integer overflow',
  'shift amount outside 0 to 63',
  'float not finite',
];
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Call each named function of the module in turn, from a reset state. */
export function callExamples(mod: WebAssembly.Module, fns: readonly string[]): Called[] {
  const env: Record<string, () => never> = {};
  for (const i of WebAssembly.Module.imports(mod))
    if (i.kind === 'function')
      env[i.name] = () => {
        throw new Error(`an example cannot use ${i.name}`);
      };
  const ex = new WebAssembly.Instance(mod, { env }).exports;
  const call = (name: string): unknown => {
    const f = ex[name];
    if (typeof f !== 'function') throw new TypeError(`${name} is not exported`);
    return f();
  };
  const why = (): string | undefined => {
    const g = ex['why'];
    return g instanceof WebAssembly.Global ? TRAPS[Number(g.value)] : undefined;
  };
  return fns.map((fn): Called => {
    call('reset');
    try {
      return call(fn) === 1;
    } catch (e) {
      const w = why();
      return { trapped: w === undefined || w === '' ? message(e) : w };
    }
  });
}
