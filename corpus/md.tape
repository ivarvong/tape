// md.tape: Markdown to HTML (a CommonMark subset). POST /render with Markdown as the body answers text/html.
// Two passes, as CommonMark describes: lines -> a typed block tree (paragraph text is parsed to inlines when the
// paragraph closes), then the tree -> HTML. Raw HTML is never passed through: every byte of text is escaped, and
// a link's URL is percent-encoded into [A-Za-z0-9;/?:@&=+$,-_.!~*'()#%] (with & as &amp;), so no input can open a
// tag or leave an attribute; javascript:, vbscript:, file: and data: (bar data:image/png|gif|jpeg|webp) URLs
// become href="". Text is never copied when a slice of the input will do.

type Inline {
  Str(text: View)
  Soft
  Hard
  CodeSpan(text: View)
  Emph(inlines: List[Inline])
  Strong(inlines: List[Inline])
  Link(dest: View, title: Option[View], inlines: List[Inline])
  Image(dest: View, title: Option[View], inlines: List[Inline])
}

type ListKind {
  Bullet(mark: Int)
  Ordered(start: Int, delim: Int)
}

type Block {
  Para(inlines: List[Inline])
  Heading(level: Int, inlines: List[Inline])
  CodeBlock(info: View, text: View)
  Rule
  Quote(blocks: List[Block])
  Items(kind: ListKind, tight: Bool, entries: List[Entry])
}

type Entry {
  Entry(blocks: List[Block])
}

// what a non-blank line starts
type Start {
  Atx(level: Int, text: View)
  Fence(mark: Int, n: Int, indent: Int, info: View)
  Hr
  QuoteLine(rest: View)
  Marker(kind: ListKind, width: Int, rest: View)
  Indented
  Plain
}

type Line {
  Empty
  Content(start: Start)
}

type Parsed {
  Parsed(blocks: List[Block], gap: Bool)
}

type Took {
  Took(block: Block, rest: List[View])
}

type Taken {
  Taken(lines: List[View], rest: List[View])
}

// a piece of an inline sequence being parsed: a finished node, or a run of * or _ that may still open or close
type Piece {
  Done(node: Inline)
  Run(delim: Delim)
}

type Delim {
  Delim(at: Int, n: Int, orig: Int, mark: Int, open: Bool, close: Bool)
}

type Stack {
  Stack(pieces: List[Piece], stars: Int, unders: Int)
}

type Tick {
  Tick(at: Int, n: Int)
}

type Bracket {
  Opens(at: Int)
  Closes(at: Int)
}

type Pair {
  Pair(open: Int, close: Int)
}

type Index {
  Index(pairs: List[Pair], runs: List[Tick])
}

type Found {
  Found(above: List[Piece], opener: Delim, below: List[Piece])
  Missing
}

type Tail {
  Tail(dest: View, title: Option[View], end: Int)
}

fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/render", body) -> respond_as(status: 200, content: Html)
      |> write_doc(text: body)
    _ -> respond(status: 404) |> append(view: "POST /render with Markdown as the body\n")
  }
}

fn write_doc(out: Buf, text: View) -> Buf {
  write_blocks(out, blocks: parse(lines: lines_of(text), depth: 0).blocks)
}

// ---------------------------------------------------------------- lines and bytes

fn lines_of(text: View) -> List[View] {
  reverse(list: split_lines(text, at: 0, acc: Nil))
}

fn split_lines(text: View, at: Int, acc: List[View]) -> List[View] {
  match {
    at >= len(text) -> acc
    else -> {
      let end = find(v: text, byte: 10, at)
      split_lines(
        text,
        at: end + 1,
        acc: Cons(head: chomp(slice(v: text, from: at, to: end)), tail: acc)
      )
    }
  }
}

fn chomp(line: View) -> View {
  match {
    len(line) > 0 and line[len(line) - 1] == 13 -> slice(v: line, from: 0, to: len(line) - 1)
    else -> line
  }
}

fn is_ws(b: Int) -> Bool {
  b == 32 or b == 9 or b == 10 or b == 13 or b == 12 or b == 11
}

fn is_punct(b: Int) -> Bool {
  b >= 33 and b <= 47 or b >= 58 and b <= 64 or b >= 91 and b <= 96 or b >= 123 and b <= 126
}

// the first position at or after `at` that is not a space or a tab
fn skip_ws(v: View, at: Int) -> Int {
  match {
    at < len(v) and (v[at] == 32 or v[at] == 9) -> skip_ws(v, at: at + 1)
    else -> at
  }
}

// the column the leading spaces and tabs reach (a tab goes to the next multiple of 4)
fn cols(v: View, at: Int, col: Int) -> Int {
  match {
    at < len(v) and v[at] == 32 -> cols(v, at: at + 1, col: col + 1)
    at < len(v) and v[at] == 9 -> cols(v, at: at + 1, col: col + 4 - col % 4)
    else -> col
  }
}

// the line without its first n columns of indentation (fewer when it has fewer); a tab that straddles column n
// leaves the rest of its width as spaces
fn strip_cols(line: View, n: Int) -> View {
  strip_at(line, at: 0, col: 0, n)
}

fn strip_at(line: View, at: Int, col: Int, n: Int) -> View {
  match {
    col >= n or at >= len(line) -> slice(v: line, from: at, to: len(line))
    line[at] == 32 -> strip_at(line, at: at + 1, col: col + 1, n)
    line[at] == 9
      and col + 4 - col % 4 <= n -> strip_at(line, at: at + 1, col: col + 4 - col % 4, n)
    line[at] == 9 -> freeze(buf: spaces(out: buf(), n: col + 4 - col % 4 - n) |> append(
      view: slice(v: line, from: at + 1, to: len(line))
    ))
    else -> slice(v: line, from: at, to: len(line))
  }
}

fn spaces(out: Buf, n: Int) -> Buf {
  match {
    n <= 0 -> out
    else -> spaces(out: push(buf: out, byte: 32), n: n - 1)
  }
}

fn strip_lead(line: View) -> View {
  slice(v: line, from: skip_ws(v: line, at: 0), to: len(line))
}

fn rtrim(v: View) -> View {
  slice(v, from: 0, to: rtrim_end(v, end: len(v)))
}

fn rtrim_end(v: View, end: Int) -> Int {
  match {
    end > 0 and is_ws(v[end - 1]) -> rtrim_end(v, end: end - 1)
    else -> end
  }
}

fn trim(v: View) -> View {
  rtrim(strip_lead(v))
}

fn is_blank(v: View) -> Bool {
  skip_ws(v, at: 0) >= len(v)
}

fn run_len(v: View, at: Int, b: Int) -> Int {
  run_end(v, at, b) - at
}

fn run_end(v: View, at: Int, b: Int) -> Int {
  match {
    at < len(v) and v[at] == b -> run_end(v, at: at + 1, b)
    else -> at
  }
}

fn byte_at(v: View, at: Int) -> Int {
  match {
    at >= 0 and at < len(v) -> v[at]
    else -> 10
  }
}

// ---------------------------------------------------------------- what a line starts

fn classify(line: View) -> Line {
  let at = skip_ws(v: line, at: 0)
  let col = cols(v: line, at: 0, col: 0)
  match {
    at >= len(line) -> Empty
    col >= 4 -> Content(start: Indented)
    else -> Content(start: start_at(line, at, col))
  }
}

fn start_at(line: View, at: Int, col: Int) -> Start {
  let b = line[at]
  match {
    b == 62 -> QuoteLine(rest: quote_rest(line, at: at + 1))
    b == 35 -> atx(line, at)
    (b == 96 or b == 126) and run_len(v: line, at, b) >= 3 -> fence(line, at, col)
    (b == 42 or b == 45 or b == 95) and is_hr(v: line, at, mark: b, count: 0) -> Hr
    (b == 42 or b == 45 or b == 43) and byte_at(v: line, at: at + 1)
      |> is_ws -> marker(line, after: at + 1, kind: Bullet(mark: b))
    is_digit(b) -> ordered(line, at, end: at)
    else -> Plain
  }
}

fn quote_rest(line: View, at: Int) -> View {
  match {
    at < len(line)
      and (line[at] == 32 or line[at] == 9) -> slice(v: line, from: at + 1, to: len(line))
    else -> slice(v: line, from: at, to: len(line))
  }
}

fn atx(line: View, at: Int) -> Start {
  let n = run_len(v: line, at, b: 35)
  match {
    n <= 6
      and (at + n >= len(line) or line[at + n] == 32 or line[at + n] == 9) -> Atx(
        level: n,
        text: atx_text(trim(slice(v: line, from: at + n, to: len(line))))
      )
    else -> Plain
  }
}

// a heading's text without its closing run of #s (which must follow a space, or be all there is)
fn atx_text(s: View) -> View {
  let k = hashes_from(s, end: len(s))
  match {
    k == len(s) -> s
    k == 0 -> ""
    s[k - 1] == 32 or s[k - 1] == 9 -> rtrim(slice(v: s, from: 0, to: k))
    else -> s
  }
}

fn hashes_from(s: View, end: Int) -> Int {
  match {
    end > 0 and s[end - 1] == 35 -> hashes_from(s, end: end - 1)
    else -> end
  }
}

fn fence(line: View, at: Int, col: Int) -> Start {
  let mark = line[at]
  let n = run_len(v: line, at, b: mark)
  let info = trim(slice(v: line, from: at + n, to: len(line)))
  match {
    mark == 96 and find(v: info, byte: 96, at: 0) < len(info) -> Plain
    else -> Fence(mark, n, indent: col, info)
  }
}

fn is_hr(v: View, at: Int, mark: Int, count: Int) -> Bool {
  match {
    at >= len(v) -> count >= 3
    v[at] == mark -> is_hr(v, at: at + 1, mark, count: count + 1)
    v[at] == 32 or v[at] == 9 -> is_hr(v, at: at + 1, mark, count)
    else -> False
  }
}

fn ordered(line: View, at: Int, end: Int) -> Start {
  match {
    end < len(line) and is_digit(line[end]) and end - at < 9 -> ordered(line, at, end: end + 1)
    end < len(line) and (line[end] == 46 or line[end] == 41) and byte_at(v: line, at: end + 1)
      |> is_ws -> marker(
        line,
        after: end + 1,
        kind: Ordered(start: digits_value(v: line, at, end, acc: 0), delim: line[end])
      )
    else -> Plain
  }
}

fn digits_value(v: View, at: Int, end: Int, acc: Int) -> Int {
  match {
    at >= end -> acc
    else -> digits_value(v, at: at + 1, end, acc: acc * 10 + v[at] - 48)
  }
}

// a list marker ending before `after`: the item's content starts after 1-4 spaces; with none, or 5 or more (an
// indented code block), one column after the marker
fn marker(line: View, after: Int, kind: ListKind) -> Start {
  let p = skip_ws(v: line, at: after)
  match {
    p >= len(line) -> Marker(kind, width: after + 1, rest: "")
    p - after >= 5 -> Marker(
      kind,
      width: after + 1,
      rest: slice(v: line, from: after + 1, to: len(line))
    )
    else -> Marker(kind, width: p, rest: slice(v: line, from: p, to: len(line)))
  }
}

// can this line go on a paragraph? (anything but a blank line or a block start that interrupts one)
fn continues(line: View) -> Bool {
  match classify(line) {
    Empty -> False
    Content(start: Plain) -> True
    Content(start: Indented) -> True
    Content(start: Marker(kind: Bullet, rest)) -> is_blank(rest)
    Content(start: Marker(kind: Ordered(start), rest)) -> start != 1 or is_blank(rest)
    _ -> False
  }
}

// can this line go on a paragraph inside a container whose marker it lacks? Only paragraph text: any block start
// (an empty list item too) begins a block of its own there
fn is_lazy(line: View) -> Bool {
  match classify(line) {
    Content(start: Plain) -> True
    Content(start: Indented) -> True
    _ -> False
  }
}

// whether a paragraph is open in a container, worked out only when a line without the container's marker asks:
// para_open descends through nested > markers, so working it out for every line made a line of d >s cost O(d^2)
type Lazy {
  After(line: View, was: Bool)
  Known(open: Bool)
}

fn open_now(lazy: Lazy) -> Bool {
  match lazy {
    After(line, was) -> para_open(was, line)
    Known(open) -> open
  }
}

// the state after one more line of the container; para_open reads `was` only for an indented line or a marker
fn after(lazy: Lazy, line: View) -> Lazy {
  match classify(line) {
    Content(start: Indented) -> After(line, was: open_now(lazy))
    Content(start: Marker) -> After(line, was: open_now(lazy))
    _ -> After(line, was: False)
  }
}

// is a paragraph open after this line, given whether one was open before it?
fn para_open(was: Bool, line: View) -> Bool {
  match classify(line) {
    Empty -> False
    Content(start: Plain) -> True
    Content(start: Indented) -> was
    Content(start: QuoteLine(rest)) -> para_open(was: False, line: rest)
    Content(start: Marker(rest)) -> was and continues(line) or para_open(was: False, line: rest)
    _ -> False
  }
}

// 1 for a line of =, 2 for a line of -, else 0
fn setext(line: View) -> Int {
  let at = skip_ws(v: line, at: 0)
  let b = byte_at(v: line, at)
  let n = run_len(v: line, at, b)
  match {
    cols(v: line, at: 0, col: 0) >= 4 or b != 61 and b != 45 -> 0
    skip_ws(v: line, at: at + n) < len(line) -> 0
    b == 61 -> 1
    else -> 2
  }
}

// ---------------------------------------------------------------- blocks

fn parse(lines: List[View], depth: Int) -> Parsed {
  blocks_from(lines, depth, acc: Nil, blank: False, gap: False)
}

// gap: two of these blocks have a blank line between them (what makes a list item loose)
fn blocks_from(lines: List[View], depth: Int, acc: List[Block], blank: Bool, gap: Bool) -> Parsed {
  match lines {
    Nil -> Parsed(blocks: reverse(list: acc), gap)
    Cons(head: line, tail: rest) -> match classify(line) {
      Empty -> blocks_from(lines: rest, depth, acc, blank: True, gap)
      Content(start) -> {
        let Took(block, rest: more) = take(start, line, rest, depth)
        blocks_from(
          lines: more,
          depth,
          acc: Cons(head: block, tail: acc),
          blank: False,
          gap: gap or blank and is_cons(acc)
        )
      }
    }
  }
}

fn is_cons(acc: List[Block]) -> Bool {
  match acc {
    Nil -> False
    _ -> True
  }
}

// depth: how many blockquotes and list items hold these lines. Past 100 a > or a list marker is paragraph text, as
// markdown-it's maxNesting does: each level is a few Wasm frames, and 1,536 nested >s overflowed the stack
// (results/depth-local.json, results/hosted-probes.json), which is not a trap Tape defines
fn take(start: Start, line: View, rest: List[View], depth: Int) -> Took {
  match start {
    QuoteLine if depth >= 100 -> para_body(
      lines: rest,
      acc: Cons(head: strip_lead(line), tail: Nil)
    )
    Marker if depth >= 100 -> para_body(lines: rest, acc: Cons(head: strip_lead(line), tail: Nil))
    Atx(level, text) -> Took(block: Heading(level, inlines: inline(text)), rest)
    Hr -> Took(block: Rule, rest)
    Fence(mark, n, indent, info) -> {
      let Taken(lines, rest: after) = fence_body(lines: rest, mark, n, indent, acc: Nil)
      Took(block: CodeBlock(info: until(v: info, byte: 32), text: joined(lines)), rest: after)
    }
    Indented -> {
      let Taken(lines, rest: after) = code_body(lines: Cons(head: line, tail: rest), acc: Nil)
      Took(block: CodeBlock(info: "", text: joined(lines)), rest: after)
    }
    QuoteLine(rest: first) -> {
      let Taken(lines, rest: after) = quote_body(
        lines: rest,
        acc: Cons(head: first, tail: Nil),
        lazy: After(line: first, was: False)
      )
      Took(block: Quote(blocks: parse(lines, depth: depth + 1).blocks), rest: after)
    }
    Marker(kind, width, rest: first) -> {
      let Taken(lines, rest: after) = item_body(
        lines: rest,
        width,
        acc: opening(first),
        lazy: After(line: first, was: False),
        bare: is_blank(first)
      )
      let p = parse(lines, depth: depth + 1)
      list_more(
        kind,
        lines: after,
        entries: Cons(head: Entry(blocks: p.blocks), tail: Nil),
        loose: p.gap,
        blank: False,
        depth
      )
    }
    Plain -> para_body(lines: rest, acc: Cons(head: strip_lead(line), tail: Nil))
  }
}

fn para_body(lines: List[View], acc: List[View]) -> Took {
  match lines {
    Nil -> Took(block: Para(inlines: inline(text: para_text(acc))), rest: Nil)
    Cons(head: line, tail: rest) -> match {
      setext(line) > 0 -> Took(
        block: Heading(level: setext(line), inlines: inline(text: para_text(acc))),
        rest
      )
      continues(line) -> para_body(lines: rest, acc: Cons(head: strip_lead(line), tail: acc))
      else -> Took(block: Para(inlines: inline(text: para_text(acc))), rest: lines)
    }
  }
}

fn para_text(acc: List[View]) -> View {
  rtrim(join(list: reverse(list: acc), sep: "\n"))
}

fn joined(lines: List[View]) -> View {
  freeze(buf: fold(
    list: lines,
    from: buf(),
    by: fn(out: Buf, line: View) -> Buf { out |> append(view: line) |> push(byte: 10) }
  ))
}

fn fence_body(lines: List[View], mark: Int, n: Int, indent: Int, acc: List[View]) -> Taken {
  match lines {
    Nil -> Taken(lines: reverse(list: acc), rest: Nil)
    Cons(head: line, tail: rest) -> match {
      closes(line, mark, n) -> Taken(lines: reverse(list: acc), rest)
      else -> fence_body(
        lines: rest,
        mark,
        n,
        indent,
        acc: Cons(head: strip_cols(line, n: indent), tail: acc)
      )
    }
  }
}

fn closes(line: View, mark: Int, n: Int) -> Bool {
  let at = skip_ws(v: line, at: 0)
  cols(v: line, at: 0, col: 0) < 4
    and run_len(v: line, at, b: mark) >= n
    and skip_ws(v: line, at: at + run_len(v: line, at, b: mark)) >= len(line)
}

fn code_body(lines: List[View], acc: List[View]) -> Taken {
  match lines {
    Nil -> unwind(acc, rest: Nil)
    Cons(head: line, tail: rest) -> match classify(line) {
      Empty -> code_body(lines: rest, acc: Cons(head: strip_cols(line, n: 4), tail: acc))
      Content(start: Indented) -> code_body(
        lines: rest,
        acc: Cons(head: strip_cols(line, n: 4), tail: acc)
      )
      _ -> unwind(acc, rest: lines)
    }
  }
}

// the lines taken (newest first in acc), without the blank lines at their end, which go back to the rest
fn unwind(acc: List[View], rest: List[View]) -> Taken {
  match acc {
    Cons(head: line, tail) if is_blank(line) -> unwind(acc: tail, rest: Cons(head: "", tail: rest))
    _ -> Taken(lines: reverse(list: acc), rest)
  }
}

fn quote_body(lines: List[View], acc: List[View], lazy: Lazy) -> Taken {
  match lines {
    Nil -> Taken(lines: reverse(list: acc), rest: Nil)
    Cons(head: line, tail: rest) -> match classify(line) {
      Content(start: QuoteLine(rest: inner)) -> quote_body(
        lines: rest,
        acc: Cons(head: inner, tail: acc),
        lazy: after(lazy, line: inner)
      )
      _ if open_now(lazy)
        and is_lazy(line) -> quote_body(
          lines: rest,
          acc: Cons(head: line, tail: acc),
          lazy: Known(open: True)
        )
      _ -> Taken(lines: reverse(list: acc), rest: lines)
    }
  }
}

// an item's first line, unless it is blank (which is no line of the item's content)
fn opening(first: View) -> List[View] {
  match is_blank(first) {
    True -> Nil
    False -> Cons(head: first, tail: Nil)
  }
}

// bare: the item began with a blank line, and nothing else yet (it may begin with at most one)
fn item_body(lines: List[View], width: Int, acc: List[View], lazy: Lazy, bare: Bool) -> Taken {
  match lines {
    Nil -> unwind(acc, rest: Nil)
    Cons(head: line, tail: rest) -> match {
      is_blank(line) and bare -> unwind(acc, rest: lines)
      is_blank(line) -> item_body(
        lines: rest,
        width,
        acc: Cons(head: "", tail: acc),
        lazy: Known(open: False),
        bare
      )
      cols(v: line, at: 0, col: 0) >= width -> item_body(
        lines: rest,
        width,
        acc: Cons(head: strip_cols(line, n: width), tail: acc),
        lazy: after(lazy, line: strip_cols(line, n: width)),
        bare: False
      )
      open_now(lazy)
        and is_lazy(line) -> item_body(
          lines: rest,
          width,
          acc: Cons(head: line, tail: acc),
          lazy: Known(open: True),
          bare: False
        )
      else -> unwind(acc, rest: lines)
    }
  }
}

fn list_more(
  kind: ListKind,
  lines: List[View],
  entries: List[Entry],
  loose: Bool,
  blank: Bool,
  depth: Int
) -> Took {
  match lines {
    Nil -> list_done(kind, entries, loose, rest: Nil, blank)
    Cons(head: line, tail: rest) -> match classify(line) {
      Empty -> list_more(kind, lines: rest, entries, loose, blank: True, depth)
      Content(start: Marker(kind: next, width, rest: first)) if same_kind(a: kind, b: next) -> {
        let Taken(lines: item, rest: after) = item_body(
          lines: rest,
          width,
          acc: opening(first),
          lazy: After(line: first, was: False),
          bare: is_blank(first)
        )
        let p = parse(lines: item, depth: depth + 1)
        list_more(
          kind,
          lines: after,
          entries: Cons(head: Entry(blocks: p.blocks), tail: entries),
          loose: loose or blank or p.gap,
          blank: False,
          depth
        )
      }
      _ -> list_done(kind, entries, loose, rest: lines, blank)
    }
  }
}

fn list_done(
  kind: ListKind,
  entries: List[Entry],
  loose: Bool,
  rest: List[View],
  blank: Bool
) -> Took {
  let back = match blank {
    True -> Cons(head: "", tail: rest)
    False -> rest
  }
  Took(block: Items(kind, tight: not loose, entries: reverse(list: entries)), rest: back)
}

fn same_kind(a: ListKind, b: ListKind) -> Bool {
  match a {
    Bullet(mark) -> match b {
      Bullet(mark: m) -> m == mark
      _ -> False
    }
    Ordered(delim) -> match b {
      Ordered(delim: d) -> d == delim
      _ -> False
    }
  }
}

// ---------------------------------------------------------------- inlines
//
// One pass left to right over the text, with a stack of pieces. Two indexes are built first, each in one linear
// pass, so that nothing is searched for twice: every backtick run (where a code span may close), and for every [
// the ] that balances it (-1 for none), paired right to left with a stack of ]s. Before them (variants/v0.tape),
// each [ searched ahead for its ] and each code span for its closing run, so n [s then one ] cost O(n^2)
// (sweeps brackets_then_close, nested_brackets and backtick_ladder in results/sweep-v0.json).

fn inline(text: View) -> List[Inline] {
  let runs = tick_runs(t: text, at: 0, acc: Nil)
  scan(
    t: text,
    at: 0,
    from: 0,
    stack: Stack(pieces: Nil, stars: 0, unders: 0),
    ix: Index(
      pairs: bracket_pairs(tokens: brackets(t: text, at: 0, runs, acc: Nil), closes: Nil, acc: Nil),
      runs
    )
  )
}

fn tick_runs(t: View, at: Int, acc: List[Tick]) -> List[Tick] {
  let j = find(v: t, byte: 96, at)
  match {
    j >= len(t) -> reverse(list: acc)
    else -> tick_runs(
      t,
      at: run_end(v: t, at: j, b: 96),
      acc: Cons(head: Tick(at: j, n: run_len(v: t, at: j, b: 96)), tail: acc)
    )
  }
}

// the runs that start at or after `at`
fn runs_from(runs: List[Tick], at: Int) -> List[Tick] {
  match runs {
    Cons(head, tail) if head.at < at -> runs_from(runs: tail, at)
    _ -> runs
  }
}

// where the next run of exactly n backticks after the first of `runs` starts, or -1
fn closing_run(runs: List[Tick], n: Int) -> Int {
  match runs {
    Nil -> -1
    Cons(tail) -> run_of(runs: tail, n)
  }
}

fn run_of(runs: List[Tick], n: Int) -> Int {
  match runs {
    Nil -> -1
    Cons(head, tail) if head.n == n -> head.at
    Cons(tail) -> run_of(runs: tail, n)
  }
}

// the [ and ] that may make links, newest first: escaped ones, and those in code spans and autolinks (which bind
// tighter than links), left out
fn brackets(t: View, at: Int, runs: List[Tick], acc: List[Bracket]) -> List[Bracket] {
  let next = next_special(t, at)
  match {
    next >= len(t) -> acc
    t[next] == 92 -> brackets(t, at: next + 2, runs, acc)
    t[next] == 96 -> {
      let here = runs_from(runs, at: next)
      let k = closing_run(runs: here, n: run_len(v: t, at: next, b: 96))
      match {
        k < 0 -> brackets(t, at: run_end(v: t, at: next, b: 96), runs: here, acc)
        else -> brackets(t, at: run_end(v: t, at: k, b: 96), runs: here, acc)
      }
    }
    t[next] == 60
      and autolink_end(t, at: next) > next -> brackets(
        t,
        at: autolink_end(t, at: next) + 1,
        runs,
        acc
      )
    t[next] == 60 -> brackets(t, at: next + 1, runs, acc)
    t[next] == 91 -> brackets(t, at: next + 1, runs, acc: Cons(head: Opens(at: next), tail: acc))
    else -> brackets(t, at: next + 1, runs, acc: Cons(head: Closes(at: next), tail: acc))
  }
}

fn next_special(t: View, at: Int) -> Int {
  match {
    at >= len(t) -> len(t)
    t[at] == 92 or t[at] == 96 or t[at] == 60 or t[at] == 91 or t[at] == 93 -> at
    else -> next_special(t, at: at + 1)
  }
}

// tokens right to left: a ] waits on a stack; a [ takes the nearest one, which is the ] that balances it
fn bracket_pairs(tokens: List[Bracket], closes: List[Int], acc: List[Pair]) -> List[Pair] {
  match tokens {
    Nil -> acc
    Cons(head: Closes(at), tail) -> bracket_pairs(
      tokens: tail,
      closes: Cons(head: at, tail: closes),
      acc
    )
    Cons(head: Opens(at), tail) -> match closes {
      Cons(head: c, tail: more) -> bracket_pairs(
        tokens: tail,
        closes: more,
        acc: Cons(head: Pair(open: at, close: c), tail: acc)
      )
      Nil -> bracket_pairs(
        tokens: tail,
        closes,
        acc: Cons(head: Pair(open: at, close: -1), tail: acc)
      )
    }
  }
}

fn pairs_from(pairs: List[Pair], at: Int) -> List[Pair] {
  match pairs {
    Cons(head, tail) if head.open < at -> pairs_from(pairs: tail, at)
    _ -> pairs
  }
}

fn scan(t: View, at: Int, from: Int, stack: Stack, ix: Index) -> List[Inline] {
  match {
    at >= len(t) -> to_inlines(t, pieces: flush(t, from, to: at, stack).pieces, acc: Nil)
    else -> match t[at] {
      92 -> escape_at(t, at, from, stack, ix)
      96 -> code_at(t, at, from, stack, ix)
      42 -> run_at(t, at, from, stack, ix)
      95 -> run_at(t, at, from, stack, ix)
      91 -> bracket_at(t, at, b: at, from, stack, ix)
      33 if byte_at(v: t, at: at + 1) == 91 -> bracket_at(t, at, b: at + 1, from, stack, ix)
      60 -> angle_at(t, at, from, stack, ix)
      10 -> break_at(t, at, from, stack, ix)
      _ -> scan(t, at: at + 1, from, stack, ix)
    }
  }
}

fn flush(t: View, from: Int, to: Int, stack: Stack) -> Stack {
  match {
    to > from -> shove(stack, piece: Done(node: Str(text: slice(v: t, from, to))))
    else -> stack
  }
}

fn shove(stack: Stack, piece: Piece) -> Stack {
  Stack(
    pieces: Cons(head: piece, tail: stack.pieces),
    stars: stack.stars + opens(piece, mark: 42),
    unders: stack.unders + opens(piece, mark: 95)
  )
}

// 1 for a run of `mark` that can open, else 0
fn opens(piece: Piece, mark: Int) -> Int {
  match piece {
    Run(delim) if delim.open and delim.mark == mark -> 1
    _ -> 0
  }
}

fn push_node(t: View, from: Int, to: Int, stack: Stack, node: Inline) -> Stack {
  shove(stack: flush(t, from, to, stack), piece: Done(node))
}

fn to_inlines(t: View, pieces: List[Piece], acc: List[Inline]) -> List[Inline] {
  match pieces {
    Nil -> acc
    Cons(head, tail) -> to_inlines(
      t,
      pieces: tail,
      acc: Cons(head: piece_inline(t, piece: head), tail: acc)
    )
  }
}

fn piece_inline(t: View, piece: Piece) -> Inline {
  match piece {
    Done(node) -> node
    Run(delim) -> Str(text: slice(v: t, from: delim.at, to: delim.at + delim.n))
  }
}

// a line ending: hard after two or more spaces, soft otherwise; the spaces are dropped either way
fn break_at(t: View, at: Int, from: Int, stack: Stack, ix: Index) -> List[Inline] {
  let end = max(a: rtrim_spaces(t, end: at), b: from)
  let node = match {
    at - end >= 2 -> Hard
    else -> Soft
  }
  let next = skip_ws(v: t, at: at + 1)
  scan(t, at: next, from: next, stack: push_node(t, from, to: end, stack, node), ix)
}

fn rtrim_spaces(t: View, end: Int) -> Int {
  match {
    end > 0 and t[end - 1] == 32 -> rtrim_spaces(t, end: end - 1)
    else -> end
  }
}

fn escape_at(t: View, at: Int, from: Int, stack: Stack, ix: Index) -> List[Inline] {
  let b = byte_at(v: t, at: at + 1)
  match {
    at + 1 < len(t)
      and is_punct(b) -> scan(
        t,
        at: at + 2,
        from: at + 2,
        stack: push_node(
          t,
          from,
          to: at,
          stack,
          node: Str(text: slice(v: t, from: at + 1, to: at + 2))
        ),
        ix
      )
    at + 1 < len(t) and b == 10 -> {
      let next = skip_ws(v: t, at: at + 2)
      scan(t, at: next, from: next, stack: push_node(t, from, to: at, stack, node: Hard), ix)
    }
    else -> scan(t, at: at + 1, from, stack, ix)
  }
}

fn code_at(t: View, at: Int, from: Int, stack: Stack, ix: Index) -> List[Inline] {
  let n = run_len(v: t, at, b: 96)
  let here = runs_from(runs: ix.runs, at)
  let k = closing_run(runs: here, n)
  let moved = Index(pairs: ix.pairs, runs: here)
  match {
    k < 0 -> scan(t, at: at + n, from, stack, ix: moved)
    else -> scan(
      t,
      at: k + n,
      from: k + n,
      stack: push_node(
        t,
        from,
        to: at,
        stack,
        node: CodeSpan(text: code_text(slice(v: t, from: at + n, to: k)))
      ),
      ix: moved
    )
  }
}

fn code_text(v: View) -> View {
  match {
    len(v) >= 2
      and is_ws(v[0])
      and is_ws(v[len(v) - 1])
      and not all_ws(v, at: 0) -> slice(v, from: 1, to: len(v) - 1)
    else -> v
  }
}

fn all_ws(v: View, at: Int) -> Bool {
  match {
    at >= len(v) -> True
    v[at] == 32 or v[at] == 10 -> all_ws(v, at: at + 1)
    else -> False
  }
}

// a run of * or _: whether it can open or close is CommonMark's flanking rule, with the start and end of the text
// as white space and every byte of 128 or more as a letter
fn run_at(t: View, at: Int, from: Int, stack: Stack, ix: Index) -> List[Inline] {
  let mark = t[at]
  let n = run_len(v: t, at, b: mark)
  let before = byte_at(v: t, at: at - 1)
  let after = byte_at(v: t, at: at + n)
  let left = not is_ws(after) and (not is_punct(after) or is_ws(before) or is_punct(before))
  let right = not is_ws(before) and (not is_punct(before) or is_ws(after) or is_punct(after))
  let open = match mark {
    42 -> left
    _ -> left and (not right or is_punct(before))
  }
  let close = match mark {
    42 -> right
    _ -> right and (not left or is_punct(after))
  }
  let run = Delim(at, n, orig: n, mark, open, close)
  let flushed = flush(t, from, to: at, stack)
  let next = match close {
    True -> close_run(t, stack: flushed, run)
    False -> shove(stack: flushed, piece: Run(delim: run))
  }
  scan(t, at: at + n, from: at + n, stack: next, ix)
}

// a closer: find the nearest opener it may close; wrap what is between in <em> or <strong>, and go on with what is
// left of either run. The search allocates nothing, and is skipped when no run of the mark can open. Before
// (variants/v0.tape) each failed search copied the stack: 512 * openers then 512 _ closers (3 KB) allocated 14 MB,
// and 1,024 of each ran out of the 64 MB (sweep openers_then_closers in results/sweep-v0.json)
fn close_run(t: View, stack: Stack, run: Delim) -> Stack {
  let k = match {
    run.mark == 42 and stack.stars == 0 or run.mark == 95 and stack.unders == 0 -> -1
    else -> seek(pieces: stack.pieces, closer: run, k: 0)
  }
  match {
    k < 0 -> shove(stack, piece: Run(delim: run))
    else -> {
      // seek found an opener k deep, so split finds it; Missing cannot come back
      let Found(above, opener: o, below) = split(
        pieces: stack.pieces,
        k,
        above: Nil
      ) else -> shove(stack, piece: Run(delim: run))
      let use = match {
        o.n >= 2 and run.n >= 2 -> 2
        else -> 1
      }
      let kids = to_inlines(t, pieces: reverse(list: above), acc: Nil)
      let node = match use {
        2 -> Strong(inlines: kids)
        _ -> Emph(inlines: kids)
      }
      // the opener and every run that could open between it and the closer leave the stack
      let base = Stack(
        pieces: below,
        stars: stack.stars - opens(
          piece: Run(delim: o),
          mark: 42
        ) - count_opens(pieces: above, mark: 42, acc: 0),
        unders: stack.unders - opens(
          piece: Run(delim: o),
          mark: 95
        ) - count_opens(pieces: above, mark: 95, acc: 0)
      )
      let kept = match {
        o.n > use -> shove(
          stack: base,
          piece: Run(delim: Delim(
            at: o.at,
            n: o.n - use,
            orig: o.orig,
            mark: o.mark,
            open: o.open,
            close: o.close
          ))
        )
        else -> base
      }
      let stacked = shove(stack: kept, piece: Done(node))
      match {
        run.n > use -> close_run(
          t,
          stack: stacked,
          run: Delim(
            at: run.at + use,
            n: run.n - use,
            orig: run.orig,
            mark: run.mark,
            open: run.open,
            close: run.close
          )
        )
        else -> stacked
      }
    }
  }
}

fn count_opens(pieces: List[Piece], mark: Int, acc: Int) -> Int {
  match pieces {
    Nil -> acc
    Cons(head, tail) -> count_opens(pieces: tail, mark, acc: acc + opens(piece: head, mark))
  }
}

// how deep in the stack the nearest opener `closer` may close is, or -1
fn seek(pieces: List[Piece], closer: Delim, k: Int) -> Int {
  match pieces {
    Nil -> -1
    Cons(head: Run(delim: d)) if pairs(a: d, b: closer) -> k
    Cons(tail) -> seek(pieces: tail, closer, k: k + 1)
  }
}

// the k pieces above the opener (oldest first), the opener, and the pieces below it
fn split(pieces: List[Piece], k: Int, above: List[Piece]) -> Found {
  match pieces {
    Cons(head: Run(delim: d), tail) if k == 0 -> Found(above, opener: d, below: tail)
    Cons(head, tail) if k > 0 -> split(pieces: tail, k: k - 1, above: Cons(head, tail: above))
    _ -> Missing
  }
}

// may run a open what run b closes? (same mark; the rule of 3 for runs that can both open and close)
fn pairs(a: Delim, b: Delim) -> Bool {
  a.open
    and a.mark == b.mark
    and not ((a.close or b.open) and (a.orig + b.orig) % 3 == 0 and not (
      a.orig % 3 == 0 and b.orig % 3 == 0
    ))
}

// [ (or ![ when b is at + 1): a link when its balanced ] is followed by (destination "title")
fn bracket_at(t: View, at: Int, b: Int, from: Int, stack: Stack, ix: Index) -> List[Inline] {
  let here = pairs_from(pairs: ix.pairs, at: b)
  let e = match here {
    Cons(head) if head.open == b -> head.close
    _ -> -1
  }
  let moved = Index(pairs: here, runs: ix.runs)
  let tail = match {
    e >= 0 -> link_tail(t, at: e + 1)
    else -> None
  }
  match tail {
    Some(value: Tail(dest, title, end)) -> {
      let kids = inline(text: slice(v: t, from: b + 1, to: e))
      match {
        b > at -> scan(
          t,
          at: end,
          from: end,
          stack: push_node(t, from, to: at, stack, node: Image(dest, title, inlines: kids)),
          ix: moved
        )
        has_link(kids) -> scan(t, at: b + 1, from, stack, ix: moved)
        else -> scan(
          t,
          at: end,
          from: end,
          stack: push_node(t, from, to: at, stack, node: Link(dest, title, inlines: kids)),
          ix: moved
        )
      }
    }
    None -> scan(t, at: b + 1, from, stack, ix: moved)
  }
}

fn has_link(list: List[Inline]) -> Bool {
  match list {
    Nil -> False
    Cons(head: Link, tail) -> True
    Cons(head: Emph(inlines), tail) -> has_link(list: inlines) or has_link(list: tail)
    Cons(head: Strong(inlines), tail) -> has_link(list: inlines) or has_link(list: tail)
    Cons(tail) -> has_link(list: tail)
  }
}

// at is just after ]: ( destination "title" )
fn link_tail(t: View, at: Int) -> Option[Tail] {
  let p = skip_nl(t, at: at + 1)
  match {
    byte_at(v: t, at) != 40 -> None
    byte_at(v: t, at: p) == 41 -> Some(value: Tail(dest: "", title: None, end: p + 1))
    byte_at(v: t, at: p) == 60 -> {
      let q = angle_end(t, at: p + 1)
      match {
        q < 0 -> None
        else -> title_part(t, dest: unescape(slice(v: t, from: p + 1, to: q)), at: q + 1)
      }
    }
    else -> {
      let q = dest_end(t, at: p, depth: 0)
      match {
        q == p -> None
        else -> title_part(t, dest: unescape(slice(v: t, from: p, to: q)), at: q)
      }
    }
  }
}

// spaces and tabs, and at most one line ending among them
fn skip_nl(t: View, at: Int) -> Int {
  let p = skip_ws(v: t, at)
  match {
    byte_at(v: t, at: p) == 10 and p < len(t) -> skip_ws(v: t, at: p + 1)
    else -> p
  }
}

fn angle_end(t: View, at: Int) -> Int {
  match {
    at >= len(t) or t[at] == 10 or t[at] == 60 -> -1
    t[at] == 62 -> at
    t[at] == 92 and at + 1 < len(t) -> angle_end(t, at: at + 2)
    else -> angle_end(t, at: at + 1)
  }
}

fn dest_end(t: View, at: Int, depth: Int) -> Int {
  match {
    at >= len(t) or t[at] <= 32 -> at
    t[at] == 92 and at + 1 < len(t) and is_punct(t[at + 1]) -> dest_end(t, at: at + 2, depth)
    t[at] == 40 -> dest_end(t, at: at + 1, depth: depth + 1)
    t[at] == 41 and depth == 0 -> at
    t[at] == 41 -> dest_end(t, at: at + 1, depth: depth - 1)
    else -> dest_end(t, at: at + 1, depth)
  }
}

fn title_part(t: View, dest: View, at: Int) -> Option[Tail] {
  let p = skip_nl(t, at)
  let b = byte_at(v: t, at: p)
  match {
    b == 41 -> Some(value: Tail(dest, title: None, end: p + 1))
    p > at and (b == 34 or b == 39 or b == 40) -> {
      let q = title_end(t, at: p + 1, close: match b {
        40 -> 41
        _ -> b
      })
      let r = skip_nl(t, at: q + 1)
      match {
        q < 0 or byte_at(v: t, at: r) != 41 -> None
        else -> Some(value: Tail(
          dest,
          title: Some(value: unescape(slice(v: t, from: p + 1, to: q))),
          end: r + 1
        ))
      }
    }
    else -> None
  }
}

fn title_end(t: View, at: Int, close: Int) -> Int {
  match {
    at >= len(t) -> -1
    t[at] == close -> at
    t[at] == 92 and at + 1 < len(t) -> title_end(t, at: at + 2, close)
    else -> title_end(t, at: at + 1, close)
  }
}

fn unescape(v: View) -> View {
  match {
    find(v, byte: 92, at: 0) >= len(v) -> v
    else -> freeze(buf: unescape_from(out: buf(), v, at: 0))
  }
}

fn unescape_from(out: Buf, v: View, at: Int) -> Buf {
  match {
    at >= len(v) -> out
    v[at] == 92
      and at + 1 < len(v)
      and is_punct(v[at + 1]) -> unescape_from(out: push(buf: out, byte: v[at + 1]), v, at: at + 2)
    else -> unescape_from(out: push(buf: out, byte: v[at]), v, at: at + 1)
  }
}

// where the > of an autolink starting at `at` is, or -1
fn autolink_end(t: View, at: Int) -> Int {
  let q = auto_end(t, at: at + 1)
  let inner = slice(v: t, from: at + 1, to: max(a: q, b: at + 1))
  match {
    q >= 0 and (is_uri(inner) or is_email(inner)) -> q
    else -> -1
  }
}

// <scheme:...> or <user@host>; anything else is a literal <
fn angle_at(t: View, at: Int, from: Int, stack: Stack, ix: Index) -> List[Inline] {
  let q = auto_end(t, at: at + 1)
  let inner = slice(v: t, from: at + 1, to: max(a: q, b: at + 1))
  let dest = match {
    q < 0 -> ""
    is_uri(inner) -> inner
    is_email(inner) -> "mailto:\(inner)"
    else -> ""
  }
  match {
    len(dest) == 0 -> scan(t, at: at + 1, from, stack, ix)
    else -> scan(
      t,
      at: q + 1,
      from: q + 1,
      stack: push_node(
        t,
        from,
        to: at,
        stack,
        node: Link(dest, title: None, inlines: Cons(head: Str(text: inner), tail: Nil))
      ),
      ix
    )
  }
}

fn auto_end(t: View, at: Int) -> Int {
  match {
    at >= len(t) or t[at] <= 32 or t[at] == 60 -> -1
    t[at] == 62 -> at
    else -> auto_end(t, at: at + 1)
  }
}

fn is_uri(v: View) -> Bool {
  let c = find(v, byte: 58, at: 0)
  c >= 2
    and c <= 32
    and c < len(v)
    and is_alpha(v[0])
    and every_byte(
      v: slice(v, from: 1, to: c),
      keep: fn(b: Int) -> Bool { is_alnum(b) or b == 43 or b == 46 or b == 45 }
    )
}

fn is_email(v: View) -> Bool {
  let a = find(v, byte: 64, at: 0)
  a >= 1
    and a + 1 < len(v)
    and every_byte(
      v: slice(v, from: 0, to: a),
      keep: fn(b: Int) -> Bool { is_alnum(b) or b > 32 and b < 127 and find(
        v: ".!#$%&'*+/=?^_`{|}~-",
        byte: b,
        at: 0
      ) < 20 }
    )
    and every_byte(
      v: slice(v, from: a + 1, to: len(v)),
      keep: fn(b: Int) -> Bool { is_alnum(b) or b == 45 or b == 46 }
    )
    and is_alnum(v[a + 1])
    and is_alnum(v[len(v) - 1])
}

// ---------------------------------------------------------------- HTML

fn write_blocks(out: Buf, blocks: List[Block]) -> Buf {
  match blocks {
    Nil -> out
    Cons(head, tail) -> write_blocks(out: write_block(out, block: head), blocks: tail)
  }
}

fn write_block(out: Buf, block: Block) -> Buf {
  match block {
    Para(inlines) -> out
      |> append(view: "<p>")
      |> write_inlines(list: inlines)
      |> append(view: "</p>\n")
    Heading(level, inlines) -> out
      |> append(view: "<h\(level)>")
      |> write_inlines(list: inlines)
      |> append(view: "</h\(level)>\n")
    CodeBlock(info, text) -> out
      |> append(view: "<pre><code")
      |> write_class(info)
      |> append(view: ">")
      |> write_esc(text)
      |> append(view: "</code></pre>\n")
    Rule -> out |> append(view: "<hr />\n")
    Quote(blocks) -> out
      |> append(view: "<blockquote>\n")
      |> write_blocks(blocks)
      |> append(view: "</blockquote>\n")
    Items(kind: Bullet, tight, entries) -> out
      |> append(view: "<ul>\n")
      |> write_entries(entries, tight)
      |> append(view: "</ul>\n")
    Items(kind: Ordered(start), tight, entries) -> out
      |> write_ol(start)
      |> write_entries(entries, tight)
      |> append(view: "</ol>\n")
  }
}

fn write_class(out: Buf, info: View) -> Buf {
  match info {
    "" -> out
    _ -> out
      |> append(view: " class=\"language-")
      |> write_esc(text: unescape(info))
      |> append(view: "\"")
  }
}

fn write_ol(out: Buf, start: Int) -> Buf {
  match start {
    1 -> out |> append(view: "<ol>\n")
    _ -> out |> append(view: "<ol start=\"\(start)\">\n")
  }
}

fn write_entries(out: Buf, entries: List[Entry], tight: Bool) -> Buf {
  match entries {
    Nil -> out
    Cons(head: Entry(blocks), tail) -> out
      |> append(view: "<li>")
      |> write_item(blocks, tight, nl: False)
      |> append(view: "</li>\n")
      |> write_entries(entries: tail, tight)
  }
}

// an item's blocks: a tight list's paragraphs are their text alone; nl says the output ends in a line feed
fn write_item(out: Buf, blocks: List[Block], tight: Bool, nl: Bool) -> Buf {
  match blocks {
    Nil -> out
    Cons(head: Para(inlines), tail) if tight -> write_item(
      out: write_inlines(out, list: inlines),
      blocks: tail,
      tight,
      nl: False
    )
    Cons(head, tail) -> {
      let fed = match nl {
        True -> out
        False -> push(buf: out, byte: 10)
      }
      write_item(out: write_block(out: fed, block: head), blocks: tail, tight, nl: True)
    }
  }
}

fn write_inlines(out: Buf, list: List[Inline]) -> Buf {
  match list {
    Nil -> out
    Cons(head, tail) -> write_inlines(out: write_inline(out, node: head), list: tail)
  }
}

fn write_inline(out: Buf, node: Inline) -> Buf {
  match node {
    Str(text) -> write_esc(out, text)
    Soft -> push(buf: out, byte: 10)
    Hard -> append(buf: out, view: "<br />\n")
    CodeSpan(text) -> out |> append(view: "<code>") |> write_esc(text) |> append(view: "</code>")
    Emph(inlines) -> out
      |> append(view: "<em>")
      |> write_inlines(list: inlines)
      |> append(view: "</em>")
    Strong(inlines) -> out
      |> append(view: "<strong>")
      |> write_inlines(list: inlines)
      |> append(view: "</strong>")
    Link(dest, title, inlines) -> out
      |> append(view: "<a href=\"")
      |> write_url(dest)
      |> append(view: "\"")
      |> write_title(title)
      |> append(view: ">")
      |> write_inlines(list: inlines)
      |> append(view: "</a>")
    Image(dest, title, inlines) -> out
      |> append(view: "<img src=\"")
      |> write_url(dest)
      |> append(view: "\" alt=\"")
      |> write_alt(list: inlines)
      |> append(view: "\"")
      |> write_title(title)
      |> append(view: " />")
  }
}

fn write_title(out: Buf, title: Option[View]) -> Buf {
  match title {
    Some(value) -> out |> append(view: " title=\"") |> write_esc(text: value) |> append(view: "\"")
    None -> out
  }
}

// an image's alt text: the text of its inlines, without tags
fn write_alt(out: Buf, list: List[Inline]) -> Buf {
  match list {
    Nil -> out
    Cons(head, tail) -> write_alt(out: match head {
      Str(text) -> write_esc(out, text)
      CodeSpan(text) -> write_esc(out, text)
      Soft -> push(buf: out, byte: 10)
      Hard -> push(buf: out, byte: 10)
      Emph(inlines) -> write_alt(out, list: inlines)
      Strong(inlines) -> write_alt(out, list: inlines)
      Link(inlines) -> write_alt(out, list: inlines)
      Image(inlines) -> write_alt(out, list: inlines)
    }, list: tail)
  }
}

// text into HTML: & < > " as entities (a line feed in a code span is a space: CommonMark)
fn write_esc(out: Buf, text: View) -> Buf {
  esc_from(out, text, from: 0, at: 0)
}

fn esc_from(out: Buf, text: View, from: Int, at: Int) -> Buf {
  match {
    at >= len(text) -> append(buf: out, view: slice(v: text, from, to: at))
    else -> match text[at] {
      38 -> esc_from(
        out: out |> append(view: slice(v: text, from, to: at)) |> append(view: "&amp;"),
        text,
        from: at + 1,
        at: at + 1
      )
      60 -> esc_from(
        out: out |> append(view: slice(v: text, from, to: at)) |> append(view: "&lt;"),
        text,
        from: at + 1,
        at: at + 1
      )
      62 -> esc_from(
        out: out |> append(view: slice(v: text, from, to: at)) |> append(view: "&gt;"),
        text,
        from: at + 1,
        at: at + 1
      )
      34 -> esc_from(
        out: out |> append(view: slice(v: text, from, to: at)) |> append(view: "&quot;"),
        text,
        from: at + 1,
        at: at + 1
      )
      _ -> esc_from(out, text, from, at: at + 1)
    }
  }
}

// a URL into an attribute: percent-encoded (an existing %XX kept), & as &amp;; an unsafe scheme is dropped
fn write_url(out: Buf, dest: View) -> Buf {
  match {
    unsafe(dest) -> out
    else -> url_from(out, v: dest, at: 0)
  }
}

fn unsafe(dest: View) -> Bool {
  let head = lower(text: slice(v: dest, from: 0, to: min(a: len(dest), b: 16)))
  starts_with(v: head, prefix: "javascript:")
    or starts_with(v: head, prefix: "vbscript:")
    or starts_with(v: head, prefix: "file:")
    or starts_with(v: head, prefix: "data:")
    and not (starts_with(v: head, prefix: "data:image/png") or starts_with(
      v: head,
      prefix: "data:image/gif"
    ) or starts_with(
      v: head,
      prefix: "data:image/jpeg"
    ) or starts_with(
      v: head,
      prefix: "data:image/webp"
    ))
}

fn url_from(out: Buf, v: View, at: Int) -> Buf {
  match {
    at >= len(v) -> out
    else -> url_from(out: url_byte(out, v, at), v, at: at + 1)
  }
}

fn url_byte(out: Buf, v: View, at: Int) -> Buf {
  let b = v[at]
  match {
    b == 38 -> append(buf: out, view: "&amp;")
    is_alnum(b) or find(v: ";/?:@=+$,-_.!~*'()#", byte: b, at: 0) < 19 -> push(buf: out, byte: b)
    b == 37
      and at + 2 < len(v)
      and is_hex(v[at + 1])
      and is_hex(v[at + 2]) -> push(buf: out, byte: b)
    else -> out |> push(byte: 37) |> push(byte: hex_digit(b >> 4)) |> push(byte: hex_digit(b & 15))
  }
}

fn hex_digit(n: Int) -> Int {
  match {
    n < 10 -> 48 + n
    else -> 55 + n
  }
}
