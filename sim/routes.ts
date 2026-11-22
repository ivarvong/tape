// sim/routes.ts: the requests a program can be sent, read from its text. Every arm of a match that names a path
// (Request(method:, path:, query:) or a match on the path itself) is a route: its method, the parts of its path
// and query, and the type its body is decoded as.
import { partsOf, patternParts, unreachable } from '../compiler/ast.ts';
import type { Expr, FnDecl, Match, PatArm, Pattern, Program } from '../compiler/ast.ts';

const dec = new TextDecoder();
const text = (bytes: readonly number[]): string => dec.decode(new Uint8Array(bytes));

/** A part of a path or a query: `lit` is text, `int` a number, `word` anything else. */
export type Part = { lit?: string; int?: string | true; word?: string };
export type Route = { method: string | null; path: Part[]; body: string | null; query: Part[] | null; key: string };
export type Unread = { fn: string; line: number };

/** Every expression of a tree, parents first. */
const within = (e: Expr): Expr[] => [e, ...partsOf(e).flatMap(within)];
const patternsIn = (p: Pattern): Pattern[] => [p, ...patternParts(p).flatMap(patternsIn)];
const nameOf = (p: Pattern): string | undefined => ('name' in p ? p.name : undefined);

// A path pattern as parts. null when this cannot say what the pattern matches.
function pathParts(pattern: Pattern | undefined): Part[] | null {
  if (!pattern) return null;
  switch (pattern.k) {
    case 'str':
      return [{ lit: text(pattern.bytes) }];
    case 'prefix': {
      const rest = pathParts(pattern.rest);
      return rest && [{ lit: text(pattern.bytes) }, ...rest];
    }
    case 'suffix': {
      const head = pathParts(pattern.head);
      return head && [...head, { lit: text(pattern.bytes) }];
    }
    case 'bind':
      return [{ word: pattern.name }];
    case 'fn':
      return [
        pattern.name === 'decimal'
          ? { int: nameOf(pattern.sub) ?? 'n' }
          : { word: nameOf(pattern.sub) ?? pattern.name },
      ];
    case 'as':
      return pathParts(pattern.pat);
    case 'any':
    case 'int':
    case 'split':
    case 'ctor':
      return null;
    default:
      return unreachable(pattern, 'pattern');
  }
}

/** A constructor with one field (Some, a refined type) is looked through. */
const inner = (p: Pattern | undefined): Pattern | undefined => {
  const [only] = p?.k === 'ctor' && p.subs.length === 1 ? p.subs : [];
  return only ? inner(only.pat) : p;
};

// The query an arm asks for, as parts: query: Some(value: "op=" ++ Op(op)) is "op=" and a word.
function queryParts(pattern: Pattern | undefined): Part[] | null {
  const p = inner(pattern);
  if (!p) return null;
  switch (p.k) {
    case 'str':
      return [{ lit: text(p.bytes) }];
    case 'prefix': {
      const rest = queryParts(p.rest);
      return rest && [{ lit: text(p.bytes) }, ...rest];
    }
    case 'bind':
      return [{ word: p.name }];
    case 'fn':
      return p.name === 'decimal' ? [{ int: true }] : null;
    case 'any':
    case 'int':
    case 'as':
    case 'suffix':
    case 'split':
    case 'ctor':
      return null;
    default:
      return unreachable(p, 'pattern');
  }
}

type Decodes = Readonly<Record<string, unknown>>;
const isStd = (fn: FnDecl): boolean => fn.file.startsWith('std/');

// The type an arm decodes its body as: the nearest decode(json:, as: T) in the arm, or in what it calls (three
// calls deep).
function bodyType(prog: Program, decodes: Decodes, expr: Expr, depth = 0, seen = new Set<string>()): string | null {
  const calls = within(expr).flatMap(e => (e.k === 'call' ? [e] : []));
  for (const call of calls) {
    const as = call.name === 'decode' ? call.args.find(a => a.label === 'as')?.value : undefined;
    const name = as && 'name' in as ? as.name : undefined;
    if (name !== undefined && Boolean(decodes[name])) return name;
  }
  if (depth >= 3) return null;
  for (const { name } of calls) {
    const fn = prog.fns.get(name);
    if (!fn || seen.has(name) || isStd(fn)) continue;
    seen.add(name);
    const type = bodyType(prog, decodes, fn.body, depth + 1, seen);
    if (type !== null) return type;
  }
  return null;
}

const holdsSlash = (pattern: Pattern | undefined): boolean =>
  pattern !== undefined &&
  patternsIn(pattern).some(p => (p.k === 'str' || p.k === 'prefix' || p.k === 'suffix') && text(p.bytes).includes('/'));

// A route as text. `word` says how a part that is not fixed is shown: '<w>' in a route's key, the name the
// program binds it to in what `tape sim` prints.
export function routeText(route: Omit<Route, 'key'>, word: (part: Part) => string = () => '<w>'): string {
  const shown = (parts: readonly Part[]): string =>
    parts.map(p => p.lit ?? (p.int === undefined ? word(p) : '<n>')).join('');
  return `${route.method ?? '*'} ${shown(route.path)}${route.query ? `?${shown(route.query)}` : ''}`;
}

/** The route of one arm; `unread` when it is on a path this cannot turn into requests; null when it names no path. */
function routeOf(prog: Program, decodes: Decodes, arm: PatArm): Route | 'unread' | null {
  const request = arm.pat.k === 'ctor' && arm.pat.name === 'Request' ? arm.pat : null;
  const field = (name: string): Pattern | undefined => request?.subs.find(s => s.field === name)?.pat;
  const pathPattern = request ? field('path') : arm.pat;
  const path = pathParts(pathPattern);
  const first = path?.[0]?.lit;
  if (!path || first?.startsWith('/') !== true) return holdsSlash(pathPattern) && !(path && first) ? 'unread' : null;
  const method = field('method');
  const asked = field('query');
  const route = {
    method: method?.k === 'str' ? text(method.bytes) : null,
    path,
    body: bodyType(prog, decodes, arm.body),
    // without the query it asks for, the arm is never reached
    query: asked?.k === 'ctor' && asked.name === 'Some' ? queryParts(asked) : null,
  };
  return { ...route, key: routeText(route) };
}

const armsOf = (m: Match): PatArm[] => (m.subject === null ? [] : m.arms);

// The routes of a program. An arm on a path this cannot turn into requests is added to `unread` (it is never sent
// to, and `tape sim` says so).
export function routesOf(prog: Program, decodes: Decodes, unread: Unread[] = []): Route[] {
  const routes: Route[] = [];
  for (const fn of prog.fns.values()) {
    if (isStd(fn) || fn.file === 'wire') continue;
    for (const match of within(fn.body).flatMap(e => (e.k === 'match' ? [e] : [])))
      for (const arm of armsOf(match)) {
        const route = routeOf(prog, decodes, arm);
        if (route === 'unread') unread.push({ fn: fn.name, line: arm.pat.line });
        else if (route && !routes.some(r => r.key === route.key)) routes.push(route);
      }
  }
  return routes;
}
