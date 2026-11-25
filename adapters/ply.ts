// adapters/ply.ts: a git repository as a Tape capability, implemented with ply (github.com/ivarvong/ply).
//   services: { repo: plyRepo({ ply, url, auth, author, refs: ['main'], paths: 'docs/', write: true }) }
// `ply` is the imported module, so Tape itself depends on nothing. The capability is one repository: the URL
// and credentials stay here and never reach the program or its effect log. `refs` and `paths` narrow it further;
// `write: false` makes it read-only.
//
// Interface (see examples/bump.tape):
//   read  head(Ref) -> Head                 the commit a branch points at
//   read  read_file(ReadFile) -> File       a text file, up to `maxBytes`
//   write edit_file(Edit) -> Edited         replace exactly one occurrence and push
//
// A write must say which head it expects and what time to stamp, so the commit it makes is a function of the
// message alone. That is what makes sending it again safe: if the branch has already moved to a commit whose
// parent, message and time are the ones in the message, that commit is ours and the answer is the same as the
// first time. ply reports a push that may have landed as `ambiguous`; the same check settles it.
import type { Service, ServiceReply } from '../host.ts';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const short = (ref: string): string => ref.replace(/^refs\/heads\//, '');

type Failed = { ok: false; error: { code?: string } };
type Result<T> = { ok: true; value: T } | Failed;
type Commit = { oid: string; parents?: string[]; message: string; author?: { epoch?: number } };
type Options = { auth: unknown; signal: AbortSignal };
/** The part of ply this adapter uses. */
export type Ply = {
  readCommit: (url: string, at: { ref: string }, o: Options) => Promise<Result<Commit | { empty: true }>>;
  readFile: (
    url: string,
    at: { ref: string; path: string },
    o: Options,
  ) => Promise<Result<{ size: number; stream: ReadableStream<Uint8Array> }>>;
  editFile: (
    url: string,
    edit: {
      ref: string;
      path: string;
      find: string;
      replace: string;
      message: string;
      author: Author & { time: number };
    },
    o: Options & { head: string; strictHead: boolean },
  ) => Promise<Result<{ newCommit: string; noop?: boolean }>>;
};
export type Author = { name: string; email: string };
export type PlyRepo = {
  ply: Ply;
  url: string;
  auth?: unknown;
  author: Author;
  /** the branches the program may touch; null for any */
  refs?: readonly string[] | null;
  /** the path prefix it may touch */
  paths?: string;
  write?: boolean;
  maxBytes?: number;
};
/** A message of the interface, as the program sent it: a field that is not there reads as '' or 0. */
type Message = {
  ref: string;
  path: string | undefined;
  find: string;
  replace: string;
  message: string;
  time: number;
  expected: string;
};
function messageOf(bytes: Uint8Array): Message {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const m: Record<string, unknown> =
    typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
  const text = (name: string): string => (typeof m[name] === 'string' ? m[name] : '');
  return {
    ref: text('ref'),
    path: typeof m['path'] === 'string' ? m['path'] : undefined,
    find: text('find'),
    replace: text('replace'),
    message: text('message'),
    time: typeof m['time'] === 'number' ? m['time'] : 0,
    expected: text('expected'),
  };
}
const ok = (value: unknown): ServiceReply => ({ status: 'ok', body: enc.encode(JSON.stringify(value)) });
const skew = (why: string): ServiceReply => ({ status: 'skew', body: enc.encode(why) });
const no = (reason: string): ServiceReply => ({ status: 'rejected', body: enc.encode(reason) });
const codeOf = (r: Failed): string => r.error.code ?? JSON.stringify(r.error);
const UNSURE = new Set(['cas_conflict', 'moved', 'ambiguous', 'stale_expected']);
type Repo = Required<Omit<PlyRepo, 'auth' | 'refs'>>;

async function head({ ply, url }: Repo, m: Message, o: Options): Promise<ServiceReply> {
  const r = await ply.readCommit(url, { ref: short(m.ref) }, o);
  if (!r.ok) return no(codeOf(r));
  return 'empty' in r.value ? no('empty') : ok({ commit: r.value.oid });
}

async function readFile({ ply, url, maxBytes }: Repo, m: Message, o: Options): Promise<ServiceReply> {
  const r = await ply.readFile(url, { ref: short(m.ref), path: m.path ?? '' }, o);
  if (!r.ok) return no(codeOf(r));
  if (r.value.size > maxBytes) {
    await r.value.stream.cancel();
    return no('too_large');
  }
  try {
    const content = dec.decode(new Uint8Array(await new Response(r.value.stream).arrayBuffer()));
    return ok({ content, size: r.value.size });
  } catch {
    return no('not_text');
  }
}

/** The branch's commit, when it is the one this message would have made; else null. */
async function mine({ ply, url }: Repo, m: Message, o: Options): Promise<string | null> {
  const now = await ply.readCommit(url, { ref: short(m.ref) }, o);
  if (!now.ok || 'empty' in now.value) return null;
  const { oid, parents, message, author } = now.value;
  return parents?.[0] === m.expected && message.trimEnd() === m.message.trimEnd() && author?.epoch === m.time
    ? oid
    : null;
}

async function editFile(repo: Repo, m: Message, o: Options): Promise<ServiceReply> {
  if (!repo.write) return no('read_only');
  const { ply, url, author } = repo;
  const edit = {
    ref: `refs/heads/${short(m.ref)}`,
    path: m.path ?? '',
    find: m.find,
    replace: m.replace,
    message: m.message,
    author: { ...author, time: m.time },
  };
  // ply's `head` is the commit we expect the branch to be at; `strictHead` makes that a precondition
  const r = await ply.editFile(url, edit, { ...o, head: m.expected, strictHead: true });
  if (r.ok) return ok({ commit: r.value.newCommit, noop: r.value.noop === true });
  // the branch is not where the message expected, or the push may have landed: is the commit there ours?
  const oid = UNSURE.has(codeOf(r)) ? await mine(repo, m, o) : null;
  return oid === null ? no(codeOf(r)) : ok({ commit: oid, noop: false });
}

const METHODS: Readonly<Record<string, (repo: Repo, m: Message, o: Options) => Promise<ServiceReply>>> = {
  head,
  read_file: readFile,
  edit_file: editFile,
};

export function plyRepo(given: PlyRepo): Service {
  const { ply, url, auth, author, refs = null, paths = '', write = true, maxBytes = 1 << 20 } = given;
  const repo: Repo = { ply, url, author, paths, write, maxBytes };
  const allowed = (ref: string, path: string | undefined): boolean =>
    (!refs || refs.includes(short(ref))) &&
    (path === undefined || (path.startsWith(paths) && !path.split('/').includes('..')));
  return (bytes, { method, signal }) => {
    const run = METHODS[method];
    if (!run)
      return Promise.resolve(skew(`no method ${method} here; this adapter serves: ${Object.keys(METHODS).join(', ')}`));
    const message = messageOf(bytes);
    return allowed(message.ref, message.path) ? run(repo, message, { auth, signal }) : Promise.resolve(no('forbidden'));
  };
}
