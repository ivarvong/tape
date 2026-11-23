// headers.ts: the headers on every response the Worker gives. The site's pages and files are the static assets',
// with the headers in their _headers, and only they may be indexed. Nothing the Worker answers is sniffed, framed or
// indexed, and nothing runs script: the API's JSON and text are sandboxed with nothing allowed; a trace page may use
// its own inline style; a program's own HTML or SVG (its operator route and its public route) may use inline style
// and data: images and post its forms to itself, and runs sandboxed, so it has no origin and runs no script. Every
// response names the commit it was built from (tape-version) and the Worker version (tape-worker-version).
// (Not in index.ts: with static assets, the main module may export only entrypoints.)
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
export const TRACE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox";
export const PROGRAM_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-forms";
const PROGRAM_PATH = /^\/p\/|^\/[^/]+\/[^/]+\/v\/\d+(\/|$)/;
/** The commit this Worker was built from (vite.config.ts), or "dev" in the tests. */
const SHA = typeof TAPE_VERSION === 'string' ? TAPE_VERSION : 'dev';
/** The compiler built in (scripts/sha.ts), or "dev" in the tests. */
const COMPILER = typeof TAPE_COMPILER === 'string' ? TAPE_COMPILER : 'dev';
export const secured = (res: Response, path: string, version?: string): Response => {
  const out = new Response(res.body, res),
    h = out.headers,
    type = h.get('content-type') ?? '',
    active = /^(text\/html|image\/svg\+xml)\b/.test(type);
  h.set('tape-version', SHA);
  // tape-mcp's answers through the binding keep the compiler it names: the deploy's parity check compares the two
  if (!h.has('tape-compiler')) h.set('tape-compiler', COMPILER);
  if (version !== undefined) h.set('tape-worker-version', version);
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'no-referrer');
  h.set('x-robots-tag', 'noindex');
  h.set('content-security-policy', !active ? API_CSP : PROGRAM_PATH.test(path) ? PROGRAM_CSP : TRACE_CSP);
  return out;
};
