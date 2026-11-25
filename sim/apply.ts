// sim/apply.ts: one choice applied to a world. The kinds of choice are listed at the top of ../sim.ts.
import { responseOf } from '../host.ts';
import { stubHttp } from '../host.ts';
import { HTTP, drain, fetchOf, hash, isCut, messageOf, programOf, rng } from './world.ts';
import type { Client, Model, Op, Reply, Request, Waiting, World } from './world.ts';
import { valueOf } from './values.ts';
import type { Schema } from './values.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const CUT = (): Error => Object.assign(new Error('the caller was reset while it waited'), { cut: true });
const crashed =
  (world: World) =>
  (e: unknown): void => {
    world.crash = e instanceof Error ? e : new Error(String(e));
  };
/** What becomes of a run: `ok` hears its result, `no` why it ended; a failure in either is the simulator's own. */
function watch<T>(world: World, run: Promise<T>, ok: (r: T) => void, no: (err: unknown) => void): void {
  const settled = async (): Promise<void> => {
    let r: T;
    try {
      r = await run;
    } catch (err) {
      no(err);
      return;
    }
    ok(r);
  };
  settled().catch(crashed(world));
}
const jsonOf = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
};
const bodyOf = (req: Request): string => {
  if (typeof req.body === 'string') return req.body;
  return req.body === undefined ? '' : JSON.stringify(req.body);
};

// A client's next request starts. It runs until it answers or reaches a call, which then waits for its decision.
async function startRequest(
  world: World,
  model: Model,
  clients: readonly Client[],
  action: string,
  a: string,
): Promise<void> {
  const c = clients[Number(a.slice(1))];
  const op = c?.ops[c.next];
  if (!c || !op) throw new Error(`${action}: no such client, or nothing left for it to send`);
  const id = `${a}.${c.next++}`;
  const req = op.make(c.mem);
  if (!req) {
    world.say(action, `${op.name}: skipped, nothing to act on`);
    return;
  }
  const body = bodyOf(req);
  const entry = programOf(world, model.entry);
  c.busy = true;
  world.cur = { id };
  world.say(action, `${id} ${req.line}${req.via ? ` (${req.via})` : ''} ${body}`);
  const text = `${req.line}${req.via ? ` ${req.via}` : ''}\n${body}`;
  const sent = { text, status: 0 };
  world.sent.push(sent);
  watch(
    world,
    entry.app.runLogged(enc.encode(text), entry.tx),
    r => {
      answered(world, c, op, id, sent, r.out);
    },
    (err: unknown) => {
      c.busy = false;
      if (!isCut(err)) {
        world.failed ??= `${id} (${req.line}) failed: ${messageOf(err)}`;
        world.say(`  ${id} failed`, messageOf(err));
        return;
      }
      unanswered(world, c, op, id);
    },
  );
  await drain();
}

/** The client's object was reset before it answered: the client hears nothing. */
function unanswered(world: World, c: Client, op: Op, id: string): void {
  const { then: heard } = op;
  heard?.(c.mem, { status: 0, json: null, text: '' });
  world.say(`  ${id} ended`, 'its object was reset; the client got no answer');
}

function answered(world: World, c: Client, op: Op, id: string, sent: World['sent'][number], out: Uint8Array): void {
  const res = responseOf(out);
  const text = dec.decode(res.body);
  c.busy = false;
  sent.status = res.status;
  sent.answer = text;
  if ([200, 201, 204].includes(res.status)) world.finished.push({ ...sent, after: world.choices });
  op.then?.(c.mem, { status: res.status, json: jsonOf(text), text });
  world.say(`  ${id} answered`, `${res.status} ${text.length > 110 ? `${text.slice(0, 110)}…` : text}`);
}

// A due timer runs.
async function fireTimer(world: World, action: string, a: string, b: string): Promise<void> {
  const p = programOf(world, a);
  const key = Number(b);
  const n = (p.fired.get(key) ?? 0) + 1;
  const id = `w.${a}.${key}.${n}`;
  const tag = `${a} ${key}`;
  p.fired.set(key, n);
  world.waking.add(tag);
  world.cur = { id };
  world.say(action, id);
  watch(
    world,
    p.app.wake(key, { ...p.tx, now: world.clock }),
    r => {
      world.waking.delete(tag);
      world.say(`  ${id} done`, r ? `${r.status} ${dec.decode(r.body).slice(0, 110)}` : 'not due');
    },
    (err: unknown) => {
      world.waking.delete(tag);
      if (!isCut(err)) {
        world.failed ??= `${id} (the timer ${key} of ${a}) failed: ${messageOf(err)}`;
        world.say(`  ${id} failed`, messageOf(err));
        return;
      }
      world.say(`  ${id} ended`, 'its object was reset; the timer is kept');
    },
  );
  await drain();
}

// A Remote that no program here serves is stood in for: 3 times in 4 it answers ok with a value of the reply's
// type, otherwise it refuses with a value of the error type the call names (a Skew, when the call names none the
// stand-in can make). Which, and what value, follow from the seed and the call's key, and a key seen before gets the
// reply it got before, as a real callee's stored reply would.
function standIn(world: World, model: Model, p: Waiting): Reply {
  const id = p.meta.key ?? p.id;
  const had = world.stubbed.get(`${p.to}/${id}`);
  if (had) return had;
  const rand = rng(hash(`${world.seed}/${p.to}/${p.meta.method}/${id}`));
  const schema = model.stubs?.[p.to]?.[p.meta.method];
  const refusal = model.refusals?.[p.to]?.[p.meta.method];
  const made = (s: Schema): Uint8Array =>
    enc.encode(JSON.stringify(valueOf(s, rand, { ids: [1, 2, 3], dict: {}, keys: [], said: {}, blank: 0.25 })));
  const reply =
    rand() < 0.75 && schema
      ? { status: 'ok', body: made(schema) }
      : refusal
        ? { status: 'rejected', body: made(refusal) }
        : { status: 'skew', body: enc.encode('the stand-in refuses') };
  if (p.meta.key) world.stubbed.set(`${p.to}/${id}`, reply);
  return reply;
}

/** What the model's table answers a held fetch; a request it has no answer for is refused, as off a host's list. */
async function stubbed(model: Model, p: Waiting): Promise<Reply> {
  const r = fetchOf(p.bytes);
  const got = await stubHttp(model.http ?? {})(
    { ...r, body: enc.encode(r.body) },
    { withinMs: p.meta.withinMs, signal: p.meta.signal, trace: null },
  );
  if ('refused' in got) return { status: 'rejected', body: enc.encode(got.refused) };
  return {
    status: 'ok',
    body: enc.encode(JSON.stringify({ status: got.status, headers: got.headers, body: dec.decode(got.body) })),
  };
}

/** How one decision about a call ends: the caller hears the reply, or is reset, or hears nothing. */
function finisher(world: World, action: string, kind: string, p: Waiting, late: boolean) {
  const decision = kind === 'deliver' && late ? 'drop' : kind;
  const key = p.meta.key ? ` once ${p.meta.key.split('/').slice(2).join('/')}` : '';
  const what = `${p.to}.${p.meta.method}${key}`;
  const finish = (reply: Reply | null, failed: string | null): void => {
    world.cur = p.run;
    const ran = reply
      ? `ran, answered ${reply.status}${reply.status === 'ok' ? '' : ` ${dec.decode(reply.body).slice(0, 80)}`}`
      : (failed ?? 'did not run');
    if (decision === 'deliver' && reply) {
      world.say(action, `${what}: ${ran}`);
      p.resolve(reply);
    } else if (decision === 'cut' || decision === 'cutafter') {
      world.say(action, `${what}: ${ran}; the caller was reset`);
      p.reject(CUT());
    } else {
      const why =
        kind === 'deliver' && late
          ? `the reply came after the ${p.meta.withinMs} ms the caller waits`
          : 'the caller got no answer';
      world.say(action, `${what}: ${ran}; ${why}`);
      p.reject(new Error('no answer'));
    }
  };
  return { decision, finish };
}

// A decision about one waiting call: delivered, lost, dropped, or the caller cut before or after the callee ran.
async function decideCall(world: World, model: Model, action: string, kind: string, a: string): Promise<void> {
  const i = world.pending.findIndex(x => x.id === a);
  const p = world.pending[i];
  if (!p) throw new Error(`${action}: no call ${a} is waiting`);
  world.pending.splice(i, 1);
  const late = world.clock - p.sent >= p.meta.withinMs;
  if (kind !== 'deliver') world.faults++;
  world.did = `${kind}:${p.to}.${p.meta.method}`;
  const { decision, finish } = finisher(world, action, kind, p, late);
  const callee = world.programs[p.to];
  if (decision === 'lose' || decision === 'cut') finish(null, null);
  // a fetch: the model's table answers it (a lost or late one is a Timeout, as for a call)
  else if (p.to === HTTP) finish(await stubbed(model, p), null);
  // a Remote nobody supplied: a reply of the right type
  else if (!callee) finish(standIn(world, model, p), null);
  else {
    // the callee may make calls of its own, which wait for their own decisions: this step does not wait for it
    world.cur = { id: `${p.id}>${p.to}` };
    watch(
      world,
      callee.app.serve({ method: p.meta.method, fingerprint: p.meta.fingerprint, key: p.meta.key }, p.bytes, callee.tx),
      r => {
        finish({ status: r.status, body: r.body }, null);
      },
      (err: unknown) => {
        if (!isCut(err)) throw err;
        finish(null, 'the callee was reset');
      },
    );
  }
  await drain();
}

/** One choice applied to the world. */
export async function apply(world: World, model: Model, clients: readonly Client[], action: string): Promise<void> {
  const [kind = '', a = '', b = ''] = action.split(' ');
  if (kind === 'tick') {
    world.clock += Number(a);
    world.say(action);
    return;
  }
  if (kind === 'start') await startRequest(world, model, clients, action, a);
  else if (kind === 'wake') await fireTimer(world, action, a, b);
  else await decideCall(world, model, action, kind, a);
}
