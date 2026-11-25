// Runs in workerd: a program's own origin and its session cookie (issue #13 part 4). With PROGRAM_DOMAIN set (the
// tests' is tape.test), <name>--<account>.tape.test is that published name's public route. There, and only there, an
// answer with start_session(id:) sets a __Host- cookie the program never sees, and a request that carries one the
// Worker verifies is Session(id). A forged, expired or another program's cookie is Anyone; a client's own
// tape-session header is not passed; on /p/ and the operator's route no cookie is set.
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { signature } from '../src/web.ts';
import { at, call, got } from './help.ts';

const PROGRAM = `fn handle(raw: View) -> Response {
  let r = request(raw)
  match r {
    Request(path: "/login", query: Some(value: "u=" ++ who)) -> empty(status: 303) |> header(name: "location", value: "/") |> start_session(id: who)
    Request(path: "/logout") -> empty(status: 303) |> header(name: "location", value: "/") |> end_session()
    Request(path: "/cookie") -> buf() |> append(view: value_or(given: header_of(r, name: "cookie"), otherwise: "none")) |> respond(status: 200)
    _ -> buf() |> append(view: caller_text(caller: r.caller)) |> respond(status: 200)
  }
}

fn caller_text(caller: Caller) -> View {
  match caller {
    Operator -> "operator"
    Anyone -> "anyone"
    Session(id) -> "session " ++ id
  }
}
`;
const site = (host: string, path: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(`https://${host}.tape.test${path}`, { redirect: 'manual', ...init });
const cookieOf = (r: Response): string => r.headers.get('set-cookie') ?? '';
const valueOf = (setCookie: string): string => /^__Host-tape-session=([^;]*)/.exec(setCookie)?.[1] ?? '';
const withCookie = (value: string): RequestInit => ({ headers: { cookie: `__Host-tape-session=${value}` } });
const b64url = (t: string): string => btoa(t).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
/** A cookie as the service makes one, under the test token, for any account, name, expiry and id. */
const made = async (account: string, name: string, exp: number, id: string): Promise<string> =>
  `${exp}.${b64url(id)}.${await signature('test-token', `tape-session/1\n${account}\n${name}\n${exp}\n${b64url(id)}`)}`;
const publish = async (account: string, name: string): Promise<void> => {
  expect(at(await got(`/${account}/${name}`, { method: 'POST', body: PROGRAM }), 'version')).toBe(1);
  expect((await call(`/_public/${account}/${name}`, { method: 'PUT', body: '{"published":true}' })).ok).toBe(true);
};

describe("a program's own origin", () => {
  it("is the published name's public route; any other name, or one that is not published, is a 404", async () => {
    expect(at(await got('/acme/quiet', { method: 'POST', body: PROGRAM }), 'version')).toBe(1);
    expect((await site('quiet--acme', '/')).status).toBe(404);
    await publish('acme', 'shop');
    const r = await site('shop--acme', '/');
    expect([r.status, await r.text()]).toEqual([200, 'anyone']);
    for (const host of ['shop-acme', 'shop--acme--x', 'x.shop--acme', '--acme', 'shop--'])
      expect((await site(host, '/')).status).toBe(404);
    // nothing of the service is there: an operator's path is the program's path
    const op = await site('shop--acme', '/_secrets/acme/shop', { headers: { authorization: 'Bearer test-token' } });
    expect([op.status, await op.text()]).toEqual([200, 'anyone']);
  });

  it('start_session sets a __Host- cookie there, and only there; the next request is Session(id)', async () => {
    await publish('acme', 'shop2');
    const login = await site('shop2--acme', '/login?u=ada');
    expect(login.status).toBe(303);
    const set = cookieOf(login);
    expect(set).toMatch(
      /^__Host-tape-session=\d+\.YWRh\.[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
    );
    expect(login.headers.get('tape-session-start')).toBeNull();
    expect(login.headers.get('cache-control')).toBe('no-store');
    const me = await site('shop2--acme', '/', withCookie(valueOf(set)));
    expect(await me.text()).toBe('session ada');
    expect(cookieOf(me)).toBe('');
    // the program never sees the cookie
    expect(await (await site('shop2--acme', '/cookie', withCookie(valueOf(set)))).text()).toBe('none');
    // on /p/ and on the operator's route the same answer sets nothing
    const viaP = await exports.default.fetch('https://tape/p/acme/shop2/login?u=ada', { redirect: 'manual' });
    const viaOp = await call('/acme/shop2/v/1/login?u=ada', { redirect: 'manual' });
    for (const r of [viaP, viaOp]) {
      expect(cookieOf(r)).toBe('');
      expect(r.headers.get('tape-session-start')).toBeNull();
    }
    // end_session clears it
    const out = await site('shop2--acme', '/logout', withCookie(valueOf(set)));
    expect(cookieOf(out)).toBe('__Host-tape-session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
  });

  it("a forged, expired or another program's cookie is Anyone; a client's tape-session header is not passed", async () => {
    await publish('acme', 'a');
    await publish('acme', 'b');
    await publish('other', 'a');
    const now = Math.floor(Date.now() / 1000);
    const good = await made('acme', 'a', now + 3600, 'ada');
    expect(await (await site('a--acme', '/', withCookie(good))).text()).toBe('session ada');
    const [exp = '', , mac = ''] = good.split('.');
    const anyone = [
      `${exp}.${b64url('root')}.${mac}`, // the id changed
      `${Number(exp) + 1}.${b64url('ada')}.${mac}`, // the expiry moved
      `${exp}.${b64url('ada')}.${'0'.repeat(64)}`, // no key
      await made('acme', 'a', now - 1, 'ada'), // expired
      await made('acme', 'a', now + 400 * 24 * 3600, 'ada'), // longer than a session lasts
      await made('acme', 'b', now + 3600, 'ada'), // b's session
      await made('other', 'a', now + 3600, 'ada'), // another account's a
      'garbage',
    ];
    for (const value of anyone) expect(await (await site('a--acme', '/', withCookie(value))).text()).toBe('anyone');
    // a's own cookie, sent to b's origin (a browser never would: __Host- keeps it to a's): b does not take it
    expect(await (await site('b--acme', '/', withCookie(good))).text()).toBe('anyone');
    expect(await (await site('a--other', '/', withCookie(good))).text()).toBe('anyone');
    // a client cannot name itself a session
    const forged = await site('a--acme', '/', { headers: { 'tape-session': b64url('root') } });
    expect(await forged.text()).toBe('anyone');
    // and on /p/ a valid cookie is no session: it is the shared origin
    expect(await (await exports.default.fetch('https://tape/p/acme/a/', withCookie(good))).text()).toBe('anyone');
  });

  it('a session lasts 30 days from its last use: one a day old is set again', async () => {
    await publish('acme', 'slide');
    const now = Math.floor(Date.now() / 1000);
    const fresh = await made('acme', 'slide', now + 30 * 24 * 3600, 'bo');
    expect(cookieOf(await site('slide--acme', '/', withCookie(fresh)))).toBe('');
    const old = await made('acme', 'slide', now + 20 * 24 * 3600, 'bo');
    const again = await site('slide--acme', '/', withCookie(old));
    expect(await again.text()).toBe('session bo');
    const renewed = valueOf(cookieOf(again));
    expect(Number(renewed.split('.')[0])).toBeGreaterThanOrEqual(now + 30 * 24 * 3600 - 5);
    expect(await (await site('slide--acme', '/', withCookie(renewed))).text()).toBe('session bo');
  });

  it("a program's page keeps its own origin there (its forms carry the cookie), and still runs no script", async () => {
    await publish('acme', 'page');
    const html = `fn handle(raw: View) -> Response {\n  buf() |> append(view: "<p>hi</p>") |> respond_as(status: 200, content: Html)\n}\n`;
    expect(at(await got('/acme/page', { method: 'POST', body: html }), 'version')).toBe(2);
    const csp = (await site('page--acme', '/')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox allow-forms allow-same-origin');
    expect(csp).not.toContain('allow-scripts');
    expect(
      (await exports.default.fetch('https://tape/p/acme/page/')).headers.get('content-security-policy'),
    ).not.toContain('allow-same-origin');
  });
});
