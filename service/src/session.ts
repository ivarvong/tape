// session.ts: a program's own origin, and the session cookie on it (issue #13 part 4).
//
// Every published program answers at /p/:account/:name/ on the service's one origin, and a cookie's Path is not a
// boundary between programs (a page at /p/a/x/ can read and set /p/a/y/'s cookies in a browser), so a session on
// that origin would be every program's. When the deploy sets PROGRAM_DOMAIN, each published name has an origin of
// its own: `<name>--<account>.<PROGRAM_DOMAIN>` is that name's public route, and only there does std/http's
// start_session(id:) set a cookie. The cookie is `__Host-` (Secure, Path=/, no Domain: the browser keeps it to that
// one origin), HttpOnly (no page script reads it; the service runs none anyway), SameSite=Lax, and its value is
// `<expiry>.<id>.<mac>`: the id the program chose, base64url, and an HMAC under the service's key of this account,
// this name, the expiry and the id. A cookie that does not verify (forged, changed, expired, another name's, a
// stale key) is no session: the request is Anyone. A session lasts SESSION_DAYS from its last use: a request that
// carries one at least a day old is answered with it again, its expiry moved on.
//
// A name or an account with `--` or `_` in it, or a label longer than DNS allows, has no origin of its own (its
// label could be read two ways, or is no host name), and stays at /p/ only.
import { signature } from './web.ts';

export const SESSION_COOKIE = '__Host-tape-session';
export const SESSION_DAYS = 30;
const DAY_S = 24 * 3600;
const PART = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The account and name a host is the origin of, or null for any other host (or when no PROGRAM_DOMAIN is set). */
export function programOrigin(
  hostname: string,
  domain: string | undefined,
): { account: string; name: string } | { none: string } | null {
  if (domain === undefined || domain === '') return null;
  const host = hostname.toLowerCase();
  if (!host.endsWith(`.${domain}`)) return null;
  const label = host.slice(0, -(domain.length + 1));
  const at = label.lastIndexOf('--');
  const name = label.slice(0, at),
    account = label.slice(at + 2);
  if (
    at <= 0 ||
    label.includes('.') ||
    label.length > 63 ||
    !PART.test(name) ||
    !PART.test(account) ||
    name.includes('--') ||
    account.includes('--')
  )
    return { none: `${label} names no program: an origin is <name>--<account>.${domain}` };
  return { account, name };
}
/** The origin a name has, or null when it has none (`--` or `_` in it, or too long a label). */
export function originOf(account: string, name: string, domain: string | undefined): string | null {
  if (domain === undefined || domain === '') return null;
  const host = `${name}--${account}.${domain}`;
  const back = programOrigin(host, domain);
  return back !== null && 'account' in back && back.account === account && back.name === name
    ? `https://${host}`
    : null;
}

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCodePoint(...b))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const fromB64url = (t: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(t)) return null;
  try {
    return Uint8Array.from(atob(t.replaceAll('-', '+').replaceAll('_', '/')), c => c.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
};
const signed = (token: string, account: string, name: string, exp: number, id: string): Promise<string> =>
  signature(token, `tape-session/1\n${account}\n${name}\n${exp}\n${id}`);
const enc = new TextEncoder();
const same = (a: string, b: string): boolean => {
  const x = enc.encode(a),
    y = enc.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
};

/** The session a request carries for this account and name: its id (base64url) and expiry, or null for none. */
export async function sessionOf(
  request: Request,
  token: string,
  account: string,
  name: string,
  now = Date.now(),
): Promise<{ id: string; exp: number } | null> {
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(c => c.trim());
  for (const c of cookies) {
    if (!c.startsWith(`${SESSION_COOKIE}=`)) continue;
    const [exp = '', id = '', mac = ''] = c.slice(SESSION_COOKIE.length + 1).split('.');
    const at = Number(exp);
    if (!/^\d{1,12}$/.test(exp) || at * 1000 <= now || at * 1000 > now + (SESSION_DAYS + 1) * DAY_S * 1000) continue;
    const bytes = fromB64url(id);
    if (bytes === null || bytes.length === 0 || b64url(bytes) !== id) continue;
    // oxlint-disable-next-line no-await-in-loop -- one cookie of a name is the usual case; each is checked in turn
    if (same(mac, await signed(token, account, name, at, id))) return { id, exp: at };
  }
  return null;
}
const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Lax';
/** The Set-Cookie of a session with this id (base64url), for SESSION_DAYS from now. */
export async function sessionCookie(
  token: string,
  account: string,
  name: string,
  id: string,
  now = Date.now(),
): Promise<string> {
  const exp = Math.floor(now / 1000) + SESSION_DAYS * DAY_S;
  return `${SESSION_COOKIE}=${exp}.${id}.${await signed(token, account, name, exp, id)}; ${ATTRIBUTES}; Max-Age=${SESSION_DAYS * DAY_S}`;
}
/** The Set-Cookie that ends one. */
export const endedCookie = `${SESSION_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;
/** Is this session old enough to be set again, its expiry moved on (a day after it was last set)? */
export const stale = (exp: number, now = Date.now()): boolean => exp * 1000 - now < (SESSION_DAYS - 1) * DAY_S * 1000;
export { b64url, fromB64url };
