// headers.ts: the headers on every response the Worker gives. The site's pages and files are the static assets',
// with the headers in their _headers, and only they may be indexed. Nothing the Worker answers is sniffed, framed or
// indexed, and nothing runs script: the API's JSON and text are sandboxed with nothing allowed; a trace page may use
// its own inline style; a program's own HTML or SVG (its operator route and its public route) may use inline style,
// show images from this origin and data: URLs, and post its forms to itself, and runs sandboxed, so it has no
// origin and runs no script.
// Chrome renders application/atom+xml, application/rss+xml and application/xml as pages: a script in the XHTML or
// SVG namespace runs, and nosniff does not stop it. Those types stay on the API policy (sandbox, default-src
// 'none'), which is what stops the script and any fetch. The page policy's extra allowances are for HTML and SVG.
// A host that serves these types must send that policy. application/xhtml+xml is not a type a program can name: a
// page is Html.
// An image from this origin is what a page needs to show a chart another of its routes draws (`<img src="chart">`,
// apps/products/FRICTION.md #16); it makes nothing active: an image runs no script. An SVG's script is not run in
// an img (Chrome 131, 24 November 2026). Every response here is nosniff, a route that needs
// a token gets none from a page (there are no cookies), and a GET of a public route is what any page anywhere can
// already cause. Nothing is fetched from another origin. Every response names the commit it was built from
// (tape-version) and the Worker version (tape-worker-version). The step accounting is on the count it goes with
// (the log, the trace), not on the response: a header from the compiler deployed now would disagree with a count
// recorded earlier.
// (Not in index.ts: with static assets, the main module may export only entrypoints.)
import { COMPILER } from './build.ts';

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
export const TRACE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox";
export const PROGRAM_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-forms";
// On a program's own origin (session.ts) its page keeps that origin (allow-same-origin), so a form it posts to
// itself carries its SameSite=Lax session cookie; it still runs no script. The origin is the program's alone.
export const SITE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-forms allow-same-origin";
const PROGRAM_PATH = /^\/p\/|^\/[^/]+\/[^/]+\/v\/\d+(\/|$)/;
/** The commit this Worker was built from (vite.config.ts), or "dev" in the tests. */
const SHA = typeof TAPE_VERSION === 'string' ? TAPE_VERSION : 'dev';
export const secured = (res: Response, path: string, version?: string, site = false): Response => {
  const out = new Response(res.body, res),
    h = out.headers,
    type = h.get('content-type') ?? '',
    // HTML and SVG get the page policy. XML is rendered too, and stays on the API policy: that policy is what
    // stops a script in the document.
    active = /^(text\/html|image\/svg\+xml)\b/.test(type);
  h.set('tape-version', SHA);
  // the hosted runner's answers (mcp/src) keep the compiler it names: the deploy's parity check compares the two
  if (!h.has('tape-compiler')) h.set('tape-compiler', COMPILER);
  if (version !== undefined) h.set('tape-worker-version', version);
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'no-referrer');
  h.set('x-robots-tag', 'noindex');
  h.set(
    'content-security-policy',
    !active ? API_CSP : site ? SITE_CSP : PROGRAM_PATH.test(path) ? PROGRAM_CSP : TRACE_CSP,
  );
  return out;
};
