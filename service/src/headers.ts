// headers.ts: the headers on every response the Worker gives. The site's pages and files are the static assets',
// with the headers in their _headers, and only they may be indexed. Nothing the Worker answers is sniffed, framed or
// indexed, and nothing runs script: the API's JSON and text are sandboxed with nothing allowed; a trace page may use
// its own inline style; a program's own HTML or SVG (its operator route and its public route) may use inline style,
// show images from this origin and data: URLs, and post its forms to itself, and runs sandboxed, so it has no
// origin and runs no script. A program's Atom, RSS or XML is a document, not a page, so it takes the API's policy,
// the same as JSON: an xml-stylesheet processing instruction cannot fetch anything. application/xhtml+xml is not a
// type a program can name, because a browser would run it as a page. An image from this origin is what a page needs
// to show a chart another of its routes draws (`<img src="chart">`, apps/products/FRICTION.md #16); it makes nothing
// active: an image runs no script (an
// SVG's is not run in an <img>: Chrome 131, 24 November 2026), every response here is nosniff, a route that needs
// a token gets none from a page (there are no cookies), and a GET of a public route is what any page anywhere can
// already cause. Nothing is fetched from another origin. Every response names the commit it was built from
// (tape-version), the step accounting that compiler builds (tape-step-version) and the Worker version
// (tape-worker-version).
// (Not in index.ts: with static assets, the main module may export only entrypoints.)
import { STEP_VERSION } from '../../compiler/step-version.ts';
import { COMPILER } from './build.ts';

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
export const TRACE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox";
export const PROGRAM_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-forms";
const PROGRAM_PATH = /^\/p\/|^\/[^/]+\/[^/]+\/v\/\d+(\/|$)/;
/** The commit this Worker was built from (vite.config.ts), or "dev" in the tests. */
const SHA = typeof TAPE_VERSION === 'string' ? TAPE_VERSION : 'dev';
export const secured = (res: Response, path: string, version?: string): Response => {
  const out = new Response(res.body, res),
    h = out.headers,
    type = h.get('content-type') ?? '',
    // HTML and SVG are rendered. XML documents (Atom, RSS, application/xml) are not: they stay on the API policy.
    active = /^(text\/html|image\/svg\+xml)\b/.test(type);
  h.set('tape-version', SHA);
  h.set('tape-step-version', String(STEP_VERSION));
  // the hosted runner's answers (mcp/src) keep the compiler it names: the deploy's parity check compares the two
  if (!h.has('tape-compiler')) h.set('tape-compiler', COMPILER);
  if (version !== undefined) h.set('tape-worker-version', version);
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'no-referrer');
  h.set('x-robots-tag', 'noindex');
  h.set('content-security-policy', !active ? API_CSP : PROGRAM_PATH.test(path) ? PROGRAM_CSP : TRACE_CSP);
  return out;
};
