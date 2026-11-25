// compiler/gen/intrinsic.ts: the functions the compiler knows itself: text and Bufs, timers, the clock, JSON out,
// and the rows of a query. Those that leave the program (sql_*, decode, call, ask) have modules of their own.
import type { Arg, Call } from '../ast.ts';
import { F64, I32, I64, TRAP, fail, sleb, uleb, utf8 } from '../common.ts';
import { stdName } from '../shadow.ts';
import { BUF, FLOAT, INT, INTRINSICS, PRIVATE_INTRINSICS, REMOTE, T, VIEW, key, scaleOf } from '../types.ts';
import { written } from './text.ts';
import type { Type } from '../types.ts';
import { buildVariant, close, fresh, get, inLocals, mathIndex, need, open, set, trapIf } from './fn.ts';
import type { Ctx } from './fn.ts';
import { emitCallOut } from './callout.ts';
import { decodeRow, emitDecode } from './decode.ts';
import { emitSql } from './sql.ts';
import { emitFloatIntrinsic } from './float.ts';
import { emitDecIntrinsic } from './dec.ts';
import { emitByteScan } from './scan.ts';
import { JSON_PLAIN, byteSet } from '../byteset.ts';

/** A call of an intrinsic with its arguments in the order of its parameters. */
type Use = { readonly c: Ctx; readonly e: Call; readonly n: string; readonly args: readonly Arg[] };
const ld = (off: number): number[] => [0x28, 2, off];
const st = (off: number): number[] => [0x36, 2, off];
const i32 = (n: number): number[] => [0x41, ...sleb(n)];

const argAt = (u: Use, i: number): Arg =>
  u.args[i] ??
  fail(u.e, 'C13', `${u.n} is missing an argument`, `${u.n} takes (${(INTRINSICS.get(u.n) ?? []).join(', ')}).`);
const paramName = (u: Use, i: number): string => `argument ${INTRINSICS.get(u.n)?.[i]}`;
/** Argument i as text: the locals of its pointer and length. */
function view(u: Use, i: number): [number, number] {
  const s = inLocals(u.c, argAt(u, i).value, VIEW);
  need(u.c, s.type, VIEW, argAt(u, i), paramName(u, i));
  return [s.locals[0] ?? 0, s.locals[1] ?? 0];
}
/** Argument i as a value of one Wasm type, in a fresh local. */
function scalar(u: Use, i: number, type: Type, vt: number): number {
  need(u.c, u.c.emit(argAt(u, i).value, type, false), type, argAt(u, i), paramName(u, i));
  const l = fresh(u.c, vt);
  u.c.code.push(...set(l));
  return l;
}
const int = (u: Use, i: number): number => scalar(u, i, INT, I64);
const bufArg = (u: Use, i: number): number => scalar(u, i, BUF, I32);

// ---- text and Bufs. A Buf is a pointer to its header: data, len, cap.

function slice(u: Use): Type {
  const [ptr, len] = view(u, 0);
  const a = int(u, 1);
  const b = int(u, 2);
  u.c.code.push(...get(a), ...get(b), 0x56, ...get(b), ...get(len), 0xad, 0x56, 0x72);
  trapIf(u.c, TRAP.BOUNDS);
  u.c.code.push(...get(ptr), ...get(a), 0xa7, 0x6a, ...get(b), ...get(a), 0x7d, 0xa7);
  return VIEW;
}

function newBuf({ c }: Use): Type {
  const h = fresh(c, I32);
  const header = [
    ...get(h),
    ...i32(16),
    0x6a,
    ...st(0),
    ...get(h),
    ...i32(0),
    ...st(4),
    ...get(h),
    ...i32(64),
    ...st(8),
  ];
  c.code.push(...i32(80), 0x10, ...uleb(c.B.ALLOC), 0x22, ...uleb(h), ...header, ...get(h));
  return BUF;
}

function push(u: Use): Type {
  const { c } = u;
  const h = bufArg(u, 0);
  const b = int(u, 1);
  c.code.push(...get(b), 0x42, ...sleb(255), 0x56);
  trapIf(c, TRAP.BOUNDS);
  c.code.push(...get(h), ...ld(4), ...get(h), ...ld(8), 0x46);
  open(c, 0x04);
  c.code.push(...get(h), ...i32(1), 0x10, ...uleb(c.B.RESERVE));
  close(c);
  const end = [...get(h), ...ld(0), ...get(h), ...ld(4), 0x6a];
  const longer = [...get(h), ...get(h), ...ld(4), ...i32(1), 0x6a, ...st(4)];
  c.code.push(...end, ...get(b), 0xa7, 0x3a, 0, 0, ...longer, ...get(h));
  return BUF;
}

function append(u: Use): Type {
  const { c } = u;
  // text with holes goes straight into this Buf: no Buf of its own, no second copy
  const text = argAt(u, 1).value;
  if (text.k === 'interp') return c.emit(written(c, text, argAt(u, 0).value), BUF, false);
  const h = bufArg(u, 0);
  const [ptr, len] = view(u, 1);
  const end = [...get(h), ...ld(0), ...get(h), ...ld(4), 0x6a];
  const longer = [...get(h), ...get(h), ...ld(4), ...get(len), 0x6a, ...st(4)];
  const reserved = [...get(h), ...get(len), 0x10, ...uleb(c.B.RESERVE)];
  c.code.push(...reserved, ...end, ...get(ptr), ...get(len), 0xfc, 0x0a, 0, 0, ...longer, ...get(h));
  return BUF;
}

/**
 * answer_body(out, body): where the body of an answer is, not its bytes: the View's address and its length, 4 bytes
 * each, little-endian, after the head std/http.tape `framed` wrote. The host reads the body from there (host/run.ts
 * answered), so an answer costs its head and not a second copy of its body. Only `framed` writes one: in any other
 * file the name is not a function, so no program reads an address.
 */
function answerBody(u: Use): Type {
  const { c } = u;
  if (c.f.file !== PRIVATE_INTRINSICS.get('answer_body'))
    return fail(
      u.e,
      'C22',
      'unknown function answer_body',
      "answer_body is std/http.tape's own, for the frame the host reads; a program gives a Response.",
    );
  const h = bufArg(u, 0);
  const [ptr, len] = view(u, 1);
  const end = [...get(h), ...ld(0), ...get(h), ...ld(4), 0x6a];
  const longer = [...get(h), ...get(h), ...ld(4), ...i32(8), 0x6a, ...st(4)];
  // room for 8 bytes, then the address and the length, each an i32.store with alignment 1 (the head is any length)
  const reserved = [...get(h), ...i32(8), 0x10, ...uleb(c.B.RESERVE)];
  c.code.push(...reserved, ...end, ...get(ptr), 0x36, 0, 0, ...end, ...get(len), 0x36, 0, 4, ...longer, ...get(h));
  return BUF;
}

/** write_float(out, value): the shortest digits that read back as the Float, as the host writes them (u32 length,
 * then the bytes), appended. */
function writeFloat(u: Use): Type {
  appendFloat(u.c, bufArg(u, 0), scalar(u, 1, FLOAT, F64));
  return BUF;
}
/** The Buf in local h with the text of the Float in local x appended, on the stack. */
function appendFloat(c: Ctx, h: number, x: number): void {
  const text = fresh(c, I32);
  c.code.push(...get(x), 0x10, ...uleb(c.B.FLOAT_TEXT_IMPORT), ...set(text));
  const len = [...get(text), ...ld(0)];
  const end = [...get(h), ...ld(0), ...get(h), ...ld(4), 0x6a];
  const longer = [...get(h), ...get(h), ...ld(4), ...len, 0x6a, ...st(4)];
  const reserved = [...get(h), ...len, 0x10, ...uleb(c.B.RESERVE)];
  const from = [...get(text), ...i32(4), 0x6a];
  c.code.push(...reserved, ...end, ...from, ...len, 0xfc, 0x0a, 0, 0, ...longer, ...get(h));
}

/** size(buf): a Buf's length without handing it over, so it takes the variable itself. */
function size(u: Use): Type {
  const { c } = u;
  const arg = argAt(u, 0);
  const a = arg.value;
  const v = a.k === 'var' ? c.env.get(a.name) : undefined;
  if (!v || v.type.name !== 'Buf')
    return fail(
      arg,
      'C29',
      'size takes a Buf variable',
      "size reads a Buf's length without handing it over, so it needs the variable itself.",
    );
  if (c.consumed.has(v))
    fail(
      arg,
      'C25',
      `${v.name} is used after it was handed over`,
      'A Buf has one owner at a time. Use the value the earlier call returned.',
    );
  c.code.push(...get(v.locals[0] ?? 0), ...ld(4), 0xad);
  return INT;
}

// ---- JSON out

// write_json(value): a scalar, a list (an array of its items), or a record; a record that is not one flat
// constructor is written by its generated wire_write_T (compiler/wire.ts), a flat one here.
function writeJson(u: Use): Type {
  const { c, e } = u;
  const { B } = c;
  need(c, c.emit(argAt(u, 0).value, BUF, false), BUF, argAt(u, 0), 'argument out');
  const value = argAt(u, 1);
  const s = inLocals(c, value.value);
  const base = B.strip(s.type).name;
  // std's function of (out, label) that writes it, by its file's stem: a program's own of that name is not it
  const via = (fn: string, label: string): Type => {
    const o = fresh(c, I32);
    c.code.push(...set(o));
    const at = { line: e.line, file: e.file };
    const held = (h: { type: Type; locals: number[] }) => ({ k: 'held' as const, held: h, ...at });
    const args = [
      { label: 'out', value: held({ type: BUF, locals: [o] }), ...at },
      { label, value: held(s), ...at },
    ];
    return c.emit({ k: 'call', name: fn, args, ...at }, BUF, false);
  };
  const json = (t: Type): boolean =>
    ['Int', 'Dec', 'Float', 'Bool', 'View'].includes(B.strip(t).name) ||
    B.WIRE.encodable.has(t.name) ||
    (t.name === 'List' && t.args.length === 1 && t.args.every(json));
  const has = (fn: string): boolean => B.find(fn, c.f.file) !== null;
  if (base === 'Int' && has('text.write_int')) return via('text.write_int', 'value');
  // a Dec is text, its count at its scale: "12.30"
  const scale = scaleOf(B.strip(s.type));
  if (scale !== null && has('text.write_units')) {
    const quote = (): void => {
      const [at, n] = B.literal(utf8('"'));
      c.code.push(...i32(at), ...i32(n), 0x10, ...uleb(B.fnIndex('write_text')));
    };
    quote();
    c.code.push(...get(s.locals[0] ?? 0), 0x42, ...sleb(BigInt(scale)), 0x10, ...uleb(B.fnIndex('write_units')));
    quote();
    return BUF;
  }
  if (base === 'Float' && has('json.json_write_float')) return via('json.json_write_float', 'value');
  if (base === 'Bool' && has('json.write_bool')) return via('json.write_bool', 'value');
  if (base === 'View' && has('json.write_json_string')) return via('json.write_json_string', 'text');
  if (s.type.name === 'List') {
    if (!json(s.type) || !has('json.wire_write_list'))
      fail(
        value,
        'C09',
        `${key(s.type)} cannot be written as JSON`,
        'A list is written as an array of its items: Int, Float, Bool, View, records that can be JSON, or lists of them.',
      );
    return via('json.wire_write_list', 'list');
  }
  if (B.WIRE.written.has(s.type.name)) {
    for (const l of s.locals) c.code.push(...get(l));
    c.code.push(0x10, ...uleb(B.fnIndex(`wire_write_${s.type.name}`)));
    return BUF;
  }
  const fields = B.shapeOf(s.type, value, false).variants[0] ?? [];
  const adt = B.adtOf(s.type, e);
  const stored = adt.boxed ? [] : (adt.variants[0]?.fields ?? []);
  const text = (t: string): void => {
    const [at, n] = B.literal(utf8(t));
    c.code.push(...i32(at), ...i32(n));
  };
  const write = (): void => {
    c.code.push(0x10, ...uleb(B.fnIndex('write_text')));
  };
  fields.forEach((fl, i) => {
    const [first = 0, second = 0] = (stored[i]?.slots ?? []).map(x => s.locals[x] ?? 0);
    text(`${i > 0 ? ',' : '{'}${JSON.stringify(fl.name)}:`);
    write();
    if (fl.kind === 'i') c.code.push(...get(first), 0x10, ...uleb(B.fnIndex('write_int')));
    else if (fl.kind.startsWith('d')) {
      // a Dec is text, its count at its scale: "12.30"
      text('"');
      write();
      c.code.push(...get(first), 0x42, ...sleb(BigInt(fl.kind.slice(1))), 0x10, ...uleb(B.fnIndex('write_units')));
      text('"');
      write();
    } else if (fl.kind === 'f') {
      const h = fresh(c, I32);
      c.code.push(...set(h));
      appendFloat(c, h, first);
    } else if (fl.kind === 't')
      c.code.push(...get(first), ...get(second), 0x10, ...uleb(B.fnIndex('write_json_string')));
    else {
      c.code.push(...get(first));
      open(c, 0x04, [I32, I32]);
      text('true');
      c.code.push(0x05);
      text('false');
      close(c);
      write();
    }
  });
  text(fields.length > 0 ? '}' : '{}');
  write();
  return BUF;
}

// ---- rows

/** next(rows): Next with the first row and the rows after it, or End. */
function next(u: Use): Type {
  const { c, e } = u;
  const { prog } = c.B;
  const arg = argAt(u, 0);
  const s = inLocals(c, arg.value);
  const [rowT] = s.type.args;
  if (s.type.name !== 'Rows' || !rowT)
    return fail(
      arg,
      'C14',
      `argument rows should be Rows[…] but is ${key(s.type)}`,
      'Pass the rows a `sql_all` gave, or the rest from the last `Next(value, rest)`.',
    );
  const [ptr = 0, count = 0] = s.locals;
  const step = T(stdName(prog, 'types', 'Step'), rowT);
  const adt = c.B.adtOf(step, e);
  const variant = (name: string): number => adt.variants.findIndex(v => v.name === stdName(prog, 'ctors', name));
  const cur = fresh(c, I32);
  c.code.push(...get(count), 0x45);
  open(c, 0x04, adt.slots);
  buildVariant(c, adt, variant('End'), []);
  c.code.push(0x05, ...get(ptr), ...set(cur));
  const ls = decodeRow(c, rowT, cur, e);
  const left = fresh(c, I32);
  c.code.push(...get(count), ...i32(1), 0x6b, ...set(left));
  buildVariant(c, adt, variant('Next'), [...ls, cur, left]);
  close(c);
  return step;
}

// ---- capabilities

// wake(timer, after: ms, key: n) -> Done: a timer, set for `after` kept within 0 ms to 30 days
function wake(c: Ctx, e: Call): Type {
  const arg = (l: string): Arg =>
    e.args.find(a => a.label === l) ??
    fail(
      e,
      'C13',
      `wake is missing argument ${l}`,
      "Write `wake(timer, after: 2000, key: id)`: when it is due, the host calls this program's `woken` with Wake(key: id).",
    );
  for (const a of e.args)
    if (a.label === null || !['timer', 'after', 'key'].includes(a.label))
      fail(a, 'C11', `wake has no parameter ${a.label ?? '(unnamed)'}`, 'wake takes (timer, after, key).');
  const t = arg('timer');
  if (c.emit(t.value, T('Timer'), false).name !== 'Timer')
    fail(
      t,
      'C14',
      'wake needs the Timer capability',
      "Add `timer: Timer` to this function's parameters and pass it here, so every caller shows that it sets timers.",
    );
  need(c, c.emit(arg('key').value, INT, false), INT, arg('key'), 'argument key');
  c.code.push(0xb9);
  need(c, c.emit(arg('after').value, INT, false), INT, arg('after'), 'argument after');
  // the host answers the delay it set; the program is given Done, the value of a call run for what it does
  c.code.push(0xb9, 0x10, ...uleb(c.B.WAKE_IMPORT), 0x1a);
  const done = T(stdName(c.B.prog, 'types', 'Done'));
  buildVariant(c, c.B.adtOf(done, e), 0, []);
  return done;
}

// remote(of: shards, index: i): one Remote of a family; which one is decided at run time, so the number of
// members is not fixed when the program is built (a router over N shards)
function remote(c: Ctx, e: Call): Type {
  const of = e.args.find(a => a.label === 'of');
  const index = e.args.find(a => a.label === 'index');
  const other = e.args.find(a => a !== of && a !== index);
  if (other || !of || !index)
    return fail(
      other ?? e,
      'C11',
      'remote takes (of, index)',
      'For example `remote(of: shards, index: fnv1a(v: key) % count)`.',
    );
  if (c.emit(of.value, T('Remotes'), false).name !== 'Remotes')
    fail(
      of,
      'C14',
      'remote needs a family of Remotes',
      "Add `shards: Remotes` to this function's parameters and pass it here.",
    );
  need(c, c.emit(index.value, INT, false), INT, index, 'argument index');
  c.code.push(0xb9, 0x10, ...uleb(c.B.MEMBER_IMPORT));
  return REMOTE;
}

/** now(clock) and random(from: entropy): asked of the host, so a replay gives the same answer. */
function ask(c: Ctx, e: Call, n: 'now' | 'random'): Type {
  const [cap, label, kind, reads] =
    n === 'now' ? ['Clock', 'clock', 0, 'the time'] : ['Entropy', 'from', 1, 'random numbers'];
  const [arg] = e.args;
  if (e.args.length !== 1 || !arg)
    return fail(
      e,
      'C11',
      `${n} takes (${label})`,
      `Write \`${n}(${label})\` with the ${label === 'clock' ? 'Clock' : 'Entropy'} parameter, and nothing else.`,
    );
  if (c.emit(arg.value, T(cap), false).name !== cap)
    fail(
      arg,
      'C14',
      `${n} needs the ${cap} capability`,
      `Add \`${label}: ${cap}\` to this function's parameters and pass it here, so every caller shows that it reads ${reads}.`,
    );
  c.code.push(0x41, kind, 0x10, ...uleb(c.B.ASK_IMPORT), 0xfc, 0x06);
  return INT;
}

/** wrapping_add(a, b), wrapping_sub, wrapping_mul: the low 64 bits of the exact result, never a stop. */
const wrapping =
  (opcode: number) =>
  (u: Use): Type => {
    const a = int(u, 0);
    const b = int(u, 1);
    u.c.code.push(...get(a), ...get(b), opcode);
    return INT;
  };

/**
 * scan(v, at, set): the first position at or after `at` whose byte is in `set`, a text literal; len(v) when there
 * is none. The bytes are fixed at compile time (compiler/gen/scan.ts). `at` outside 0..len(v) traps.
 */
function scan(u: Use): Type {
  const member = argAt(u, 2);
  if (member.value.k !== 'str')
    return fail(
      member,
      'C93',
      'the set of scan must be a text literal',
      'The bytes are fixed when the program is compiled, so the scan reads 16 at a time. Write the bytes to stop on as text: `set: "*_[]!<&"` (`\\n` is byte 10).',
    );
  return scanBytes(u, byteSet(member.value.bytes));
}

/** scan_plain(v, at): scan of the bytes that end a JSON string's plain run (below 32, 128 or more, a quote, a backslash). */
function scanPlain(u: Use): Type {
  return scanBytes(u, JSON_PLAIN);
}

function scanBytes(u: Use, mask: readonly number[]): Type {
  const [p, n] = view(u, 0);
  const at = int(u, 1);
  emitByteScan(u.c, p, n, at, mask);
  return INT;
}

/**
 * parse_float(text): Some of the Float nearest the number `text` (the host's env.float_of, host/memory.ts floatOf:
 * ECMA-262's StringToNumber of a number in JSON's syntax; correctly rounded, the same everywhere), or None when that
 * is not finite (1e400) or `text` is not such a number ("", " 1", "0x10", "+1", ".5", "05"). A
 * plain decimal of at most 2^53 in its digits and 22 after the point is read in the module, exactly as the host would;
 * the rest is the host's.
 */
function parseFloat(u: Use): Type {
  const { c } = u;
  const [p, n] = view(u, 0);
  const x = fresh(c, F64);
  const opt = T('Option', FLOAT);
  const adt = c.B.adtOf(opt, u.e);
  const which = (name: string): number => adt.variants.findIndex(v => v.name === name);
  // the module's own reading of a plain decimal (compiler/math/decimal.ts), NaN when it is not one; then the host's
  const fast = [...get(p), ...get(n), 0x10, ...uleb(mathIndex(c.B, 'parse_decimal')), 0x22, ...uleb(x)];
  const host = [...get(p), ...get(n), 0x10, ...uleb(c.B.FLOAT_OF_IMPORT), ...set(x)];
  const read = [...fast, ...get(x), 0x62, 0x04, 0x40, ...host, 0x0b];
  // then whether it is finite: x - x is 0 (NaN for NaN and the infinities)
  c.code.push(...read, ...get(x), ...get(x), 0xa1, 0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0x61);
  open(c, 0x04, adt.slots);
  buildVariant(c, adt, which('Some'), [x]);
  c.code.push(0x05);
  buildVariant(c, adt, which('None'), []);
  close(c);
  return opt;
}

const BY_NAME: Readonly<Record<string, (u: Use) => Type>> = {
  len: u => {
    u.c.code.push(...get(view(u, 0)[1]), 0xad);
    return INT;
  },
  slice,
  buf: newBuf,
  push,
  append,
  answer_body: answerBody,
  // rollback(out): the Response, as it was given, with the stretch's writes marked to be undone
  rollback: u => {
    const want = T(stdName(u.c.B.prog, 'types', 'Response'));
    const s = inLocals(u.c, argAt(u, 0).value, want);
    need(u.c, s.type, want, argAt(u, 0), paramName(u, 0));
    u.c.code.push(...i32(1), 0x24, u.c.B.G_UNDO, ...s.locals.flatMap(l => get(l)));
    return s.type;
  },
  freeze: u => {
    const h = bufArg(u, 0);
    u.c.code.push(...get(h), ...ld(0), ...get(h), ...ld(4));
    return VIEW;
  },
  size,
  write_json: writeJson,
  write_float: writeFloat,
  next,
  wrapping_add: wrapping(0x7c),
  wrapping_sub: wrapping(0x7d),
  wrapping_mul: wrapping(0x7e),
  scan_plain: scanPlain,
  scan,
  parse_float: parseFloat,
};

export function emitIntrinsic(c: Ctx, e: Call): Type {
  const n = e.name;
  if (n.startsWith('sql_')) return emitSql(c, e);
  if (n === 'decode') return emitDecode(c, e);
  if (n === 'call' || n === 'ask') return emitCallOut(c, e);
  if (n === 'wake') return wake(c, e);
  if (n === 'remote') return remote(c, e);
  if (n === 'now' || n === 'random') return ask(c, e, n);
  const float = emitFloatIntrinsic(c, e);
  if (float) return float;
  const ordered = (): Arg[] => c.B.orderArgs(`function ${n}`, INTRINSICS.get(n) ?? [], e.args, e);
  const dec = emitDecIntrinsic(c, e, ordered);
  if (dec) return dec;
  const args = ordered();
  const known = Object.hasOwn(BY_NAME, n) ? BY_NAME[n] : undefined;
  return known
    ? known({ c, e, n, args })
    : fail(
        e,
        'C99',
        `unsupported intrinsic ${n}`,
        'This is a compiler bug, not a mistake in the program: please report it with the program that shows it.',
      );
}
