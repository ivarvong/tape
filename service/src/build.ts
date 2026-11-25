// build.ts: a program's source to what an upload stores, and what the compiler deployed now says of a version
// stored before.
import { compile, parseProgram } from '../../compiler.ts';
import type { Built } from '../../compiler.ts';
import type { Program } from '../../compiler/ast.ts';
import { machinePlan } from '../../rules.ts';
import type { MachinePlan } from '../../rules/plan.ts';
import core from '../../std/core.tape?raw';
import text from '../../std/text.tape?raw';
import json from '../../std/json.tape?raw';
import http from '../../std/http.tape?raw';
import list from '../../std/list.tape?raw';
import map from '../../std/map.tape?raw';
import retry from '../../std/retry.tape?raw';
import time from '../../std/time.tape?raw';

/** The compiler built in (scripts/sha.ts, vite.config.ts), or "dev" in the tests. A stored build says which compiler
 * made it; one made by another is made again from its source (name.ts, #fresh). */
export const COMPILER = typeof TAPE_COMPILER === 'string' ? TAPE_COMPILER : 'dev';
/** The standard library as the compiler takes it (std.ts in Node); mcp/ uses the same list. */
export const STD = Object.entries({ core, text, json, http, list, map, retry, time }).map(([n, t]) => ({
  name: `std/${n}.tape`,
  text: t,
}));
const withStd = (source: string): { name: string; text: string }[] => [...STD, { name: 'program.tape', text: source }];
const MAX_ROW = 7_500_000; // a SQLite row holds at most 8 MB; one version is one row

/** A problem as the service reports it. */
export type Reported = { code: string; line: number; message: string; hint?: string };
/** Why something was not done, as the status and body of the answer. */
export type Refusal = { status: number; error: string; errors?: Reported[] };
/** What an upload stores of a program: its two builds and what the supervisor reads of them. */
export type Stored = {
  plain: Built['wasm'];
  traced: Built['wasm'];
  sites: Built['sites'];
  migrations: Built['migrations'];
  /** the schema statements, before any migration */
  base: string[];
  methods: Built['methods'];
  schemas: Built['schemas'];
  entry: Built['entry'];
  /** the schema at this program's chain point: its schema, then every migration */
  schema: string[];
  queries: string[];
};
export const isRefusal = (b: Stored | Refusal): b is Refusal => 'status' in b;

// Source to the row an upload stores, or the reason it cannot be stored. `rules: false` builds a version already
// accepted, whose source today's rules may refuse (rulesNow says so in its listing): a rebuild keeps it running.
export const build = (source: string, { rules = true }: { rules?: boolean } = {}): Stored | Refusal => {
  const sources = withStd(source),
    plain = compile(sources, { rules });
  if (plain.wasm === null)
    return {
      status: 400,
      error: 'does not compile',
      errors: plain.errors.map(({ code, line, message, hint }) => ({ code, line, message, hint })),
    };
  const traced = compile(sources, { trace: true, rules });
  // A Worker cannot compile Wasm, but it can validate it: a module the Loader would refuse is never stored.
  if (traced.wasm === null || !WebAssembly.validate(plain.wasm) || !WebAssembly.validate(traced.wasm))
    return {
      status: 500,
      error: 'the compiler produced a module that does not validate; this is a compiler bug, and nothing was stored',
    };
  const size = plain.wasm.length + traced.wasm.length + source.length;
  if (size > MAX_ROW)
    return { status: 413, error: `this program is ${size} bytes compiled; a version holds at most ${MAX_ROW}` };
  return {
    plain: plain.wasm,
    traced: traced.wasm,
    sites: traced.sites,
    migrations: plain.migrations,
    base: plain.schema,
    methods: plain.methods,
    schemas: plain.schemas,
    entry: plain.entry,
    schema: [...plain.schema, ...plain.migrations.flatMap(m => m.statements)],
    queries: plain.queries.map(q => q.sql),
  };
};

// What the compiler deployed now says of a stored version's source: [] when it passes, else the problems (its
// rules, rules.ts C51-C56, or anything else it no longer accepts). A version uploaded before a rule existed keeps
// running (rebuilt without the rules when the compiler changes, name.ts #fresh); this is how its listing, an
// upload beside it, and its KV cluster say that it would not be accepted today. Cached by hash and source, per
// isolate.
const today = new Map<string, Reported[]>();
export const rulesNow = (hash: string, source: string): Reported[] => {
  const at = `${hash}:${source}`;
  const known = today.get(at);
  if (known) return known;
  const now = compile(withStd(source)).errors.map(({ code, line, message }) => ({ code, line, message }));
  today.set(at, now);
  return now;
};
// A stored source, parsed by today's compiler, for the machine plan; null when it no longer parses. Cached likewise.
const parsed = new Map<string, Program | null>();
const progOf = (hash: string, source: string): Program | null => {
  const at = `${hash}:${source}`;
  const known = parsed.get(at);
  if (known !== undefined) return known;
  let prog: Program | null = null;
  try {
    prog = parseProgram(withStd(source));
  } catch {
    // reported by rulesNow
  }
  parsed.set(at, prog);
  return prog;
};

/** A stored version, as the plan and the rules read it. */
export type VersionRow = { version: number; hash: string; source: string; live?: boolean | number };
export type Note = { version: number; code: string; line: number; message: string };
// The machines in force on a name's data, given the versions that will be live (rules.ts, machinePlan): each
// declaring version's moves, and the moves the others make under them. `rows`: oldest first. A version whose
// source no longer parses is left out, with a note.
export const machinesFor = (rows: readonly VersionRow[]): Omit<MachinePlan, 'notes'> & { notes: Note[] } => {
  const versions: { version: number; prog: Program }[] = [],
    unparsed: number[] = [];
  for (const r of rows) {
    const prog = progOf(r.hash, r.source);
    if (prog) versions.push({ version: r.version, prog });
    else unparsed.push(r.version);
  }
  const plan = machinePlan(versions);
  const unread = unparsed.map(version => ({
    version,
    code: 'C60',
    line: 0,
    message: 'its source no longer parses, so the machines cannot read it',
  }));
  return { ...plan, notes: [...plan.notes, ...(plan.machines.length > 0 ? unread : [])] };
};
/** The live versions (but `except`) that today's compiler would not accept, each with why. */
export const failing = (
  rows: readonly VersionRow[],
  except: number | null = null,
  notes: readonly Note[] = [],
): { version: number; problems: Reported[] }[] =>
  rows
    .filter(r => r.version !== except && Boolean(r.live))
    .map(r => ({
      version: r.version,
      problems: [
        ...rulesNow(r.hash, r.source),
        ...notes.filter(n => n.version === r.version).map(({ code, line, message }) => ({ code, line, message })),
      ],
    }))
    .filter(r => r.problems.length > 0);
