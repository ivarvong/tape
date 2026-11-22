// trace.tape: an OTLP/JSON trace in, an SVG waterfall out. handle(raw) reads the bytes as JSON (RFC 8259) by
// hand, a byte at a time, then reads OTLP from it: resourceSpans, each with its resource (service.name) and
// scopeSpans, each with spans. Every span is a row (a call and the callee's server span share one), ordered as
// a tree (a parent, then its children by start time): a label column with the tree, the service and the name,
// and a track with the bar placed by its times on a shared axis, a mark for each event and the duration. Idle
// gaps are compressed. What it cannot read is said in the picture: input that is not JSON, or JSON that is not
// OTLP, gives an SVG saying why.
//
// Geometry is in integers. Across the page, the label column is the first 32% and the track runs from 33% to
// 98.5%; inside the track a position is in basis points of its width (10000 is all of it), written as a
// percentage with two decimals, so the picture fills any width. Down the page, positions are pixels: each row
// is 26 high.
//
// The rules a reader of the SVG can check (apps/trace/test.ts does, from the OTLP alone):
// - a time is a string of 1 to 19 digits no larger than 2^63 - 1, or a JSON integer no larger than 2^53 - 1;
//   anything else is unreadable. A span with no readable start starts at its end; with neither, at the first
//   time of the trace. An end that is unreadable or before the start is the start.
// - t0 is the earliest start and t1 the latest end; the axis spans t1 - t0, or 1 ms when that is 0.
// - roots are spans with no parent id, or whose parent is not in the trace (orphans); they come first, by start.
//   Then any span not reached (its parents form a cycle) starts a tree of its own, marked, by start. Children
//   are ordered by start; equal starts keep the order of the input. The first span with an id holds its children.
// - JSON.parse keeps the last of a repeated key, and so does this.

// ---------- types ----------

type Checked {
  Fine
  Broken(at: Int)
}

// A member's key, decoded, and where its value starts.
type Key { Key(name: View, value: Int) }

// What a reader read, and where the value it read ends.
type Got[T] { Got(value: T, next: Int) }

type Attr { Attr(key: View, value: View) }

type Ev { Ev(time: Int, name: View, attrs: List[Attr]) }

type Stat { Stat(code: Int, message: View) }

// A span as read. start and end are -1 when unreadable. color is the service's place in the order services were
// first seen; code is the status code (2: error).
type Span { Span(
  idx: Int,
  trace: View,
  id: View,
  parent: View,
  name: View,
  kind: Int,
  start: Int,
  end: Int,
  service: View,
  color: Int,
  code: Int,
  message: View,
  attrs: List[Attr],
  events: List[Ev]
) }

// A resource as read: its service name ("" when it names none) and its spans, last first, not yet numbered.
type Pend { Pend(service: View, spans: List[Span]) }

// The top-level object as read: the resources of its last resourceSpans (last first), and what that member was: 0
// none, 1 an array, 2 something else.
type Top { Top(res: List[Pend], found: Int) }

// What reading has gathered: the spans (last first), how many, each service's colour and how many there are, and
// the service and colour of the resource being read.
type Acc { Acc(
  spans: List[Span],
  n: Int,
  colors: Map[Int],
  services: Int,
  service: View,
  color: Int
) }

// A row waiting to be shown: its span, its depth, its mark (0 in the tree, 1 an orphan, 2 the start of a cycle),
// the service of the row it hangs from ("" at the top), that row's place (-1 at the top), and, when the span is a
// call (a client span) whose one child is the callee's server span, that server span: a call is one row.
type Frame { Frame(span: Span, depth: Int, mark: Int, above: View, prow: Int, pair: Option[Span]) }

// The rows walked so far (last first), the spans shown by number, how many spans and how many rows.
type Walked { Walked(rows: List[Frame], seen: Map[Bool], count: Int, nrows: Int) }

// An idle stretch of the trace, a to b ns after t0, when no span is running: drawn narrow, with a break.
type Gap { Gap(a: Int, b: Int) }

// The time axis: t0 and t1; d, the time it shows (ns); the idle gaps it compresses; u, the time left when they
// are taken out, and w, the basis points of the track that u is spread over (each gap gets 800); the tick step,
// and the unit tick labels are written in (ns per unit).
type Axis { Axis(t0: Int, t1: Int, d: Int, gaps: List[Gap], u: Int, w: Int, step: Int, unit: Int) }

// What the header says, and how many bytes of each service name are a prefix all of them share.
type Summary { Summary(spans: Int, services: Int, errors: Int, traces: Int, trace: View, cut: Int) }

// ---------- the entry point ----------

fn handle(raw: View) -> Buf {
  match checked(v: raw) {
    Fine -> document(v: raw, at: json_ws(v: raw, at: 0))
    Broken(at) -> problem(
      why: "This is not JSON.",
      detail: "It stops being JSON at byte \(at) of \(len(raw)).",
      raw,
      at
    )
  }
}

fn document(v: View, at: Int) -> Buf {
  match {
    v[at] != 123 -> problem(
      why: "This is not an OTLP trace.",
      detail: "Its JSON is not an object.",
      raw: v,
      at: -1
    )
    else -> read(top: top(v, at: inside(v, at), res: Nil, found: 0))
  }
}

fn read(top: Top) -> Buf {
  match {
    top.found != 1 -> problem(
      why: "This is not an OTLP trace.",
      detail: "It has no resourceSpans array.",
      raw: "",
      at: -1
    )
    else -> spans_read(acc: numbered(
      list: reverse(list: top.res),
      acc: Acc(spans: Nil, n: 0, colors: Empty, services: 0, service: "", color: 0)
    ))
  }
}

fn spans_read(acc: Acc) -> Buf {
  let spans = reverse(list: acc.spans)
  match {
    acc.n == 0 -> problem(
      why: "This trace has no spans.",
      detail: "Its resourceSpans hold no span objects.",
      raw: "",
      at: -1
    )
    else -> drawn(spans, acc, lo: earliest(list: spans, lo: -1))
  }
}

fn drawn(spans: List[Span], acc: Acc, lo: Int) -> Buf {
  let first = max(a: lo, b: 0)
  let t0 = first_begin(list: spans, lo: first, best: -1)
  let t1 = last_finish(list: spans, lo: first, best: 0)
  let walked = trees(spans, lo: first)
  svg(
    rows: reverse(list: walked.rows),
    nrows: walked.nrows,
    axis: axis_for(t0, t1, by_start: sorted(list: spans, lo: first), lo: first),
    lo: first,
    acc,
    sum: summary(list: spans, acc)
  )
}

// ---------- JSON: is it well formed? ----------

// One JSON value with only whitespace around it, or where it stops being one. `open` holds the containers the
// position is inside, innermost first: True for an object, False for an array.
fn checked(v: View) -> Checked {
  jvalue(v, at: json_ws(v, at: 0), open: Nil)
}

fn jvalue(v: View, at: Int, open: List[Bool]) -> Checked {
  match {
    at >= len(v) -> Broken(at)
    v[at] == 123 -> jobject(v, at: json_ws(v, at: at + 1), open)
    v[at] == 91 -> jarray(v, at: json_ws(v, at: at + 1), open)
    v[at] == 34 -> jstring(v, at, end: string_valid(v, at: at + 1), open)
    has(v, at, word: "true") -> jafter(v, at: at + 4, open)
    has(v, at, word: "false") -> jafter(v, at: at + 5, open)
    has(v, at, word: "null") -> jafter(v, at: at + 4, open)
    else -> jnumber(v, at, end: number_end(v, at), open)
  }
}

fn jobject(v: View, at: Int, open: List[Bool]) -> Checked {
  match {
    at < len(v) and v[at] == 125 -> jafter(v, at: at + 1, open)
    else -> jkey(v, at, open: Cons(head: True, tail: open))
  }
}

fn jarray(v: View, at: Int, open: List[Bool]) -> Checked {
  match {
    at < len(v) and v[at] == 93 -> jafter(v, at: at + 1, open)
    else -> jvalue(v, at, open: Cons(head: False, tail: open))
  }
}

fn jstring(v: View, at: Int, end: Int, open: List[Bool]) -> Checked {
  match {
    end < 0 -> Broken(at)
    else -> jafter(v, at: end, open)
  }
}

// After the closing quote of the string whose body starts at `at`, or -1 when it is not a JSON string. Printable
// ASCII is passed four bytes a step where it can, else one; an escape or a byte past ASCII is read by std's
// json_char, which checks escapes, surrogates and UTF-8.
fn string_valid(v: View, at: Int) -> Int {
  match {
    at >= len(v) -> -1
    v[at] == 34 -> at + 1
    at + 4 <= len(v) and ascii(b: v[at]) and ascii(b: v[at + 1]) and ascii(b: v[at + 2]) and ascii(
      b: v[at + 3]
    ) -> string_valid(v, at: at + 4)
    ascii(b: v[at]) -> string_valid(v, at: at + 1)
    else -> string_char(v, found: json_char(v, at))
  }
}

// Printable ASCII that a string holds as it is: not a control, a quote or a backslash.
fn ascii(b: Int) -> Bool {
  b >= 32 and b < 128 and b != 34 and b != 92
}

fn string_char(v: View, found: JsonChar) -> Int {
  match found {
    Char(next) -> string_valid(v, at: next)
    Quote(next) -> next
    BadChar -> -1
  }
}

fn jnumber(v: View, at: Int, end: Option[Int], open: List[Bool]) -> Checked {
  match end {
    Some(value) -> jafter(v, at: value, open)
    None -> Broken(at)
  }
}

fn jkey(v: View, at: Int, open: List[Bool]) -> Checked {
  match {
    at < len(v) and v[at] == 34 -> jcolon(v, at, end: string_valid(v, at: at + 1), open)
    else -> Broken(at)
  }
}

fn jcolon(v: View, at: Int, end: Int, open: List[Bool]) -> Checked {
  match {
    end < 0 -> Broken(at)
    else -> jcolon_at(v, at: json_ws(v, at: end), open)
  }
}

fn jcolon_at(v: View, at: Int, open: List[Bool]) -> Checked {
  match {
    at < len(v) and v[at] == 58 -> jvalue(v, at: json_ws(v, at: at + 1), open)
    else -> Broken(at)
  }
}

fn jafter(v: View, at: Int, open: List[Bool]) -> Checked {
  let s = json_ws(v, at)
  match open {
    Nil -> jend(v, at: s)
    Cons(head: True, tail) -> jin_object(v, at: s, open, tail)
    Cons(tail) -> jin_array(v, at: s, open, tail)
  }
}

fn jend(v: View, at: Int) -> Checked {
  match {
    at == len(v) -> Fine
    else -> Broken(at)
  }
}

fn jin_object(v: View, at: Int, open: List[Bool], tail: List[Bool]) -> Checked {
  match {
    at >= len(v) -> Broken(at)
    v[at] == 44 -> jkey(v, at: json_ws(v, at: at + 1), open)
    v[at] == 125 -> jafter(v, at: at + 1, open: tail)
    else -> Broken(at)
  }
}

fn jin_array(v: View, at: Int, open: List[Bool], tail: List[Bool]) -> Checked {
  match {
    at >= len(v) -> Broken(at)
    v[at] == 44 -> jvalue(v, at: json_ws(v, at: at + 1), open)
    v[at] == 93 -> jafter(v, at: at + 1, open: tail)
    else -> Broken(at)
  }
}

// ---------- JSON: reading what is known to be well formed ----------

// Where the value that starts at `at` ends: what is skipped is read once, by these.
fn value_end(v: View, at: Int) -> Int {
  match {
    v[at] == 34 -> string_end(v, at: at + 1)
    v[at] == 123 or v[at] == 91 -> nested_end(v, at: at + 1, depth: 1)
    else -> scalar_end(v, at)
  }
}

// From inside a string: after its closing quote.
fn string_end(v: View, at: Int) -> Int {
  match {
    v[at] == 34 -> at + 1
    v[at] == 92 -> string_end(v, at: at + 2)
    plain(b: v[at + 1]) and plain(b: v[at + 2]) and plain(b: v[at + 3]) -> string_end(v, at: at + 4)
    else -> string_end(v, at: at + 1)
  }
}

fn nested_end(v: View, at: Int, depth: Int) -> Int {
  let b = v[at]
  match {
    b == 34 -> nested_end(v, at: string_end(v, at: at + 1), depth)
    b == 123 or b == 91 -> nested_end(v, at: at + 1, depth: depth + 1)
    (b == 125 or b == 93) and depth == 1 -> at + 1
    b == 125 or b == 93 -> nested_end(v, at: at + 1, depth: depth - 1)
    else -> nested_end(v, at: at + 1, depth)
  }
}

fn scalar_end(v: View, at: Int) -> Int {
  match {
    at >= len(v) -> at
    v[at] == 44 or v[at] == 125 or v[at] == 93 or v[at] <= 32 -> at
    else -> scalar_end(v, at: at + 1)
  }
}

// The first member or element inside the object or array whose bracket is at `at`.
fn inside(v: View, at: Int) -> Int {
  json_ws(v, at: at + 1)
}

// After a member or element that ends at `at`: the next one, or the bracket that closes them.
fn following(v: View, at: Int) -> Int {
  let s = json_ws(v, at)
  match {
    v[s] == 44 -> json_ws(v, at: s + 1)
    else -> s
  }
}

// After a value that starts at `at` and is not wanted.
fn skipped(v: View, at: Int) -> Int {
  following(v, at: value_end(v, at))
}

// The member whose key starts at `at`: the key, decoded, and where its value starts.
fn key_at(v: View, at: Int) -> Key {
  let got = string_at(v, at)
  Key(name: got.value, value: json_ws(v, at: json_ws(v, at: got.next) + 1))
}

// A string, decoded; "" for any other value.
fn text_val(v: View, at: Int) -> Got[View] {
  match {
    v[at] == 34 -> string_at(v, at)
    else -> Got(value: "", next: value_end(v, at))
  }
}

// The string whose quote is at `at` (known to be well formed): a view of the input when it has no escape,
// decoded by std's json_text when it has one.
fn string_at(v: View, at: Int) -> Got[View] {
  let end = plain_end(v, at: at + 1)
  match {
    v[end] == 34 -> Got(value: slice(v, from: at + 1, to: end), next: end + 1)
    else -> text_got(found: json_text(v, at: at + 1), v, at)
  }
}

// The first quote or backslash from `at`.
fn plain_end(v: View, at: Int) -> Int {
  match {
    v[at] == 34 or v[at] == 92 -> at
    plain(b: v[at + 1]) and plain(b: v[at + 2]) and plain(b: v[at + 3]) -> plain_end(v, at: at + 4)
    else -> plain_end(v, at: at + 1)
  }
}

// Neither a quote nor a backslash.
fn plain(b: Int) -> Bool {
  b != 34 and b != 92
}

fn text_got(found: JsonText, v: View, at: Int) -> Got[View] {
  match found {
    JsonText(text, next) -> Got(value: text, next)
    BadText -> Got(value: "", next: value_end(v, at))
  }
}

// A value as text: a string is itself; a number, true, false or null is as written; an array or an object is
// […] or {…}.
fn scalar_val(v: View, at: Int) -> Got[View] {
  match {
    v[at] == 34 -> text_val(v, at)
    v[at] == 123 -> Got(value: "{…}", next: value_end(v, at))
    v[at] == 91 -> Got(value: "[…]", next: value_end(v, at))
    else -> Got(value: slice(v, from: at, to: scalar_end(v, at)), next: scalar_end(v, at))
  }
}

// ---------- OTLP, read in one pass ----------
//
// Each reader starts at the first member or element of its object or array (or at the bracket that closes it),
// reads what it wants as it passes, skips the rest once, and gives what it read and where its value ends. A
// repeated key replaces what the earlier one gave, as JSON.parse does.

// The top-level object: the resources of the last resourceSpans (last first), and what that member was.
fn top(v: View, at: Int, res: List[Pend], found: Int) -> Top {
  match {
    v[at] == 125 -> Top(res, found)
    else -> top_member(v, k: key_at(v, at), res, found)
  }
}

fn top_member(v: View, k: Key, res: List[Pend], found: Int) -> Top {
  match {
    k.name == "resourceSpans" and v[k.value] == 91 -> top_read(
      v,
      got: resources(v, at: inside(v, at: k.value), acc: Nil)
    )
    k.name == "resourceSpans" -> top(v, at: skipped(v, at: k.value), res: Nil, found: 2)
    else -> top(v, at: skipped(v, at: k.value), res, found)
  }
}

fn top_read(v: View, got: Got[List[Pend]]) -> Top {
  top(v, at: following(v, at: got.next), res: got.value, found: 1)
}

fn resources(v: View, at: Int, acc: List[Pend]) -> Got[List[Pend]] {
  match {
    v[at] == 93 -> Got(value: acc, next: at + 1)
    v[at] == 123 -> resources_read(
      v,
      got: resource(v, at: inside(v, at), service: "", spans: Nil),
      acc
    )
    else -> resources(v, at: skipped(v, at), acc)
  }
}

fn resources_read(v: View, got: Got[Pend], acc: List[Pend]) -> Got[List[Pend]] {
  resources(v, at: following(v, at: got.next), acc: Cons(head: got.value, tail: acc))
}

// A resource: its service name ("" when it has none) and the spans of its last scopeSpans, last first.
fn resource(v: View, at: Int, service: View, spans: List[Span]) -> Got[Pend] {
  match {
    v[at] == 125 -> Got(value: Pend(service, spans), next: at + 1)
    else -> resource_member(v, k: key_at(v, at), service, spans)
  }
}

fn resource_member(v: View, k: Key, service: View, spans: List[Span]) -> Got[Pend] {
  match {
    k.name == "resource" and v[k.value] == 123 -> resource_named(
      v,
      got: described(v, at: inside(v, at: k.value), name: ""),
      spans
    )
    k.name == "resource" -> resource(v, at: skipped(v, at: k.value), service: "", spans)
    k.name == "scopeSpans" and v[k.value] == 91 -> resource_scoped(
      v,
      got: scopes(v, at: inside(v, at: k.value), acc: Nil),
      service
    )
    k.name == "scopeSpans" -> resource(v, at: skipped(v, at: k.value), service, spans: Nil)
    else -> resource(v, at: skipped(v, at: k.value), service, spans)
  }
}

fn resource_named(v: View, got: Got[View], spans: List[Span]) -> Got[Pend] {
  resource(v, at: following(v, at: got.next), service: got.value, spans)
}

fn resource_scoped(v: View, got: Got[List[Span]], service: View) -> Got[Pend] {
  resource(v, at: following(v, at: got.next), service, spans: got.value)
}

// The `resource` object: the service.name of its last attributes.
fn described(v: View, at: Int, name: View) -> Got[View] {
  match {
    v[at] == 125 -> Got(value: name, next: at + 1)
    else -> described_member(v, k: key_at(v, at), name)
  }
}

fn described_member(v: View, k: Key, name: View) -> Got[View] {
  match {
    k.name == "attributes" and v[k.value] == 91 -> described_read(
      v,
      got: service_in(v, at: inside(v, at: k.value), name: "")
    )
    k.name == "attributes" -> described(v, at: skipped(v, at: k.value), name: "")
    else -> described(v, at: skipped(v, at: k.value), name)
  }
}

fn described_read(v: View, got: Got[View]) -> Got[View] {
  described(v, at: following(v, at: got.next), name: got.value)
}

// The value of the last attribute named service.name.
fn service_in(v: View, at: Int, name: View) -> Got[View] {
  match {
    v[at] == 93 -> Got(value: name, next: at + 1)
    v[at] == 123 -> service_read(v, got: attr(v, at: inside(v, at), key: "", text: ""), name)
    else -> service_in(v, at: skipped(v, at), name)
  }
}

fn service_read(v: View, got: Got[Attr], name: View) -> Got[View] {
  service_in(
    v,
    at: following(v, at: got.next),
    name: matching(a: got.value, key: "service.name", found: name)
  )
}

fn matching(a: Attr, key: View, found: View) -> View {
  match a {
    Attr(key: k, value) if k == key -> value
    _ -> found
  }
}

// The scopes of a resource: each one's spans go onto `acc` (last first), in order.
fn scopes(v: View, at: Int, acc: List[Span]) -> Got[List[Span]] {
  match {
    v[at] == 93 -> Got(value: acc, next: at + 1)
    v[at] == 123 -> scopes_read(v, got: scope(v, at: inside(v, at), base: acc, spans: acc))
    else -> scopes(v, at: skipped(v, at), acc)
  }
}

fn scopes_read(v: View, got: Got[List[Span]]) -> Got[List[Span]] {
  scopes(v, at: following(v, at: got.next), acc: got.value)
}

// A scope: the spans of its last `spans` member, on top of `base`.
fn scope(v: View, at: Int, base: List[Span], spans: List[Span]) -> Got[List[Span]] {
  match {
    v[at] == 125 -> Got(value: spans, next: at + 1)
    else -> scope_member(v, k: key_at(v, at), base, spans)
  }
}

fn scope_member(v: View, k: Key, base: List[Span], spans: List[Span]) -> Got[List[Span]] {
  match {
    k.name == "spans" and v[k.value] == 91 -> scope_read(
      v,
      got: span_items(v, at: inside(v, at: k.value), acc: base),
      base
    )
    k.name == "spans" -> scope(v, at: skipped(v, at: k.value), base, spans: base)
    else -> scope(v, at: skipped(v, at: k.value), base, spans)
  }
}

fn scope_read(v: View, got: Got[List[Span]], base: List[Span]) -> Got[List[Span]] {
  scope(v, at: following(v, at: got.next), base, spans: got.value)
}

fn span_items(v: View, at: Int, acc: List[Span]) -> Got[List[Span]] {
  match {
    v[at] == 93 -> Got(value: acc, next: at + 1)
    v[at] == 123 -> span_items_read(v, got: span_obj(v, at: inside(v, at), s: blank()), acc)
    else -> span_items(v, at: skipped(v, at), acc)
  }
}

fn span_items_read(v: View, got: Got[Span], acc: List[Span]) -> Got[List[Span]] {
  span_items(v, at: following(v, at: got.next), acc: Cons(head: got.value, tail: acc))
}

// A span before it is read: no ids, no times, no status. Its number, service and colour are given at the end.
fn blank() -> Span {
  Span(
    idx: 0,
    trace: "",
    id: "",
    parent: "",
    name: "",
    kind: 0,
    start: -1,
    end: -1,
    service: "",
    color: 0,
    code: 0,
    message: "",
    attrs: Nil,
    events: Nil
  )
}

fn span_obj(v: View, at: Int, s: Span) -> Got[Span] {
  match {
    v[at] == 125 -> Got(value: s, next: at + 1)
    else -> span_member(v, k: key_at(v, at), s)
  }
}

fn span_member(v: View, k: Key, s: Span) -> Got[Span] {
  match k.name {
    "traceId" -> span_text(v, got: text_val(v, at: k.value), s, field: 0)
    "spanId" -> span_text(v, got: text_val(v, at: k.value), s, field: 1)
    "parentSpanId" -> span_text(v, got: text_val(v, at: k.value), s, field: 2)
    "name" -> span_text(v, got: text_val(v, at: k.value), s, field: 3)
    "kind" -> span_int(v, got: kind_val(v, at: k.value), s, field: 0)
    "startTimeUnixNano" -> span_int(v, got: nanos_val(v, at: k.value), s, field: 1)
    "endTimeUnixNano" -> span_int(v, got: nanos_val(v, at: k.value), s, field: 2)
    "status" -> span_status(v, got: status_val(v, at: k.value), s)
    "attributes" -> span_attrs(v, got: attrs_val(v, at: k.value), s)
    "events" -> span_events(v, got: events_val(v, at: k.value), s)
    _ -> span_obj(v, at: skipped(v, at: k.value), s)
  }
}

fn span_text(v: View, got: Got[View], s: Span, field: Int) -> Got[Span] {
  span_obj(v, at: following(v, at: got.next), s: with_text(s, field, x: got.value))
}

fn span_int(v: View, got: Got[Int], s: Span, field: Int) -> Got[Span] {
  span_obj(v, at: following(v, at: got.next), s: with_int(s, field, x: got.value))
}

fn span_status(v: View, got: Got[Stat], s: Span) -> Got[Span] {
  let Span(idx, trace, id, parent, name, kind, start, end, service, color, attrs, events) = s
  let Stat(code, message) = got.value
  span_obj(
    v,
    at: following(v, at: got.next),
    s: Span(
      idx,
      trace,
      id,
      parent,
      name,
      kind,
      start,
      end,
      service,
      color,
      code,
      message,
      attrs,
      events
    )
  )
}

fn span_attrs(v: View, got: Got[List[Attr]], s: Span) -> Got[Span] {
  let Span(
    idx,
    trace,
    id,
    parent,
    name,
    kind,
    start,
    end,
    service,
    color,
    code,
    message,
    events
  ) = s
  span_obj(
    v,
    at: following(v, at: got.next),
    s: Span(
      idx,
      trace,
      id,
      parent,
      name,
      kind,
      start,
      end,
      service,
      color,
      code,
      message,
      attrs: got.value,
      events
    )
  )
}

fn span_events(v: View, got: Got[List[Ev]], s: Span) -> Got[Span] {
  let Span(idx, trace, id, parent, name, kind, start, end, service, color, code, message, attrs) = s
  span_obj(
    v,
    at: following(v, at: got.next),
    s: Span(
      idx,
      trace,
      id,
      parent,
      name,
      kind,
      start,
      end,
      service,
      color,
      code,
      message,
      attrs,
      events: got.value
    )
  )
}

// The span with one text field replaced: 0 traceId, 1 spanId, 2 parentSpanId, 3 name.
fn with_text(s: Span, field: Int, x: View) -> Span {
  let Span(
    idx,
    trace,
    id,
    parent,
    name,
    kind,
    start,
    end,
    service,
    color,
    code,
    message,
    attrs,
    events
  ) = s
  match field {
    0 -> Span(
      idx,
      trace: x,
      id,
      parent,
      name,
      kind,
      start,
      end,
      service,
      color,
      code,
      message,
      attrs,
      events
    )
    1 -> Span(
      idx,
      trace,
      id: x,
      parent,
      name,
      kind,
      start,
      end,
      service,
      color,
      code,
      message,
      attrs,
      events
    )
    2 -> Span(
      idx,
      trace,
      id,
      parent: x,
      name,
      kind,
      start,
      end,
      service,
      color,
      code,
      message,
      attrs,
      events
    )
    _ -> Span(
      idx,
      trace,
      id,
      parent,
      name: x,
      kind,
      start,
      end,
      service,
      color,
      code,
      message,
      attrs,
      events
    )
  }
}

// The span with one number replaced: 0 kind, 1 start, 2 end.
fn with_int(s: Span, field: Int, x: Int) -> Span {
  let Span(
    idx,
    trace,
    id,
    parent,
    name,
    kind,
    start,
    end,
    service,
    color,
    code,
    message,
    attrs,
    events
  ) = s
  match field {
    0 -> Span(
      idx,
      trace,
      id,
      parent,
      name,
      kind: x,
      start,
      end,
      service,
      color,
      code,
      message,
      attrs,
      events
    )
    1 -> Span(
      idx,
      trace,
      id,
      parent,
      name,
      kind,
      start: x,
      end,
      service,
      color,
      code,
      message,
      attrs,
      events
    )
    _ -> Span(
      idx,
      trace,
      id,
      parent,
      name,
      kind,
      start,
      end: x,
      service,
      color,
      code,
      message,
      attrs,
      events
    )
  }
}

// SpanKind: 1 internal, 2 server, 3 client, 4 producer, 5 consumer; 0 for anything else. A number or its name.
fn kind_val(v: View, at: Int) -> Got[Int] {
  let g = scalar_val(v, at)
  Got(value: kind_named(name: g.value), next: g.next)
}

fn kind_named(name: View) -> Int {
  match name {
    "1" -> 1
    "2" -> 2
    "3" -> 3
    "4" -> 4
    "5" -> 5
    "SPAN_KIND_INTERNAL" -> 1
    "SPAN_KIND_SERVER" -> 2
    "SPAN_KIND_CLIENT" -> 3
    "SPAN_KIND_PRODUCER" -> 4
    "SPAN_KIND_CONSUMER" -> 5
    _ -> 0
  }
}

// A status object: its code (1 ok, 2 error, 0 anything else; a number or its name) and message. Anything that
// is not an object is no status.
fn status_val(v: View, at: Int) -> Got[Stat] {
  match {
    v[at] == 123 -> status(v, at: inside(v, at), code: 0, message: "")
    else -> Got(value: Stat(code: 0, message: ""), next: value_end(v, at))
  }
}

fn status(v: View, at: Int, code: Int, message: View) -> Got[Stat] {
  match {
    v[at] == 125 -> Got(value: Stat(code, message), next: at + 1)
    else -> status_member(v, k: key_at(v, at), code, message)
  }
}

fn status_member(v: View, k: Key, code: Int, message: View) -> Got[Stat] {
  match k.name {
    "code" -> status_code(v, got: scalar_val(v, at: k.value), message)
    "message" -> status_message(v, got: text_val(v, at: k.value), code)
    _ -> status(v, at: skipped(v, at: k.value), code, message)
  }
}

fn status_code(v: View, got: Got[View], message: View) -> Got[Stat] {
  status(v, at: following(v, at: got.next), code: code_named(name: got.value), message)
}

fn status_message(v: View, got: Got[View], code: Int) -> Got[Stat] {
  status(v, at: following(v, at: got.next), code, message: got.value)
}

fn code_named(name: View) -> Int {
  match name {
    "1" -> 1
    "2" -> 2
    "STATUS_CODE_OK" -> 1
    "STATUS_CODE_ERROR" -> 2
    _ -> 0
  }
}

// Attributes, in order; anything that is not an array is none, and an element that is not an object is skipped.
fn attrs_val(v: View, at: Int) -> Got[List[Attr]] {
  match {
    v[at] == 91 -> attr_items(v, at: inside(v, at), acc: Nil)
    else -> Got(value: Nil, next: value_end(v, at))
  }
}

fn attr_items(v: View, at: Int, acc: List[Attr]) -> Got[List[Attr]] {
  match {
    v[at] == 93 -> Got(value: reverse(list: acc), next: at + 1)
    v[at] == 123 -> attr_items_read(v, got: attr(v, at: inside(v, at), key: "", text: ""), acc)
    else -> attr_items(v, at: skipped(v, at), acc)
  }
}

fn attr_items_read(v: View, got: Got[Attr], acc: List[Attr]) -> Got[List[Attr]] {
  attr_items(v, at: following(v, at: got.next), acc: Cons(head: got.value, tail: acc))
}

// One attribute: its key and its value as text (any_value).
fn attr(v: View, at: Int, key: View, text: View) -> Got[Attr] {
  match {
    v[at] == 125 -> Got(value: Attr(key, value: text), next: at + 1)
    else -> attr_member(v, k: key_at(v, at), key, text)
  }
}

fn attr_member(v: View, k: Key, key: View, text: View) -> Got[Attr] {
  match {
    k.name == "key" -> attr_key(v, got: text_val(v, at: k.value), text)
    k.name == "value" and v[k.value] == 123 -> attr_value(
      v,
      got: any_value(v, at: inside(v, at: k.value), text: "", best: 99),
      key
    )
    k.name == "value" -> attr(v, at: skipped(v, at: k.value), key, text: "")
    else -> attr(v, at: skipped(v, at: k.value), key, text)
  }
}

fn attr_key(v: View, got: Got[View], text: View) -> Got[Attr] {
  attr(v, at: following(v, at: got.next), key: got.value, text)
}

fn attr_value(v: View, got: Got[View], key: View) -> Got[Attr] {
  attr(v, at: following(v, at: got.next), key, text: got.value)
}

// An AnyValue as text: of the kinds it has, the first in this order: stringValue, intValue, boolValue,
// doubleValue, bytesValue, arrayValue, kvlistValue (the last of a repeated one). `best` is the rank of the kind
// taken so far (99: none).
fn any_value(v: View, at: Int, text: View, best: Int) -> Got[View] {
  match {
    v[at] == 125 -> Got(value: text, next: at + 1)
    else -> any_member(v, k: key_at(v, at), text, best)
  }
}

fn any_member(v: View, k: Key, text: View, best: Int) -> Got[View] {
  let rank = rank_of(name: k.name)
  match {
    rank <= best -> any_taken(v, got: scalar_val(v, at: k.value), rank)
    else -> any_value(v, at: skipped(v, at: k.value), text, best)
  }
}

fn any_taken(v: View, got: Got[View], rank: Int) -> Got[View] {
  any_value(v, at: following(v, at: got.next), text: got.value, best: rank)
}

fn rank_of(name: View) -> Int {
  match name {
    "stringValue" -> 0
    "intValue" -> 1
    "boolValue" -> 2
    "doubleValue" -> 3
    "bytesValue" -> 4
    "arrayValue" -> 5
    "kvlistValue" -> 6
    _ -> 100
  }
}

// Events, in order, as attributes are.
fn events_val(v: View, at: Int) -> Got[List[Ev]] {
  match {
    v[at] == 91 -> event_items(v, at: inside(v, at), acc: Nil)
    else -> Got(value: Nil, next: value_end(v, at))
  }
}

fn event_items(v: View, at: Int, acc: List[Ev]) -> Got[List[Ev]] {
  match {
    v[at] == 93 -> Got(value: reverse(list: acc), next: at + 1)
    v[at] == 123 -> event_items_read(
      v,
      got: event(v, at: inside(v, at), ev: Ev(time: -1, name: "", attrs: Nil)),
      acc
    )
    else -> event_items(v, at: skipped(v, at), acc)
  }
}

fn event_items_read(v: View, got: Got[Ev], acc: List[Ev]) -> Got[List[Ev]] {
  event_items(v, at: following(v, at: got.next), acc: Cons(head: got.value, tail: acc))
}

fn event(v: View, at: Int, ev: Ev) -> Got[Ev] {
  match {
    v[at] == 125 -> Got(value: ev, next: at + 1)
    else -> event_member(v, k: key_at(v, at), ev)
  }
}

fn event_member(v: View, k: Key, ev: Ev) -> Got[Ev] {
  let Ev(time, name, attrs) = ev
  match k.name {
    "timeUnixNano" -> event_time_read(v, got: nanos_val(v, at: k.value), name, attrs)
    "name" -> event_name_read(v, got: text_val(v, at: k.value), time, attrs)
    "attributes" -> event_attrs_read(v, got: attrs_val(v, at: k.value), time, name)
    _ -> event(v, at: skipped(v, at: k.value), ev)
  }
}

fn event_time_read(v: View, got: Got[Int], name: View, attrs: List[Attr]) -> Got[Ev] {
  event(v, at: following(v, at: got.next), ev: Ev(time: got.value, name, attrs))
}

fn event_name_read(v: View, got: Got[View], time: Int, attrs: List[Attr]) -> Got[Ev] {
  event(v, at: following(v, at: got.next), ev: Ev(time, name: got.value, attrs))
}

fn event_attrs_read(v: View, got: Got[List[Attr]], time: Int, name: View) -> Got[Ev] {
  event(v, at: following(v, at: got.next), ev: Ev(time, name, attrs: got.value))
}

// A time in nanoseconds since 1970, or -1 when it cannot be read (see the rules at the top).
fn nanos_val(v: View, at: Int) -> Got[Int] {
  let g = scalar_val(v, at)
  match {
    v[at] == 34 -> Got(value: nanos(t: g.value, most: 9223372036854775807), next: g.next)
    is_digit(v[at]) -> Got(value: nanos(t: g.value, most: 9007199254740991), next: g.next)
    else -> Got(value: -1, next: g.next)
  }
}

fn nanos(t: View, most: Int) -> Int {
  match {
    len(t) == 0 or len(t) > 19 -> -1
    else -> nanos_from(t, at: 0, value: 0, most)
  }
}

fn nanos_from(t: View, at: Int, value: Int, most: Int) -> Int {
  match {
    at >= len(t) -> value
    not is_digit(t[at]) -> -1
    value > (most - (t[at] - 48)) / 10 -> -1
    else -> nanos_from(t, at: at + 1, value: value * 10 + (t[at] - 48), most)
  }
}

// ---------- numbering what was read ----------

// The resources in order: each span gets its number, its service ("(unknown service)" when the resource names
// none) and that service's colour, given when its first span is numbered.
fn numbered(list: List[Pend], acc: Acc) -> Acc {
  match list {
    Cons(head: Pend(service, spans), tail) -> numbered(
      list: tail,
      acc: number_spans(list: reverse(list: spans), acc: serving(acc, name: service_shown(service)))
    )
    Nil -> acc
  }
}

fn service_shown(service: View) -> View {
  match {
    len(service) == 0 -> "(unknown service)"
    else -> service
  }
}

fn number_spans(list: List[Span], acc: Acc) -> Acc {
  match list {
    Cons(head, tail) -> number_spans(list: tail, acc: number_one(s: head, acc: colored(acc)))
    Nil -> acc
  }
}

fn number_one(s: Span, acc: Acc) -> Acc {
  let Span(trace, id, parent, name, kind, start, end, code, message, attrs, events) = s
  let Acc(spans, n, colors, services, service, color) = acc
  Acc(
    spans: Cons(
      head: Span(
        idx: n,
        trace,
        id,
        parent,
        name,
        kind,
        start,
        end,
        service,
        color,
        code,
        message,
        attrs,
        events
      ),
      tail: spans
    ),
    n: n + 1,
    colors,
    services,
    service,
    color
  )
}

fn serving(acc: Acc, name: View) -> Acc {
  let Acc(spans, n, colors, services, color) = acc
  Acc(spans, n, colors, services, service: name, color)
}

// The colour of the service being numbered, given to it when its first span is numbered.
fn colored(acc: Acc) -> Acc {
  let Acc(spans, n, colors, services, service) = acc
  match get(map: colors, key: service) {
    Some(value) -> Acc(spans, n, colors, services, service, color: value)
    None -> Acc(
      spans,
      n,
      colors: put(map: colors, key: service, value: services),
      services: services + 1,
      service,
      color: services
    )
  }
}

// ---------- times ----------

fn max(a: Int, b: Int) -> Int {
  match {
    a > b -> a
    else -> b
  }
}

fn min(a: Int, b: Int) -> Int {
  match {
    a < b -> a
    else -> b
  }
}

// The earliest readable time, start or end, of any span; -1 when there is none.
fn earliest(list: List[Span], lo: Int) -> Int {
  match list {
    Cons(head, tail) -> earliest(list: tail, lo: lower(a: lower(a: lo, b: head.start), b: head.end))
    Nil -> lo
  }
}

// The smaller of two times, where -1 is no time.
fn lower(a: Int, b: Int) -> Int {
  match {
    a < 0 -> b
    b < 0 -> a
    else -> min(a, b)
  }
}

fn begin(s: Span, lo: Int) -> Int {
  match {
    s.start >= 0 -> s.start
    s.end >= 0 -> s.end
    else -> lo
  }
}

fn finish(s: Span, lo: Int) -> Int {
  max(a: s.end, b: begin(s, lo))
}

fn first_begin(list: List[Span], lo: Int, best: Int) -> Int {
  match list {
    Cons(head, tail) -> first_begin(list: tail, lo, best: lower(a: best, b: begin(s: head, lo)))
    Nil -> best
  }
}

fn last_finish(list: List[Span], lo: Int, best: Int) -> Int {
  match list {
    Cons(head, tail) -> last_finish(list: tail, lo, best: max(a: best, b: finish(s: head, lo)))
    Nil -> best
  }
}

// The axis. Idle gaps (no span running) of a fifth of the trace or more are compressed to 800 basis points
// each, so a timer that fires a second after a 2 ms request does not squash the request; the rest of the track,
// w, is shared by u, the time that is left. A gap is compressed only when some time is left. The tick step is 1,
// 2 or 5 times a power of ten, at least u / (w / 1100): ticks at least 11% of the track apart.
fn axis_for(t0: Int, t1: Int, by_start: List[Span], lo: Int) -> Axis {
  let d = span_of(d: t1 - t0)
  let found = gaps_in(list: by_start, lo, t0, end: 0, need: d / 5 + min(a: d % 5, b: 1), acc: Nil)
  let idle = gap_total(list: found, n: 0)
  match {
    idle < d -> axis_with(t0, t1, d, gaps: found, u: d - idle, w: 10000 - 800 * length(list: found))
    else -> axis_with(t0, t1, d, gaps: Nil, u: d, w: 10000)
  }
}

fn axis_with(t0: Int, t1: Int, d: Int, gaps: List[Gap], u: Int, w: Int) -> Axis {
  let q = w / 1100
  let step = step_of(need: u / q + min(a: u % q, b: 1), mant: 1, pow: 1)
  Axis(t0, t1, d, gaps, u, w, step, unit: unit_of(step))
}

// The gaps between the spans' times, in order: `end` is the latest finish so far (after t0).
fn gaps_in(list: List[Span], lo: Int, t0: Int, end: Int, need: Int, acc: List[Gap]) -> List[Gap] {
  match list {
    Cons(head, tail) -> gap_after(
      list: tail,
      lo,
      t0,
      b: begin(s: head, lo) - t0,
      e: finish(s: head, lo) - t0,
      end,
      need,
      acc
    )
    Nil -> reverse(list: acc)
  }
}

fn gap_after(
  list: List[Span],
  lo: Int,
  t0: Int,
  b: Int,
  e: Int,
  end: Int,
  need: Int,
  acc: List[Gap]
) -> List[Gap] {
  match {
    b - end >= need -> gaps_in(
      list,
      lo,
      t0,
      end: e,
      need,
      acc: Cons(head: Gap(a: end, b), tail: acc)
    )
    else -> gaps_in(list, lo, t0, end: max(a: end, b: e), need, acc)
  }
}

fn gap_total(list: List[Gap], n: Int) -> Int {
  match list {
    Cons(head, tail) -> gap_total(list: tail, n: n + head.b - head.a)
    Nil -> n
  }
}

fn span_of(d: Int) -> Int {
  match {
    d <= 0 -> 1000000
    else -> d
  }
}

// The unit a tick label is written in: the largest of s, ms, µs, ns that is at most five steps.
fn unit_of(step: Int) -> Int {
  match {
    step >= 200000000 -> 1000000000
    step >= 200000 -> 1000000
    step >= 200 -> 1000
    else -> 1
  }
}

fn unit_name(unit: Int) -> View {
  match unit {
    1000000000 -> "s"
    1000000 -> "ms"
    1000 -> "µs"
    _ -> "ns"
  }
}

fn step_of(need: Int, mant: Int, pow: Int) -> Int {
  match {
    mant * pow >= need -> mant * pow
    mant == 1 -> step_of(need, mant: 2, pow)
    mant == 2 -> step_of(need, mant: 5, pow)
    else -> step_of(need, mant: 1, pow: pow * 10)
  }
}

// Where time t (ns after t0) is on the track, in basis points of its width: linear in the time that is not
// in a compressed gap, and each gap 800 wide.
fn x_of(t: Int, axis: Axis) -> Int {
  place(t, list: axis.gaps, removed: 0, k: 0, axis)
}

fn place(t: Int, list: List[Gap], removed: Int, k: Int, axis: Axis) -> Int {
  match list {
    Cons(head: Gap(a, b), tail) if t > b -> place(
      t,
      list: tail,
      removed: removed + b - a,
      k: k + 1,
      axis
    )
    Cons(head: Gap(a, b)) if t > a -> scale(
      a: a - removed,
      d: axis.u,
      w: axis.w
    ) + 800 * k + scale(a: t - a, d: b - a, w: 800)
    _ -> scale(a: t - removed, d: axis.u, w: axis.w) + 800 * k
  }
}

// a * w / d, rounded, for 0 <= a <= d and w <= 10000: halved together until the product cannot overflow.
fn scale(a: Int, d: Int, w: Int) -> Int {
  match {
    d > 900000000000000 -> scale(a: a / 2, d: d / 2, w)
    else -> (a * w + d / 2) / d
  }
}

// ---------- the tree ----------

// Every span once, in the order shown: the trees under the roots, then those under spans no root reaches.
fn trees(spans: List[Span], lo: Int) -> Walked {
  let byid = holders(list: reverse(list: spans), map: Empty)
  let kids = families(list: reverse(list: spans), byid, map: Empty)
  let roots = sorted(list: rootless(list: spans, byid, acc: Nil), lo)
  let first = walk(
    stack: framed(list: roots, byid, depth: 0, above: "", prow: -1, acc: Nil),
    seen: Empty,
    rows: Nil,
    count: 0,
    nrows: 0,
    kids,
    byid,
    lo,
    check: False
  )
  match {
    first.count >= length(list: spans) -> first
    else -> cycles(
      list: sorted(list: spans, lo),
      walked: Walked(
        rows: first.rows,
        seen: seen_of(list: first.rows, map: Empty),
        count: first.count,
        nrows: first.nrows
      ),
      kids,
      byid,
      lo
    )
  }
}

// The first span with each id (the list is last first, so the first put last).
fn holders(list: List[Span], map: Map[Span]) -> Map[Span] {
  match list {
    Cons(head, tail) if len(head.id) > 0 -> holders(
      list: tail,
      map: put(map, key: head.id, value: head)
    )
    Cons(tail) -> holders(list: tail, map)
    Nil -> map
  }
}

// Each parent id's children, in the order of the input (the list is last first).
fn families(list: List[Span], byid: Map[Span], map: Map[List[Span]]) -> Map[List[Span]] {
  match list {
    Cons(head, tail) if held(byid, id: head.parent) -> families(
      list: tail,
      byid,
      map: put(map, key: head.parent, value: Cons(head, tail: children(map, id: head.parent)))
    )
    Cons(tail) -> families(list: tail, byid, map)
    Nil -> map
  }
}

fn held(byid: Map[Span], id: View) -> Bool {
  match get(map: byid, key: id) {
    Some -> len(id) > 0
    None -> False
  }
}

fn children(map: Map[List[Span]], id: View) -> List[Span] {
  match get(map, key: id) {
    Some(value) -> value
    None -> Nil
  }
}

// Spans with no parent, or whose parent is not in the trace, in input order.
fn rootless(list: List[Span], byid: Map[Span], acc: List[Span]) -> List[Span] {
  match list {
    Cons(head, tail) if held(byid, id: head.parent) -> rootless(list: tail, byid, acc)
    Cons(head, tail) -> rootless(list: tail, byid, acc: Cons(head, tail: acc))
    Nil -> reverse(list: acc)
  }
}

// Frames for these spans, the first on top, onto the stack `acc`.
fn framed(
  list: List[Span],
  byid: Map[Span],
  depth: Int,
  above: View,
  prow: Int,
  acc: List[Frame]
) -> List[Frame] {
  onto(list: reverse(list: list), byid, depth, above, prow, acc)
}

fn onto(
  list: List[Span],
  byid: Map[Span],
  depth: Int,
  above: View,
  prow: Int,
  acc: List[Frame]
) -> List[Frame] {
  match list {
    Cons(head, tail) -> onto(
      list: tail,
      byid,
      depth,
      above,
      prow,
      acc: Cons(
        head: Frame(span: head, depth, mark: orphan(s: head, depth), above, prow, pair: None),
        tail: acc
      )
    )
    Nil -> acc
  }
}

fn orphan(s: Span, depth: Int) -> Int {
  match {
    depth == 0 and len(s.parent) > 0 -> 1
    else -> 0
  }
}

fn walk(
  stack: List[Frame],
  seen: Map[Bool],
  rows: List[Frame],
  count: Int,
  nrows: Int,
  kids: Map[List[Span]],
  byid: Map[Span],
  lo: Int,
  check: Bool
) -> Walked {
  match stack {
    Nil -> Walked(rows, seen, count, nrows)
    Cons(head: Frame(span), tail) if check and seen_has(seen, idx: span.idx) -> walk(
      stack: tail,
      seen,
      rows,
      count,
      nrows,
      kids,
      byid,
      lo,
      check
    )
    Cons(head: f, tail) -> visit(
      f,
      mine: sorted(list: held_kids(s: f.span, byid, kids), lo),
      stack: tail,
      seen,
      rows,
      count,
      nrows,
      kids,
      byid,
      lo,
      check
    )
  }
}

// One row: a call (a client span) whose only child is a server span is shown with it, as one row, and the
// server span's children hang from that row; any other span is a row of its own.
fn visit(
  f: Frame,
  mine: List[Span],
  stack: List[Frame],
  seen: Map[Bool],
  rows: List[Frame],
  count: Int,
  nrows: Int,
  kids: Map[List[Span]],
  byid: Map[Span],
  lo: Int,
  check: Bool
) -> Walked {
  match mine {
    Cons(head: k, tail: Nil) if f.span.kind == 3 and k.kind == 2 and not (
      check and seen_has(seen, idx: k.idx)
    ) -> walk(
      stack: framed(
        list: sorted(list: held_kids(s: k, byid, kids), lo),
        byid,
        depth: f.depth + 1,
        above: k.service,
        prow: nrows,
        acc: stack
      ),
      seen: noted(seen: noted(seen, idx: f.span.idx, check), idx: k.idx, check),
      rows: Cons(
        head: Frame(
          span: f.span,
          depth: f.depth,
          mark: f.mark,
          above: f.above,
          prow: f.prow,
          pair: Some(value: k)
        ),
        tail: rows
      ),
      count: count + 2,
      nrows: nrows + 1,
      kids,
      byid,
      lo,
      check
    )
    _ -> walk(
      stack: framed(
        list: mine,
        byid,
        depth: f.depth + 1,
        above: f.span.service,
        prow: nrows,
        acc: stack
      ),
      seen: noted(seen, idx: f.span.idx, check),
      rows: Cons(head: f, tail: rows),
      count: count + 1,
      nrows: nrows + 1,
      kids,
      byid,
      lo,
      check
    )
  }
}

// The spans shown so far, by number. The walk from the roots needs none: each span is a root, or in the
// children of one parent id, which only the span holding that id shows, so none is reached twice. Only the
// walks into cycles, after it, look.
fn noted(seen: Map[Bool], idx: Int, check: Bool) -> Map[Bool] {
  match {
    check -> put(map: seen, key: decimal_text(value: idx), value: True)
    else -> seen
  }
}

fn seen_of(list: List[Frame], map: Map[Bool]) -> Map[Bool] {
  match list {
    Cons(head, tail) -> seen_of(
      list: tail,
      map: paired_seen(
        pair: head.pair,
        map: put(map, key: decimal_text(value: head.span.idx), value: True)
      )
    )
    Nil -> map
  }
}

fn paired_seen(pair: Option[Span], map: Map[Bool]) -> Map[Bool] {
  match pair {
    Some(value) -> put(map, key: decimal_text(value: value.idx), value: True)
    None -> map
  }
}

fn seen_has(seen: Map[Bool], idx: Int) -> Bool {
  match get(map: seen, key: decimal_text(value: idx)) {
    Some -> True
    None -> False
  }
}

// A span's children, when it is the span that holds its id.
fn held_kids(s: Span, byid: Map[Span], kids: Map[List[Span]]) -> List[Span] {
  match get(map: byid, key: s.id) {
    Some(value) if value.idx == s.idx -> children(map: kids, id: s.id)
    _ -> Nil
  }
}

// Spans no root reached: each not yet shown starts a tree, marked 2.
fn cycles(
  list: List[Span],
  walked: Walked,
  kids: Map[List[Span]],
  byid: Map[Span],
  lo: Int
) -> Walked {
  match list {
    Cons(head, tail) if not seen_has(seen: walked.seen, idx: head.idx) -> cycles(
      list: tail,
      walked: walk(
        stack: Cons(
          head: Frame(span: head, depth: 0, mark: 2, above: "", prow: -1, pair: None),
          tail: Nil
        ),
        seen: walked.seen,
        rows: walked.rows,
        count: walked.count,
        nrows: walked.nrows,
        kids,
        byid,
        lo,
        check: True
      ),
      kids,
      byid,
      lo
    )
    Cons(tail) -> cycles(list: tail, walked, kids, byid, lo)
    Nil -> walked
  }
}

// ---------- sorting by start, stable ----------

fn sorted(list: List[Span], lo: Int) -> List[Span] {
  let n = length(list)
  match {
    n < 2 -> list
    else -> merge(
      a: sorted(list: take(list, n: n / 2, acc: Nil), lo),
      b: sorted(list: drop(list, n: n / 2), lo),
      lo,
      acc: Nil
    )
  }
}

fn take(list: List[Span], n: Int, acc: List[Span]) -> List[Span] {
  match list {
    Cons(head, tail) if n > 0 -> take(list: tail, n: n - 1, acc: Cons(head, tail: acc))
    _ -> reverse(list: acc)
  }
}

fn drop(list: List[Span], n: Int) -> List[Span] {
  match list {
    Cons(tail) if n > 0 -> drop(list: tail, n: n - 1)
    _ -> list
  }
}

fn merge(a: List[Span], b: List[Span], lo: Int, acc: List[Span]) -> List[Span] {
  match a {
    Nil -> reverse_onto(list: acc, acc: b)
    Cons(head: x, tail: xs) -> merge_b(x, xs, b, lo, acc)
  }
}

fn merge_b(x: Span, xs: List[Span], b: List[Span], lo: Int, acc: List[Span]) -> List[Span] {
  match b {
    Nil -> reverse_onto(list: acc, acc: Cons(head: x, tail: xs))
    Cons(head: y, tail: ys) if begin(s: y, lo) < begin(s: x, lo) -> merge(
      a: Cons(head: x, tail: xs),
      b: ys,
      lo,
      acc: Cons(head: y, tail: acc)
    )
    _ -> merge(a: xs, b, lo, acc: Cons(head: x, tail: acc))
  }
}

// ---------- counting ----------

fn summary(list: List[Span], acc: Acc) -> Summary {
  let traces = trace_ids(list, map: Empty)
  Summary(
    spans: acc.n,
    services: acc.services,
    errors: errors(list, n: 0),
    traces: count(map: traces),
    trace: only_key(map: traces),
    cut: service_cut(map: acc.colors)
  )
}

fn errors(list: List[Span], n: Int) -> Int {
  match list {
    Cons(head, tail) if head.code == 2 -> errors(list: tail, n: n + 1)
    Cons(tail) -> errors(list: tail, n)
    Nil -> n
  }
}

fn trace_ids(list: List[Span], map: Map[Bool]) -> Map[Bool] {
  match list {
    Cons(head, tail) if len(head.trace) > 0 -> trace_ids(
      list: tail,
      map: put(map, key: head.trace, value: True)
    )
    Cons(tail) -> trace_ids(list: tail, map)
    Nil -> map
  }
}

fn only_key(map: Map[Bool]) -> View {
  match map {
    Node(key) -> key
    Empty -> ""
  }
}

// How many bytes to leave off the front of every service name: the prefix they all share, up to and with its
// last "/" ("demo/" of demo/orders and demo/stock), when every name has something after it; else 0.
fn service_cut(map: Map[Int]) -> Int {
  match map {
    Node(key) -> cut_checked(cut: slash_end(v: key, at: common(map, first: key, n: len(key))), map)
    Empty -> 0
  }
}

fn cut_checked(cut: Int, map: Map[Int]) -> Int {
  match {
    shortest(map, n: cut + 1) > cut -> cut
    else -> 0
  }
}

// How long the prefix `first` shares with every key is (at most n).
fn common(map: Map[Int], first: View, n: Int) -> Int {
  match map {
    Node(left, key, right) -> common(
      map: left,
      first,
      n: common(map: right, first, n: shared(a: first, b: key, at: 0, n))
    )
    Empty -> n
  }
}

fn shared(a: View, b: View, at: Int, n: Int) -> Int {
  match {
    at < n and at < len(b) and a[at] == b[at] -> shared(a, b, at: at + 1, n)
    else -> at
  }
}

// After the last "/" before `at`, or 0.
fn slash_end(v: View, at: Int) -> Int {
  match {
    at <= 0 -> 0
    v[at - 1] == 47 -> at
    else -> slash_end(v, at: at - 1)
  }
}

// The length of the shortest key (at most n).
fn shortest(map: Map[Int], n: Int) -> Int {
  match map {
    Node(left, key, right) -> shortest(
      map: left,
      n: shortest(map: right, n: min(a: n, b: len(key)))
    )
    Empty -> n
  }
}

// A service name with the shared prefix left off.
fn write_service(out: Buf, name: View, cut: Int, n: Int) -> Buf {
  out |> write_short(text: slice(v: name, from: min(a: cut, b: len(name)), to: len(name)), n)
}

// What kinds of event the rows show (the first 100 of each span): 1 SQL, 2 a timer, 4 an error, 8 any other.
fn event_kinds(list: List[Frame], kinds: Int) -> Int {
  match list {
    Cons(head, tail) -> event_kinds(
      list: tail,
      kinds: pair_kinds(pair: head.pair, kinds: kinds_of(list: head.span.events, n: 0, kinds))
    )
    Nil -> kinds
  }
}

fn pair_kinds(pair: Option[Span], kinds: Int) -> Int {
  match pair {
    Some(value) -> kinds_of(list: value.events, n: 0, kinds)
    None -> kinds
  }
}

fn kinds_of(list: List[Ev], n: Int, kinds: Int) -> Int {
  match list {
    Cons(head, tail) if n < 100 -> kinds_of(
      list: tail,
      n: n + 1,
      kinds: with_bit(kinds, bit: ev_kind(ev: head))
    )
    _ -> kinds
  }
}

fn with_bit(kinds: Int, bit: Int) -> Int {
  match {
    kinds & bit > 0 -> kinds
    else -> kinds + bit
  }
}

// An event's mark: an SQL event whose first tape.sql.undone attribute is true is a write its run's rollback or trap
// undid (16, a dashed tick), a timer whose first tape.timer.undone is true a timer it undid (32, a dashed ring);
// otherwise by its name.
fn ev_kind(ev: Ev) -> Int {
  let k = kind_bit(name: ev.name)
  match {
    k == 1 and attr_named(list: ev.attrs, key: "tape.sql.undone") == "true" -> 16
    k == 2 and attr_named(list: ev.attrs, key: "tape.timer.undone") == "true" -> 32
    else -> k
  }
}

fn kind_bit(name: View) -> Int {
  match {
    bad_name(name) -> 4
    starts_with(v: name, prefix: "db.") -> 1
    name == "tape.timer.set" -> 2
    else -> 8
  }
}

fn bad_name(name: View) -> Bool {
  match name {
    "tape.span.missing" -> True
    "tape.run.rolled_back" -> True
    "tape.check.problem" -> True
    "db.prepare.failed" -> True
    "exception" -> True
    _ -> False
  }
}

// ---------- the picture ----------

// Across the page: the label column is the first 32% (an <svg> per row, so a long name is cut at its edge), the
// track runs from 33% to 98.5%, and inside it a position is in basis points of the track. Down the page, in
// pixels: the header, then rows 26 high from `top`.
fn svg(rows: List[Frame], nrows: Int, axis: Axis, lo: Int, acc: Acc, sum: Summary) -> Buf {
  let top = 100
  let rule = top - 1
  let bottom = top + 26 * nrows
  let opened = buf()
    |> append(view: "<svg xmlns=\"http://www.w3.org/2000/svg\" class=\"otlp-waterfall\" \
        width=\"100%\" height=\"\(bottom + 12)\" role=\"img\" aria-label=\"Trace waterfall: \
        \(sum.spans) spans\">")
  opened
    |> style
    |> background(height: bottom + 12)
    |> header(sum, axis, acc, rows)
    |> append(view: "<svg class=\"tc\" x=\"33%\" width=\"65.5%\" height=\"\(bottom)\" \
        overflow=\"visible\">")
    |> gap_bands(list: axis.gaps, axis, top, bottom)
    |> ticks(axis, segs: segments(list: axis.gaps, from: 0, d: axis.d), j: 0, top, bottom)
    |> append(
    view: "<line class=\"ax\" x1=\"0\" x2=\"100%\" y1=\"\(rule).5\" y2=\"\(rule).5\"/></svg>"
  )
    |> rows(list: rows, i: 0, top, axis, lo, cut: sum.cut)
    |> append(view: "<svg class=\"over\" x=\"33%\" width=\"65.5%\" height=\"\(bottom)\" \
        overflow=\"visible\">")
    |> gap_marks(list: axis.gaps, axis, top)
    |> append(view: "</svg>")
    |> append(view: "<svg class=\"lc gd\" y=\"\(top)\" width=\"32%\" height=\"\(bottom - top)\">")
    |> guides(list: rows, i: 0)
    |> append(view: "</svg></svg>\n")
}

fn style(out: Buf) -> Buf {
  out
    |> append(view: "<style>")
    |> append(view: ".otlp-waterfall{--_bg:var(--tr-bg,#fff);--_fg:var(--tr-fg,#18181b);--_mut:var(--tr-muted,#696972);--_grid:var(--tr-grid,#ededf0);--_hover:var(--tr-row-hover,#f4f4f6);--_err:var(--tr-error,#d92d20);--_s1:var(--tr-s1,#2563eb);--_s2:var(--tr-s2,#b45309);--_s3:var(--tr-s3,#0f766e);--_s4:var(--tr-s4,#7c3aed);--_s5:var(--tr-s5,#be185d);--_s6:var(--tr-s6,#0e7490);--_s7:var(--tr-s7,#4d7c0f);--_s8:var(--tr-s8,#71717a);--_ink:#fff;font-family:var(--tr-font,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);font-variant-numeric:tabular-nums}")
    |> append(view: "@media (prefers-color-scheme:dark){.otlp-waterfall:not([data-theme=light] \
        *):not([data-theme=light])")
    |> dark
    |> append(view: "}[data-theme=dark] .otlp-waterfall,.otlp-waterfall[data-theme=dark]")
    |> dark
    |> append(view: ".otlp-waterfall text{fill:var(--_fg);font-size:12.5px}.otlp-waterfall \
        .page{fill:var(--_bg)}.otlp-waterfall .h1{font-size:15px;font-weight:600}.otlp-waterfall \
        .st{font-size:12px;font-weight:600}.otlp-waterfall .ok{fill:var(--_mut)}.otlp-waterfall \
        .bad,.otlp-waterfall .errs{fill:var(--_err)}.otlp-waterfall .meta,.otlp-waterfall \
        .lg{font-size:12px;fill:var(--_mut)}.otlp-waterfall .meta \
        .v{fill:var(--_fg);font-weight:600}.otlp-waterfall \
        .mono{font-family:var(--tr-mono,ui-monospace,'SF \
        Mono',Menlo,Consolas,monospace);font-size:11.5px}.otlp-waterfall .tk,.otlp-waterfall \
        .dur,.otlp-waterfall .gapl{font-size:11px;fill:var(--_mut)}.otlp-waterfall \
        .svc,.otlp-waterfall .tag{font-size:11.5px;fill:var(--_mut)}.otlp-waterfall \
        .tag{font-style:italic}.otlp-waterfall .anon{fill:var(--_mut);font-style:italic}")
    |> append(view: ".otlp-waterfall .gl{stroke:var(--_grid);stroke-width:1}.otlp-waterfall \
        .ax{stroke:var(--_grid);stroke-width:1}.otlp-waterfall \
        .gap{fill:var(--_hover)}.otlp-waterfall \
        .brk{fill:none;stroke:var(--_mut);stroke-width:1.25}.otlp-waterfall .gd,.otlp-waterfall \
        .over{pointer-events:none}.otlp-waterfall .gd \
        path{fill:none;stroke:var(--_grid);stroke-width:1}.otlp-waterfall \
        .bg{fill:transparent}.otlp-waterfall .row{outline:none}.otlp-waterfall .row:hover \
        .bg,.otlp-waterfall .row:focus-visible .bg{fill:var(--_hover)}.otlp-waterfall \
        .row:focus-visible .bg{stroke:var(--_s1);stroke-width:2}.otlp-waterfall \
        .acc{fill:var(--_err)}")
    |> append(view: ".otlp-waterfall .c0{fill:var(--_s1);color:var(--_s1)}.otlp-waterfall \
        .c1{fill:var(--_s2);color:var(--_s2)}.otlp-waterfall \
        .c2{fill:var(--_s3);color:var(--_s3)}.otlp-waterfall \
        .c3{fill:var(--_s4);color:var(--_s4)}.otlp-waterfall \
        .c4{fill:var(--_s5);color:var(--_s5)}.otlp-waterfall \
        .c5{fill:var(--_s6);color:var(--_s6)}.otlp-waterfall \
        .c6{fill:var(--_s7);color:var(--_s7)}.otlp-waterfall \
        .c7{fill:var(--_s8);color:var(--_s8)}.otlp-waterfall \
        .bar.e{fill:var(--_err);color:var(--_err)}.otlp-waterfall \
        .env{fill-opacity:.2;stroke:currentColor;stroke-opacity:.55;stroke-width:1}.otlp-waterfall .orphan .bar,.otlp-waterfall .cycle .bar{stroke:var(--_fg);stroke-width:1;stroke-dasharray:3 2}.otlp-waterfall .err .dur,.otlp-waterfall .err .nm{fill:var(--_err)}.otlp-waterfall .dur.in{fill:var(--_ink);font-weight:600}.otlp-waterfall .err .dur.in{fill:var(--_ink)}")
    |> append(view: ".otlp-waterfall .ev{stroke:var(--_bg);stroke-width:1}.otlp-waterfall \
        .ev.q{stroke:var(--_fg);stroke-width:1.5}.otlp-waterfall \
        .ev.u{stroke:var(--_mut);stroke-width:1.5;stroke-dasharray:2 2}.otlp-waterfall \
        .ev.tu{fill:var(--_bg);stroke:var(--_mut);stroke-width:1.5;stroke-dasharray:2 \
        1.5}.otlp-waterfall \
        .ev.t{fill:var(--_bg);stroke:var(--_fg);stroke-width:1.5}.otlp-waterfall \
        .ev.o{fill:var(--_fg)}.otlp-waterfall .ev.x{fill:var(--_err)}.otlp-waterfall \
        .ev.out{opacity:.45}.otlp-waterfall .k-q{fill:var(--_fg);font-weight:700}.otlp-waterfall \
        .k-u{fill:var(--_mut);font-weight:700}.otlp-waterfall \
        .k-x{fill:var(--_err)}.otlp-waterfall .k-t,.otlp-waterfall \
        .k-o{fill:var(--_fg)}.otlp-waterfall .why{font-size:15px;font-weight:600}.otlp-waterfall \
        .warn{fill:var(--_s2)}@media (max-width:560px){.otlp-waterfall .odd,.otlp-waterfall \
        .tid,.otlp-waterfall .gapl,.otlp-waterfall .ek,.otlp-waterfall .lg \
        .v{display:none}}</style>")
}

fn dark(out: Buf) -> Buf {
  out
    |> append(view: "{--_bg:var(--tr-bg,#111114);--_fg:var(--tr-fg,#ececef);--_mut:var(--tr-muted,#a1a1aa);--_grid:var(--tr-grid,#26262b);--_hover:var(--tr-row-hover,#1d1d22);--_err:var(--tr-error,#f97066);--_s1:var(--tr-s1,#60a5fa);--_s2:var(--tr-s2,#fbbf24);--_s3:var(--tr-s3,#2dd4bf);--_s4:var(--tr-s4,#c4b5fd);--_s5:var(--tr-s5,#f472b6);--_s6:var(--tr-s6,#67e8f9);--_s7:var(--tr-s7,#a3e635);--_s8:var(--tr-s8,#a1a1aa);--_ink:#111114}")
}

fn background(out: Buf, height: Int) -> Buf {
  out |> append(view: "<rect class=\"page\" x=\"0\" y=\"0\" width=\"100%\" height=\"\(height)\"/>")
}

// What happened, first: the first row's name and how it answered; then how long the trace took, its spans,
// services and errors, and its id; then the services, by colour, and the kinds of event shown.
fn header(out: Buf, sum: Summary, axis: Axis, acc: Acc, rows: List[Frame]) -> Buf {
  match rows {
    Cons(head) -> out
      |> append(view: "<text class=\"h1\" x=\"12\" y=\"24\">")
      |> nonempty(text: head.span.name, n: 80, none: "(unnamed)")
      |> outcome(s: head.span)
      |> append(view: "</text>")
      |> meta(sum, axis)
      |> legend(acc, rows, sum, color: 0)
      |> append(view: "</text>")
    Nil -> out
  }
}

// How the first row answered: its HTTP status when it has one, else OK or Error.
fn outcome(out: Buf, s: Span) -> Buf {
  let code = attr_named(list: s.attrs, key: "http.response.status_code")
  let opened = out |> append(view: "<tspan class=\"st ") |> status_class(s, code)
  match {
    len(code) > 0 -> opened
      |> append(view: "\" dx=\"10\">")
      |> write_short(text: code, n: 12)
      |> append(view: "</tspan>")
    s.code == 2 -> opened |> append(view: "\" dx=\"10\">Error</tspan>")
    else -> opened |> append(view: "\" dx=\"10\">OK</tspan>")
  }
}

fn status_class(out: Buf, s: Span, code: View) -> Buf {
  match {
    s.code == 2 or starts_with(v: code, prefix: "5") -> out |> append(view: "bad")
    starts_with(v: code, prefix: "4") -> out |> append(view: "warn")
    else -> out |> append(view: "ok")
  }
}

// The value of the first attribute with this key, or "".
fn attr_named(list: List[Attr], key: View) -> View {
  match list {
    Cons(head: Attr(key: k, value), tail) if k == key -> value
    Cons(tail) -> attr_named(list: tail, key)
    Nil -> ""
  }
}

fn meta(out: Buf, sum: Summary, axis: Axis) -> Buf {
  out
    |> append(view: "<text class=\"meta\" x=\"12\" y=\"46\"><tspan class=\"v\">")
    |> write_dur(d: axis.t1 - axis.t0)
    |> append(view: "</tspan> · \(sum.spans) ")
    |> plural(n: sum.spans, one: "span", many: "spans")
    |> append(view: " · \(sum.services) ")
    |> plural(n: sum.services, one: "service", many: "services")
    |> error_count(n: sum.errors)
    |> trace_id(sum)
    |> append(view: "</text>")
}

fn trace_id(out: Buf, sum: Summary) -> Buf {
  match {
    sum.traces == 1 -> out
      |> append(view: "<tspan class=\"tid\"> · trace <tspan class=\"mono\">")
      |> write_short(text: sum.trace, n: 9)
      |> append(view: "</tspan><title>")
      |> write_short(text: sum.trace, n: 64)
      |> append(view: "</title></tspan>")
    sum.traces == 0 -> out
    else -> out |> append(view: " · \(sum.traces) traces")
  }
}

fn plural(out: Buf, n: Int, one: View, many: View) -> Buf {
  match {
    n == 1 -> append(buf: out, view: one)
    else -> append(buf: out, view: many)
  }
}

fn error_count(out: Buf, n: Int) -> Buf {
  match {
    n == 0 -> out
    n == 1 -> out |> append(view: " · <tspan class=\"errs\">1 error</tspan>")
    else -> out |> append(view: " · <tspan class=\"errs\">\(n) errors</tspan>")
  }
}

// The services in the order first seen: a swatch of its colour, its name, how many spans. Past seven, the rest
// share the last colour and are counted together. Then a key to the event marks the rows show.
fn legend(out: Buf, acc: Acc, rows: List[Frame], sum: Summary, color: Int) -> Buf {
  match {
    color == 0 -> legend(
      out: out |> append(view: "<text class=\"lg\" x=\"12\" y=\"68\">"),
      acc,
      rows,
      sum,
      color: 1
    )
    color > acc.services or color > 8 -> out
      |> append(view: "<tspan class=\"ek\" dx=\"18\">")
      |> event_key(kinds: event_kinds(list: rows, kinds: 0))
      |> append(view: "</tspan>")
    color == 8 and acc.services > 8 -> legend(
      out: out |> append(view: "<tspan class=\"c7\" dx=\"14\">■</tspan> \(acc.services - 7) more"),
      acc,
      rows,
      sum,
      color: 9
    )
    else -> legend(
      out: out
        |> append(view: "<tspan class=\"c\(color - 1)\"")
        |> swatch_gap(color)
        |> append(view: ">■</tspan> ")
        |> write_service(
        name: service_named(map: acc.colors, color: color - 1),
        cut: sum.cut,
        n: 32
      )
        |> append(view: " <tspan class=\"v\">")
        |> write_int(value: rows_spans(list: rows, color: color - 1, n: 0))
        |> append(view: "</tspan>"),
      acc,
      rows,
      sum,
      color: color + 1
    )
  }
}

fn swatch_gap(out: Buf, color: Int) -> Buf {
  match {
    color > 1 -> out |> append(view: " dx=\"14\"")
    else -> out
  }
}

fn event_key(out: Buf, kinds: Int) -> Buf {
  out
    |> key_part(on: kinds & 1, view: "<tspan class=\"k-q\">│</tspan> sql ")
    |> key_part(on: kinds & 16, view: "<tspan class=\"k-u\">┆</tspan> undone ")
    |> key_part(on: kinds & 2, view: "<tspan class=\"k-t\">○</tspan> timer ")
    |> key_part(on: kinds & 32, view: "<tspan class=\"k-u\">◌</tspan> timer undone ")
    |> key_part(on: kinds & 4, view: "<tspan class=\"k-x\">◆</tspan> error ")
    |> key_part(on: kinds & 8, view: "<tspan class=\"k-o\">•</tspan> event ")
}

fn key_part(out: Buf, on: Int, view: View) -> Buf {
  match {
    on > 0 -> out |> append(view)
    else -> out
  }
}

// How many spans of this colour the rows show (a call's row shows two).
fn rows_spans(list: List[Frame], color: Int, n: Int) -> Int {
  match list {
    Cons(head, tail) -> rows_spans(
      list: tail,
      color,
      n: n + same_color(s: head.span, color) + pair_color(pair: head.pair, color)
    )
    Nil -> n
  }
}

fn same_color(s: Span, color: Int) -> Int {
  match {
    s.color == color -> 1
    else -> 0
  }
}

fn pair_color(pair: Option[Span], color: Int) -> Int {
  match pair {
    Some(value) -> same_color(s: value, color)
    None -> 0
  }
}

// The service with this colour (the map is small: one entry per service).
fn service_named(map: Map[Int], color: Int) -> View {
  match map {
    Empty -> ""
    Node(left, key, value, right) -> named_in(
      here: key,
      found: value == color,
      left: service_named(map: left, color),
      right: service_named(map: right, color)
    )
  }
}

fn named_in(here: View, found: Bool, left: View, right: View) -> View {
  match {
    found -> here
    len(left) > 0 -> left
    else -> right
  }
}

// ---------- the axis ----------

// The stretches of time between the compressed gaps, as Gap(start, end).
fn segments(list: List[Gap], from: Int, d: Int) -> List[Gap] {
  match list {
    Cons(head, tail) -> Cons(
      head: Gap(a: from, b: head.a),
      tail: segments(list: tail, from: head.b, d)
    )
    Nil -> Cons(head: Gap(a: from, b: d), tail: Nil)
  }
}

// Each compressed gap: a band down the rows (under them), then, over them, a break on the axis and how long it
// was idle (so a row's hover does not hide it).
fn gap_bands(out: Buf, list: List[Gap], axis: Axis, top: Int, bottom: Int) -> Buf {
  match list {
    Cons(head: Gap(a, b), tail) -> gap_bands(
      out: out
        |> append(view: "<rect class=\"gap\" x=\"")
        |> write_bp(bp: x_of(t: a, axis))
        |> append(view: "\" y=\"\(top)\" width=\"8%\" height=\"\(bottom - top)\"/>"),
      list: tail,
      axis,
      top,
      bottom
    )
    Nil -> out
  }
}

fn gap_marks(out: Buf, list: List[Gap], axis: Axis, top: Int) -> Buf {
  match list {
    Cons(head: Gap(a, b), tail) -> gap_marks(
      out: out
        |> append(view: "<svg x=\"")
        |> write_bp(bp: x_of(t: a, axis) + 400)
        |> append(view: "\" overflow=\"visible\"><path class=\"brk\" d=\"M-6 \(top + 4)l4 -9M2 \
            \(top + 4)l4 -9\"/>")
        |> append(view: "<text class=\"gapl\" transform=\"rotate(-90)\" x=\"-\(top + 10)\" \
            y=\"4\" text-anchor=\"end\">")
        |> write_dur(d: b - a)
        |> append(view: " idle</text></svg>"),
      list: tail,
      axis,
      top
    )
    Nil -> out
  }
}

// Ticks in each stretch: in the first, at multiples of the step from 0, labelled with the time; in each one
// after a gap, at multiples of the step from its start (not the start itself), labelled "+" the time since it.
fn ticks(out: Buf, axis: Axis, segs: List[Gap], j: Int, top: Int, bottom: Int) -> Buf {
  match segs {
    Cons(head, tail) -> ticks(
      out: seg_ticks(
        out,
        axis,
        seg: head,
        m: min(a: j, b: 1),
        n: (head.b - head.a) / axis.step,
        j,
        top,
        bottom
      ),
      axis,
      segs: tail,
      j: j + 1,
      top,
      bottom
    )
    Nil -> out
  }
}

fn seg_ticks(out: Buf, axis: Axis, seg: Gap, m: Int, n: Int, j: Int, top: Int, bottom: Int) -> Buf {
  let x = x_of(t: seg.a + min(a: m, b: n) * axis.step, axis)
  match {
    m > n -> out
    else -> seg_ticks(
      out: out
        |> append(view: "<g class=\"tick")
        |> odd(hide: j > 0 or n >= 4 and m % 2 == 1)
        |> append(view: "\"><line class=\"gl\" x1=\"")
        |> write_bp(bp: x)
        |> append(view: "\" x2=\"")
        |> write_bp(bp: x)
        |> append(view: "\" y1=\"\(top)\" y2=\"\(bottom)\" shape-rendering=\"crispEdges\"/><text \
            class=\"tk\" x=\"")
        |> write_bp(bp: x)
        |> anchor(first: m == 0, bp: x)
        |> append(view: " y=\"\(top - 10)\">")
        |> tick_label(value: m * axis.step, axis, after: j > 0)
        |> append(view: "</text></g>"),
      axis,
      seg,
      m: m + 1,
      n,
      j,
      top,
      bottom
    )
  }
}

// Ticks hidden on a narrow screen: every other one when a stretch has four or more, and all of a stretch after a
// gap (its labels would crowd the gap's).
fn odd(out: Buf, hide: Bool) -> Buf {
  match {
    hide -> out |> append(view: " odd")
    else -> out
  }
}

fn anchor(out: Buf, first: Bool, bp: Int) -> Buf {
  match {
    first -> out |> append(view: "\" text-anchor=\"start\"")
    bp >= 9000 -> out |> append(view: "\" text-anchor=\"end\"")
    else -> out |> append(view: "\" text-anchor=\"middle\"")
  }
}

// A tick's time in the axis unit: whole, or with one decimal when it has a fraction (a step is at least a fifth
// of the unit, so one decimal is exact).
fn tick_label(out: Buf, value: Int, axis: Axis, after: Bool) -> Buf {
  let signed = plus(out, after)
  match {
    value == 0 -> signed |> append(view: "0")
    value % axis.unit == 0 -> signed
      |> write_int(value: value / axis.unit)
      |> append(view: " \(unit_name(unit: axis.unit))")
    else -> signed
      |> write_int(value: value / axis.unit)
      |> append(view: ".")
      |> write_int(value: (value % axis.unit) / (axis.unit / 10))
      |> append(view: " \(unit_name(unit: axis.unit))")
  }
}

fn plus(out: Buf, after: Bool) -> Buf {
  match {
    after -> out |> append(view: "+")
    else -> out
  }
}

// A position on the track, as a percentage with two decimals.
fn write_bp(out: Buf, bp: Int) -> Buf {
  let whole = out |> write_int(value: bp / 100) |> append(view: ".")
  match {
    bp % 100 < 10 -> whole |> append(view: "0") |> write_int(value: bp % 100) |> append(view: "%")
    else -> whole |> write_int(value: bp % 100) |> append(view: "%")
  }
}

// A duration, to three significant digits with no trailing zeros: 812 ns, 4.2 µs, 13.5 ms, 2 s, 1234 s.
fn write_dur(out: Buf, d: Int) -> Buf {
  match {
    d < 1000 -> out |> write_int(value: d) |> append(view: " ns")
    d < 1000000 -> in_unit(out, d, unit: 1000)
    d < 1000000000 -> in_unit(out, d, unit: 1000000)
    else -> in_unit(out, d, unit: 1000000000)
  }
}

fn in_unit(out: Buf, d: Int, unit: Int) -> Buf {
  let hundredths = rounded(d, by: unit / 100)
  let tenths = rounded(d, by: unit / 10)
  let whole = rounded(d, by: unit)
  match {
    hundredths < 1000 -> out
      |> decimals(n: hundredths, places: 2)
      |> append(view: " \(unit_name(unit))")
    tenths < 1000 -> out |> decimals(n: tenths, places: 1) |> append(view: " \(unit_name(unit))")
    whole < 1000 or unit == 1000000000 -> out
      |> write_int(value: whole)
      |> append(view: " \(unit_name(unit))")
    else -> in_unit(out, d, unit: unit * 1000)
  }
}

// n hundredths (places 2) or tenths (places 1), without trailing zeros.
fn decimals(out: Buf, n: Int, places: Int) -> Buf {
  match {
    places == 2 and n % 10 > 0 -> out
      |> write_int(value: n / 100)
      |> append(view: ".")
      |> two_digits(n: n % 100)
    places == 2 -> decimals(out, n: n / 10, places: 1)
    n % 10 > 0 -> out |> write_int(value: n / 10) |> append(view: ".") |> write_int(value: n % 10)
    else -> out |> write_int(value: n / 10)
  }
}

// d / by, rounded half up, without adding to d (which may be near the largest Int).
fn rounded(d: Int, by: Int) -> Int {
  match {
    (d % by) * 2 >= by -> d / by + 1
    else -> d / by
  }
}

fn two_digits(out: Buf, n: Int) -> Buf {
  match {
    n < 10 -> out |> append(view: "0") |> write_int(value: n)
    else -> out |> write_int(value: n)
  }
}

// ---------- rows ----------

fn rows(out: Buf, list: List[Frame], i: Int, top: Int, axis: Axis, lo: Int, cut: Int) -> Buf {
  match list {
    Cons(head, tail) -> rows(
      out: row(out, f: head, y: top + 26 * i, axis, lo, cut),
      list: tail,
      i: i + 1,
      top,
      axis,
      lo,
      cut
    )
    Nil -> out
  }
}

// A row: a <g> that takes the focus, with the span's tooltip; the label in its column; in the track, the bar (a
// call's row: the client span as a pale envelope, the server span solid inside it, so the time between is the
// network and the queue), the event marks and the duration.
fn row(out: Buf, f: Frame, y: Int, axis: Axis, lo: Int, cut: Int) -> Buf {
  let s = f.span
  let b = begin(s, lo)
  let e = finish(s, lo)
  let x = x_of(t: b - axis.t0, axis)
  let xe = x_of(t: e - axis.t0, axis)
  out
    |> append(view: "<g class=\"row")
    |> row_classes(f)
    |> append(view: "\" tabindex=\"0\" data-idx=\"\(s.idx)\"")
    |> pair_idx(pair: f.pair)
    |> append(view: " data-id=\"")
    |> write_short(text: s.id, n: 64)
    |> append(view: "\" data-depth=\"\(f.depth)\"><title>")
    |> tooltip(s, mark: f.mark, b, e, axis)
    |> append(view: "</title><rect class=\"bg\" x=\"0\" y=\"\(y)\" width=\"100%\" height=\"26\"/>")
    |> accent(f, y)
    |> label(f, y, cut)
    |> append(view: "<svg class=\"tc\" x=\"33%\" y=\"\(y)\" width=\"65.5%\" height=\"26\" \
        overflow=\"visible\">")
    |> bars(f, x, xe, axis, lo)
    |> markers(list: s.events, n: 0, b, e, axis)
    |> pair_markers(pair: f.pair, axis, lo)
    |> duration(
    x,
    xe,
    d: e - b,
    after: room(list: axis.gaps, edge: xe, after: True, axis),
    before: room(list: axis.gaps, edge: x, after: False, axis)
  )
    |> append(view: "</svg></g>")
}

fn row_classes(out: Buf, f: Frame) -> Buf {
  out
    |> error_class(on: f.span.code == 2 or pair_code(pair: f.pair) == 2)
    |> mark_class(mark: f.mark)
}

fn pair_code(pair: Option[Span]) -> Int {
  match pair {
    Some(value) -> value.code
    None -> 0
  }
}

fn error_class(out: Buf, on: Bool) -> Buf {
  match {
    on -> out |> append(view: " err")
    else -> out
  }
}

fn mark_class(out: Buf, mark: Int) -> Buf {
  match mark {
    1 -> out |> append(view: " orphan")
    2 -> out |> append(view: " cycle")
    _ -> out
  }
}

fn pair_idx(out: Buf, pair: Option[Span]) -> Buf {
  match pair {
    Some(value) -> out |> append(view: " data-pair=\"\(value.idx)\"")
    None -> out
  }
}

// A red edge on a row with an error.
fn accent(out: Buf, f: Frame, y: Int) -> Buf {
  match {
    f.span.code == 2 or pair_code(pair: f.pair) == 2 -> out
      |> append(
      view: "<rect class=\"acc\" x=\"0\" y=\"\(y + 3)\" width=\"3\" height=\"20\" rx=\"1.5\"/>"
    )
    else -> out
  }
}

// The service a row is shown as: the callee's for a call's row.
fn shown_span(f: Frame) -> Span {
  match f.pair {
    Some(value) -> value
    None -> f.span
  }
}

// The label: indented 14 px a level (to twelve levels; deeper rows say their depth), a swatch of the service's
// colour, the name, and the service when it is not the one of the row above it in the tree.
fn label(out: Buf, f: Frame, y: Int, cut: Int) -> Buf {
  let ind = 12 + 14 * min(a: f.depth, b: 12)
  let shown = shown_span(f)
  out
    |> append(view: "<svg class=\"lc\" y=\"\(y)\" width=\"32%\" height=\"26\"><rect class=\"sw c")
    |> write_int(value: min(a: shown.color, b: 7))
    |> append(view: "\" x=\"\(ind)\" y=\"9\" width=\"8\" height=\"8\" rx=\"2\"/>")
    |> append(view: "<text class=\"nm\" x=\"\(ind + 14)\" y=\"17\">")
    |> deep(depth: f.depth)
    |> span_name(name: f.span.name)
    |> service_tag(s: shown, above: f.above, cut)
    |> mark_tag(mark: f.mark)
    |> append(view: "</text></svg>")
}

fn deep(out: Buf, depth: Int) -> Buf {
  match {
    depth > 12 -> out |> append(view: "<tspan class=\"tag\">\(depth) ▸ </tspan>")
    else -> out
  }
}

fn span_name(out: Buf, name: View) -> Buf {
  match {
    len(name) == 0 -> out |> append(view: "<tspan class=\"anon\">(unnamed)</tspan>")
    else -> out |> write_short(text: name, n: 80)
  }
}

fn service_tag(out: Buf, s: Span, above: View, cut: Int) -> Buf {
  match {
    s.service == above -> out
    else -> out
      |> append(view: "<tspan class=\"svc\" dx=\"4\"> ")
      |> write_service(name: s.service, cut, n: 40)
      |> append(view: "</tspan>")
  }
}

fn mark_tag(out: Buf, mark: Int) -> Buf {
  match mark {
    1 -> out |> append(view: "<tspan class=\"tag\" dx=\"4\"> orphan</tspan>")
    2 -> out |> append(view: "<tspan class=\"tag\" dx=\"4\"> cycle</tspan>")
    _ -> out
  }
}

fn bars(out: Buf, f: Frame, x: Int, xe: Int, axis: Axis, lo: Int) -> Buf {
  match f.pair {
    None -> out |> bar(s: f.span, x, xe, env: "", rest: "\" y=\"7\" height=\"12\" rx=\"2\"/>")
    Some(value) -> out
      |> bar(s: f.span, x, xe, env: " env", rest: "\" y=\"4\" height=\"18\" rx=\"3\"/>")
      |> server_bar(s: value, axis, lo)
  }
}

// A bar, at least 0.30% of the track wide, so a span with no duration is still seen.
fn bar(out: Buf, s: Span, x: Int, xe: Int, env: View, rest: View) -> Buf {
  out
    |> append(view: "<rect class=\"bar c\(min(a: s.color, b: 7))")
    |> bar_error(s)
    |> append(view: env)
    |> append(view: "\" data-idx=\"\(s.idx)\" x=\"")
    |> write_bp(bp: x)
    |> append(view: "\" width=\"")
    |> write_bp(bp: max(a: xe - x, b: 30))
    |> append(view: rest)
}

fn bar_error(out: Buf, s: Span) -> Buf {
  match {
    s.code == 2 -> out |> append(view: " e")
    else -> out
  }
}

// The callee's span, inside the call's envelope, with its own tooltip.
fn server_bar(out: Buf, s: Span, axis: Axis, lo: Int) -> Buf {
  let b = begin(s, lo)
  let e = finish(s, lo)
  let x = x_of(t: b - axis.t0, axis)
  out
    |> append(view: "<rect class=\"bar c\(min(a: s.color, b: 7))")
    |> bar_error(s)
    |> append(view: "\" data-idx=\"\(s.idx)\" x=\"")
    |> write_bp(bp: x)
    |> append(view: "\" width=\"")
    |> write_bp(bp: max(a: x_of(t: e - axis.t0, axis) - x, b: 30))
    |> append(view: "\" y=\"8\" height=\"10\" rx=\"2\"><title>")
    |> tooltip(s, mark: 0, b, e, axis)
    |> append(view: "</title></rect>")
}

fn pair_markers(out: Buf, pair: Option[Span], axis: Axis, lo: Int) -> Buf {
  match pair {
    Some(value) -> out
      |> markers(list: value.events, n: 0, b: begin(s: value, lo), e: finish(s: value, lo), axis)
    None -> out
  }
}

// Whether there is room for a duration label beside a bar's edge: not when a compressed gap starts within 15%
// of the track after its end, or ends within 15% before its start (the label would run into the gap's band).
fn room(list: List[Gap], edge: Int, after: Bool, axis: Axis) -> Bool {
  match list {
    Cons(head, tail) -> clear(
      at: gap_side(gap: head, after, axis) - edge,
      after
    ) and room(list: tail, edge, after, axis)
    Nil -> True
  }
}

fn gap_side(gap: Gap, after: Bool, axis: Axis) -> Int {
  match {
    after -> x_of(t: gap.a, axis)
    else -> x_of(t: gap.b, axis)
  }
}

fn clear(at: Int, after: Bool) -> Bool {
  match {
    after -> at < 0 or at >= 1500
    else -> at > 0 or at <= -1500
  }
}

// The duration beside the bar: after it when it ends before 78% of the track and there is room, else before it
// when it starts after 22% and there is room, else inside it when it is wide enough to hold it, else after it, or
// before it when it ends past 88%.
fn duration(out: Buf, x: Int, xe: Int, d: Int, after: Bool, before: Bool) -> Buf {
  match {
    xe <= 7800 and after -> out
      |> append(view: "<text class=\"dur\" x=\"")
      |> write_bp(bp: max(a: xe, b: x + 30))
      |> append(view: "\" dx=\"6\" y=\"17\">")
      |> write_dur(d)
      |> append(view: "</text>")
    x >= 2200 and before -> out
      |> append(view: "<text class=\"dur\" x=\"")
      |> write_bp(bp: x)
      |> append(view: "\" dx=\"-6\" text-anchor=\"end\" y=\"17\">")
      |> write_dur(d)
      |> append(view: "</text>")
    xe - x >= 1800 -> out
      |> append(view: "<text class=\"dur in\" x=\"")
      |> write_bp(bp: xe)
      |> append(view: "\" dx=\"-6\" text-anchor=\"end\" y=\"17\">")
      |> write_dur(d)
      |> append(view: "</text>")
    xe <= 8800 -> out
      |> append(view: "<text class=\"dur\" x=\"")
      |> write_bp(bp: max(a: xe, b: x + 30))
      |> append(view: "\" dx=\"6\" y=\"17\">")
      |> write_dur(d)
      |> append(view: "</text>")
    else -> out
      |> append(view: "<text class=\"dur\" x=\"")
      |> write_bp(bp: x)
      |> append(view: "\" dx=\"-6\" text-anchor=\"end\" y=\"17\">")
      |> write_dur(d)
      |> append(view: "</text>")
  }
}

// A mark for each event, to 100, at its time (kept to the axis; an unreadable time is the span's start). Its
// shape says its kind: a tick for SQL and a ring for a timer (each dashed when its run undid it), a red diamond for
// an error, a dot for anything else.
// An event whose time is outside its span's is drawn faint and says so.
fn markers(out: Buf, list: List[Ev], n: Int, b: Int, e: Int, axis: Axis) -> Buf {
  match list {
    Cons(head, tail) if n < 100 -> markers(
      out: marker(out, ev: head, b, e, axis),
      list: tail,
      n: n + 1,
      b,
      e,
      axis
    )
    _ -> out
  }
}

// When an event is, after t0: its time, kept to the axis, or the span's start when its time is unreadable.
fn event_time(ev: Ev, b: Int, axis: Axis) -> Int {
  match {
    ev.time < 0 -> b - axis.t0
    else -> max(a: 0, b: min(a: ev.time - axis.t0, b: axis.d))
  }
}

fn outside(ev: Ev, b: Int, e: Int) -> Bool {
  ev.time >= 0 and (ev.time < b or ev.time > e)
}

fn marker(out: Buf, ev: Ev, b: Int, e: Int, axis: Axis) -> Buf {
  let t = event_time(ev, b, axis)
  let x = x_of(t, axis)
  let kind = ev_kind(ev)
  let out_of = outside(ev, b, e)
  match {
    kind == 1 or kind == 16 -> out
      |> append(view: "<line class=\"ev ")
      |> tick_kind(kind)
      |> out_class(on: out_of)
      |> append(view: "\" x1=\"")
      |> write_bp(bp: x)
      |> append(view: "\" x2=\"")
      |> write_bp(bp: x)
      |> append(view: "\" y1=\"5\" y2=\"21\"><title>")
      |> event_title(ev, t, b: b - axis.t0, out_of)
      |> append(view: "</title></line>")
    kind == 4 -> out
      |> append(view: "<svg class=\"ev x")
      |> out_class(on: out_of)
      |> append(view: "\" x=\"")
      |> write_bp(bp: x)
      |> append(view: "\" overflow=\"visible\"><title>")
      |> event_title(ev, t, b: b - axis.t0, out_of)
      |> append(view: "</title><path d=\"M0 7.5 5.5 13 0 18.5-5.5 13Z\"/></svg>")
    else -> out
      |> append(view: "<circle class=\"ev ")
      |> circle_kind(kind)
      |> out_class(on: out_of)
      |> append(view: "\" cx=\"")
      |> write_bp(bp: x)
      |> circle_size(kind)
      |> event_title(ev, t, b: b - axis.t0, out_of)
      |> append(view: "</title></circle>")
  }
}

fn tick_kind(out: Buf, kind: Int) -> Buf {
  match {
    kind == 16 -> out |> append(view: "u")
    else -> out |> append(view: "q")
  }
}

fn circle_kind(out: Buf, kind: Int) -> Buf {
  match {
    kind == 2 -> out |> append(view: "t")
    kind == 32 -> out |> append(view: "tu")
    else -> out |> append(view: "o")
  }
}

fn circle_size(out: Buf, kind: Int) -> Buf {
  match {
    kind == 2 or kind == 32 -> out |> append(view: "\" cy=\"13\" r=\"3.5\"><title>")
    else -> out |> append(view: "\" cy=\"13\" r=\"2.5\"><title>")
  }
}

fn out_class(out: Buf, on: Bool) -> Buf {
  match {
    on -> out |> append(view: " out")
    else -> out
  }
}

fn event_title(out: Buf, ev: Ev, t: Int, b: Int, out_of: Bool) -> Buf {
  out
    |> nonempty(text: ev.name, n: 120, none: "(unnamed event)")
    |> append(view: "\n")
    |> offset(d: t - b, after: " after the span starts")
    |> outside_line(on: out_of)
    |> attr_lines(list: ev.attrs, n: 0, most: 12)
}

fn outside_line(out: Buf, on: Bool) -> Buf {
  match {
    on -> out |> append(view: "\noutside the span's time")
    else -> out
  }
}

fn offset(out: Buf, d: Int, after: View) -> Buf {
  match {
    d < 0 -> out
      |> write_dur(d: 0 - d)
      |> append(view: " before")
      |> append(view: slice(v: after, from: 6, to: len(after)))
    else -> out |> write_dur(d) |> append(view: after)
  }
}

fn nonempty(out: Buf, text: View, n: Int, none: View) -> Buf {
  match {
    len(text) == 0 -> out |> append(view: none)
    else -> out |> write_short(text, n)
  }
}

// The elbows of the tree, over the label column: from under the parent's swatch down to this row and across.
fn guides(out: Buf, list: List[Frame], i: Int) -> Buf {
  match list {
    Cons(head, tail) -> guides(out: guide(out, f: head, i), list: tail, i: i + 1)
    Nil -> out
  }
}

fn guide(out: Buf, f: Frame, i: Int) -> Buf {
  let px = 16 + 14 * (f.depth - 1)
  match {
    f.prow < 0 or f.depth > 12 -> out
    else -> out
      |> append(view: "<path d=\"M\(px).5 \(26 * f.prow + 19)V\(26 * i + 13).5H\(px + 10)\"/>")
  }
}

// ---------- tooltips ----------

fn tooltip(out: Buf, s: Span, mark: Int, b: Int, e: Int, axis: Axis) -> Buf {
  out
    |> nonempty(text: s.name, n: 200, none: "(unnamed)")
    |> append(view: "\n")
    |> write_short(text: s.service, n: 80)
    |> append(view: " · ")
    |> append(view: kind_name(kind: s.kind))
    |> append(view: " · ")
    |> write_dur(d: e - b)
    |> append(view: "\nstarts ")
    |> write_dur(d: b - axis.t0)
    |> append(view: " into the trace\nspan ")
    |> nonempty(text: s.id, n: 64, none: "(no id)")
    |> parent_line(s)
    |> status_line(s)
    |> mark_line(mark)
    |> times_line(s)
    |> attr_lines(list: s.attrs, n: 0, most: 24)
    |> event_count(n: length(list: s.events))
}

fn kind_name(kind: Int) -> View {
  match kind {
    1 -> "internal"
    2 -> "server"
    3 -> "client"
    4 -> "producer"
    5 -> "consumer"
    _ -> "unspecified kind"
  }
}

fn parent_line(out: Buf, s: Span) -> Buf {
  match {
    len(s.parent) == 0 -> out
    else -> out |> append(view: " · parent ") |> write_short(text: s.parent, n: 64)
  }
}

fn status_line(out: Buf, s: Span) -> Buf {
  match {
    s.code == 2 and len(s.message) > 0 -> out
      |> append(view: "\nerror: ")
      |> write_short(text: s.message, n: 300)
    s.code == 2 -> out |> append(view: "\nerror")
    else -> out
  }
}

fn mark_line(out: Buf, mark: Int) -> Buf {
  match mark {
    1 -> out |> append(view: "\norphan: its parent is not in this trace")
    2 -> out |> append(view: "\ncycle: its parents lead back to it, so it is shown at the top")
    _ -> out
  }
}

fn times_line(out: Buf, s: Span) -> Buf {
  match {
    s.start < 0 and s.end < 0 -> out |> append(view: "\nno readable start or end time")
    s.start < 0 -> out |> append(view: "\nno readable start time")
    s.end < 0 -> out |> append(view: "\nno readable end time")
    s.end < s.start -> out |> append(view: "\nit ends before it starts")
    else -> out
  }
}

fn attr_lines(out: Buf, list: List[Attr], n: Int, most: Int) -> Buf {
  match list {
    Cons(head: Attr(key, value), tail) if n < most -> attr_lines(
      out: out
        |> append(view: "\n")
        |> write_short(text: key, n: 80)
        |> append(view: " = ")
        |> write_short(text: value, n: 160),
      list: tail,
      n: n + 1,
      most
    )
    Cons -> out
      |> append(view: "\n… and ")
      |> write_int(value: length(list))
      |> append(view: " more")
    Nil -> out
  }
}

fn event_count(out: Buf, n: Int) -> Buf {
  match {
    n == 0 -> out
    n == 1 -> out |> append(view: "\n1 event")
    else -> out |> append(view: "\n\(n) events")
  }
}

// ---------- text into XML ----------

// How many characters (code points) v has from `at`.
fn chars(v: View, at: Int, n: Int) -> Int {
  match {
    at >= len(v) -> n
    (v[at] & 192) == 128 -> chars(v, at: at + 1, n)
    else -> chars(v, at: at + 1, n: n + 1)
  }
}

// Where the n-th character from `at` starts (len(v) when there are fewer).
fn char_at(v: View, at: Int, n: Int) -> Int {
  match {
    at >= len(v) -> at
    (v[at] & 192) == 128 -> char_at(v, at: at + 1, n)
    n == 0 -> at
    else -> char_at(v, at: at + 1, n: n - 1)
  }
}

// Text, to n characters: past that, its first n - 1 and an ellipsis.
fn write_short(out: Buf, text: View, n: Int) -> Buf {
  match {
    chars(v: text, at: 0, n: 0) <= n -> write_xml(out, v: text, at: 0, to: len(text))
    else -> write_xml(out, v: text, at: 0, to: char_at(v: text, at: 0, n: n - 1))
      |> append(view: "…")
  }
}

// Text as XML character data or attribute text: & < > " ' as references; tab, line feed and carriage return as
// spaces; any other control character, and U+FFFE and U+FFFF (which XML does not allow), as U+FFFD.
fn write_xml(out: Buf, v: View, at: Int, to: Int) -> Buf {
  match {
    at >= to -> out
    v[at] == 38 -> write_xml(out: append(buf: out, view: "&amp;"), v, at: at + 1, to)
    v[at] == 60 -> write_xml(out: append(buf: out, view: "&lt;"), v, at: at + 1, to)
    v[at] == 62 -> write_xml(out: append(buf: out, view: "&gt;"), v, at: at + 1, to)
    v[at] == 34 -> write_xml(out: append(buf: out, view: "&quot;"), v, at: at + 1, to)
    v[at] == 39 -> write_xml(out: append(buf: out, view: "&#39;"), v, at: at + 1, to)
    v[at] == 9 or v[at] == 10 or v[at] == 13 -> write_xml(
      out: push(buf: out, byte: 32),
      v,
      at: at + 1,
      to
    )
    v[at] < 32 -> write_xml(out: append(buf: out, view: "�"), v, at: at + 1, to)
    v[at] == 239 and at + 2 < to and v[at + 1] == 191 and (
      v[at + 2] == 190 or v[at + 2] == 191
    ) -> write_xml(
      out: append(buf: out, view: "�"),
      v,
      at: at + 3,
      to
    )
    else -> write_xml(out: push(buf: out, byte: v[at]), v, at: at + 1, to)
  }
}

// ---------- when the trace cannot be drawn ----------

fn problem(why: View, detail: View, raw: View, at: Int) -> Buf {
  buf()
    |> append(view: "<svg xmlns=\"http://www.w3.org/2000/svg\" class=\"otlp-waterfall problem\" \
        width=\"100%\" height=\"104\" role=\"img\" aria-label=\"")
    |> write_xml(v: why, at: 0, to: len(why))
    |> append(view: "\">")
    |> style
    |> background(height: 104)
    |> append(view: "<text class=\"why\" x=\"12\" y=\"32\">")
    |> write_xml(v: why, at: 0, to: len(why))
    |> append(view: "</text><text class=\"meta\" x=\"12\" y=\"56\">")
    |> write_xml(v: detail, at: 0, to: len(detail))
    |> append(view: "</text>")
    |> near(raw, at)
    |> append(view: "</svg>\n")
}

// The bytes around where it stopped, so the reader can find the place.
fn near(out: Buf, raw: View, at: Int) -> Buf {
  match {
    at < 0 or len(raw) == 0 -> out
    else -> out
      |> append(view: "<text class=\"meta\" x=\"12\" y=\"80\"><tspan class=\"v\">near: </tspan>")
      |> write_short(
      text: valid_slice(v: raw, from: max(a: 0, b: at - 24), to: min(a: len(raw), b: at + 24)),
      n: 48
    )
      |> append(view: "</text>")
  }
}

// The bytes from..to, narrowed to whole UTF-8 characters, and to nothing if they are not UTF-8.
fn valid_slice(v: View, from: Int, to: Int) -> View {
  let a = char_at(v, at: from, n: 0)
  let s = slice(v, from: a, to: max(a, b: back(v, at: to)))
  match {
    utf8_ok(v: s, at: 0) -> s
    else -> ""
  }
}

fn back(v: View, at: Int) -> Int {
  match {
    at < len(v) and at > 0 and (v[at] & 192) == 128 -> back(v, at: at - 1)
    else -> at
  }
}

fn utf8_ok(v: View, at: Int) -> Bool {
  match {
    at >= len(v) -> True
    v[at] < 128 -> utf8_ok(v, at: at + 1)
    else -> utf8_next(v, found: utf8_at(v, at))
  }
}

fn utf8_next(v: View, found: Utf8) -> Bool {
  match found {
    Utf8(next) -> utf8_ok(v, at: next)
    BadUtf8 -> False
  }
}
