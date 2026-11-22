// sim/model.ts: a model from the programs alone. auto([{ name, text }]) gives everything a run needs, read from
// the programs; `tape sim a.tape b.tape` is this.
//   requests   every route the entry program names (routes.ts), with a body of the type the arm decodes; ids and
//              keys seen in earlier answers come back in later requests
//   values     from each type's JSON Schema, bounds of refinements included (values.ts); text from the programs'
//              own seed rows, so a card or a sku that exists is sent (dictionary.ts)
//   remotes    a Remote that no file serves is stood in for by the reply type of each call
//   checks     the invariants the programs declare, a run that fails, and timers that never stop
import { parseProgram } from '../compiler.ts';
import type { Program } from '../compiler/ast.ts';
import type { Problem } from '../compiler/common.ts';
import { std } from '../std.ts';
import { dictionaryOf } from './dictionary.ts';
import type { Dictionary } from './dictionary.ts';
import { build } from './engine.ts';
import type { Answer, BuiltProgram, Mem, Model, Op, Request } from './engine.ts';
import { routesOf } from './routes.ts';
import type { Part, Route, Unread } from './routes.ts';
import { valueOf } from './values.ts';
import type { Json, Schema } from './values.ts';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isSuccess = (status: number): boolean => status >= 200 && status < 300;
const isKeyName = (name: string): boolean => /^(key|client|op|once|idempotency)/.test(name);
const words = (lit: string): string[] => lit.split('/').filter(Boolean);

// The kind of thing a number in a path is: the word before it. /holds/<n> takes the id of a hold, not an event.
const kindBefore = (path: readonly Part[], i: number): string => words(path[i - 1]?.lit ?? '').pop() ?? '';

// What an answer to a route holds ids of: the last word of the path (/events/<n>/tiers answers with a tier), or
// for a path that ends in a number (/holds/<n>) its first word.
function kindAnswered(route: Route): string {
  const all = route.path.flatMap(p => (p.lit ? words(p.lit) : []));
  return (route.path.at(-1)?.lit ? all.at(-1) : all[0]) ?? '';
}

// The routes that take an id of a kind this client was given or has seen listed.
const followUps = (routes: readonly Route[], kinds: readonly string[]): Route[] =>
  kinds.length === 0
    ? []
    : routes.filter(route =>
        route.path.some((part, i) => part.int !== undefined && kinds.includes(kindBefore(route.path, i))),
      );

/** What the clients of a run have learnt between them: ids by kind, keys, words said, and the writes sent. */
type Notes = {
  ids: number[];
  kinds: Record<string, number[]>;
  keys: string[];
  said: Record<string, string[]>;
  dict: Dictionary;
  past: { route: string; req: Request }[];
  fix: Readonly<Record<string, number>>;
};
/** One client's own: the route it last sent to, the kind that answers with, and the ids it was given. */
type Own = { route: string; kind: string; own: Record<string, number[]> };
type Tally = { sent: number; ok: number; statuses: Record<number, number> };
type Asking = {
  routes: readonly Route[];
  decodes: Readonly<Record<string, Schema | null>>;
  callers: boolean;
  rand: () => number;
};

/** An id of the kind the path asks for: mostly one this client was given, as a person acts on their own things. */
function idOf({ rand }: Asking, mem: Own, notes: Notes, kind: string): number {
  const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(rand() * list.length)];
  const own = mem.own[kind] ?? [];
  const all = notes.kinds[kind] ?? [];
  if (own.length > 0 && rand() < 0.6) return own[own.length - 1 - Math.floor(rand() * Math.min(2, own.length))] ?? 0;
  if (all.length > 0 && rand() < 0.8) return pick(all) ?? 0;
  return pick(notes.ids) ?? 0;
}

/** The route this client sends to next. */
function routeFor({ routes, rand }: Asking, mem: Own, notes: Notes): Route | undefined {
  const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(rand() * list.length)];
  // a client that was given something mostly goes on with it: half the time its next request is one that takes an
  // id of a kind it holds (the hold it made is checked out, then refunded)
  const held = [...Object.keys(mem.own), ...Object.keys(notes.kinds).filter(k => (notes.kinds[k]?.length ?? 0) > 0)];
  const follow = followUps(routes, held);
  return follow.length > 0 && rand() < 0.5 ? pick(follow) : pick(routes);
}

/** A body of the type the route decodes; sometimes with a key missing. */
function bodyFor(a: Asking, schema: Schema | null | undefined, notes: Notes): Json | undefined {
  const body = schema ? valueOf(schema, a.rand, notes) : undefined;
  if (body === undefined || body === null || body === false || body === 0 || body === '' || a.rand() >= 0.06)
    return body;
  if (typeof body !== 'object' || Array.isArray(body)) return body;
  const fields = Object.keys(body);
  if (fields.length === 0) return body;
  const gone = fields[Math.floor(a.rand() * fields.length)];
  return Object.fromEntries(Object.entries(body).filter(([k]) => k !== gone));
}

// One client's next request. `notes` is what the clients of a run have learnt between them (ids by kind, keys,
// words said); `mem` is this client's own (the ids it was given).
function nextRequest(a: Asking, mem: Own, notes: Notes): Request {
  const { routes, decodes, callers, rand } = a;
  const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(rand() * list.length)];
  if (routes.length === 0) return { line: 'GET /' };

  // one request in seven is an earlier one sent again as it was: a client that got no answer, or two tabs
  const again = notes.past.length > 0 && rand() < 0.14 ? pick(notes.past.slice(-8)) : undefined;
  if (again) {
    Object.assign(mem, { route: again.route, kind: '' });
    return again.req;
  }
  const route = routeFor(a, mem, notes);
  if (!route) return { line: 'GET /' };

  const word = (name = ''): string =>
    pick([...(notes.said[name] ?? []), ...(notes.dict[name] ?? []), 'ann', 'bob']) ?? '';
  // a key in a query: mostly a new one, sometimes one used before
  const key = (): string => {
    if (notes.keys.length > 0 && rand() < 0.3) return pick(notes.keys) ?? '';
    const made = `k${notes.keys.length + 1}`;
    notes.keys.push(made);
    return made;
  };
  const inPath = (p: Part, i: number): string =>
    p.lit ?? (p.int === undefined ? word(p.word) : String(idOf(a, mem, notes, kindBefore(route.path, i))));
  const inQuery = (p: Part): string => {
    if (p.lit !== undefined) return p.lit;
    if (p.int !== undefined) return String(pick([1, 2, 3]));
    return isKeyName(p.word ?? '') ? key() : word(p.word);
  };
  const path = route.path.map(inPath).join('');
  const query = (route.query ?? []).map(inQuery).join('');

  const schema = route.body === null ? null : decodes[route.body];
  const body = bodyFor(a, schema, notes);
  Object.assign(mem, { route: route.key, kind: kindAnswered(route) });
  const method = route.method ?? (schema ? 'POST' : (pick(['GET', 'POST']) ?? 'GET'));
  const req = {
    line: `${method} ${path}${route.query ? `?${query}` : ''}`,
    via: callers && rand() < 0.2 ? 'public' : undefined,
    body,
  };
  if (WRITES.has(method)) notes.past.push({ route: route.key, req });
  return req;
}

const idIn = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && 'id' in value ? value.id : undefined;
const remember = (list: number[], value: unknown): void => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && !list.includes(value) && list.length < 12)
    list.push(value);
};
/** Every field named id anywhere in an answer can be guessed at later. */
function ids(notes: Notes, value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) ids(notes, item);
    return;
  }
  for (const [name, inner] of Object.entries(value)) {
    if ((name === 'id' || name.endsWith('_id')) && Number.isSafeInteger(inner)) remember(notes.ids, inner);
    else ids(notes, inner);
  }
}

// What an answer teaches: the id it gives is this client's own, of the kind the route answers with; ids in a list
// are known to all; and any field named id anywhere in the answer can be guessed at later.
function learn(answered: Map<string, Tally>, mem: Own, notes: Notes, res: Answer): void {
  const tally = answered.get(mem.route);
  if (tally) {
    tally.sent++;
    if (isSuccess(res.status)) tally.ok++;
    tally.statuses[res.status] = (tally.statuses[res.status] ?? 0) + 1;
  }
  if (isSuccess(res.status) && mem.kind !== '') {
    const ofKind = (notes.kinds[mem.kind] ??= []);
    const id = idIn(res.json);
    if (typeof id === 'number' && Number.isSafeInteger(id)) {
      (mem.own[mem.kind] ??= []).push(id);
      remember(ofKind, id);
    }
    if (Array.isArray(res.json)) for (const item of res.json) remember(ofKind, idIn(item));
  }
  ids(notes, res.json);
}

type Named = { name: string; text: string };
type Ready = Named & BuiltProgram & { prog: Program };
type Stubs = Record<string, Record<string, Schema | null>>;

// Remotes that some program calls and no file serves: { remote: { method: reply schema } }
function unserved(programs: readonly Ready[]): Stubs {
  const stubs: Stubs = {};
  for (const program of programs)
    for (const [call, schema] of Object.entries(program.info.json.replies)) {
      const [to = '', method = ''] = call.split('.');
      if (to !== '' && !programs.some(p => p.name === to)) (stubs[to] ??= {})[method] = schema;
    }
  return stubs;
}

export type AutoOptions = {
  rules?: boolean;
  clients?: number;
  ops?: number;
  anyone?: boolean;
  /** values to pin, by field name */
  fix?: Readonly<Record<string, number>>;
};
/** Why there is no model: what the compiler refused, by program, or that no program takes requests. */
export type Sim = Partial<Problem> & { code: string; message: string; program?: string };
export type Auto = {
  errors?: undefined;
  model: Model;
  routes: Route[];
  stubs: Stubs;
  /** what each route was answered with, over every run made from this model */
  answered: Map<string, Tally>;
  unread: Unread[];
  invariants: ({ program: string } & Ready['info']['invariants'][number])[];
  refused: (Problem & { program: string })[];
};

/** The clients' requests: each asks the model for the next one and learns from its answer. */
function requests(
  entry: Ready,
  routes: Route[],
  dict: Dictionary,
  answered: Map<string, Tally>,
  o: Required<AutoOptions>,
) {
  const callers = o.anyone && /\bAnyone\b/.test(entry.text);
  const shared = new WeakMap<object, Notes>();
  const owns = new WeakMap<Mem, Own>();
  const notesOf = (mem: Mem): Notes => {
    const made = shared.get(mem.notes) ?? { ids: [1, 2, 3], kinds: {}, keys: [], said: {}, dict, past: [], fix: o.fix };
    shared.set(mem.notes, made);
    return made;
  };
  const ownOf = (mem: Mem): Own => {
    const made = owns.get(mem) ?? { route: '', kind: '', own: {} };
    owns.set(mem, made);
    return made;
  };
  return (rand: () => number): Op => ({
    name: 'request',
    make: mem => nextRequest({ routes, decodes: entry.info.json.decodes, callers, rand }, ownOf(mem), notesOf(mem)),
    then: (mem, res) => {
      learn(answered, ownOf(mem), notesOf(mem), res);
    },
  });
}

export function auto(files: readonly Named[], options: AutoOptions = {}): Auto | { errors: Sim[] } {
  const { rules = true, clients = 3, ops = 6, anyone = true, fix = {} } = options;
  const built = files.map(file => ({ ...file, built: build(file.text, { rules }) }));
  const failed = built.flatMap(b => (b.built.errors ?? []).map(e => ({ ...e, program: b.name })));
  if (failed.length > 0) return { errors: failed };

  const programs: Ready[] = built.flatMap(b =>
    b.built.errors
      ? []
      : [
          {
            ...b.built,
            name: b.name,
            text: b.text,
            prog: parseProgram([...std, { name: 'program.tape', text: b.text }]),
          },
        ],
  );
  const entry = programs.find(p => p.prog.fns.has('handle'));
  if (!entry) return { errors: [{ code: 'sim', message: 'none of these programs has a handle to send requests to' }] };

  const unread: Unread[] = [];
  const routes = routesOf(entry.prog, entry.info.json.decodes, unread);
  // a route never answered 2xx was never really exercised, and the command says so
  const answered = new Map<string, Tally>(routes.map(r => [r.key, { sent: 0, ok: 0, statuses: {} }]));
  const stubs = unserved(programs);
  const request = requests(entry, routes, dictionaryOf(files.map(f => f.text)), answered, {
    rules,
    clients,
    ops,
    anyone,
    fix,
  });
  const model: Model = {
    modules: Object.fromEntries(programs.map(p => [p.name, p.module])),
    entry: entry.name,
    stubs,
    machines: Object.fromEntries(programs.map(p => [p.name, p.info.machines])),
    queries: Object.fromEntries(programs.map(p => [p.name, p.info.queries])),
    clients: rand => Array.from({ length: clients }, () => Array.from({ length: ops }, () => request(rand))),
  };
  return {
    model,
    routes,
    stubs,
    answered,
    unread,
    invariants: programs.flatMap(p => p.info.invariants.map(v => ({ program: p.name, ...v }))),
    refused: programs.flatMap(p => p.refused.map(e => ({ ...e, program: p.name }))),
  };
}
