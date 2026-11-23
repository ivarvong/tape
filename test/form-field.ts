// std form_field: reading the fields of a form costs no memory for the keys it passes. Each lookup decoded every
// key it skipped into new memory that lived until the request ended, so a handler that read each of n fields
// allocated O(n^2) bytes, and an 11 KB form (1,536 fields) ran out of the request's 64 MB. A form is now compared
// with the name in place, decoding as it goes; only the value found is decoded into memory. The answers are
// checked against URLSearchParams (the WHATWG form decoding a browser and Node do), not against std.
import '../node25.ts';
import { instantiate } from '../host.ts';
import { built, finish, moduleOf, same } from './harness.ts';

const PROGRAM = {
  name: 'form.tape',
  text: `fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(path: "/n/" ++ decimal(n)) -> read_all(n)
    Request(path: "/get", query: Some(value: q), body) -> shown(o: form_field(body: q, name: body))
    _ -> respond(status: 404)
  }
}

fn read_all(n: Int) -> Buf {
  let q = freeze(buf: form(out: buf(), i: 0, n))
  respond(status: 200) |> write_int(value: total(q, i: 0, n, acc: 0))
}

fn form(out: Buf, i: Int, n: Int) -> Buf {
  match {
    i >= n -> out
    i == 0 -> form(out: out |> append(view: "f0=1"), i: 1, n)
    else -> form(out: out |> append(view: "&f") |> write_int(value: i) |> append(view: "=1"), i: i + 1, n)
  }
}

fn total(q: View, i: Int, n: Int, acc: Int) -> Int {
  match {
    i >= n -> acc
    else -> total(q, i: i + 1, n, acc: acc + found(o: form_field(body: q, name: "f\\(i)")))
  }
}

fn found(o: Option[View]) -> Int {
  match o {
    Some(value) -> 1
    None -> 0
  }
}

fn shown(o: Option[View]) -> Buf {
  match o {
    Some(value) -> respond(status: 200) |> append(view: "[\\(value)]")
    None -> respond(status: 200) |> append(view: "none")
  }
}
`,
};
const app = instantiate(moduleOf(built([PROGRAM])));
const enc = new TextEncoder(),
  dec = new TextDecoder();
const ask = (request: string): { body: string; bytes: number } => {
  try {
    const out = dec.decode(app.handle(enc.encode(request)));
    return { body: out.slice(out.indexOf('\n') + 1), bytes: app.bytesUsed };
  } catch (e) {
    return { body: e instanceof Error ? e.message : String(e), bytes: Infinity };
  }
};

// ---- memory: n lookups of n fields
const at = (n: number) => ask(`GET /n/${n}`);
const [small, large] = [at(256), at(1024)];
same('every field of a 256-field form is found', small.body, '256');
same('…and of a 1,024-field form', large.body, '1024');
same(
  'a form 4 times longer, read 4 times as often, takes at most about 4 times the memory (it took 16)',
  large.bytes < 5 * small.bytes,
  true,
);
same('the 1,536-field form (11 KB) that ran out of memory answers', at(1536).body, '1536');

// ---- the answers, against URLSearchParams
const forms: readonly (readonly [string, string])[] = [
  ['qty=2&buyer=ada+l%C3%B6', 'buyer'],
  ['qty=2', 'buyer'],
  ['done', 'done'],
  ['done=', 'done'],
  ['x=1&done&y', 'done'],
  ['a=1&a=2', 'a'],
  ['a+b=1', 'a b'],
  ['a%20b=1', 'a b'],
  ['a%2=1&a%=2', 'a%'],
  ['%61=1', 'a'],
  ['ab=1', 'a'],
  ['a=1', 'ab'],
  ['=1&x=2', ''],
  ['k=%zz', 'k'],
  ['%C3%B6=yes', 'ö'],
  ['', 'a'],
];
for (const [form, name] of forms) {
  const want = new URLSearchParams(form).get(name);
  same(
    `form_field(${JSON.stringify(form)}, ${JSON.stringify(name)})`,
    ask(`GET /get?${form}\n${name}`).body,
    want === null ? 'none' : `[${want}]`,
  );
}

finish();
