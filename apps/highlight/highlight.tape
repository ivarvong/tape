// highlight.tape: Tape source in, HTML out. Every token is wrapped in a span whose class says what it is, and
// the text between and inside the spans is the source with & < > " escaped, so taking the tags away and
// unescaping gives back the input byte for byte. It reads the bytes one at a time, the way compiler/lex.ts
// reads characters, and decides the same token boundaries.
//
// Classes: c comment, s text literal (e an escape inside one, or the backslash that carries it on to the next
// line; h a hole, `\(…)`, whose expression inside is highlighted as code between two hd delimiters), n number,
// k reserved word, w a word with a meaning only where it stands, t a type or constructor name, i any other name,
// o operator or punctuation, q SQL (a migration's or an invariant's body, or a text literal that starts like a
// statement; inside it, sk an SQL keyword, sp a named placeholder and ss quoted SQL text), x what the compiler would refuse.

// Where the scan stands, for the one decision that needs history: is a `{` the start of SQL? `stack` holds one
// bit per open bracket (1 for `{`), newest lowest, and `depth` how many are open. `last` is 0 before the first
// token, 1 after a line break that counts, 2 after any other token. `mig` is how many tokens came after the last
// `migration` (capped), and `inv` how many came after an `invariant "name"` that began a line, on that line: 0
// right after the word itself, -1 when there is none. `held` is what `inv` was before the last line break that
// counted: a line that starts with `|>` takes that break back (lex.ts drops it), and the line goes on.
type Scan { Scan(stack: Int, depth: Int, last: Int, mig: Int, inv: Int, held: Int) }

// Where a literal or a block ends: Closed at the offset after its last byte, or Open at the end of what it
// could take, when its closing byte never came.
type End {
  Closed(at: Int)
  Open(at: Int)
}

fn handle(raw: View) -> Buf {
  scan(src: raw, at: 0, out: buf(), state: fresh())
}

fn fresh() -> Scan {
  Scan(stack: 0, depth: 0, last: 0, mig: 1000, inv: -1, held: -1)
}

fn scan(src: View, at: Int, out: Buf, state: Scan) -> Buf {
  match {
    at >= len(src) -> out
    else -> token(src, at, out, state, ch: src[at])
  }
}

fn token(src: View, at: Int, out: Buf, state: Scan, ch: Int) -> Buf {
  match {
    ch == 10 -> scan(src, at: at + 1, out: push(buf: out, byte: 10), state: newline(state))
    ch == 32 or ch == 9 or ch == 13 -> scan(src, at: at + 1, out: push(buf: out, byte: ch), state)
    ch == 47
      and byte_at(src, at: at + 1) == 47 -> scan(
      src,
      at: find(v: src, byte: 10, at),
      out: span(out, class: "c", src, from: at, to: find(v: src, byte: 10, at)),
      state
    )
    ch == 34 -> text(src, at, out, state, end: text_end(src, at: at + 1))
    ch >= 48 and ch <= 57 -> number(src, at, out, state, end: number_end(src, at))
    letter(b: ch)
      or (ch == 95 and word_byte(b: byte_at(src, at: at + 1))) -> word(
      src,
      at,
      out,
      state,
      end: word_end(src, at: at + 1)
    )
    ch == 123
      and opens_sql(state) -> block(src, at, out, state, end: sql_end(src, at: at + 1, depth: 1))
    else -> operator(src, at, out, state, size: op_size(src, at))
  }
}

// ---------- the scan's state ----------

// A token was emitted. kind: 0 any, 1 a text literal, 2 the word `migration`, 3 the name `invariant`.
fn pushed(state: Scan, kind: Int) -> Scan {
  let Scan(stack, depth, last, mig, inv, held) = state
  Scan(stack, depth, last: 2, mig: after_mig(mig, kind), inv: after_inv(inv, kind, last), held)
}

fn after_mig(mig: Int, kind: Int) -> Int {
  match {
    kind == 2 -> 0
    mig >= 1000 -> 1000
    else -> mig + 1
  }
}

fn after_inv(inv: Int, kind: Int, last: Int) -> Int {
  match {
    kind == 3 and last != 2 -> 0
    inv == 0 and kind == 1 -> 1
    inv == 0 -> -1
    inv >= 100 -> 100
    inv >= 1 -> inv + 1
    else -> -1
  }
}

// A line break is a token unless a ( or [ is open, the scan has no token yet, or the last token was one.
fn newline(state: Scan) -> Scan {
  let Scan(stack, depth, last, mig, inv, held) = state
  match {
    (depth == 0 or (stack & 1) == 1)
      and last == 2 -> Scan(stack, depth, last: 1, mig: after_mig(mig, kind: 0), inv: -1, held: inv)
    else -> state
  }
}

// The compiler's rule (lex.ts, opensSql): a `{` opens SQL when `migration` is among the last four tokens, or
// when an `invariant "name"` began this line at most nine tokens back.
fn opens_sql(state: Scan) -> Bool {
  state.mig <= 3 or (state.inv >= 1 and state.inv <= 8)
}

fn opened(state: Scan, brace: Int) -> Scan {
  let Scan(stack, depth, last, mig, inv, held) = state
  pushed(state: Scan(stack: (stack << 1) | brace, depth: depth + 1, last, mig, inv, held), kind: 0)
}

// A `|>` that starts a line carries on the line before it: the line break is taken back, so the tokens since it
// are one fewer (mig) and an `invariant "name"` before it still stands on this line (inv).
fn piped(state: Scan) -> Scan {
  let Scan(stack, depth, last, mig, inv, held) = state
  match {
    last == 1 -> Scan(stack, depth, last: 2, mig, inv: after_inv(inv: held, kind: 0, last: 2), held)
    else -> pushed(state, kind: 0)
  }
}

fn closed(state: Scan) -> Scan {
  let Scan(stack, depth, last, mig, inv, held) = state
  match {
    depth == 0 -> pushed(state, kind: 0)
    else -> pushed(state: Scan(stack: stack >> 1, depth: depth - 1, last, mig, inv, held), kind: 0)
  }
}

// ---------- words and numbers ----------

fn word(src: View, at: Int, out: Buf, state: Scan, end: Int) -> Buf {
  let w = slice(v: src, from: at, to: end)
  scan(
    src,
    at: end,
    out: span(out, class: word_class(w), src, from: at, to: end),
    state: pushed(state, kind: word_kind(w))
  )
}

fn word_kind(w: View) -> Int {
  match w {
    "migration" -> 2
    "invariant" -> 3
    _ -> 0
  }
}

fn word_class(w: View) -> View {
  match {
    reserved(w) -> "k"
    contextual(w) -> "w"
    w[0] >= 65 and w[0] <= 90 -> "t"
    else -> "i"
  }
}

fn reserved(w: View) -> Bool {
  match w {
    "fn" -> True
    "export" -> True
    "type" -> True
    "schema" -> True
    "migration" -> True
    "flag" -> True
    "match" -> True
    "with" -> True
    "let" -> True
    "do" -> True
    "if" -> True
    "else" -> True
    "and" -> True
    "or" -> True
    "not" -> True
    _ -> False
  }
}

fn contextual(w: View) -> Bool {
  match w {
    "interface" -> True
    "machine" -> True
    "invariant" -> True
    "where" -> True
    "contract" -> True
    "settled" -> True
    "private" -> True
    "final" -> True
    "read" -> True
    "write" -> True
    _ -> False
  }
}

// A number, as lex.ts reads one: digits, then a point and digits, then an exponent, then `f` for a Float
// (`1.5f`, `2f`, `1e-3f`), all one span. Digits alone are an Int, and digits with a point a Dec (`12.30`). An
// exponent without the f is refused, and so are a Dec with more than 18 digits after its point and a Float with
// more than 20 significant digits or beyond the largest Float. `end` is where the digits, point and exponent end.
fn number(src: View, at: Int, out: Buf, state: Scan, end: Int) -> Buf {
  match {
    byte_at(src, at: end) == 102
      and not word_byte(b: byte_at(src, at: end + 1)) -> scan(
      src,
      at: end + 1,
      out: span(out, class: float_class(src, at, f: end), src, from: at, to: end + 1),
      state: pushed(state, kind: 0)
    )
    refused(src, at, end) -> scan(
      src,
      at: end,
      out: span(out, class: "n x", src, from: at, to: end),
      state: pushed(state, kind: 0)
    )
    else -> scan(
      src,
      at: end,
      out: span(out, class: "n", src, from: at, to: end),
      state: pushed(state, kind: 0)
    )
  }
}

// an Int or a Dec lex.ts refuses: an exponent (it is only for a Float), or more than 18 digits after the point
fn refused(src: View, at: Int, end: Int) -> Bool {
  let point = digits_end(v: src, at)
  end > fraction_end(src, at: point) or end > point + 19
}

fn number_end(src: View, at: Int) -> Int {
  exponent_end(src, at: fraction_end(src, at: digits_end(v: src, at)))
}

// a point counts only with a digit after it (`1.x` is 1, then `.`)
fn fraction_end(src: View, at: Int) -> Int {
  match {
    byte_at(src, at) == 46 and is_digit(byte_at(src, at: at + 1)) -> digits_end(v: src, at: at + 1)
    else -> at
  }
}

// an e or E, a sign or none, and at least one digit (`1e` is 1, then the name e)
fn exponent_end(src: View, at: Int) -> Int {
  let b = byte_at(src, at)
  let from = at + 1 + sign_size(src, at: at + 1)
  match {
    (b == 101 or b == 69) and is_digit(byte_at(src, at: from)) -> digits_end(v: src, at: from)
    else -> at
  }
}

fn sign_size(src: View, at: Int) -> Int {
  match {
    byte_at(src, at) == 43 or byte_at(src, at) == 45 -> 1
    else -> 0
  }
}

// The Float from `at` to its f at `f`: "n", or "n x" when lex.ts refuses it. Its digits without the point run
// from the first that is not 0 (`first`) to the last that is not 0; there must be at most 20 of them. The
// first stands at 10 to the power `power`. Number() of it is finite below 10^308, and at 10^308 when its first
// 20 digits are at most 17976931348623158079: halfway between the largest Float and the next power of two,
// 1.7976931348623158079372…e308, rounds to infinity.
fn float_class(src: View, at: Int, f: Int) -> View {
  let point = digits_end(v: src, at)
  let mantissa = fraction_end(src, at: point)
  let first = nonzero_from(src, at, to: mantissa)
  let power = digit_count(src, at: first, to: mantissa) - 1 + exponent_of(
    src,
    at: mantissa,
    to: f
  ) - digit_count(
    src,
    at: point,
    to: mantissa
  )
  match {
    first == mantissa -> "n"
    digit_count(
      src,
      at: first,
      to: nonzero_before(src, at: mantissa, from: first) + 1
    ) > 20 -> "n x"
    power > 308 -> "n x"
    power == 308 and above_largest(src, at: first, to: mantissa, k: 0) -> "n x"
    else -> "n"
  }
}

// the first digit from `at` that is not 0 (a point is passed over), or `to`
fn nonzero_from(src: View, at: Int, to: Int) -> Int {
  match {
    at >= to -> to
    src[at] >= 49 and src[at] <= 57 -> at
    else -> nonzero_from(src, at: at + 1, to)
  }
}

// the last digit before `at` that is not 0, at or after `from` (which is one)
fn nonzero_before(src: View, at: Int, from: Int) -> Int {
  match {
    at - 1 <= from -> from
    src[at - 1] >= 49 and src[at - 1] <= 57 -> at - 1
    else -> nonzero_before(src, at: at - 1, from)
  }
}

// how many digits from `at` to `to` (a point is not one)
fn digit_count(src: View, at: Int, to: Int) -> Int {
  match {
    at >= to -> 0
    src[at] == 46 -> digit_count(src, at: at + 1, to)
    else -> 1 + digit_count(src, at: at + 1, to)
  }
}

// the exponent from `at` (an e or E) to `to`, 0 when there is none; its size is held at 100000, past any
// Float's either way
fn exponent_of(src: View, at: Int, to: Int) -> Int {
  match {
    at >= to -> 0
    src[at + 1] == 45 -> 0 - exponent_digits(src, at: at + 2, to, acc: 0)
    src[at + 1] == 43 -> exponent_digits(src, at: at + 2, to, acc: 0)
    else -> exponent_digits(src, at: at + 1, to, acc: 0)
  }
}

fn exponent_digits(src: View, at: Int, to: Int, acc: Int) -> Int {
  match {
    at >= to -> acc
    acc > 100000 -> 100000
    else -> exponent_digits(src, at: at + 1, to, acc: acc * 10 + src[at] - 48)
  }
}

// Are the digits from `at` (a point passed over; 0 past `to`), from the k-th on, above those of
// 17976931348623158079?
fn above_largest(src: View, at: Int, to: Int, k: Int) -> Bool {
  let largest = "17976931348623158079"
  match {
    k == 20 -> False
    at < to and src[at] == 46 -> above_largest(src, at: at + 1, to, k)
    at < to and src[at] > largest[k] -> True
    at < to and src[at] < largest[k] -> False
    at < to -> above_largest(src, at: at + 1, to, k: k + 1)
    else -> 48 > largest[k]
  }
}

fn letter(b: Int) -> Bool {
  (b >= 97 and b <= 122) or (b >= 65 and b <= 90)
}

fn word_byte(b: Int) -> Bool {
  letter(b) or (b >= 48 and b <= 57) or b == 95
}

fn word_end(src: View, at: Int) -> Int {
  match {
    at < len(src) and word_byte(b: src[at]) -> word_end(src, at: at + 1)
    else -> at
  }
}

// The byte at `at`, or -1 past the end.
fn byte_at(src: View, at: Int) -> Int {
  match {
    at < len(src) -> src[at]
    else -> -1
  }
}

// ---------- operators ----------

fn operator(src: View, at: Int, out: Buf, state: Scan, size: Int) -> Buf {
  let ch = src[at]
  match {
    size == 0 -> scan(
      src,
      at: utf8_end(src, at: at + 1),
      out: span(out, class: "x", src, from: at, to: utf8_end(src, at: at + 1)),
      state
    )
    ch == 40
      or ch == 91 -> scan(
      src,
      at: at + 1,
      out: span(out, class: "o", src, from: at, to: at + 1),
      state: opened(state, brace: 0)
    )
    ch == 123 -> scan(
      src,
      at: at + 1,
      out: span(out, class: "o", src, from: at, to: at + 1),
      state: opened(state, brace: 1)
    )
    size == 1
      and (ch == 41 or ch == 93 or ch == 125) -> scan(
      src,
      at: at + 1,
      out: span(out, class: "o", src, from: at, to: at + 1),
      state: closed(state)
    )
    size == 2
      and ch == 124
      and src[at + 1] == 62 -> scan(
      src,
      at: at + 2,
      out: span(out, class: "o", src, from: at, to: at + 2),
      state: piped(state)
    )
    else -> scan(
      src,
      at: at + size,
      out: span(out, class: "o", src, from: at, to: at + size),
      state: pushed(state, kind: 0)
    )
  }
}

// How long the operator at `at` is: 2, 1, or 0 when no operator starts there.
fn op_size(src: View, at: Int) -> Int {
  match {
    pair(src, at) -> 2
    single(b: src[at]) -> 1
    else -> 0
  }
}

fn pair(src: View, at: Int) -> Bool {
  match {
    at + 2 > len(src) -> False
    else -> two(p: slice(v: src, from: at, to: at + 2))
  }
}

fn two(p: View) -> Bool {
  match p {
    "->" -> True
    "|>" -> True
    "++" -> True
    "==" -> True
    "!=" -> True
    "<=" -> True
    ">=" -> True
    "<<" -> True
    ">>" -> True
    _ -> False
  }
}

fn single(b: Int) -> Bool {
  match b {
    40 -> True
    41 -> True
    123 -> True
    125 -> True
    91 -> True
    93 -> True
    44 -> True
    58 -> True
    46 -> True
    61 -> True
    60 -> True
    62 -> True
    43 -> True
    45 -> True
    42 -> True
    47 -> True
    37 -> True
    38 -> True
    124 -> True
    94 -> True
    95 -> True
    _ -> False
  }
}

// A refused byte takes the UTF-8 continuation bytes after it, so a span never splits a character.
fn utf8_end(src: View, at: Int) -> Int {
  match {
    at < len(src) and (src[at] & 192) == 128 -> utf8_end(src, at: at + 1)
    else -> at
  }
}

// ---------- text literals ----------

// From after the opening quote: Closed after the closing quote, or Open at the line break or the end. A backslash
// at the end of a line carries the text on to the next one; a hole is skipped to its end (or to where it broke).
fn text_end(src: View, at: Int) -> End {
  match {
    at >= len(src) or src[at] == 10 -> Open(at)
    src[at] == 34 -> Closed(at: at + 1)
    src[at] == 92
      and byte_at(src, at: at + 1) == 40 -> text_end(
      src,
      at: past(end: hole_end(src, at: at + 2, depth: 1))
    )
    src[at] == 92 and at + 1 < len(src) -> text_end(src, at: at + 2)
    else -> text_end(src, at: at + 1)
  }
}

fn past(end: End) -> Int {
  match end {
    Closed(at) -> at
    Open(at) -> at
  }
}

// A hole, from after its `\(` (lex.ts, hole): Closed after the `)` that balances it, or Open at the line break, the
// double quote or the end that broke it (the compiler refuses that: L05).
fn hole_end(src: View, at: Int, depth: Int) -> End {
  match {
    at >= len(src) or src[at] == 10 or src[at] == 34 -> Open(at)
    src[at] == 41 and depth == 1 -> Closed(at: at + 1)
    src[at] == 41 -> hole_end(src, at: at + 1, depth: depth - 1)
    src[at] == 40 -> hole_end(src, at: at + 1, depth: depth + 1)
    else -> hole_end(src, at: at + 1, depth)
  }
}

// Does the literal from `at` to `to` have a hole? Then lex.ts makes it a text with holes, not a text, and a `{`
// after `invariant "name\(x)"` does not open SQL.
fn holed(src: View, at: Int, to: Int) -> Bool {
  match {
    at + 1 >= to -> False
    src[at] == 92 and src[at + 1] == 40 -> True
    src[at] == 92 -> holed(src, at: at + 2, to)
    else -> holed(src, at: at + 1, to)
  }
}

fn literal_kind(src: View, at: Int, to: Int) -> Int {
  match {
    holed(src, at, to) -> 0
    else -> 1
  }
}

fn text(src: View, at: Int, out: Buf, state: Scan, end: End) -> Buf {
  let sql = statement(src, at: at + 1)
  match end {
    Closed(at: to) -> scan(
      src,
      at: to,
      out: append(
        buf: body(
          src,
          at: at + 1,
          to: to - 1,
          out: append(buf: open_text(out, sql, bad: False), view: "&quot;"),
          sql
        ),
        view: "&quot;</span>"
      ),
      state: pushed(state, kind: literal_kind(src, at: at + 1, to))
    )
    Open(at: to) -> scan(
      src,
      at: to,
      out: append(
        buf: body(
          src,
          at: at + 1,
          to,
          out: append(buf: open_text(out, sql, bad: True), view: "&quot;"),
          sql
        ),
        view: "</span>"
      ),
      state: pushed(state, kind: literal_kind(src, at: at + 1, to))
    )
  }
}

fn open_text(out: Buf, sql: Bool, bad: Bool) -> Buf {
  match {
    sql and bad -> append(buf: out, view: "<span class=\"s q x\">")
    sql -> append(buf: out, view: "<span class=\"s q\">")
    bad -> append(buf: out, view: "<span class=\"s x\">")
    else -> append(buf: out, view: "<span class=\"s\">")
  }
}

// Does the text at `at` start like an SQL statement?
fn statement(src: View, at: Int) -> Bool {
  has(v: src, at, word: "SELECT ")
    or has(v: src, at, word: "INSERT ")
    or has(v: src, at, word: "UPDATE ")
    or has(v: src, at, word: "DELETE ")
    or has(v: src, at, word: "WITH ")
    or has(v: src, at, word: "CREATE ")
    or has(v: src, at, word: "ALTER ")
    or has(v: src, at, word: "DROP ")
    or has(v: src, at, word: "REPLACE ")
    or has(v: src, at, word: "PRAGMA ")
}

// The inside of a text literal, from `at` to `to`: escapes as spans, SQL keywords too when it is a statement, and
// each hole's expression as code.
fn body(src: View, at: Int, to: Int, out: Buf, sql: Bool) -> Buf {
  match {
    at >= to -> out
    src[at] == 92
      and at + 1 < to
      and src[at + 1] == 40 -> body(
      src,
      at: past(end: hole_end(src, at: at + 2, depth: 1)),
      to,
      out: hole(src, at, out, end: hole_end(src, at: at + 2, depth: 1)),
      sql
    )
    src[at] == 92
      and at + 1 < to
      and src[at + 1] == 10 -> body(
      src,
      at: at + 1,
      to,
      out: span(out, class: "e", src, from: at, to: at + 1),
      sql
    )
    src[at] == 92
      and at + 1 < to
      and escape(b: src[at + 1]) -> body(
      src,
      at: at + 2,
      to,
      out: span(out, class: "e", src, from: at, to: at + 2),
      sql
    )
    src[at] == 92
      and at + 1 < to
      and src[at + 1] < 128 -> body(
      src,
      at: at + 2,
      to,
      out: span(out, class: "e x", src, from: at, to: at + 2),
      sql
    )
    src[at] == 92 -> body(
      src,
      at: at + 1,
      to,
      out: span(out, class: "e x", src, from: at, to: at + 1),
      sql
    )
    sql
      and placeholder_at(src, at, to) -> body(
      src,
      at: word_end(src: slice(v: src, from: 0, to), at: at + 1),
      to,
      out: span(
        out,
        class: "sp",
        src,
        from: at,
        to: word_end(src: slice(v: src, from: 0, to), at: at + 1)
      ),
      sql
    )
    sql
      and keyword_at(src, at, to) -> body(
      src,
      at: upper_end(src, at, to),
      to,
      out: span(out, class: "sk", src, from: at, to: upper_end(src, at, to)),
      sql
    )
    else -> body(src, at: at + 1, to, out: escaped(out, b: src[at]), sql)
  }
}

// A hole: its delimiters, and between them its expression, scanned as a program of its own (lex.ts lexes the
// inside of a hole on its own too).
fn hole(src: View, at: Int, out: Buf, end: End) -> Buf {
  match end {
    Closed(at: to) -> append(
      buf: span(
        out: scan(
          src: slice(v: src, from: at + 2, to: to - 1),
          at: 0,
          out: append(buf: out, view: "<span class=\"h\">")
            |> span(class: "hd", src, from: at, to: at + 2),
          state: fresh()
        ),
        class: "hd",
        src,
        from: to - 1,
        to
      ),
      view: "</span>"
    )
    Open(at: to) -> append(
      buf: scan(
        src: slice(v: src, from: at + 2, to),
        at: 0,
        out: append(buf: out, view: "<span class=\"h x\">")
          |> span(class: "hd", src, from: at, to: at + 2),
        state: fresh()
      ),
      view: "</span>"
    )
  }
}

fn escape(b: Int) -> Bool {
  match b {
    34 -> True
    92 -> True
    47 -> True
    110 -> True
    114 -> True
    116 -> True
    98 -> True
    102 -> True
    _ -> False
  }
}

// ---------- SQL ----------

// From after the `{`, as lex.ts reads it: quoted SQL text is skipped, braces nest, and the block is Closed after
// its matching `}`, or Open at the end of the source.
fn sql_end(src: View, at: Int, depth: Int) -> End {
  match {
    at >= len(src) -> Open(at: len(src))
    src[at] == 39
      or src[at] == 34 -> sql_end(src, at: find(v: src, byte: src[at], at: at + 1) + 1, depth)
    src[at] == 123 -> sql_end(src, at: at + 1, depth: depth + 1)
    src[at] == 125 and depth == 1 -> Closed(at: at + 1)
    src[at] == 125 -> sql_end(src, at: at + 1, depth: depth - 1)
    else -> sql_end(src, at: at + 1, depth)
  }
}

fn block(src: View, at: Int, out: Buf, state: Scan, end: End) -> Buf {
  match end {
    Closed(at: to) -> scan(
      src,
      at: to,
      out: append(
        buf: sql(src, at, to, out: append(buf: out, view: "<span class=\"q\">")),
        view: "</span>"
      ),
      state: pushed(state, kind: 0)
    )
    Open(at: to) -> scan(
      src,
      at: to,
      out: append(
        buf: sql(src, at, to, out: append(buf: out, view: "<span class=\"q x\">")),
        view: "</span>"
      ),
      state: pushed(state, kind: 0)
    )
  }
}

fn sql(src: View, at: Int, to: Int, out: Buf) -> Buf {
  match {
    at >= to -> out
    src[at] == 39 -> sql(
      src,
      at: quoted_end(src, at: at + 1, to),
      to,
      out: span(out, class: "ss", src, from: at, to: quoted_end(src, at: at + 1, to))
    )
    placeholder_at(src, at, to) -> sql(
      src,
      at: word_end(src: slice(v: src, from: 0, to), at: at + 1),
      to,
      out: span(
        out,
        class: "sp",
        src,
        from: at,
        to: word_end(src: slice(v: src, from: 0, to), at: at + 1)
      )
    )
    keyword_at(src, at, to) -> sql(
      src,
      at: upper_end(src, at, to),
      to,
      out: span(out, class: "sk", src, from: at, to: upper_end(src, at, to))
    )
    else -> sql(src, at: at + 1, to, out: escaped(out, b: src[at]))
  }
}

// After the closing ' of quoted SQL text, or `to` when it does not close.
fn quoted_end(src: View, at: Int, to: Int) -> Int {
  match {
    at >= to -> to
    src[at] == 39 -> at + 1
    else -> quoted_end(src, at: at + 1, to)
  }
}

// A named placeholder, `:name`: the value a query takes by that name (LANGUAGE.md 0.1). A colon that follows a word
// or another colon is not one.
fn placeholder_at(src: View, at: Int, to: Int) -> Bool {
  src[at] == 58
    and at + 1 < to
    and (letter(b: src[at + 1]) or src[at + 1] == 95)
    and (at == 0 or (not word_byte(b: src[at - 1]) and src[at - 1] != 58))
}

// An SQL keyword, as far as colour goes: two or more capitals (or _) standing alone.
fn keyword_at(src: View, at: Int, to: Int) -> Bool {
  upper(b: src[at])
    and (at == 0 or not word_byte(b: src[at - 1]))
    and upper_end(src, at, to) >= at + 2
    and (upper_end(src, at, to) >= to or not word_byte(b: src[upper_end(src, at, to)]))
}

fn upper(b: Int) -> Bool {
  (b >= 65 and b <= 90) or b == 95
}

fn upper_end(src: View, at: Int, to: Int) -> Int {
  match {
    at < to and upper(b: src[at]) -> upper_end(src, at: at + 1, to)
    else -> at
  }
}

// ---------- HTML ----------

fn span(out: Buf, class: View, src: View, from: Int, to: Int) -> Buf {
  let opened = append(
    buf: append(buf: append(buf: out, view: "<span class=\""), view: class),
    view: "\">"
  )
  append(buf: copy(out: opened, src, at: from, to), view: "</span>")
}

fn copy(out: Buf, src: View, at: Int, to: Int) -> Buf {
  match {
    at >= to -> out
    else -> copy(out: escaped(out, b: src[at]), src, at: at + 1, to)
  }
}

fn escaped(out: Buf, b: Int) -> Buf {
  match b {
    38 -> append(buf: out, view: "&amp;")
    60 -> append(buf: out, view: "&lt;")
    62 -> append(buf: out, view: "&gt;")
    34 -> append(buf: out, view: "&quot;")
    _ -> push(buf: out, byte: b)
  }
}
