// docs/guide.md's worked REST service against the compiler and the host: the program (the ```tape items.tape
// block) compiles with the rules on and is in fmt's layout, and each request of the ```text items.tape block, sent
// in order to one fresh database, answers the status and body written under it, as application/json. The answers
// in the guide were written from what the section says the service does, not copied from a run.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { format } from '../fmt.ts';
import { instantiate, responseOf } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { finish, ok, raw, std } from './harness.ts';

const guide = raw('docs/guide.md');
const block = (lang: string): string | null =>
  new RegExp(`^\`\`\`${lang} items\\.tape\\n([\\s\\S]*?)^\`\`\`$`, 'm').exec(guide)?.[1] ?? null;
const program = block('tape') ?? '';
const transcript = block('text') ?? '';
ok('the guide has the program and its requests', program !== '' && transcript !== '');

const build = (text: string) => compile([...std, { name: 'items.tape', text }]);
const built = build(program);
ok(
  'the program compiles, with the rules on',
  built.wasm !== null,
  built.errors.map(e => `${e.code}:${e.line} ${e.message}`).join('; '),
);
ok("the program is in fmt's layout", format(program) === program);

// the section says that without the UNIQUE key and ON CONFLICT, the compiler refuses the INSERT (C55)
const unkeyed = program
  .replace('key TEXT NOT NULL UNIQUE,', 'key TEXT NOT NULL,')
  .replace('ON CONFLICT(key) \\\n        DO NOTHING RETURNING *', 'RETURNING *');
ok(
  'the INSERT without a UNIQUE key and ON CONFLICT is refused with C55, as the section says',
  unkeyed !== program && build(unkeyed).errors.some(e => e.code === 'C55'),
  build(unkeyed)
    .errors.map(e => e.code)
    .join(','),
);

type Exchange = { request: string; status: number; body: string };
const lines = transcript.replace(/\n$/, '').split('\n');
const exchanges: Exchange[] = [];
for (let i = 0; i + 1 < lines.length; i += 2) {
  const req = lines[i] ?? '',
    ans = lines[i + 1] ?? '';
  const m = /^(\S+ \S+)(?: (.*))?$/.exec(req),
    a = /^(\d{3}) (.*)$/.exec(ans);
  if (!m || !a) {
    ok(`line ${i + 1} of the requests is a request, and the next its answer`, false, `${req} / ${ans}`);
    continue;
  }
  exchanges.push({ request: `${m[1]}\n${m[2] ?? ''}`, status: Number(a[1]), body: a[2] ?? '' });
}
ok('the requests come in pairs, at least 20 of them', lines.length % 2 === 0 && exchanges.length >= 20);

if (built.wasm) {
  const app = instantiate(new WebAssembly.Module(built.wasm), { sql: nodeSql() });
  const enc = new TextEncoder(),
    dec = new TextDecoder();
  for (const x of exchanges) {
    const r = responseOf(app.handle(enc.encode(x.request)));
    const body = dec.decode(r.body);
    ok(
      `${x.request.replace('\n', ' ').trim()} answers ${x.status} ${x.body.slice(0, 60)}`,
      r.status === x.status && body === x.body && r.type === 'application/json',
      `got ${r.status} ${r.type ?? ''} ${body}`,
    );
  }
}
finish();
