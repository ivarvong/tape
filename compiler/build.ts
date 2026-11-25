// compiler/build.ts: a parsed program checked and written as a Wasm module. The steps are in compiler/gen/: what
// each type is at run time (layout), who may release what (ownership), the module's tables (module), the
// functions that serve an export (served), the runtime's three functions (runtime), and the bytes (assemble).
import { emptyProgram } from './ast.ts';
import type { FnDecl, Program } from './ast.ts';
import { ambient, granted } from './ambient.ts';
import { fetchKeys } from './fetch.ts';
import { CompileError, LEVEL_BASE, fail } from './common.ts';
import { STEP_VERSION } from './step-version.ts';
import type { Problem } from './common.ts';
import { functionCompiler } from './function.ts';
import { assemble } from './gen/assemble.ts';
import type { Compiled } from './gen/assemble.ts';
import type { Build, CallDecl, Place, Site } from './gen/fn.ts';
import * as layout from './gen/layout.ts';
import * as mod from './gen/module.ts';
import type { Options, QueryEntry } from './gen/module.ts';
import { ownedParameters } from './gen/ownership.ts';
import { jsonSchema } from './gen/schema.ts';
import type { JsonSchema } from './gen/schema.ts';
import { answer, statusLiterals } from './gen/answer.ts';
import { serve } from './gen/served.ts';
import type { Served } from './gen/served.ts';
import { checkInvariants } from './invariants.ts';
import { parse } from './parse.ts';
import { resolvePipes } from './pipes.ts';
import { fuseRanges } from './fuse.ts';
import { rowColumns } from './rows.ts';
import { Sha256, sha256 } from './sha256.ts';
import { shadow } from './shadow.ts';
import { bindFieldNames } from './fieldbind.ts';
import { chainOf } from './sqltext.ts';
import { tidy } from './tidy.ts';
import { addCapability, key } from './types.ts';
import type { Type } from './types.ts';
import { wireSource } from './wire.ts';
import { rules } from '../rules/driver.ts';

export type Source = { readonly name: string; readonly text: string };

const UTF8 = new TextEncoder();
/** The hasher after `[[` and the standard library's entries, kept while the same std files lead the sources. */
let stdPrefix: { files: readonly Source[]; h: Sha256 } | null = null;
/**
 * The build's name: the first 16 hex characters of the SHA-256 of JSON.stringify([sources.map(x => [x.name,
 * x.text]), pin]). The standard library's files lead every compile's sources (82 KB); the hash of their part is
 * kept while they are the same objects, so a compile hashes its own files and the pin only. Hashing all of it,
 * from a copy of every byte as a number in an array, was 7% of what a hosted compile allocated (heap profiles of
 * tape ff30a865, 2026-11-23). test/sha256.ts checks it against the formula.
 */
export function buildName(sources: readonly Source[], pin: unknown): string {
  let k = 0;
  while (k < sources.length && (sources[k]?.name.startsWith('std/') ?? false)) k++;
  const std = sources.slice(0, k);
  const entry = (x: Source): string => JSON.stringify([x.name, x.text]);
  let kept = stdPrefix;
  if (kept === null || kept.files.length !== k || std.some((x, i) => x !== kept?.files[i])) {
    kept = { files: std, h: new Sha256().update(UTF8.encode(`[[${std.map(entry).join(',')}`)) };
    stdPrefix = kept;
  }
  const rest = sources.slice(k).map(entry).join(',');
  const tail = `${k > 0 && k < sources.length ? ',' : ''}${rest}],${JSON.stringify([pin]).slice(1, -1)}]`;
  return kept.h.clone().update(UTF8.encode(tail)).hex().slice(0, 16);
}
type HostParam = { name: string; type: string };
/** What a build gives: the module, and what the host and the tools read beside it. */
export type Built = {
  wasm: Uint8Array<ArrayBuffer>;
  errors: never[];
  /** each recursive function's weight against the depth budget, by its name (common.ts DEPTH_BUDGET; interp.ts) */
  levels: Record<string, number>;
  /** what the rules found, when the build was asked to go on anyway (`rules: false`) */
  refused: Problem[];
  queries: QueryEntry[];
  sites: Site[];
  flags: { name: string; type: string; default: number | boolean; at: number; pinned?: unknown }[];
  entry: HostParam[];
  calls: CallDecl[];
  methods: { name: string; fingerprint: string; params: HostParam[] }[];
  schemas: { name: string; input: JsonSchema; output: JsonSchema; error: JsonSchema }[];
  build: string;
  schema: string[];
  migrations: ReturnType<typeof chainOf>;
  machines: { table: string; column: string; start: string | null; states: string[]; moves: string[][] }[];
  invariants: ReturnType<typeof checkInvariants>;
  json: {
    replies: Record<string, JsonSchema | null>;
    /** each call's refusal: the JSON Schema of the error type it names */
    refusals: Record<string, JsonSchema | null>;
    decodes: Record<string, JsonSchema | null>;
  };
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
  bindFieldNames(prog);
  resolvePipes(prog);
  fuseRanges(prog);
  ambient(prog);
  granted(prog);
  rowColumns(prog);
  // the rules, read from the program as written (before the generated functions are added); reported only once the
  // program has type-checked, so a type error is shown first
  const ruled = [...rules(prog), ...tidy(prog), ...statusLiterals(prog), ...fetchKeys(prog)];
  const sqlFound: Problem[] = [];
  const invariants = checkInvariants(prog, sqlFound);
  // an interface's name is a capability type, like Remote, for this build only
  for (const n of prog.interfaces.keys()) addCapability(n);
  const served = serve(prog);
  // the function the host calls as `handle`: the program's handle, its Response written in the host's frame
  const entry = answer(prog);
  const WIRE = wireSource(prog);
  if (WIRE.text) parse('wire', WIRE.text, prog);
  return { prog, ruled, sqlFound, invariants, served, entry, WIRE };
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
  const calls: CallDecl[] = [];
  const sites: Site[] = [];
  const table: string[] = [];
  const replies: SimJson = {};
  const refusals: SimJson = {};
  const decodes: SimJson = {};
  return { calls, sites, table, flagRead: new Set<string>(), SIMJSON: { replies, refusals, decodes } };
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
  const { prog, WIRE, sqlFound } = fr;
  const { tables, callsOf } = parts;
  const { fns, ctors, types } = prog;
  const find = (n: string, file: string, at?: Place): FnDecl | null => mod.find(prog, n, file, at);
  const ownedParams = ownedParameters(fns, find, opts.reuse, opts.ownershipRounds);
  // what both sides must agree on: the method, its message, its reply and its error (a capability's is text), so a
  // caller built against another error type is told Skew before anything runs, never handed a refusal it cannot read
  const fingerprint = (method: string, send: Type, reply: Type, error: Type, at: Place): string =>
    sha256(
      UTF8.encode(
        JSON.stringify([
          method,
          layout.describe(L, send, at),
          layout.describe(L, reply, at),
          error.name === 'View' ? 'View' : layout.describe(L, error, at),
        ]),
      ),
    ).slice(0, 16);
  for (const n of Object.keys(opts.pin))
    if (!prog.flags.some(x => x.name === n))
      fail(
        null,
        'C37',
        `cannot pin ${n}: the program declares no such flag`,
        `Pin a flag the program declares${prog.flags.length > 0 ? `: ${prog.flags.map(x => x.name).join(', ')}` : '; it declares none'}.`,
      );
  const shared = { WIRE, callsOf, fns, opts, prog, sqlFound, ctors, types, find, fingerprint };
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
    fnAt: (index: number) => tables.order[index - tables.first],
    freeList: (size: number) => mod.freeList(tables, size),
    literal: (bytes: readonly number[]) => mod.literal(tables, bytes),
    constData: (bytes: readonly number[]) => mod.constData(tables, bytes),
    room: (size: number) => mod.room(tables, size),
    queryId: (q: Omit<QueryEntry, 'run'>) => mod.queryId(tables, q),
    reads: (f: FnDecl, i: number) =>
      opts.reuse && !(f.owns?.includes(i) ?? false) && ownedParams.get(f.base ?? f.name)?.[i] === false,
    rowOf: (t: Type, at: Place) => layout.rowOf(L, t, at),
    rowKind: (f: { type: Type }) => layout.rowKind(L, f),
    fieldlessIn: (t: Type) => layout.fieldlessIn(L, t),
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
  const counters = { lambdas: 0 };
  const compileFn = functionCompiler(kit, counters);
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
  // a flag read only by a function the exports do not reach (`handle`, when the doc examples are the exports) is read
  const readUnreached = checkUnreached(fr, opts, L, { imports, callsOf, counters }, tables);
  for (const fl of prog.flags)
    if (!filled.flagRead.has(fl.name) && !readUnreached.has(fl.name))
      fail(
        fl,
        'C38',
        `flag ${fl.name} is never read`,
        `Delete the declaration, or read it with \`flags.${fl.name}\`. A flag nothing reads is a rollout that already finished.`,
      );
  const levels = levelsOf(compiled);
  return { imports, tables, compiled, levels, fingerprint: kit.fingerprint, resolve: kit.resolve, ...filled };
}

/** n as an i32.const's 5-byte LEB, the size of the place left for it (function.ts WEIGHT_SLOT). */
const leb5 = (n: number): number[] => [
  (n & 127) | 128,
  ((n >> 7) & 127) | 128,
  ((n >> 14) & 127) | 128,
  ((n >> 21) & 127) | 128,
  (n >> 28) & 7,
];
/**
 * Each recursive function's weight against the depth budget: LEVEL_BASE and the most parameters and locals of any
 * copy of it (a generic function's copies share one weight, so it is a function's, by name, as the interpreter
 * knows it), written where each copy's code left a place for it.
 */
function levelsOf(compiled: Compiled[]): Map<string, number> {
  const w = new Map<string, number>();
  for (const c of compiled)
    if (c.level) w.set(c.level.of, Math.max(w.get(c.level.of) ?? 0, LEVEL_BASE + c.level.slots));
  compiled.forEach((c, i) => {
    if (!c.level) return;
    const body = [...c.body],
      bytes = leb5(w.get(c.level.of) ?? 0);
    for (const at of c.level.at) body.splice(at, 5, ...bytes);
    compiled[i] = { ...c, body };
  });
  return w;
}

/**
 * Every function the exports do not reach, type-checked all the same: compiled into tables of its own and thrown
 * away, so a mistake in a function nothing calls yet is the program's error, at its line, and the module is what it
 * was. A generic function is checked where it is called, for the types it is called with. Gives the flags they read.
 */
function checkUnreached(
  fr: Front,
  opts: Options,
  L: layout.Layouts,
  parts: { imports: mod.Imports; callsOf: mod.CallGraph; counters: { lambdas: number } },
  reached: mod.Tables,
): ReadonlySet<string> {
  const { prog } = fr;
  const rest = [...prog.fns.values()].filter(f => f.tparams.length === 0 && !reached.indexOf.has(f.name));
  if (rest.length === 0) return new Set();
  const tables = mod.tables(prog, parts.imports.FIRST);
  const filled = filling();
  const kit = toolkit(fr, opts, L, { tables, imports: parts.imports, callsOf: parts.callsOf, filled });
  const check = functionCompiler(kit, parts.counters);
  for (const f of rest) check(f);
  return filled.flagRead;
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
    fingerprint: fingerprint(f.method, resolve(f.message), resolve(f.reply), resolve(f.error), f),
    params: hostParams(prog.fns.get(`serve_${f.method}`)),
  }));
  const schemas = served.map((f: Served) => ({
    name: f.method,
    input: jsonSchema(L, resolve(f.message), f),
    output: jsonSchema(L, resolve(f.reply), f),
    error: key(f.error) === 'View' ? { type: 'string' } : jsonSchema(L, resolve(f.error), f),
  }));
  const settled = (part: SimJson): Record<string, JsonSchema | null> =>
    Object.fromEntries(Object.entries(part).map(([k, v]) => [k, Array.isArray(v) ? schemaOr(L, v) : v]));
  const json = {
    replies: settled(SIMJSON.replies),
    refusals: settled(SIMJSON.refusals),
    decodes: settled(SIMJSON.decodes),
  };
  return {
    json,
    entry: hostParams(prog.fns.get('handle')),
    methods,
    schemas,
    // The build's name: a hash of the sources and the pinned flags. A traced build of the same sources has the
    // same name, so its replays are accepted; any other change to the program gives another.
    build: buildName(sources, opts.pin),
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
  const { tables, calls, sites } = done;
  const { bytes: flagBytes, flags } = flagsOf(prog, opts);
  const about = describeModule(fr, opts, sources, L, done);
  const queries: QueryEntry[] = tables.queries;
  const custom: [string, unknown][] = [
    ['queries', queries],
    ['schema', prog.schema],
    ['migrations', about.migrations],
    ['flags', flags],
    ['entry', about.entry],
    ['calls', calls],
    ['methods', about.methods],
    ['build', about.build],
    // the step accounting this module was built for (compiler/step-version.ts): a count is comparable only within it
    ['step_version', STEP_VERSION],
  ];
  // only a program that declares a machine has this section
  if (about.machines.length > 0) custom.push(['machines', about.machines]);
  if (invariants.length > 0) custom.push(['invariants', invariants]);
  const { imports, table, compiled } = done;
  const wasm = assemble({ imports, opts, tables, table, compiled, flagBytes, custom, entry: fr.entry });
  return {
    wasm,
    errors: [],
    refused: found,
    queries,
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
    levels: Object.fromEntries(done.levels),
    options: opts,
  };
}

export function build(sources: readonly Source[], opts0: Options): Built {
  return builds(sources, opts0, [])[0];
}

/**
 * The module for opts0, then one more for each of `also` (opts0 with those options over it), all from one front:
 * the sources lexed, parsed, checked and ruled once. What differs between them is code generation only (a traced
 * build, { trace: true }, adds its trace calls), and the problems are the first's: the others are made only when it
 * has none to throw. The hosted run's line trace compiled the program twice, half its CPU (profiles of tape
 * dddd2c92, 2026-11-23); test/builds.ts checks each module is byte for byte the one a build of its own makes.
 */
export function builds(
  sources: readonly Source[],
  opts0: Options,
  also: readonly Partial<Options>[],
): [Built, ...Built[]] {
  const fr = front(sources);
  const { prog, served } = fr;
  // `handle` is exported as the generated function around it (compiler/gen/answer.ts), and every method as its own
  const exported = (names: readonly string[]): string[] => [
    ...names.flatMap(n => (n !== 'handle' ? [n] : fr.entry !== null ? [fr.entry] : served.length === 0 ? [n] : [])),
    ...served.map(f => `serve_${f.method}`),
  ];
  const opts: Options = { ...opts0, exports: exported(opts0.exports) };
  const found: Problem[] = [];
  // emitting adds functions to the program (a generic one per type arguments, a lambda, a trampoline), each with
  // its types resolved for that build: each later build starts from the functions as they were written
  const written = new Map(prog.fns);
  const made = finish(fr, opts, sources, found);
  // the rules' problems and the queries' (C67-C69, found while emitting), in the order of the source
  const byPlace = (a: Problem, b: Problem): number =>
    a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code);
  found.push(...[...fr.ruled, ...fr.sqlFound].toSorted(byPlace));
  // rules: false builds the module anyway and returns what the rules found as `refused` (sim.ts runs such a
  // program to see whether what a rule refuses is a bug the simulator finds too); nothing else reads the option
  const [first] = found;
  if (first && opts.rules !== false) throw new CompileError(first, found);
  // emitting adds the queries' problems to the front's list: each later build starts from the list as it stood
  const sql = fr.sqlFound.length;
  const rest = also.map(o => {
    prog.fns.clear();
    for (const [n, f] of written) prog.fns.set(n, f);
    const b = finish(fr, { ...opts, ...o, exports: o.exports ? exported(o.exports) : opts.exports }, sources, [
      ...found,
    ]);
    fr.sqlFound.length = sql;
    return b;
  });
  return [made, ...rest];
}
