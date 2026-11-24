// bench/suite/blog.ts: the renderer and the blog as workloads. Neither has a JS twin, so they are not in NAMES and
// the tape/js table does not run them. node bench/suite/profile.ts <name> tape-nolog profiles one.
// The blog's file is compiled first. A name is the first file's (LANGUAGE.md §4), so its handle is the entry and
// the renderer's is md.handle, typechecked and left out of the module. The blog calls the renderer's write_doc.
// SQL, the clock and an operator's request are all things the harness already does, so the write, the cached read,
// the index and the feed all run. Date.now is pinned: the feed formats it by walking years from 1970, and that
// walk's steps would change on New Year's Day. The instant is 2026-11-24T12:00:00.000Z.
import { readFileSync } from 'node:fs';
import type { Workload } from './common.ts';

const enc = new TextEncoder();
const MARKDOWN = readFileSync(new URL('../../corpus/blog.md', import.meta.url), 'utf8');

/** Pinned Date.now for every workload here, milliseconds since 1970. */
export const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
export const TITLE = 'Sunset in Integers';
const DAY = '2026-11-24';
const SLUG = 'sunset';

function request(method: string, target: string, headers = '', body = ''): Uint8Array {
  const line = headers === '' ? `${method} ${target}` : `${method} ${target}\r${headers}`;
  return enc.encode(`${line}\n${body}`);
}

/** md.tape's one route: the post's Markdown in, its HTML out. */
export const renderRequest = (): Uint8Array => request('POST', '/render', '', MARKDOWN);
/** A first write of the post. `k` keeps each sample's idempotency key its own. */
export const putRequest = (k: number): Uint8Array =>
  request('PUT', `/posts/${SLUG}`, `x-title: ${TITLE}\rx-date: ${DAY}\ridempotency-key: sunset-${k}`, MARKDOWN);
export const getRequest = (): Uint8Array => request('GET', `/posts/${SLUG}`);
/** The article HTML alone, the bytes POST /render answers. */
export const bodyRequest = (): Uint8Array => request('GET', `/posts/${SLUG}/body`);
export const indexRequest = (): Uint8Array => request('GET', '/');
export const feedRequest = (): Uint8Array => request('GET', '/feed.xml');

const blog = {
  tape: 'corpus/blog.tape',
  more: ['corpus/md.tape'],
  sql: true,
  now: NOW,
  twin: false,
} as const;

function noTwin(name: string): Workload['js'] {
  return () => req => {
    throw new Error(`${name} has no JS twin (${req.length} bytes)`);
  };
}

function workload(name: string, describe: string, requestOf: Workload['request'], extra: Partial<Workload>): Workload {
  return {
    name,
    describe,
    ...blog,
    js: noTwin(name),
    inputs: () => [],
    request: requestOf,
    ...extra,
  };
}

export const workloads: Readonly<Record<string, Workload>> = {
  md: {
    name: 'md',
    describe: 'render corpus/blog.md to HTML (corpus/md.tape, POST /render)',
    tape: 'corpus/md.tape',
    sql: false,
    now: NOW,
    twin: false,
    js: noTwin('md'),
    inputs: () => [],
    request: () => renderRequest(),
  },
  'blog-put': workload(
    'blog-put',
    'write the post: PUT renders corpus/blog.md into the cache (a new database each request)',
    k => putRequest(k),
    { fresh: true },
  ),
  'blog-get': workload(
    'blog-get',
    'read the post back: the PUT is not timed, and the GET is a cache hit',
    () => getRequest(),
    { opening: k => [putRequest(k)] },
  ),
  'blog-index': workload('blog-index', 'the index of one post: the PUT is not timed', () => indexRequest(), {
    opening: k => [putRequest(k)],
  }),
  'blog-feed': workload(
    'blog-feed',
    'the Atom feed of one post: the PUT is not timed, and the clock is pinned',
    () => feedRequest(),
    { opening: k => [putRequest(k)] },
  ),
};
