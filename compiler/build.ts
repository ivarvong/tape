// compiler/build.ts: a parsed program checked and written as a Wasm module. The steps are in compiler/gen/: what
// each type is at run time (layout), who may release what (ownership), the module's tables (module), the
// functions that serve an export (served), the runtime's three functions (runtime), and the bytes (assemble).
import { emptyProgram } from './ast.ts';
import type { FnDecl, Program } from './ast.ts';
import { ambient } from './ambient.ts';
import { CompileError, fail, utf8 } from './common.ts';
import type { Problem } from './common.ts';
import { functionCompiler } from './function.ts';
import { assemble } from './gen/assemble.ts';
import type { Compiled } from './gen/assemble.ts';
import type { Build, CallDecl, Place, Site } from './gen/fn.ts';
import * as layout from './gen/layout.ts';
import type { Shape } from './gen/layout.ts';
import * as mod from './gen/module.ts';
import type { Options, QueryEntry } from './gen/module.ts';
import { ownedParameters } from './gen/ownership.ts';
import { jsonSchema } from './gen/schema.ts';
import type { JsonSchema } from './gen/schema.ts';
import { serve } from './gen/served.ts';
import type { Served } from './gen/served.ts';
import { checkInvariants } from './invariants.ts';
import { parse } from './parse.ts';
import { resolvePipes } from './pipes.ts';
import { rowColumns } from './rows.ts';
import { sha256 } from './sha256.ts';
import { shadow } from './shadow.ts';
import { chainOf } from './sqltext.ts';
import { tidy } from './tidy.ts';
import { addCapability, key } from './types.ts';
import type { Type } from './types.ts';
import { wireSource } from './wire.ts';
import { rules } from '../rules/driver.ts';
import { stateFields } from '../rules/model.ts';

export type Source = { readonly name: string; readonly text: string };
type HostParam = { name: string; type: string };
/** What a build gives: the module, and what the host and the tools read beside it. */
export type Built = {
  wasm: Uint8Array<ArrayBuffer>;
  errors: never[];
  /** what the rules found, when the build was asked to go on anyway (`rules: false`) */
  refused: Problem[];
  queries: QueryEntry[];
  shapes: Shape[];
  sites: Site[];
  flags: { name: string; type: string; default: number | boolean; at: number; pinned?: unknown }[];
  entry: HostParam[];
  calls: CallDecl[];
  methods: { name: string; fingerprint: string; params: HostParam[] }[];
  schemas: { name: string; input: JsonSchema; output: JsonSchema }[];
  build: string;
  schema: string[];
  migrations: ReturnType<typeof chainOf>;
  machines: { table: string; column: string; start: string | null; states: string[]; moves: string[][] }[];
  invariants: ReturnType<typeof checkInvariants>;
  json: { replies: Record<string, JsonSchema | null>; decodes: Record<string, JsonSchema | null> };
  functions: string[];
  options: Options;
};
/** What the program decodes and each call's reply, for the simulator (sim.ts): a type and where, until its JSON Schema is made. */
type SimJson = Record<string, [Type, Place] | JsonSchema | null>;

// The program as parsed and rewritten, before anything is compiled: with the functions that serve its exports
// and those that read and write its nested JSON.
function front(sources: readonly Source[]) {
  const prog = emptyProgram();
  for (const s of sources) parse(s.name, s.text, prog);
  shadow(prog);
  resolvePipes(prog);
  ambient(prog);
  rowColumns(prog);
  // the rules, read from the program as written (before the generated functions are added); reported only once the
  // program has type-checked, so a type error is shown first
  const ruled = [...rules(prog), ...tidy(prog)];
  const sqlFound: Problem[] = [];
  const STATES = stateFields(prog);
  const invariants = checkInvariants(prog, sqlFound);
  // an interface's name is a capability type, like Remote, for this build only
  for (const n of prog.interfaces.keys()) addCapability(n);
  const served = serve(prog);
  const WIRE = wireSource(prog);
  if (WIRE.text) parse('wire', WIRE.text, prog);
  return { prog, ruled, sqlFound, STATES, invariants, served, WIRE };
}
type Front = ReturnType<typeof front>;

/** The flags as the module stores them, and as the host is told of them. */
function flagsOf(prog: Program, opts: Options) {
  const bytes = prog.flags.flatMap(fl => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, typeof fl.default === 'bigint' ? fl.default : fl.default ? 1n : 0n, true);
    return [...b];
  });
  const flags = prog.flags.map((fl, i) => ({
    name: fl.name,
    type: fl.type,
    default: typeof fl.default === 'bigint' ? Number(fl.default) : fl.default,
    at: mod.FLAG_BASE + 8 * i,
    ...(Object.hasOwn(opts.pin, fl.name) ? { pinned: opts.pin[fl.name] } : {}),
  }));
  return { bytes, flags };
}

/** What the functions add to as they are compiled, beside the module's tables. */
function filling() {
  const shapes: Shape[] = [];
  const calls: CallDecl[] = [];
  const sites: Site[] = [];
  const table: string[] = [];
  const replies: SimJson = {};
  const decodes: SimJson = {};
  return { shapes, calls, sites, table, flagRead: new Set<string>(), SIMJSON: { replies, decodes } };
}

/** Each function with its types resolved; a generic one is resolved per set of type arguments, when it is called. */
function resolveSignatures(prog: Program, L: layout.Layouts): void {
  for (const f of prog.fns.values()) {
    if (f.tparams.length > 0) continue;
    for (const pm of f.params) pm.type = layout.resolve(L, pm.typeAst);
    f.ret = layout.resolve(L, f.retAst);
  }
}

type Parts = { tables: mod.Tables; imports: mod.Imports; callsOf: mod.CallGraph; filled: ReturnType<typeof filling> };

/** What the function compiler is given: the program, its layouts, and the tables functions add to. */
function toolkit(fr: Front, opts: Options, L: layout.Layouts, parts: Parts): Omit<Build, 'counters'> {
  const { prog, WIRE, STATES, sqlFound } = fr;
  const { tables, callsOf } = parts;
  const { fns, ctors, types } = prog;
  const find = (n: string, file: string, at?: Place): FnDecl | null => mod.find(prog, n, file, at);
  const ownedParams = ownedParameters(fns, find, opts.reuse);
  const fingerprint = (method: string, send: Type, reply: Type, at: Place): string =>
    sha256(utf8(JSON.stringify([method, layout.describe(L, send, at), layout.describe(L, reply, at)]))).slice(0, 16);
  for (const n of Object.keys(opts.pin))
    if (!prog.flags.some(x => x.name === n))
      fail(
        null,
        'C37',
        `cannot pin ${n}: the program declares no such flag`,
        `Pin a flag the program declares${prog.flags.length > 0 ? `: ${prog.flags.map(x => x.name).join(', ')}` : '; it declares none'}.`,
      );
  const shared = { STATES, WIRE, callsOf, fns, opts, prog, sqlFound, ctors, types, find, fingerprint };
  const constants = {
    FLAG_BASE: mod.FLAG_BASE,
    G_COST: mod.G_COST,
    G_UNDO: mod.G_UNDO,
    trap: mod.trap,
    walk: mod.callsIn,
  };
  const pure = {
    isLinear: layout.isLinear,
    nearest: layout.nearest,
    orderArgs: mod.orderArgs,
    rowKind: layout.rowKind,
  };
  return {
    ...shared,
    ...constants,
    ...pure,
    ...parts.imports,
    ...parts.filled,
    recursive: mod.recursiveOf(fns, callsOf),
    resolve: (ast: Type, map?: ReadonlyMap<string, Type>): Type => layout.resolve(L, ast, map),
    adtOf: (t: Type, at: Place) => layout.adtOf(L, t, at),
    adtOrNull: (t: Type, at: Place) => layout.adtOrNull(L, t, at),
    fnIndex: (n: string) => mod.fnIndex(tables, n),
    freeList: (size: number) => mod.freeList(tables, size),
    literal: (bytes: readonly number[]) => mod.literal(tables, bytes),
    queryId: (q: Omit<QueryEntry, 'run'>) => mod.queryId(tables, q),
    reads: (f: FnDecl, i: number) => opts.reuse && ownedParams.get(f.base ?? f.name)?.[i] === false,
    rowOf: (t: Type, at: Place) => layout.rowOf(L, t, at),
    shapeOf: (t: Type, at: Place, decoding: boolean) => layout.shapeOf(L, t, at, decoding),
    sig: (params: readonly number[], results: readonly number[]) => mod.sig(tables, params, results),
    slotsOf: (t: Type, at?: Place) => layout.slotsOf(L, t, at),
    strip: (t: Type) => layout.strip(L, t),
  };
}

/** Every function the exports reach, compiled; with the tables they filled. */
function compileAll(fr: Front, opts: Options, L: layout.Layouts) {
  const { prog } = fr;
  resolveSignatures(prog, L);
  const callsOf = mod.callGraph(prog.fns);
  const imports = mod.importsOf(prog, callsOf, opts, fr.served);
  const tables = mod.tables(prog, imports.FIRST);
  const filled = filling();
  const kit = toolkit(fr, opts, L, { tables, imports, callsOf, filled });
  const compileFn = functionCompiler(kit);
  for (const n of opts.exports) {
    if (!prog.fns.has(n)) fail(null, 'C30', `the program has no function ${n}`, `The host calls \`${n}\`. Define it.`);
    mod.fnIndex(tables, n);
  }
  // compiling a function names the functions it calls, which puts them at the end of the list
  const compiled: Compiled[] = [];
  for (let i = 0; i < tables.order.length; i++) {
    const f = tables.order[i];
    if (f) compiled.push(compileFn(f));
  }
  for (const fl of prog.flags)
    if (!filled.flagRead.has(fl.name))
      fail(
        fl,
        'C38',
        `flag ${fl.name} is never read`,
        `Delete the declaration, or read it with \`flags.${fl.name}\`. A flag nothing reads is a rollout that already finished.`,
      );
  return { imports, tables, compiled, fingerprint: kit.fingerprint, resolve: kit.resolve, ...filled };
}

/** The JSON Schema of a type the simulator will need, or null when it has none. */
function schemaOr(L: layout.Layouts, [type, at]: [Type, Place]): JsonSchema | null {
  try {
    return jsonSchema(L, type, at);
  } catch {
    return null;
  }
}

/** What the host reads beside the code: the methods served, their schemas, the machines, the build's name. */
function describeModule(
  fr: Front,
  opts: Options,
  sources: readonly Source[],
  L: layout.Layouts,
  done: ReturnType<typeof compileAll>,
) {
  const { prog, served } = fr;
  const { resolve, fingerprint, SIMJSON } = done;
  // what the host passes to `handle`, in order; and the methods this module serves, each with its fingerprint
  const hostType = (t: Type | undefined): string => (t ? (prog.interfaces.has(t.name) ? 'Remote' : key(t)) : '');
  const hostParams = (f: FnDecl | undefined): HostParam[] =>
    (f?.params ?? []).map(pm => ({ name: pm.name, type: hostType(pm.type) }));
  const methods = served.map((f: Served) => ({
    name: f.method,
    fingerprint: fingerprint(f.method, resolve(f.message), resolve(f.reply), f),
    params: hostParams(prog.fns.get(`serve_${f.method}`)),
  }));
  const schemas = served.map((f: Served) => ({
    name: f.method,
    input: jsonSchema(L, resolve(f.message), f),
    output: jsonSchema(L, resolve(f.reply), f),
  }));
  const settled = (part: SimJson): Record<string, JsonSchema | null> =>
    Object.fromEntries(Object.entries(part).map(([k, v]) => [k, Array.isArray(v) ? schemaOr(L, v) : v]));
  const json = { replies: settled(SIMJSON.replies), decodes: settled(SIMJSON.decodes) };
  return {
    json,
    entry: hostParams(prog.fns.get('handle')),
    methods,
    schemas,
    // The build's name: a hash of the sources and the pinned flags. A traced build of the same sources has the
    // same name, so its replays are accepted; any other change to the program gives another.
    build: sha256(utf8(JSON.stringify([sources.map(x => [x.name, x.text]), opts.pin]))).slice(0, 16),
    migrations: chainOf(prog.migrations),
    // the machines as the host installs them: `start` is where a row starts, `moves` the pairs [from, to] allowed
    machines: prog.machines.map(m => ({
      table: m.table,
      column: m.column,
      start: m.start,
      states: m.states,
      moves: m.moves.map(x => [x.from, x.to]),
    })),
  };
}

function finish(fr: Front, opts: Options, sources: readonly Source[], found: Problem[]): Built {
  const { prog, invariants } = fr;
  const L = layout.layouts(prog, fr.WIRE);
  const done = compileAll(fr, opts, L);
  const { tables, shapes, calls, sites } = done;
  const { bytes: flagBytes, flags } = flagsOf(prog, opts);
  const about = describeModule(fr, opts, sources, L, done);
  const queries: QueryEntry[] = tables.queries;
  const custom: [string, unknown][] = [
    ['queries', queries],
    ['schema', prog.schema],
    ['migrations', about.migrations],
    ['shapes', shapes],
    ['flags', flags],
    ['entry', about.entry],
    ['calls', calls],
    ['methods', about.methods],
    ['build', about.build],
  ];
  // only a program that declares a machine has this section, so every other module is byte for byte as before
  if (about.machines.length > 0) custom.push(['machines', about.machines]);
  if (invariants.length > 0) custom.push(['invariants', invariants]);
  const { imports, table, compiled } = done;
  const wasm = assemble({ imports, opts, tables, table, compiled, flagBytes, custom });
  return {
    wasm,
    errors: [],
    refused: found,
    queries,
    shapes,
    sites,
    flags,
    entry: about.entry,
    calls,
    methods: about.methods,
    schemas: about.schemas,
    build: about.build,
    schema: prog.schema,
    migrations: about.migrations,
    machines: about.machines,
    invariants,
    json: about.json,
    functions: tables.order.map(f => f.name),
    options: opts,
  };
}

export function build(sources: readonly Source[], opts0: Options): Built {
  const fr = front(sources);
  const { prog, served } = fr;
  const opts: Options = {
    ...opts0,
    exports: [
      ...opts0.exports.filter(n => n !== 'handle' || prog.fns.has('handle') || served.length === 0),
      ...served.map(f => `serve_${f.method}`),
    ],
  };
  const found: Problem[] = [];
  const made = finish(fr, opts, sources, found);
  // the rules' problems and the queries' (C67-C69, found while emitting), in the order of the source
  const byPlace = (a: Problem, b: Problem): number =>
    a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code);
  found.push(...[...fr.ruled, ...fr.sqlFound].toSorted(byPlace));
  // rules: false builds the module anyway and returns what the rules found as `refused` (sim.ts runs such a
  // program to see whether what a rule refuses is a bug the simulator finds too); nothing else reads the option
  const [first] = found;
  if (first && opts.rules !== false) throw new CompileError(first, found);
  return made;
}
