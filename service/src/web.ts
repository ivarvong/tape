// web.ts: what the routes and the objects share: replies, hashes, signed trace links, the operator's token.
const enc = new TextEncoder();

export const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The object that lists every published account/name (the public route asks only it): no account or name can be
 * `~` (SEGMENT). */
export const PUBLISHED = '~/published';
/** The object that lists every account that has uploaded a program (POST /_rebuild walks them). */
export const ACCOUNTS = '~/accounts';
export const reply = (body: unknown, status = 200): Response => Response.json(body, { status });
export const hexOf = (buf: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const hex = async (bytes: BufferSource): Promise<string> => hexOf(await crypto.subtle.digest('SHA-256', bytes));
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** An answer of 503 because the object stopped before it answered (a deploy resets the objects it moves to a new
 * version): logged, so the deploy's telemetry gate can tell it from a fault (scripts/telemetry.ts). */
export const stopped = (e: unknown): void => {
  console.warn(JSON.stringify({ 'tape.stopped': messageOf(e).slice(0, 300) }));
};
export const randomHex = (bytes: number): string => hexOf(crypto.getRandomValues(new Uint8Array(bytes)));

const TRACE_TTL = 7 * 24 * 3600; // seconds a signed trace URL lasts
// Trace URLs are signed with the token: HMAC-SHA256 over the path and the expiry.
const hmac = (token: string, use: 'sign' | 'verify'): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, [use]);
/** The token's signature over some text, as hex. */
export const signature = async (token: string, text: string): Promise<string> =>
  hexOf(await crypto.subtle.sign('HMAC', await hmac(token, 'sign'), enc.encode(text)));
export const signed = async (token: string, origin: string, path: string): Promise<string> => {
  const exp = Math.floor(Date.now() / 1000) + TRACE_TTL;
  return `${origin}/t${path}?exp=${exp}&sig=${await signature(token, `${path}?${exp}`)}`;
};
export const verified = async (
  token: string,
  path: string,
  exp: string | null,
  sig: string | null,
): Promise<boolean> => {
  if (sig === null || !/^[0-9a-f]{64}$/.test(sig) || !(Number(exp) > Date.now() / 1000)) return false;
  const given = Uint8Array.from(sig.match(/../g) ?? [], h => Number.parseInt(h, 16));
  return crypto.subtle.verify('HMAC', await hmac(token, 'verify'), given, enc.encode(`${path}?${exp}`));
};

export const authorized = (request: Request, token: string): boolean => {
  const given = enc.encode(request.headers.get('authorization') ?? ''),
    want = enc.encode(`Bearer ${token}`);
  return given.length === want.length && crypto.subtle.timingSafeEqual(given, want);
};

// Body caps: a request's body is read as it streams and refused (413) once it passes its cap, so a body sent without
// a content-length is never read whole; a content-length over the cap is refused before anything is read.
export const BODY_MAX = 1024 * 1024; // an operator's request to a version
export const SOURCE_MAX = 1024 * 1024; // an upload's source
export const tooLarge = (what: string, max: number): Response =>
  reply({ error: `${what} is at most ${max} bytes` }, 413);
/** The request's body, if it is at most `max` bytes; null when it is longer, and the rest is not read. */
export const bodyOf = async (request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (Number(request.headers.get('content-length') ?? 0) > max) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader: ReadableStreamDefaultReader<unknown> = request.body.getReader(),
    parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk after another
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) throw new TypeError('a request body is bytes');
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

// The request headers a program sees (std/http's header_of): those that say what a client asks for and how its
// body is written, and the client's own x- headers. Never cookie, authorization (the operator's token), the
// client's address or what Cloudflare adds. Each value is cut at HEADER_VALUE_MAX.
const PASSED =
  /^(accept|accept-language|content-type|if-match|if-none-match|if-modified-since|idempotency-key|x-(?!forwarded|real-ip).+)$/;
export const HEADER_VALUE_MAX = 1024;
const passedHeaders = (request: Request): string =>
  [...request.headers]
    .filter(([name]) => PASSED.test(name))
    .slice(0, 32)
    .map(([name, value]) => `\r${name}: ${value.slice(0, HEADER_VALUE_MAX).replaceAll(/[\0\r\n]/g, ' ')}`)
    .join('');

// The program's request: METHOD SP TARGET (CR name: value)* LF BODY; through a published name's public route,
// METHOD SP TARGET SP public … (std/http: caller Anyone). The target is percent-encoded by the URL, so it has no
// space. Null when the body is over BODY_MAX.
export const tapeRequest = async (
  request: Request,
  path: string,
  search: string,
  via: string | null = null,
): Promise<Uint8Array<ArrayBuffer> | null> => {
  // HEAD is GET without the body (RFC 9110 9.3.2): the program is asked GET, and the runtime sends no body for a HEAD
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  const head = `${method} ${path}${search}${via === null || via === '' ? '' : ` ${via}`}${passedHeaders(request)}\n`,
    body = await bodyOf(request, BODY_MAX);
  return body === null ? null : new Uint8Array(await new Blob([head, body]).arrayBuffer());
};
