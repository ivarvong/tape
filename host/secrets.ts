// host/secrets.ts: what a host gives `secret(from:, name:)`, and how a value read keeps out of the effect log.
//
// A secret is read by name, and the log records the name and the version given, never the value: a replay asks the
// store for that version, and when it is gone (the secret was deleted, or replaced more often than the store keeps)
// the replay stops with that reason instead of running on a value the run never saw.
//
// What the run sends and receives over HTTP (std/http.tape fetch) is logged too, so each value the run has read is
// kept out of that entry: in the request (its URL, its header values, its body) every occurrence is written
// `[secret <name>]`, one way: the replay reads the same values and writes the same request, which is what it
// compares. The reply must come back byte for byte in a replay, so there each occurrence is a mark the replay turns
// back into the value (`hold` and `release`): the mark is the bytes 0x00 "tape-secret:" and the secret's place
// among those the run read, then ";"; a 0x00 "tape-secret:" already in the reply is written with "~" after it, so
// no reply is read back as anything but itself.

/** A secret as the store holds it: the value, and its version (a counter per secret, from 1). */
export type SecretValue = { value: Uint8Array; version: number };
/** Where a host's secrets come from. `read` is the current value; `at` a version a log names, or null when gone. */
export type SecretStore = {
  read: (name: string) => SecretValue | null;
  at: (name: string, version: number) => Uint8Array | null;
};
/** The secrets a run has read, in the order it read them. */
export type Read = { name: string; value: Uint8Array }[];

/** A store of fixed values, each version 1: the command line's `--secret name=value`, a test's, the simulator's. */
export function fixedSecrets(values: Readonly<Record<string, string | Uint8Array>>): SecretStore {
  const enc = new TextEncoder();
  const bytes = (v: string | Uint8Array): Uint8Array => (typeof v === 'string' ? enc.encode(v) : v);
  return {
    read: name => (Object.hasOwn(values, name) ? { value: bytes(values[name] ?? ''), version: 1 } : null),
    at: (name, version) => (version === 1 && Object.hasOwn(values, name) ? bytes(values[name] ?? '') : null),
  };
}

/** A name a store holds: 1-64 of a-z 0-9 _ -. Any other name is no secret. */
export const SECRET_NAME = /^[a-z0-9_-]{1,64}$/;
/** The longest a secret may be. */
export const SECRET_MAX = 4096;

const enc = new TextEncoder();
const MARK = enc.encode('\u0000tape-secret:');

/** Does `part` stand in `b` at `i`? */
function startsAt(b: Uint8Array, part: Uint8Array, i: number): boolean {
  if (i + part.length > b.length) return false;
  for (let j = 0; j < part.length; j++) if (b[i + j] !== part[j]) return false;
  return true;
}
/** Where `part` is in `b` from `from` on, or -1. */
function indexOf(b: Uint8Array, part: Uint8Array, from: number): number {
  const [first] = part;
  if (first === undefined) return -1;
  for (let i = b.indexOf(first, from); i >= 0; i = b.indexOf(first, i + 1)) if (startsAt(b, part, i)) return i;
  return -1;
}

/** `b` with every occurrence of each value replaced by what `by` gives for it, the longest values first. */
function replaced(b: Uint8Array, values: readonly { value: Uint8Array; by: Uint8Array }[]): Uint8Array {
  const order = values.filter(v => v.value.length > 0).toSorted((x, y) => y.value.length - x.value.length);
  const out: number[] = [];
  const at = (i: number): { value: Uint8Array; by: Uint8Array } | undefined => order.find(v => startsAt(b, v.value, i));
  let i = 0;
  while (i < b.length) {
    const hit = at(i);
    if (hit) {
      out.push(...hit.by);
      i += hit.value.length;
    } else out.push(b[i++] ?? 0);
  }
  return Uint8Array.from(out);
}
const anyIn = (b: Uint8Array, read: Read): boolean => read.some(r => indexOf(b, r.value, 0) >= 0);

/** Bytes as they may be logged: each value read written `[secret <name>]`. One way: for what a replay compares. */
export function redacted(b: Uint8Array, read: Read): Uint8Array {
  if (read.length === 0 || !anyIn(b, read)) return b;
  return replaced(
    b,
    read.map(r => ({ value: r.value, by: enc.encode(`[secret ${r.name}]`) })),
  );
}
/** Text as it may be logged (a URL, a header value). */
export const redactedText = (t: string, read: Read): string =>
  read.length === 0 ? t : new TextDecoder().decode(redacted(enc.encode(t), read));

/** Bytes to log that a replay must give back exactly: each value read held as a mark, an existing mark escaped. */
export function hold(b: Uint8Array, read: Read): Uint8Array {
  if (read.length === 0 || (!anyIn(b, read) && indexOf(b, MARK, 0) < 0)) return b;
  return replaced(b, [
    { value: MARK, by: Uint8Array.from([...MARK, 0x7e]) },
    ...read.map((r, i) => ({ value: r.value, by: enc.encode(`\u0000tape-secret:${i};`) })),
  ]);
}
/** What `hold` held, given back: the values as the run read them. Null when a mark names a secret it did not read. */
export function release(b: Uint8Array, read: Read): Uint8Array | null {
  if (indexOf(b, MARK, 0) < 0) return b;
  const out: number[] = [];
  let i = 0;
  for (let at = indexOf(b, MARK, 0); at >= 0; at = indexOf(b, MARK, i)) {
    out.push(...b.subarray(i, at));
    const after = at + MARK.length;
    if (b[after] === 0x7e) {
      out.push(...MARK);
      i = after + 1;
      continue;
    }
    const end = b.indexOf(0x3b, after);
    const n = end < 0 ? -1 : Number(new TextDecoder().decode(b.subarray(after, end)));
    const r = Number.isInteger(n) && n >= 0 ? read[n] : undefined;
    if (!r) return null;
    out.push(...r.value);
    i = end + 1;
  }
  out.push(...b.subarray(i));
  return Uint8Array.from(out);
}
