// apps/playground/src/worker.ts: the page's second thread. Compiling a program (30 to 80 ms for the larger
// examples) and simulating one (seconds) happen here, so typing never waits for either. The compiler's result
// is plain data (its Wasm bytes, queries, sites, schemas), so it crosses to the page as it is.
import { compile } from '../../../compiler.ts';
import type { Built, Refused } from '../../../compiler.ts';
import { format } from '../../../fmt.ts';
import { std } from '../../../std.ts';
import initSqlJs from '../vendor/sql.js-1.10.3/sql-wasm.js';
import { simulate } from './simulate.ts';
import type { SimFile } from './simulate.ts';
import { loadSqlite } from './sqlite.ts';

export type Ask =
  | { id: number; kind: 'compile'; file: string; text: string; trace?: boolean; withStd?: boolean }
  | { id: number; kind: 'format'; file: string; text: string }
  | { id: number; kind: 'sim'; files: SimFile[]; wasm: ArrayBuffer; seeds?: number };
export type Answer =
  | { id: number; kind: 'compile'; result: Built | Refused; ms: number }
  | { id: number; kind: 'format'; text: string | null; error: string | null }
  | { id: number; kind: 'sim'; result: Awaited<ReturnType<typeof simulate>> }
  | { id: number; kind: 'error'; message: string };

// sim/world.ts lets pending work run with setImmediate, which is Node's; a worker has none. A message to itself is
// the same: a macrotask with no 4 ms clamp (setTimeout nested deeper than five is clamped to 4 ms, and the
// simulator drains thousands of times a run).
const g: { setImmediate?: (f: () => void) => void } = globalThis;
if (!g.setImmediate) {
  const queue: (() => void)[] = [];
  const channel = new MessageChannel();
  channel.port1.addEventListener('message', (): void => {
    queue.shift()?.();
  });
  channel.port1.start();
  g.setImmediate = (f: () => void): void => {
    queue.push(f);
    channel.port2.postMessage(0);
  };
}

type Port = {
  postMessage: (m: Answer, transfer?: Transferable[]) => void;
  addEventListener: (type: 'message', f: (e: MessageEvent<Ask>) => void) => void;
};
// the worker's own global, as far as this file uses it (the page's types are the window's, lib dom)
const port: Port = {
  postMessage: (m, transfer = []) => {
    // a worker's postMessage takes no target origin (that is window.postMessage)
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    self.postMessage(m, { transfer });
  },
  addEventListener: (type, f) => {
    self.addEventListener(type, f);
  },
};

port.addEventListener('message', (e: MessageEvent<Ask>): void => {
  const ask = e.data;
  void (async (): Promise<void> => {
    try {
      if (ask.kind === 'compile') {
        const t0 = performance.now();
        const sources =
          ask.withStd === false ? [{ name: ask.file, text: ask.text }] : [...std, { name: ask.file, text: ask.text }];
        const result = compile(sources, ask.trace ? { trace: true } : {});
        const ms = performance.now() - t0;
        port.postMessage({ id: ask.id, kind: 'compile', result, ms }, result.wasm ? [result.wasm.buffer] : []);
      } else if (ask.kind === 'format') {
        try {
          port.postMessage({ id: ask.id, kind: 'format', text: format(ask.text, ask.file, std), error: null });
        } catch (err) {
          port.postMessage({
            id: ask.id,
            kind: 'format',
            text: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        await loadSqlite(initSqlJs, ask.wasm);
        port.postMessage({ id: ask.id, kind: 'sim', result: await simulate(ask.files, { seeds: ask.seeds ?? 300 }) });
      }
    } catch (err) {
      port.postMessage({
        id: ask.id,
        kind: 'error',
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
  })();
});
