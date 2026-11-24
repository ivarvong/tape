// interp/form.ts: `form_raw` for the reference interpreter. It runs the compiler's own scan
// (compiler/formscan.ts), copied into a module of its own, so the two cannot disagree about which
// field was found. The value comes back still encoded; std `form_field` decodes it with `form_decoded`.
import { formScanModule } from '../compiler/formscan.ts';

type Scan = (bodyPtr: number, bodyLen: number, namePtr: number, nameLen: number) => unknown;
const isScan = (f: unknown): f is Scan => typeof f === 'function';

const isTriple = (r: unknown): r is [number, number, number] =>
  Array.isArray(r) && r.length === 3 && r.every(v => typeof v === 'number');
function triple(r: unknown): [number, number, number] {
  if (!isTriple(r)) throw new TypeError('form scan returned an unexpected result');
  return [r[0], r[1], r[2]];
}

type Ready = { memory: WebAssembly.Memory; scan: Scan };
let ready: Ready | null = null;
function module(): Ready {
  if (ready) return ready;
  // Module is abstract in the Workers types (a Worker does not compile Wasm); Reflect.construct is what
  // interp/float.ts uses, and it is a real constructor in Node, where the interpreter runs.
  const mod: unknown = Reflect.construct(WebAssembly.Module, [formScanModule()]);
  if (!(mod instanceof WebAssembly.Module)) throw new TypeError('form scan module did not compile');
  const instance = new WebAssembly.Instance(mod);
  const memory = instance.exports['memory'];
  const scan = instance.exports['scan'];
  if (!(memory instanceof WebAssembly.Memory) || !isScan(scan))
    throw new TypeError('form scan module exports no memory or no scan');
  ready = { memory, scan };
  return ready;
}

/**
 * The raw value (still `+` and %XX) of the first field of `body` whose name decodes to `name`, or null when
 * the form has no such field. A copy: the module's memory is reused on the next call.
 */
export function formRaw(body: Uint8Array, name: Uint8Array): Uint8Array | null {
  const { memory, scan } = module();
  const need = body.length + name.length;
  if (memory.buffer.byteLength < need) {
    const pages = Math.ceil((need - memory.buffer.byteLength) / 65536);
    if (memory.grow(pages) < 0) throw new Error('form scan memory could not grow');
  }
  const mem = new Uint8Array(memory.buffer);
  mem.set(body, 0);
  mem.set(name, body.length);
  const [found, ptr, len] = triple(scan(0, body.length, body.length, name.length));
  if (found === 0) return null;
  if (found !== 1 || len < 0 || ptr < 0 || ptr + len > memory.buffer.byteLength)
    throw new Error('form scan returned an unexpected result');
  return len === 0 ? new Uint8Array(0) : new Uint8Array(memory.buffer, ptr, len).slice();
}
