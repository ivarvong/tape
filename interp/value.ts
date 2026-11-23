// interp/value.ts: what a Tape expression can be, in the reference interpreter. A value is a variant of a union;
// each reader below gives the variant asked for or stops, so a program that would be ill-typed stops here and does
// not go on with whatever JavaScript makes of it.
import type { Block } from '../compiler/ast.ts';
import type { Dec } from './dec.ts';

export type Env = Map<string, Value>;
/** A constructor applied to its fields: `Order(id: 1, state: "new")`. */
export type Adt = { readonly k: 'adt'; readonly c: string; readonly f: Readonly<Record<string, Value>> };
/** Bytes being written. `push` and `append` add to it in place, as the compiled build does. */
export type Buf = { readonly k: 'buf'; readonly buf: number[] };
/** A function value: a named function, or a `fn(…) -> … { … }` with the names it was written among. */
export type Fn = {
  readonly k: 'fn';
  readonly params: string[];
  readonly body: Block;
  readonly file: string;
  readonly env: Env | null;
  /** a function of the program, by its name: a recursive one holds its weight against the depth budget */
  readonly name?: string;
};
/** The rows of `sql_all`, read with `next`. */
export type Rows = { readonly k: 'rows'; readonly rows: readonly Value[]; readonly at: number };
export type Remote = { readonly k: 'remote'; readonly remote: string };
export type Family = { readonly k: 'family'; readonly family: string };
/** What stands for Sql, Clock, Entropy or Timer: holding it is the permission, and it carries nothing else. */
export type Capability = { readonly k: 'capability'; readonly capability: string };
/** An Int is a bigint and a Float a number, so one is never taken for the other. */
export type Value = bigint | number | boolean | Uint8Array | Dec | Adt | Buf | Fn | Rows | Remote | Family | Capability;

export const adt = (c: string, f: Record<string, Value> = {}): Adt => ({ k: 'adt', c, f });
export const kindOf = (v: Value | undefined): string =>
  v === undefined
    ? 'nothing'
    : typeof v === 'bigint'
      ? 'a number'
      : typeof v === 'number'
        ? 'a Float'
        : typeof v === 'boolean'
          ? 'a Bool'
          : v instanceof Uint8Array
            ? 'text'
            : v.k === 'adt'
              ? v.c
              : v.k === 'dec'
                ? `a Dec[${v.s}]`
                : `a ${v.k}`;
const not = (want: string, v: Value | undefined): never => {
  throw new Error(`expected ${want}, found ${kindOf(v)}`);
};
export const asInt = (v: Value | undefined): bigint => (typeof v === 'bigint' ? v : not('a number', v));
export const asFloat = (v: Value | undefined): number => (typeof v === 'number' ? v : not('a Float', v));
export const asBool = (v: Value | undefined): boolean => (typeof v === 'boolean' ? v : not('a Bool', v));
export const asBytes = (v: Value | undefined): Uint8Array => (v instanceof Uint8Array ? v : not('text', v));
const isObject = (v: Value | undefined): v is Dec | Adt | Buf | Fn | Rows | Remote | Family | Capability =>
  typeof v === 'object' && !(v instanceof Uint8Array);
export const isDec = (v: Value | undefined): v is Dec => isObject(v) && v.k === 'dec';
export const asDec = (v: Value | undefined): Dec => (isDec(v) ? v : not('a Dec', v));
export const isFn = (v: Value | undefined): v is Fn => isObject(v) && v.k === 'fn';
export const asAdt = (v: Value | undefined): Adt => (isObject(v) && v.k === 'adt' ? v : not('a constructed value', v));
export const asBuf = (v: Value | undefined): Buf => (isObject(v) && v.k === 'buf' ? v : not('a Buf', v));
export const asRows = (v: Value | undefined): Rows => (isObject(v) && v.k === 'rows' ? v : not('Rows', v));
export const asRemote = (v: Value | undefined): Remote | null => (isObject(v) && v.k === 'remote' ? v : null);
export const asFamily = (v: Value | undefined): Family => (isObject(v) && v.k === 'family' ? v : not('Remotes', v));

export const wrap = (x: bigint): bigint => BigInt.asIntN(64, x);
export const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
/** A number small enough to be exact outside the program (a SQL parameter, a timer's key). */
export const exact = (x: bigint, what: string): number => {
  const n = Number(x);
  if (!Number.isSafeInteger(n)) throw new TypeError(`${what} outside ±2^53`);
  return n;
};
