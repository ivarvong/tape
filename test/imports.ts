// A host function the module calls is one it imports. Which are imported is decided before any code is made
// (compiler/gen/module.ts importsOf: the indices of the functions after them depend on it), from what the program
// names, so a call it missed is a call of another function's index: a module WebAssembly refuses ("expected type
// f64, found call of type i32"), from a program the compiler accepted. Each program here has a Float only through
// parse_float or decode (as: Float), or calls std's wake as `retry.retry_later`; each must give a module that
// WebAssembly takes, and the Float ones answer through the host.
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
import { finish, messageOf, ok, same, std } from './harness.ts';

const enc = new TextEncoder(),
  dec = new TextDecoder();

/** The module of a program, or what refused it: the compiler, or WebAssembly. */
function moduleOf(text: string, name = 'imports.tape'): WebAssembly.Module | string {
  const b = compile([...std, { name, text }]);
  if (b.wasm === null) return b.errors.map(e => `${e.code} ${e.line} ${e.message}`).join('; ');
  try {
    return new WebAssembly.Module(b.wasm);
  } catch (e) {
    return messageOf(e);
  }
}
const importsOf = (m: WebAssembly.Module | string): string[] =>
  typeof m === 'string' ? [m] : WebAssembly.Module.imports(m).map(i => i.name);

const head = `fn handle(raw: View) -> Response {
  let Request(body) = request(raw) else -> empty(status: 400)
`;
const FLOATS: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
  [
    'parse_float, its Float in a hole',
    `${head}  match parse_float(body) {
    Some(value: x) -> buf() |> append(view: "\\(x)") |> respond(status: 200)
    None -> buf() |> append(view: "none") |> respond(status: 200)
  }
}
`,
    [
      ['2.50', '2.5'],
      ['x', 'none'],
    ],
  ],
  [
    'parse_float, its Float unused',
    `${head}  match parse_float(body) {
    Some(value: _) -> buf() |> append(view: "number") |> respond(status: 200)
    None -> buf() |> append(view: "none") |> respond(status: 200)
  }
}
`,
    [
      ['1e3', 'number'],
      ['1e400', 'none'],
    ],
  ],
  [
    'parse_float in a function handle calls',
    `${head}  match number(body) {
    True -> buf() |> append(view: "number") |> respond(status: 200)
    False -> buf() |> append(view: "none") |> respond(status: 200)
  }
}

fn number(text: View) -> Bool {
  match parse_float(text) {
    Some(value: _) -> True
    None -> False
  }
}
`,
    [
      ['-0.5', 'number'],
      ['0.5.', 'none'],
    ],
  ],
  [
    'decode of a Float, its Float in a hole',
    `${head}  match decode(json: body, as: Float) {
    Ok(value: x) -> buf() |> append(view: "\\(x)") |> respond(status: 200)
    Err -> buf() |> append(view: "none") |> respond(status: 200)
  }
}
`,
    [
      ['0.10', '0.1'],
      ['"a"', 'none'],
    ],
  ],
  [
    'write_json of a Float decoded',
    `${head}  match decode(json: body, as: Float) {
    Ok(value: x) -> buf() |> write_json(value: x) |> respond(status: 200)
    Err -> buf() |> append(view: "none") |> respond(status: 200)
  }
}
`,
    [['12.5e-1', '1.25']],
  ],
];
for (const [what, text, answers] of FLOATS) {
  const m = moduleOf(text);
  same(`${what}: WebAssembly takes the module, which imports float_text and float_of`, importsOf(m), [
    'float_text',
    'float_of',
  ]);
  if (typeof m === 'string') continue;
  const app = instantiate(m, { name: 'imports' });
  const got = answers.map(([sent]) => dec.decode(responseOf(app.handle(enc.encode(`POST /f\n${sent}`))).body));
  same(
    `${what}: answers`,
    got,
    answers.map(([, want]) => want),
  );
}

// examples/fulfillment.tape sets its timers with std/retry.tape's retry_later; written `retry.retry_later`, it is
// the same call, and the module imports wake all the same
const fulfillment = readFileSync(new URL('../examples/fulfillment.tape', import.meta.url), 'utf8');
const qualified = fulfillment.replace(' retry_later(', ' retry.retry_later(');
ok('fulfillment.tape calls retry_later once, unqualified', qualified !== fulfillment);
same(
  'fulfillment.tape with `retry.retry_later`: WebAssembly takes the module, with the imports of the one as written',
  importsOf(moduleOf(qualified, 'fulfillment.tape')),
  importsOf(moduleOf(fulfillment, 'fulfillment.tape')),
);
finish();
