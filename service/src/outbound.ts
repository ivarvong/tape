// outbound.ts: a program's HTTP requests (std/http.tape fetch, issue #13 part 3), made by the Worker for the
// program's facet (index.ts Calls.http), which has no network of its own (globalOutbound: null).
//
// The operator lists, per name, the hosts its program may reach (PUT /_http/:account/:name {"hosts": [...]}): exact
// host names, no wildcard, no IP address, no port. A request is sent only when it is https, on the default port, to a
// host on that list; any other is refused (Err(Rejected("host not allowed: …"))) before anything is sent. A redirect
// is not followed (`redirect: "manual"`): the 3xx is the reply, so a listed host cannot send the request on to one
// that is not. The request's body is at most 64 KB (host/call.ts HTTP_LIMITS, checked before this), the reply's at
// most 1 MB: past that the reply is refused, and what was read of it dropped.
import { HTTP_LIMITS, refusalOf } from './host.ts';
import type { HttpAnswer, HttpRequest } from './host.ts';

/** The most hosts one name may list. */
export const HOSTS_MOST = 32;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A host name the list may hold, or why not: exact, lower case, of DNS labels, not an address, no port. */
export function hostRefusal(host: unknown): string | null {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253)
    return 'a host is a name of 1 to 253 characters';
  if (host !== host.toLowerCase()) return `${host}: a host is written in lower case`;
  if (host.includes('*')) return `${host}: a host is exact; a wildcard is not listed`;
  if (/^[0-9.]+$/.test(host) || host.includes(':') || host.startsWith('['))
    return `${host}: an IP address is not listed; list the host name`;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every(l => LABEL.test(l)))
    return `${host}: a host is two or more DNS labels (a-z 0-9 -), as api.stripe.com`;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local'))
    return `${host}: a local name is not listed`;
  return null;
}

/** Where the Worker's requests go: Workers' fetch. A test replaces it, to see what would be sent. */
export const network: { fetch: (request: Request) => Promise<Response> } = {
  fetch: request => fetch(request),
};

/** The reply's body, if it is at most `most` bytes; null when it is longer, and the rest is not read. */
async function bodyUpTo(res: Response, most: number): Promise<Uint8Array | null> {
  if (res.body === null) return new Uint8Array(0);
  const reader: ReadableStreamDefaultReader<unknown> = res.body.getReader(),
    parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk after another
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) throw new TypeError('a reply body is bytes');
    n += value.length;
    if (n > most) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One request, against the name's list: the reply whatever its status, or why it was not sent. */
export async function outbound(request: HttpRequest, hosts: readonly string[], withinMs: number): Promise<HttpAnswer> {
  const refused = refusalOf(request);
  if (refused !== null) return { refused };
  const url = new URL(request.url);
  if (url.port !== '') return { refused: `host not allowed: ${url.host} (only the default https port is fetched)` };
  if (!hosts.includes(url.hostname))
    return {
      refused: `host not allowed: ${url.hostname} is not on this program's list (PUT /_http/:account/:name {"hosts": [...]})`,
    };
  const headers = new Headers(request.headers);
  if (request.key !== null) headers.set('idempotency-key', request.key);
  const res = await network.fetch(
    new Request(url, {
      method: request.method,
      headers,
      ...(request.body.length > 0 ? { body: request.body } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(1, Math.min(withinMs, 60_000))),
    }),
  );
  const body = await bodyUpTo(res, HTTP_LIMITS.reply);
  if (body === null) return { refused: `a reply's body is at most ${HTTP_LIMITS.reply} bytes` };
  return { status: res.status, headers: [...res.headers], body };
}
