// test/secrets.ts: Secrets, `secret(from:, name:)` (issue #13 part 2). The value is given to the program and never
// written into its log: the log holds the name and the version read, a replay reads that version from the store,
// and a replay whose version is gone stops and says so. The compiled build and the reference interpreter answer
// the same; a program that reads no secret has a module without the import.
import '../node25.ts';
import { fixedSecrets, instantiate, replay, traceOf } from '../host.ts';
import type { SecretStore } from '../host.ts';
import { interpret } from '../interp.ts';
import { nodeSql } from '../nodesql.ts';
import { answered, built, codes, finish, moduleOf, ok, same, std } from './harness.ts';

const enc = new TextEncoder();
const PROGRAM = `fn handle(raw: View, secrets: Secrets) -> Response {
  match secret(name: request(raw).path |> after(byte: 47)) {
    Some(value) -> buf() |> append(view: "length ") |> write_int(value: len(value)) |> respond(status: 200)
    None -> empty(status: 404)
  }
}
`;
const VALUE = 'sk_live_51HxQ9vKp0tTq7';
const b = built(PROGRAM);
const module = moduleOf(b);
const traced = moduleOf(built(PROGRAM, { trace: true }));

// ---- a value read, never logged
{
  const app = instantiate(module, { sql: nodeSql(), name: 't', secrets: fixedSecrets({ stripe: VALUE }) });
  const req = enc.encode('GET /stripe\n'),
    ran = await app.runLogged(req);
  same('the program reads the value', answered(ran.out), `200\nlength ${VALUE.length}`);
  same('the log says the name and the version', ran.effects.slice(1), [{ secret: 'stripe', version: 1 }]);
  ok('the log holds no byte of the value', !JSON.stringify(ran.effects).includes(VALUE));
  const t = traceOf(traced, req, ran.effects, undefined, { secrets: fixedSecrets({ stripe: VALUE }) });
  ok(
    'the trace replays and holds no byte of it',
    t.error === null && !JSON.stringify(t.events).includes(VALUE),
    String(t.error),
  );
  same(
    'a replay with the store gives the same answer',
    answered(replay(module, req, ran.effects, { secrets: fixedSecrets({ stripe: VALUE }) })),
    answered(ran.out),
  );
  const none = await app.runLogged(enc.encode('GET /other\n'));
  same(
    'a name the store does not hold is None, logged with no version',
    [answered(none.out), none.effects.slice(1)],
    ['404\n', [{ secret: 'other', version: null }]],
  );
  const odd = await app.runLogged(enc.encode('GET /Stripe\n'));
  same('a name that is no secret name is None, the store not asked', answered(odd.out), '404\n');
}

// ---- versions: a replay reads the version its log names; a version gone fails the replay closed
{
  const versions = new Map<number, string>([
    [1, 'first-value-1234'],
    [2, 'second-value-5678'],
  ]);
  let current = 2;
  const store: SecretStore = {
    read: name => (name === 'stripe' ? { value: enc.encode(versions.get(current) ?? ''), version: current } : null),
    at: (name, version) =>
      name === 'stripe' && versions.has(version) ? enc.encode(versions.get(version) ?? '') : null,
  };
  const app = instantiate(module, { sql: nodeSql(), name: 't', secrets: store });
  const req = enc.encode('GET /stripe\n'),
    ran = await app.runLogged(req);
  same('the current version is read', ran.effects.slice(1), [{ secret: 'stripe', version: 2 }]);
  versions.set(3, 'third-value-and-longer');
  current = 3;
  same(
    'rotated: the replay still reads version 2',
    answered(replay(module, req, ran.effects, { secrets: store })),
    `200\nlength ${'second-value-5678'.length}`,
  );
  versions.delete(2);
  let why = '';
  try {
    replay(module, req, ran.effects, { secrets: store });
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  ok(
    'version 2 gone: the replay stops and says why',
    why.includes('stripe at version 2') && why.includes('no longer held'),
    why,
  );
  const t = traceOf(traced, req, ran.effects, undefined, { secrets: store });
  ok(
    'and the trace says it, rather than run on another value',
    (t.error ?? '').includes('no longer held'),
    String(t.error),
  );
  let without = '';
  try {
    replay(module, req, ran.effects);
  } catch (e) {
    without = e instanceof Error ? e.message : String(e);
  }
  ok('a replay given no store fails the same way', without.includes('no longer held'), without);
}

// ---- the compiler: Secrets is granted by an entry point, and used by name below it
{
  const helper = `fn key() -> Option[View] {\n  secret(name: "stripe")\n}\n\nfn handle(raw: View, secrets: Secrets) -> Response {\n  match key() {\n    Some -> empty(status: 200)\n    None -> empty(status: 404)\n  }\n}\n`;
  same("a helper reads the entry point's Secrets by name", codes(helper), []);
  same(
    'secret() with no Secrets declared is C72',
    codes(
      'fn handle(raw: View) -> Response {\n  match secret(name: "x") {\n    Some -> empty(status: 200)\n    None -> empty(status: 404)\n  }\n}\n',
    ).map(c => c.slice(0, 3)),
    ['C72'],
  );
  same(
    'a secret read and dropped is C83, as any effect is',
    codes(
      'fn handle(raw: View, secrets: Secrets) -> Response {\n  let s = secret(name: "x")\n  empty(status: 200)\n}\n',
    ).map(c => c.slice(0, 3)),
    ['C83'],
  );
  const imports = (m: WebAssembly.Module): string[] => WebAssembly.Module.imports(m).map(i => i.name);
  ok('a module that reads a secret imports env.secret', imports(module).includes('secret'));
  ok(
    'one that reads none does not',
    !imports(moduleOf(built('fn handle(raw: View) -> Response {\n  empty(status: 200)\n}\n'))).includes('secret'),
  );
}

// ---- the reference interpreter answers as the build does
{
  const it = interpret([...std, { name: 'program.tape', text: PROGRAM }], {
    secret: name => (name === 'stripe' ? enc.encode(VALUE) : null),
  });
  const app = instantiate(module, { sql: nodeSql(), name: 't', secrets: fixedSecrets({ stripe: VALUE }) });
  for (const path of ['/stripe', '/other']) {
    const req = enc.encode(`GET ${path}\n`);
    same(`interpreter and build agree on GET ${path}`, answered(it.handle(req)), answered(app.handle(req)));
  }
}

finish();
