// compiler/gen/assemble.ts: the module's bytes, from the functions compiled and the tables they filled.
import { F64, I32, I64, name, section, sleb, uleb, utf8, vec } from '../common.ts';
import { FLAG_BASE, G_COST, G_HP, G_UNDO, G_WHY, sig } from './module.ts';
import type { Imports, Options, Tables } from './module.ts';
import { inline } from './inline.ts';
import { allocBody, reserveBody, resetBody } from './runtime.ts';

/** A function as compiled: the index of its type, and its locals and code. */
export type Compiled = { readonly sig: number; readonly body: readonly number[] };
export type Parts = {
  readonly imports: Imports;
  readonly opts: Options;
  readonly tables: Tables;
  /** the functions called through a value, by name: the module's table */
  readonly table: readonly string[];
  readonly compiled: readonly Compiled[];
  readonly flagBytes: readonly number[];
  /** what the host reads from the module beside its code, each under its section's name */
  readonly custom: readonly (readonly [string, unknown])[];
};

// `\0asm`, version 1
const MAGIC = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
const body = (b: readonly number[]): number[] => [...uleb(b.length), ...b];
const func = (field: string, type: number): number[] => [...name('env'), ...name(field), 0, ...uleb(type)];

/** The host functions imported, in the order of their indices, each with its type. */
function importList({ imports, opts, tables }: Parts): [string, number][] {
  const three = [I32, I32, I32];
  const wanted: [boolean, string, number[], number[]][] = [
    [opts.profile, 'allocated', [I32], []],
    [imports.usesSql, 'sql', three, [F64]],
    [opts.trace, 'trace', [I32, I32], []],
    [imports.usesCall, 'call_key', [I32, I32, I32, I32, F64, I32, I32], [F64]],
    [imports.usesAsk, 'ask', [I32], [F64]],
    [imports.usesMember, 'member', [I32, F64], [I32]],
    [imports.usesWake, 'wake', [F64, F64], [F64]],
    [imports.usesFloat, 'float_text', [F64], [I32]],
    [imports.usesFloat, 'float_of', [I32, I32], [F64]],
  ];
  // the types are numbered in this order; the imports are listed in the order of their indices
  const typed = new Map(
    wanted.flatMap(([on, field, p, r]): [string, number][] => (on ? [[field, sig(tables, p, r)]] : [])),
  );
  return ['sql', 'call_key', 'member', 'ask', 'wake', 'float_text', 'float_of', 'trace', 'allocated'].flatMap(
    (field): [string, number][] => {
      const type = typed.get(field);
      return type === undefined ? [] : [[field, type]];
    },
  );
}

function exportsSection({ imports, opts, tables }: Parts): number[] {
  const fn = (n: string, index: number): number[] => [...name(n), 0, ...uleb(index)];
  const global = (n: string, g: number): number[] => [...name(n), 3, g];
  return section(
    7,
    vec([
      [...name('memory'), 2, 0],
      fn('alloc', imports.ALLOC),
      fn('reset', imports.RESET),
      global('cost', G_COST),
      global('heap', G_HP),
      global('undo', G_UNDO),
      global('why', G_WHY),
      ...opts.exports.map(n => fn(n, tables.indexOf.get(n) ?? 0)),
    ]),
  );
}

function globalsSection(heap: number, freeLists: number): number[] {
  const zero = [I32, 1, 0x41, 0, 0x0b];
  return section(
    6,
    vec([
      [I32, 1, 0x41, ...sleb(heap), 0x0b],
      [I64, 1, 0x42, 0, 0x0b],
      zero,
      zero,
      ...Array.from({ length: freeLists }, () => zero),
    ]),
  );
}

/** The names of the functions, by index: the imports, the runtime's three, then the program's. */
function nameSection(imported: readonly [string, number][], { tables }: Parts): number[] {
  const fields = imported.map(([field]) => (field === 'call_key' ? 'call' : field));
  const names = [...fields, 'alloc', 'reset', 'reserve', ...tables.order.map(f => f.name)];
  return section(0, [...name('name'), 1, ...body(vec(names.map((n, i) => [...uleb(i), ...name(n)])))]);
}

/** The types a function's signature names: its parameters and its results. */
function typesOf(tables: Tables, index: number): { params: number[]; results: number[] } {
  const [, np = 0, ...rest] = tables.sigs[index] ?? [];
  return { params: rest.slice(0, np), results: rest.slice(np + 1) };
}

/** The bodies with small functions inlined (gen/inline.ts); the runtime's three are the first, and are not inlined
 * (alloc written at every allocation made the code 8–10% larger and no request measurably faster). */
function inlined(
  { imports, opts, tables, table, compiled }: Parts,
  runtime: readonly number[],
  written: readonly (readonly number[])[],
) {
  const first = imports.ALLOC;
  const sigs = [...runtime, ...compiled.map(c => c.sig)];
  const roots = new Set([imports.ALLOC, imports.RESET, ...opts.exports.map(n => tables.indexOf.get(n) ?? 0)]);
  for (const n of table) roots.add(tables.indexOf.get(n) ?? 0);
  return inline({
    fns: written.map((code, i) => ({ ...typesOf(tables, sigs[i] ?? 0), body: code })),
    first,
    roots,
    kept: new Set([imports.ALLOC, imports.RESET, imports.RESERVE]),
    blockSig: results => sig(tables, [], results),
    cost: G_COST,
    limit: INLINE_LIMIT,
  });
}
/** The most bytes of instructions a function inlined into its callers may have: a checked `a * b / c` is about 100. */
export const INLINE_LIMIT = 128;

export function assemble(parts: Parts): Uint8Array<ArrayBuffer> {
  const { imports, opts, tables, table, compiled, flagBytes, custom } = parts;
  const heap = (tables.dataBase + tables.data.length + 7) & ~7;
  const runtime = [sig(tables, [I32], [I32]), sig(tables, [], []), sig(tables, [I32, I32], [])];
  const imported = importList(parts);
  const written = [
    allocBody(opts.profile ? imports.PROFILE_IMPORT : null),
    resetBody(heap, [...tables.freeLists.values()]),
    reserveBody(imports.ALLOC),
    ...compiled.map(c => c.body),
  ];
  const slots = table.map(n => uleb(tables.indexOf.get(n) ?? 0));
  const bodies = opts.inline && !opts.profile ? inlined(parts, runtime, written) : written;
  const stored = [...flagBytes, ...tables.data];
  return new Uint8Array([
    ...MAGIC,
    ...section(1, vec(tables.sigs)),
    ...(imported.length > 0 ? section(2, vec(imported.map(([field, type]) => func(field, type)))) : []),
    ...section(3, vec([...runtime, ...compiled.map(c => c.sig)].map(uleb))),
    ...(table.length > 0 ? section(4, vec([[0x70, 0, ...uleb(table.length)]])) : []),
    ...section(5, vec([[1, ...uleb(Math.ceil(heap / 65536) + 1), ...uleb(opts.pages)]])),
    ...globalsSection(heap, tables.freeLists.size),
    ...exportsSection(parts),
    ...(table.length > 0 ? section(9, vec([[0, 0x41, 0, 0x0b, ...vec(slots)]])) : []),
    ...section(10, vec(bodies.map(body))),
    ...(stored.length > 0
      ? section(11, vec([[0, 0x41, ...sleb(FLAG_BASE), 0x0b, ...uleb(stored.length), ...stored]]))
      : []),
    ...nameSection(imported, parts),
    ...custom.flatMap(([n, value]) => section(0, [...name(n), ...utf8(JSON.stringify(value))])),
  ]);
}
