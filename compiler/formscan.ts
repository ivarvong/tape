// compiler/formscan.ts: the scan behind std `form_field`. Finding one field used to walk the form again from the
// start, one recursive entry per pair and per name byte (`form_from`, `form_named`, and `find` for `&` and `=`),
// so reading every field of an n-field form took O(n²) steps and n = 4096 passed the 50,000,000-step budget.
// A built-in costs no steps however long it runs (LANGUAGE.md §10), the same way `scan_plain` reads a JSON
// string. This is that built-in: one forward pass over the bytes, included in a module only when `form_raw` is
// reached (compiler/gen/float.ts names it through the math-library hook). It returns the raw value, still `+`
// and %XX; `form_decoded` decodes that value alone.
//
// The split is on the raw bytes `&` (38) and `=` (61), before any decoding, and the first match wins. The name
// compare is `form_named`'s match, which does not fall through: a `+` (43) that is not a space fails the name,
// and a well-formed %XX whose byte is not the name's fails it too. An incomplete or non-hex `%` is the literal
// byte 37. Both hex digits are read only when both lie inside the name (tape `and` does not read past it).
import { name, section, uleb, vec } from './common.ts';
import {
  I32,
  add,
  and,
  assembleBody,
  eq,
  eqz,
  geU,
  i,
  leU,
  loadB,
  ltU,
  ne,
  or,
  select,
  shl,
  sub,
} from './math/wasm.ts';
import type { Def, E, Linker } from './math/wasm.ts';

const AMP = 38,
  EQ = 61,
  PLUS = 43,
  PCT = 37,
  SPACE = 32;

const between = (b: E, lo: number, hi: number): E => and(geU(b, i(lo)), leU(b, i(hi)));
/** `is_hex` (std/json.tape): a digit, or a–f, or A–F. */
const isHexByte = (b: E): E => or(between(b, 48, 57), or(between(b, 97, 102), between(b, 65, 70)));
/** `hex` (std/json.tape), for a byte `is_hex` has already accepted. */
const hexVal = (b: E): E => select(leU(b, i(57)), sub(b, i(48)), select(geU(b, i(97)), sub(b, i(87)), sub(b, i(55))));

/**
 * (bodyPtr, bodyLen, namePtr, nameLen) -> (found, valPtr, valLen). `found` is 1 when some field's name decodes
 * to `name`, and the value is then the raw bytes body[valPtr, valPtr + valLen) in the caller's memory (empty
 * when the pair has no `=`). `found` is 0 otherwise; the pointer and length are then 0.
 */
export const FORM_SCAN: Def = {
  params: [I32, I32, I32, I32],
  results: [I32, I32, I32],
  body(b) {
    const bodyPtr = b.p(0);
    const bodyLen = b.p(1);
    const namePtr = b.p(2);
    const nameLen = b.p(3);
    const at = b.let(i(0));
    const end = b.let(i(0));
    const eqAt = b.let(i(0));
    const ni = b.let(i(0));
    const nn = b.let(i(0));
    const equal = b.let(i(0));
    const byte = b.let(i(0));
    const h1 = b.let(i(0));
    const h2 = b.let(i(0));
    const found = b.let(i(0));
    const valPtr = b.let(i(0));
    const valLen = b.let(i(0));
    // The first `stop` at or after `from`, and before `limit`; `limit` itself when there is none. Never loads
    // at or past `limit`.
    const scanTo = (from: E, limit: E, stop: number, into: typeof at): void => {
      b.set(into, from);
      b.block('hit', () => {
        b.loop('step', () => {
          b.brIf('hit', geU(into, limit));
          b.brIf('hit', eq(loadB(add(bodyPtr, into)), i(stop)));
          b.set(into, add(into, i(1)));
          b.br('step');
        });
      });
    };
    const failName = (): void => {
      b.set(equal, i(0));
      b.br('cmpDone');
    };
    const advance = (skip: number): void => {
      b.set(ni, add(ni, i(skip)));
      b.set(nn, add(nn, i(1)));
      b.br('cmp');
    };
    b.block('done', () => {
      b.loop('pairs', () => {
        scanTo(at, bodyLen, AMP, end);
        scanTo(at, end, EQ, eqAt);
        b.set(equal, i(0));
        b.set(ni, at);
        b.set(nn, i(0));
        b.block('cmpDone', () => {
          b.loop('cmp', () => {
            b.if(geU(ni, eqAt), () => {
              b.set(equal, eq(nn, nameLen));
              b.br('cmpDone');
            });
            b.if(geU(nn, nameLen), () => {
              failName();
            });
            b.set(byte, loadB(add(bodyPtr, ni)));
            b.if(eq(byte, i(PLUS)), () => {
              b.if(ne(loadB(add(namePtr, nn)), i(SPACE)), () => {
                failName();
              });
              advance(1);
            });
            b.if(eq(byte, i(PCT)), () => {
              // Leave the block, and compare `%` as a literal byte, when the escape is not two hex digits
              // inside the name. A well-formed escape that is not this name byte fails the whole name.
              b.block('pct', () => {
                b.brIf('pct', geU(add(ni, i(2)), eqAt));
                b.set(h1, loadB(add(bodyPtr, add(ni, i(1)))));
                b.set(h2, loadB(add(bodyPtr, add(ni, i(2)))));
                b.brIf('pct', eqz(isHexByte(h1)));
                b.brIf('pct', eqz(isHexByte(h2)));
                b.if(ne(loadB(add(namePtr, nn)), or(shl(hexVal(h1), i(4)), hexVal(h2))), () => {
                  failName();
                });
                advance(3);
              });
            });
            b.if(ne(loadB(add(namePtr, nn)), byte), () => {
              failName();
            });
            advance(1);
          });
        });
        b.if(equal, () => {
          b.set(found, i(1));
          b.if(
            ltU(eqAt, end),
            () => {
              b.set(valPtr, add(bodyPtr, add(eqAt, i(1))));
              b.set(valLen, sub(end, add(eqAt, i(1))));
            },
            () => {
              b.set(valPtr, add(bodyPtr, end));
              b.set(valLen, i(0));
            },
          );
          b.br('done');
        });
        b.brIf('done', geU(end, bodyLen));
        b.set(at, add(end, i(1)));
        b.br('pairs');
      });
    });
    b.ret(found, valPtr, valLen);
  },
};

const unused: Linker = {
  index: () => {
    throw new Error('form_scan calls nothing');
  },
  data: () => {
    throw new Error('form_scan has no data');
  },
  scratch: () => {
    throw new Error('form_scan has no scratch');
  },
};

/**
 * `FORM_SCAN` as a module of its own, memory and `scan` exported, so the reference interpreter runs the same
 * function the compiler emits. The memory grows (1 page, up to 1024) to hold the body and the name.
 */
export function formScanModule(): Uint8Array<ArrayBuffer> {
  const body = assembleBody(FORM_SCAN, unused);
  const fnType = [0x60, ...vec(FORM_SCAN.params.map(t => [t])), ...vec(FORM_SCAN.results.map(t => [t]))];
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, vec([fnType])),
    ...section(3, vec([uleb(0)])),
    ...section(5, vec([[1, ...uleb(1), ...uleb(1024)]])),
    ...section(
      7,
      vec([
        [...name('memory'), 0x02, 0],
        [...name('scan'), 0x00, 0],
      ]),
    ),
    ...section(10, vec([[...uleb(body.length), ...body]])),
  ]);
}
