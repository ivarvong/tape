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
