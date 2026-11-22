// apps/playground/serve.ts: the site for development, built from the tree on every load of a page.
//   node apps/playground/serve.ts [port]       then open http://127.0.0.1:<port>/ (the homepage) or /playground/
// It serves what build.ts makes (in memory), with the headers its _headers file gives a static host: the hashed
// files under a/ immutable, the pages never cached. The homepage's artefacts (runs of the real compiler, host and
// simulator, a few seconds) are made again on a load of the homepage, and kept for loads of the playground.
// It listens on 127.0.0.1 only.
import '../../node25.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { artefacts } from './artefacts.ts';
import type { Artefacts } from './artefacts.ts';
import { build } from './build.ts';
import type { Built } from './build.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};
let last: Built | null = null,
  made: Artefacts | null = null;
const fresh = async (home: boolean): Promise<Built> => {
  if (home || !made) made = await artefacts();
  last = await build({ made });
  return last;
};

const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('GET only');
    return;
  }
  if (path === 'playground') {
    res.writeHead(301, { location: '/playground/' }).end();
    return;
  }
  try {
    const page = path === '' || path.endsWith('/') || path.endsWith('index.html');
    const b = page || !last ? await fresh(path === '' || path === 'index.html') : last;
    const file = b.files.get(path === '' || path.endsWith('/') ? `${path}index.html` : path);
    if (file === undefined || path === '_headers') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const hashed = path.startsWith('a/');
    res.writeHead(200, {
      'content-type':
        TYPES[extname(path.endsWith('/') || path === '' ? 'index.html' : path)] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : file);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'content-type': 'text/plain' }).end(e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
};
const server = createServer((req, res) => {
  void serve(req, res);
});
server.listen(Number(process.argv[2] ?? 8418), '127.0.0.1', () => {
  const at = server.address();
  console.log(`http://127.0.0.1:${typeof at === 'object' && at ? at.port : '?'}/`);
});
