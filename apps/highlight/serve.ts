// apps/highlight/serve.ts: serve the highlighter page with the repository's own compiler.
//   node apps/highlight/serve.ts [port]        then open http://127.0.0.1:<port>/apps/highlight/
// It serves the repository read-only on 127.0.0.1. A .ts file is served as JavaScript with its types stripped
// (node:module's stripTypeScriptTypes; the compiler is erasable TypeScript), so the page imports compiler.ts and
// host.ts as they are in the tree, and the browser follows their imports. /apps/highlight/std.json is std.ts's
// list of the standard library, the same files in the same order every other build is given.
import '../../node25.ts';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, normalize, sep } from 'node:path';
import { std } from '../../std.ts';

const ROOT = normalize(new URL('../../', import.meta.url).pathname);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.tape': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const send = (status: number, type: string, body: string | Buffer): void => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (req.method !== 'GET') return send(405, 'text/plain', 'GET only');
  if (path === '/') {
    res.writeHead(302, { location: '/apps/highlight/' }).end();
    return;
  }
  if (path === '/apps/highlight/std.json') return send(200, TYPES['.json'] ?? '', JSON.stringify(std));
  const file = normalize(ROOT + (path.endsWith('/') ? path + 'index.html' : path));
  if (!file.startsWith(ROOT) || file.split(sep).includes('node_modules') || file.split(sep).includes('.git'))
    return send(403, 'text/plain', 'outside the repository');
  const type = TYPES[extname(file)];
  if (!type) return send(404, 'text/plain', 'not served');
  try {
    if (!statSync(file).isFile()) return send(404, 'text/plain', 'not a file');
    const body = readFileSync(file);
    send(200, type, extname(file) === '.ts' ? stripTypeScriptTypes(body.toString('utf8'), { mode: 'strip' }) : body);
  } catch (e) {
    send(e instanceof Error && 'code' in e && e.code === 'ENOENT' ? 404 : 500, 'text/plain', String(e));
  }
});
server.listen(Number(process.argv[2] ?? 8417), '127.0.0.1', () => {
  const at = server.address();
  console.log(`http://127.0.0.1:${typeof at === 'object' && at ? at.port : '?'}/apps/highlight/`);
});
