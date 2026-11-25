// Ports code written before `once:` keys were text or records (C64) to the current language, mechanically, so a
// historical fixture is judged by the other rules rather than stopping at C64: every `once: <expr>` (an Int, then)
// becomes `once: OnceKey(n: <expr>)`, and the record is declared. Nothing else changes, so a key that was made of
// what the message carries (the ledger's amount) is still made of it, and C65 judges it.
export function portKeys(text: string): string {
  if (!/\bonce: /.test(text) || /^type OnceKey\b/m.test(text)) return text;
  let out = '', i = 0, n = 0;
  for (let at; (at = text.indexOf('once: ', i)) >= 0;) {
    // a call's argument, not a field of a record type or a parameter (`once: View`, `once: Int`)
    // (calls write it after `within:`; a record field or a function parameter named once is left alone)
    if (!/within: [\w.]+(?:\([^()]*\))?, $/.test(text.slice(Math.max(0, at - 80), at))) { out += text.slice(i, at + 6); i = at + 6; continue; }
    let j = at + 6, depth = 0;
    for (; j < text.length; j++) { const c = text[j]; if (c === '(') depth++; else if (c === ')') { if (!depth) break; depth--; } else if ((c === ',' || c === '\n') && !depth) break; }
    out += text.slice(i, at) + `once: OnceKey(n: ${text.slice(at + 6, j).trim()})`; i = j; n++;
  }
  out += text.slice(i);
  return n ? `${out.replace(/\n?$/, '\n')}// added by experiments/lang/port-keys.ts: keys were Ints before C64\ntype OnceKey { OnceKey(n: Int) }\n` : text;
}

// `machine t.c { "a" -> "b" … }` of then names its type now (issue 12): `machine t.c: TCState { A -> B … }`, each
// move on the line it was on, and the type is declared at the end, its constructors the states in the order first
// named, so each is stored as the text it was ('a', 'b'). A machine whose states are not lower-case words is left as
// it was (the parser refuses it, P01).
const pascal = (s: string): string => s.replaceAll(/(?:^|_)([a-z])/g, (_m, c: string) => c.toUpperCase());
export function portMachines(text: string): string {
  const MACHINE = /^machine ([a-z_]+)\.([a-z_]+) \{\n((?:[ \t]*"[a-z_]+" -> "[a-z_]+"[ \t]*\n)*)\}/gm;
  // a name of the program's own that a state's constructor now takes (`type Pending { Pending(…) }`) is renamed
  // `PendingRow` everywhere outside text, where no state was named
  const states = new Set([...text.matchAll(MACHINE)].flatMap(m => [...(m[3] ?? '').matchAll(/"([a-z_]+)"/g)].map(s => pascal(s[1] ?? ''))));
  const TOKEN = /("(?:[^"\\]|\\.)*")|\b([A-Z]\w*)\b/g;
  const clash = new Set([...text.matchAll(TOKEN)].flatMap(m => (m[2] && states.has(m[2]) ? [m[2]] : [])));
  const renamed =
    clash.size === 0
      ? text
      : text.replaceAll(TOKEN, (m, _s: string | undefined, id: string | undefined) =>
          id !== undefined && clash.has(id) ? `${id}Row` : m,
        );
  const types: string[] = [];
  const out = renamed.replace(MACHINE, (_m, table: string, column: string, body: string) => {
    const name = `${pascal(table)}${pascal(column)}`;
    const named: string[] = [];
    const moves = body.replaceAll(/"([a-z_]+)" -> "([a-z_]+)"/g, (_x, a: string, b: string) => {
      for (const s of [a, b]) if (!named.includes(s)) named.push(s);
      return `${pascal(a)} -> ${pascal(b)}`;
    });
    if (named.length > 0 && !types.some(t => t.startsWith(`type ${name} `)))
      types.push(`type ${name} { ${named.map(pascal).join(' ')} }`);
    return `machine ${table}.${column}: ${name} {\n${moves}}`;
  });
  return types.length === 0
    ? out
    : `${out.replace(/\n?$/, '\n')}// added by experiments/lang/port-keys.ts: a machine's states were text before issue 12\n${types.join('\n')}\n`;
}
// the pattern json(T(…)) of then is decode now (the compiler refuses the pattern: C35), line for line
export const portJson = (text: string): string => {
  const types = ['NewTodo', 'Changes'];
  return !/^    json\(/m.test(text)
    ? text
    : text
        .replace(/^  match body \{$/gm, () => `  match decode(json: body, as: ${types.shift()}) {`)
        .replace(/^    json\((.*)\) -> /gm, '    Ok(value: $1) -> ');
};
// `with { P <- e … -> result else -> fallback }` of then is `let P = e else -> fallback` per step now (the compiler
// refuses `with`: C35), each step on the line it was on
export const portWith = (text: string): string =>
  text.replace(
    /^  with \{\n((?:    .* <- .*\n)+)    -> (.*)\n    else -> (.*)\n  \}$/gm,
    (_m, steps: string, result: string, fallback: string) =>
      [
        '  // (was: with {)',
        ...steps
          .trimEnd()
          .split('\n')
          .map(step =>
            step.replace(
              /^    (.*?) <- (.*)$/,
              (_all, pattern: string, value: string) => `  let ${pattern} = ${value} else -> ${fallback}`,
            ),
          ),
        `  ${result}`,
        '',
        '',
      ].join('\n'),
  );

// A call names its callee's error type now, and an exported method's is a type of the program's own (issue #17,
// C98): every `reply: R` of a call gains `error: Refusal` on its line, `CallError` is `CallError[Refusal]`, a bound
// `Rejected(reason)` binds the text of `Refused(reason)`, an exported method's `Result[R, View]` (not woken's) is
// `Result[R, Refusal]` with each `Err(error: "…")` a `Refused(reason: "…")`, and the type is declared at the end, so
// no line moves.
export function portErrors(text: string): string {
  // a capability's method (an interface) refuses with text still: CallError[View], and nothing else changes
  if (!/reply: (?!Result\b)[A-Z]\w*[,)]/.test(text)) return text.replaceAll(/\bCallError\b(?!\[)/g, 'CallError[View]');
  let out = text
    .replaceAll(/(reply: [A-Z]\w*)(,|\))/g, '$1, error: Refusal$2')
    .replaceAll(/\bCallError\b(?!\[)/g, 'CallError[Refusal]')
    .replaceAll('Rejected(reason)', 'Rejected(reason: Refused(reason))');
  if (/export fn (?!woken\b)\w+\([^)]*\) -> Result\[\w+, View\]/.test(out))
    out = out
      .replaceAll(/(fn (?!woken\b)\w+\([^)]*\) -> Result\[\w+, )View\]/g, '$1Refusal]')
      .replaceAll(/Err\(error: ("(?:[^"\\]|\\.)*")\)/g, 'Err(error: Refused(reason: $1))');
  return out === text
    ? text
    : `${out.replace(/\n?$/, '\n')}// added by experiments/lang/port-keys.ts: a call's error was text before issue 17\ntype Refusal { Refused(reason: View) }\n`;
}
