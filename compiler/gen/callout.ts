// compiler/gen/callout.ts: call(to, send, within, once) and ask(to, send, within): one request to another object
// or Worker. The host answers from the effect log; when the reply is not there yet it stops this run, makes the
// call with the time budget, and runs the handler again.
import { partsOf } from '../ast.ts';
import type { Arg, At, Expr } from '../ast.ts';
import { I32, fail, sleb, uleb } from '../common.ts';
import { stdName } from '../shadow.ts';
import { BUILTIN_TYPES, INT, REMOTE, T, VIEW, key } from '../types.ts';
import type { Type } from '../types.ts';
import { decodeTo } from './decode.ts';
import { buildVariant, close, fresh, get, inLocals, need, open, set } from './fn.ts';
import type { CallOut, Ctx, Stored } from './fn.ts';
import type { Adt } from './layout.ts';

/** The arguments of a call out, each found by its name. */
type Named = {
  within: Arg;
  once: Arg | null;
  to: Arg;
  method: Arg;
  send: Arg;
  reply: Arg;
  methodName: string;
  replyT: Type;
};
const text = (bytes: readonly number[]): string => new TextDecoder().decode(new Uint8Array(bytes));
const variantOf = (adt: Adt, name: string): number => adt.variants.findIndex(x => x.name === name);

function named(e: CallOut): Named {
  const keyed = e.name === 'call';
  const takes = ['to', 'method', 'send', 'reply', 'within', ...(keyed ? ['once'] : [])];
  const arg = (n: string): Arg | undefined => e.args.find(a => a.label === n);
  const must = (n: string, hint: string): Arg => arg(n) ?? fail(e, 'C13', `${e.name} is missing argument ${n}`, hint);
  for (const a of e.args)
    if (a.label === null || !takes.includes(a.label))
      fail(
        a,
        'C11',
        `${e.name} takes (${takes.join(', ')})`,
        a.label === 'once'
          ? 'A read has no key. Use `call` for a command.'
          : `Take out ${a.label === null ? 'the unnamed argument' : `${a.label}:`}; ${e.name} is written ${e.name}(${takes.map(t => `${t}: …`).join(', ')}).`,
      );
  const within =
    arg('within') ??
    fail(
      e,
      'C39',
      `${e.name} is missing argument within`,
      'Every call has a time budget in milliseconds, for example `within: 200`. When it runs out the result is Err(Timeout).',
    );
  const once = keyed
    ? (arg('once') ??
      fail(
        e,
        'C41',
        'call is missing argument once',
        'A command carries a key, for example `once: id`: the other side runs it at most once per key, so sending it again after a timeout is safe. For a read, use `ask`.',
      ))
    : null;
  const to = must('to', 'Pass a Remote parameter: every call names the capability it uses.');
  const method = must('method', 'Name the method, for example `method: "reserve"`.');
  const send = must('send', 'Pass the message record.');
  const reply = must('reply', 'Name the reply type, for example `reply: Reserved`.');
  if (method.value.k !== 'str')
    return fail(
      method,
      'C14',
      'argument method should be a text literal',
      'Write the method as a text literal, `method: "reserve"`: it is part of the message both programs agree on.',
    );
  if (reply.value.k !== 'ctor' || reply.value.args.length > 0)
    return fail(
      reply,
      'C14',
      'argument reply should be a type name',
      'Name the reply type itself, `reply: Reserved`, not a value of it.',
    );
  return { within, once, to, method, send, reply, methodName: text(method.value.bytes), replyT: T(reply.value.name) };
}

// ---- the key of a command (once): text, or a record that names the command; the host scopes it by this object
// and the method, and the callee refuses it for another message (host.ts serve). An Int is refused (C64): it names
// nothing, and one that is the same every time makes every command one (C65; a key made only of what the message
// carries is C65 in rules/commands.ts, which knows the rows a command is for)

/** `a.b.c` for a variable or a field of one; null for anything else. */
const pathOf = (n: Expr): string | null => {
  if (n.k === 'var') return n.name;
  const base = n.k === 'field' ? pathOf(n.e) : null;
  return base !== null && n.k === 'field' ? `${base}.${n.name}` : null;
};

/** The variables, and fields of variables, an expression reads: `a`, `a.b.c`. */
function leaves(x: Expr): Set<string> {
  const out = new Set<string>();
  const go = (n: Expr): void => {
    const path = pathOf(n);
    if (path === null) partsOf(n).forEach(go);
    else out.add(path);
  };
  go(x);
  return out;
}

function checkKey(c: Ctx, once: Arg, kt: Type): void {
  const { prog } = c.B;
  const kadt = !BUILTIN_TYPES.has(kt.name) && prog.types.has(kt.name) ? c.B.adtOf(kt, once) : null;
  const wrapper = ['Option', 'Result', 'Move', stdName(prog, 'types', 'Step')].includes(kt.name);
  const record = !!kadt && kadt.variants.length === 1 && (kadt.variants[0]?.fields.length ?? 0) > 0 && !wrapper;
  if (kt.name !== 'View' && !record)
    fail(
      once,
      'C64',
      `the key of a command must be text or a record, not ${key(kt)}`,
      `Name the command: \`once: ${kt.name === 'Int' ? 'Charge(order: id)' : 'Charge(order: …)'}\` (a record of your own: type Charge { Charge(order: Int) }), or text such as \`once: "charge-" ++ decimal_text(value: id)\`. A bare number says nothing of what it is the key of, and the same number used for another command is taken for a repeat of it.`,
    );
  const kl = leaves(once.value);
  if (kl.size === 0)
    fail(
      once,
      'C65',
      'this command has the same key every time it is sent: the first is run, and every later one is answered with its reply',
      'Key it by what makes this command one of its kind: the id of the row it is for, or a key the client sent.',
    );
}

/** A value already held, written as JSON text: `freeze(write_json(buf(), value))`. */
function asJson(held: Stored, at: At): Expr {
  const arg = (label: string, value: Expr): Arg => ({ label, value, ...at });
  const call = (name: string, args: Arg[]): Expr => ({ k: 'call', name, args, ...at });
  const out = call('write_json', [arg('out', call('buf', [])), arg('value', { k: 'held', held, ...at })]);
  return call('freeze', [arg('buf', out)]);
}

// the reply block: u32 status (0 ok, 1 timeout, 2 unreachable, 3 rejected, 4 skew), u32 length, bytes
function readReply(c: Ctx, e: CallOut, replyT: Type): Type {
  const [r, tag, pt, n] = [fresh(c, I32), fresh(c, I32), fresh(c, I32), fresh(c, I32)];
  const out = c.B.slotsOf(replyT).map(vt => fresh(c, vt));
  const why: [number, number] = [fresh(c, I32), fresh(c, I32)];
  const errT = T('CallError');
  const err = c.B.adtOf(errT, e);
  const res = T('Result', replyT, errT);
  const adt = c.B.adtOf(res, e);
  if (
    !err.tagged ||
    err.slots.length !== 3 ||
    err.variants.map(x => x.name).join(',') !== 'Timeout,Unreachable,Rejected,Skew'
  )
    fail(
      e,
      'C99',
      'std/core.tape: CallError must be Timeout, Unreachable, Rejected(reason: View), Skew(reason: View)',
      'This is a compiler bug, not a mistake in the program: please report it with the program that shows it.',
    );
  const status = [0x22, ...uleb(r), 0x28, 2, 0, 0x41, 1, 0x6b, ...set(tag)];
  const body = [...get(r), 0x28, 2, 4, ...set(n), ...get(r), 0x41, 8, 0x6a, ...set(pt)];
  c.code.push(0x10, ...uleb(c.B.CALL_IMPORT), 0xfc, 0x03, ...status, ...body, ...get(tag), 0x41, ...sleb(-1), 0x46);
  open(c, 0x04, adt.slots);
  decodeTo(c, replyT, [pt, n], out, e, why);
  open(c, 0x04, adt.slots);
  buildVariant(c, adt, variantOf(adt, 'Ok'), out);
  // a reply that is not the promised record: the two sides disagree despite the fingerprint
  c.code.push(0x05, 0x41, 3, ...set(tag));
  buildVariant(c, adt, variantOf(adt, 'Err'), [tag, ...why]);
  close(c);
  c.code.push(0x05);
  buildVariant(c, adt, variantOf(adt, 'Err'), [tag, pt, n]);
  close(c);
  return res;
}

export function emitCallOut(c: Ctx, e: CallOut): Type {
  const { B } = c;
  const { within, once, to, send, methodName, replyT } = named(e);
  const at = { line: e.line, file: e.file };
  const toType = c.emit(to.value, REMOTE, false);
  if (!B.prog.interfaces.has(toType.name)) need(c, toType, REMOTE, to, 'argument to');
  // the message, written as JSON
  const sent = inLocals(c, send.value, e.sendType ?? null);
  if (e.sendType) need(c, sent.type, e.sendType, send, 'argument send');
  const keyHeld = once ? inLocals(c, once.value, null) : null;
  if (once && keyHeld) checkKey(c, once, B.strip(keyHeld.type));
  // for the simulator: what a reply to this method looks like, so a Remote nobody supplied can be stood in for
  B.SIMJSON.replies[`${'name' in to.value ? to.value.name : ''}.${methodName}`] = [replyT, e];
  const fingerprint = B.fingerprint(methodName, sent.type, replyT, e);
  const id = B.calls.push({ method: methodName, keyed: e.name === 'call', fingerprint }) - 1;
  c.code.push(0x41, ...sleb(id));
  need(c, c.emit(asJson(sent, at), VIEW, false), VIEW, send, 'argument send');
  need(c, c.emit(within.value, INT, false), INT, within, 'argument within');
  c.code.push(0xb9);
  if (once && keyHeld) {
    const isText = B.strip(keyHeld.type).name === 'View';
    need(
      c,
      c.emit(isText ? { k: 'held', held: keyHeld, ...at } : asJson(keyHeld, at), VIEW, false),
      VIEW,
      once,
      'argument once',
    );
  } else c.code.push(0x41, 0, 0x41, 0);
  return readReply(c, e, replyT);
}
