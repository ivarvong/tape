// visual-smoke.ts: the site as a browser draws it. A status code is not that: a page can answer 200 with a
// stylesheet that does not apply, a script its policy refuses, or a layout wider than a phone.
//   node scripts/visual-smoke.ts <base-url> [--pin <version-id>] [--shots <dir>] [--no-products]
// Drives headless Chrome over the DevTools protocol (a WebSocket; no dependency). Chrome is $CHROME, or where
// macOS and Linux put it; without one this exits 2 and says so, so a pipeline never counts it as passed.
// With --pin every request carries Cloudflare-Workers-Version-Overrides (as smoke.ts). With --shots each page's
// screenshot is written there, named <page>-<width>-<theme>.png: look at them.
//
// Checks, for the homepage and the playground at 375 px and 1280 px, light and dark:
//   - the stylesheets applied: the body's background is the theme's --bg (style.css: #ffffff, #0b0b0c), and the
//     primary button is drawn inverted
//   - nothing is wider than the window (no horizontal scroll)
//   - no console error, no exception, no message from the content security policy, no request that failed
//   - the homepage compiled hello.tape in the page; the playground compiled its example, Tab leaves its editor,
//     and its first request, sent with the page's own button, answered 200 "Hello, Ada"
// and for each of apps/products' ten pages (/p/demo/<name>/, unless --no-products) at 375 px, light and dark: it
// has its own style (a background that is not the browser's), nothing wider than the window, no console error.
// Exits 1 if any check failed, printing each.
import '../../node25.ts';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const base = (args.find(a => !a.startsWith('--') && /^https?:\/\//.test(a)) ?? '').replace(/\/$/, '');
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? null : (args[i + 1] ?? null);
};
const pin = opt('pin'),
  shots = opt('shots');
if (base === '') {
  console.error('usage: node scripts/visual-smoke.ts <base-url> [--pin <version-id>] [--shots <dir>] [--no-products]');
  process.exit(2);
}
const chrome = [
  process.env['CHROME'] ?? '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(p => p !== '' && existsSync(p));
if (chrome === undefined) {
  console.error('visual-smoke: no Chrome found (set CHROME to its binary): nothing was checked');
  process.exit(2);
}

let failed = 0,
  passed = 0;
const check = (ok: boolean, what: string): void => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`  FAIL ${what}`);
  }
};
const sleep = (ms: number): Promise<void> =>
  new Promise(r => {
    setTimeout(r, ms);
  });

// ---------- the DevTools protocol, as far as this file uses it
type Message = Record<string, unknown>;
const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v)) : {};
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

const profile = mkdtempSync(join(tmpdir(), 'tape-visual-'));
const browser = spawn(
  chrome,
  ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars'],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const endpoint = await new Promise<string>((resolve, reject) => {
  let said = '';
  browser.stderr.on('data', (d: Buffer) => {
    said += d.toString();
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(said);
    if (m?.[1] !== undefined) resolve(m[1]);
  });
  setTimeout(() => {
    reject(new Error(`Chrome did not start: ${said.slice(0, 400)}`));
  }, 20_000);
});
const socket = new WebSocket(endpoint);
await new Promise<void>(r => {
  socket.addEventListener(
    'open',
    () => {
      r();
    },
    { once: true },
  );
});
let sent = 0;
const waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
const listeners = new Set<(m: Message) => void>();
socket.addEventListener('message', (e: MessageEvent<string>) => {
  const parsed: unknown = JSON.parse(e.data);
  const m = record(parsed),
    id = typeof m['id'] === 'number' ? m['id'] : -1,
    w = waiting.get(id);
  if (w) {
    waiting.delete(id);
    if (m['error'] === undefined) w.resolve(record(m['result']));
    else w.reject(new Error(JSON.stringify(m['error'])));
  } else for (const l of listeners) l(m);
});
const send = (method: string, params: object = {}, sessionId?: string): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const id = ++sent;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

type Page = {
  /** what went wrong while it loaded and ran: console errors, exceptions, the policy's refusals, failed requests */
  problems: string[];
  /** the value of an expression in the page */
  value: (expression: string) => Promise<unknown>;
  /** wait until the expression is true; false if it never was */
  until: (expression: string, ms?: number) => Promise<boolean>;
  /** press one key, as the keyboard does */
  press: (key: string, code: number) => Promise<void>;
  shot: (name: string) => Promise<void>;
  close: () => Promise<void>;
};
async function open(path: string, width: number, dark: boolean): Promise<Page> {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const session = text(sessionId);
  const to = (method: string, params: object = {}): Promise<Record<string, unknown>> => send(method, params, session);
  const problems: string[] = [];
  const requests = new Map<string, string>();
  let arrived = (): void => {};
  const loaded = new Promise<boolean>(r => {
    arrived = (): void => {
      r(true);
    };
  });
  const listen = (m: Message): void => {
    if (m['sessionId'] !== session) return;
    const p = record(m['params']),
      method = m['method'];
    if (method === 'Page.loadEventFired') arrived();
    else if (method === 'Runtime.exceptionThrown') {
      const d = record(p['exceptionDetails']);
      problems.push(`exception: ${text(record(d['exception'])['description']) || text(d['text'])}`);
    } else if (method === 'Runtime.consoleAPICalled' && (p['type'] === 'error' || p['type'] === 'assert')) {
      const said = Array.isArray(p['args'])
        ? p['args'].map(a => text(record(a)['value']) || text(record(a)['description']))
        : [];
      problems.push(`console.error: ${said.join(' ')}`);
    } else if (method === 'Log.entryAdded') {
      // the browser's own messages: a refusal by the content security policy or the sandbox, a failed load
      const entry = record(p['entry']);
      if (entry['level'] === 'error' || /Content Security Policy|Refused to/.test(text(entry['text'])))
        problems.push(`${text(entry['source'])}: ${text(entry['text'])} ${text(entry['url'])}`.trim());
    } else if (method === 'Network.requestWillBeSent')
      requests.set(text(p['requestId']), text(record(p['request'])['url']));
    else if (method === 'Network.responseReceived') {
      const response = record(p['response']);
      if (Number(response['status']) >= 400) problems.push(`${text(response['status'])} ${text(response['url'])}`);
    } else if (method === 'Network.loadingFailed' && p['canceled'] !== true)
      problems.push(`failed to load ${requests.get(text(p['requestId'])) ?? '?'}: ${text(p['errorText'])}`);
  };
  listeners.add(listen);
  for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await to(`${domain}.enable`);
  await to('Network.setCacheDisabled', { cacheDisabled: true });
  await to('Network.setExtraHTTPHeaders', {
    headers: {
      'x-tape-synthetic': 'deploy-smoke',
      ...(pin === null ? {} : { 'cloudflare-workers-version-overrides': `tape="${pin}"` }),
    },
  });
  const mobile = width < 600;
  await to('Emulation.setDeviceMetricsOverride', { width, height: mobile ? 812 : 800, deviceScaleFactor: 1, mobile });
  await to('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
  });
  await to('Page.navigate', { url: `${base}${path}` });
  if (!(await Promise.race([loaded, sleep(30_000).then(() => false)])))
    problems.push('the page did not finish loading in 30 s');
  const value = async (expression: string): Promise<unknown> => {
    const r = await to('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r['exceptionDetails'] !== undefined) throw new Error(`${expression}: ${JSON.stringify(r['exceptionDetails'])}`);
    return record(r['result'])['value'];
  };
  return {
    problems,
    value,
    until: async (expression, ms = 20_000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        if ((await value(expression)) === true) return true;
        await sleep(50);
      }
      return false;
    },
    press: async (key, code) => {
      for (const type of ['keyDown', 'keyUp'])
        await to('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code });
    },
    shot: async name => {
      if (shots === null) return;
      const r = await to('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(shots, { recursive: true });
      writeFileSync(
        join(shots, `${name}-${width}-${dark ? 'dark' : 'light'}.png`),
        Buffer.from(text(r['data']), 'base64'),
      );
    },
    close: async () => {
      listeners.delete(listen);
      await send('Target.closeTarget', { targetId });
    },
  };
}

// ---------- the checks
const BACKGROUND = 'getComputedStyle(document.body).backgroundColor';
// against the width asked for, not window.innerWidth: a phone's window grows to fit a page that is too wide (it
// zooms out), so there the two are equal whatever the page does
const wider = (width: number): string => `document.documentElement.scrollWidth - ${width}`;
// What is drawn past the window's right edge and cannot be scrolled to: a page that hides its overflow has no
// scroll bar and still cuts its text (a heading that could not wrap is cut at 375 px under `overflow-x: hidden` with nothing to scroll). An
// element inside a box that scrolls sideways (the editor, a code block, a table) is reached by scrolling it.
const cut = (width: number): string => `(() => {
  const scrolls = e => { for (let a = e.parentElement; a; a = a.parentElement) if (/auto|scroll/.test(getComputedStyle(a).overflowX)) return true; return false; };
  return [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > ${width} + 1 && getComputedStyle(e).visibility !== 'hidden' && !scrolls(e); })
    .slice(0, 3).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : '') + ' to ' + Math.round(e.getBoundingClientRect().right) + ' px').join(', ');
})()`;
/** the checks every page gets, once it has done what it does */
async function drawn(page: Page, width: number, what: string): Promise<void> {
  const over = Number(await page.value(wider(width)));
  check(over <= 0, `${what}: the page is ${over} px wider than the window`);
  const past = text(await page.value(cut(width)));
  check(past === '', `${what}: drawn past the window's edge, where nothing scrolls to it: ${past}`);
  check(
    page.problems.length === 0,
    `${what}: ${page.problems.length} problems: ${page.problems.slice(0, 3).join(' | ')}`,
  );
}

try {
  for (const width of [375, 1280])
    for (const dark of [false, true]) {
      const at = `${width} px ${dark ? 'dark' : 'light'}`,
        bg = dark ? 'rgb(11, 11, 12)' : 'rgb(255, 255, 255)',
        // the primary button is the text colour on the page's: the other theme's background, nearly
        inverted = `(() => { const b = document.querySelector('.btn.primary'); return b ? getComputedStyle(b).backgroundColor : 'no .btn.primary'; })()`;

      const home = await open('/', width, dark);
      check(
        await home.until(`/Compiled in/.test(document.getElementById('hero-status-text')?.textContent ?? '')`),
        `/ at ${at}: hello.tape did not compile in the page: ${text(await home.value(`document.getElementById('hero-status-text')?.textContent`))}`,
      );
      check(
        (await home.value(BACKGROUND)) === bg,
        `/ at ${at}: the body's background is ${text(await home.value(BACKGROUND))}, not ${bg}`,
      );
      const button = text(await home.value(inverted));
      check(
        button === (dark ? 'rgb(237, 237, 238)' : 'rgb(12, 12, 14)'),
        `/ at ${at}: the primary button's background is ${button}`,
      );
      await drawn(home, width, `/ at ${at}`);
      await home.shot('home');
      await home.close();

      const pg = await open('/playground/', width, dark);
      check(
        await pg.until(`/compiled in/.test(document.getElementById('status-text')?.textContent ?? '')`),
        `/playground/ at ${at}: the example did not compile: ${text(await pg.value(`document.getElementById('status-text')?.textContent`))}`,
      );
      check(
        (await pg.value(BACKGROUND)) === bg,
        `/playground/ at ${at}: the body's background is ${text(await pg.value(BACKGROUND))}, not ${bg}`,
      );
      // the keyboard is not held by the editor: with the focus in it (where the page puts it on a desktop) and
      // nothing typed, Tab moves on
      await pg.value(`document.querySelector('#editor textarea')?.focus()`);
      await pg.press('Tab', 9);
      check(
        (await pg.value(`document.activeElement?.tagName`)) !== 'TEXTAREA',
        `/playground/ at ${at}: Tab does not leave the editor`,
      );
      // on a phone the request is behind the Run tab
      if (width < 600) await pg.value(`document.querySelector('[data-view="run"]')?.click()`);
      await pg.value(`document.getElementById('send')?.click()`);
      const answered = await pg.until(
        `/^\\s*200/.test(document.getElementById('result-head')?.textContent ?? '') && /Hello, Ada/.test(document.getElementById('rbody')?.textContent ?? '')`,
        10_000,
      );
      check(
        answered,
        `/playground/ at ${at}: Send did not answer 200 "Hello, Ada": ${text(await pg.value(`(document.getElementById('result-head')?.textContent ?? '') + ' | ' + (document.getElementById('rbody')?.textContent ?? '').slice(0, 80)`))}`,
      );
      await drawn(pg, width, `/playground/ at ${at}`);
      await pg.shot('playground');
      await pg.close();
    }

  if (!args.includes('--no-products')) {
    // the tree's directories are the list (apps/products/<name>/<name>.tape is /p/demo/<name>/)
    const products = readdirSync(new URL('../../apps/products', import.meta.url), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const name of products)
      for (const dark of [false, true]) {
        const what = `/p/demo/${name}/ at 375 px ${dark ? 'dark' : 'light'}`;
        const page = await open(`/p/demo/${name}/`, 375, dark);
        const bg = text(await page.value(BACKGROUND));
        // a page with no style of its own is the browser's: transparent over white (or, dark, over #121212)
        check(bg !== 'rgba(0, 0, 0, 0)' && bg !== '', `${what}: the body has no background of its own (${bg})`);
        check(Number(await page.value('document.querySelectorAll("style").length')) > 0, `${what}: no <style>`);
        await drawn(page, 375, what);
        await page.shot(`product-${name}`);
        await page.close();
      }
  }
} finally {
  socket.close();
  browser.kill();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(
  failed > 0
    ? `visual smoke: ${failed} of ${passed + failed} checks failed at ${base}`
    : `visual smoke ok: ${passed} checks at ${base}${shots === null ? '' : `, screenshots in ${shots}`}`,
);
process.exit(failed > 0 ? 1 : 0);
