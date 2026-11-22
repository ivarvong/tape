// std/json.tape: JSON (RFC 8259), read by stepping and written by appending.
//
// Reading an object:   json_first(v) gives the first step, json_next(v, at) the step after a member:
//   Member(key, value, next)   one member; key is decoded; value is a Json; next is where to continue
//   Close(next)                the object ended at next
//   Malformed                  not JSON
// Strings must be valid UTF-8 and well-formed Unicode: a lone surrogate escape is Malformed.
// A repeated key is reported again; the caller decides (JSON.parse keeps the last).

type Json {
  JsonString(text: View)
  JsonBool(value: Bool)
  JsonOther
}

type JsonStep {
  Member(key: View, value: Json, next: Int)
  Close(next: Int)
  Malformed
}

type JsonValue {
  JsonValue(json: Json, next: Int)
  BadValue
}

type JsonText {
  JsonText(text: View, next: Int)
  BadText
}

// One character of a string body.
type JsonChar {
  Char(code: Int, next: Int, escaped: Bool)
  Quote(next: Int)
  BadChar
}

// The first step of the object that v holds (whitespace around it allowed).
fn json_first(v: View) -> JsonStep {
  let at = json_ws(v, at: 0)
  match {
    at < len(v) and v[at] == 123 -> first_member(v, at: at + 1)
    else -> Malformed
  }
}

// The step after a member whose `next` was `at`.
fn json_next(v: View, at: Int) -> JsonStep {
  let s = json_ws(v, at)
  match {
    s >= len(v) -> Malformed
    v[s] == 125 -> Close(next: s + 1)
    v[s] == 44 -> member(v, at: json_ws(v, at: s + 1))
    else -> Malformed
  }
}

// Does only whitespace follow position `at`?
fn json_end(v: View, at: Int) -> Bool {
  json_ws(v, at) == len(v)
}

fn json_ws(v: View, at: Int) -> Int {
  match {
    at < len(v) and (
      v[at] == 32 or v[at] == 10 or v[at] == 13 or v[at] == 9
    ) -> json_ws(v, at: at + 1)
    else -> at
  }
}

fn first_member(v: View, at: Int) -> JsonStep {
  let s = json_ws(v, at)
  match {
    s < len(v) and v[s] == 125 -> Close(next: s + 1)
    else -> member(v, at: s)
  }
}

fn member(v: View, at: Int) -> JsonStep {
  match {
    at < len(v) and v[at] == 34 -> member_key(v, key: json_text(v, at: at + 1))
    else -> Malformed
  }
}

fn member_key(v: View, key: JsonText) -> JsonStep {
  match key {
    JsonText(text, next) -> member_colon(v, key: text, at: json_ws(v, at: next))
    BadText -> Malformed
  }
}

fn member_colon(v: View, key: View, at: Int) -> JsonStep {
  match {
    at < len(v) and v[at] == 58 -> member_value(
      key,
      value: json_value(v, at: json_ws(v, at: at + 1))
    )
    else -> Malformed
  }
}

fn member_value(key: View, value: JsonValue) -> JsonStep {
  match value {
    JsonValue(json, next) -> Member(key, value: json, next)
    BadValue -> Malformed
  }
}

// The value that starts at `at`.
fn json_value(v: View, at: Int) -> JsonValue {
  match {
    at >= len(v) -> BadValue
    v[at] == 34 -> string_value(found: json_text(v, at: at + 1))
    v[at] == 123 -> other(end: object_end(v, step: first_member(v, at: at + 1)))
    v[at] == 91 -> other(end: array_end(v, at: json_ws(v, at: at + 1)))
    has(v, at, word: "true") -> JsonValue(json: JsonBool(True), next: at + 4)
    has(v, at, word: "false") -> JsonValue(json: JsonBool(False), next: at + 5)
    has(v, at, word: "null") -> JsonValue(json: JsonOther, next: at + 4)
    else -> other(end: number_end(v, at))
  }
}

fn string_value(found: JsonText) -> JsonValue {
  match found {
    JsonText(text, next) -> JsonValue(json: JsonString(text), next)
    BadText -> BadValue
  }
}

fn other(end: Option[Int]) -> JsonValue {
  match end {
    Some(value) -> JsonValue(json: JsonOther, next: value)
    None -> BadValue
  }
}

fn object_end(v: View, step: JsonStep) -> Option[Int] {
  match step {
    Member(next) -> object_end(v, step: json_next(v, at: next))
    Close(next) -> Some(next)
    Malformed -> None
  }
}

// `at` is the first non-space position after `[`.
fn array_end(v: View, at: Int) -> Option[Int] {
  match {
    at < len(v) and v[at] == 93 -> Some(at + 1)
    else -> element(v, value: json_value(v, at))
  }
}

fn element(v: View, value: JsonValue) -> Option[Int] {
  match value {
    JsonValue(next) -> element_end(v, at: json_ws(v, at: next))
    BadValue -> None
  }
}

fn element_end(v: View, at: Int) -> Option[Int] {
  match {
    at >= len(v) -> None
    v[at] == 93 -> Some(at + 1)
    v[at] == 44 -> element(v, value: json_value(v, at: json_ws(v, at: at + 1)))
    else -> None
  }
}

// -? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?
fn number_end(v: View, at: Int) -> Option[Int] {
  let i = skip(v, at, byte: 45)
  let d = digits_end(v, at: i)
  match {
    d == i -> None
    v[i] == 48 and d > i + 1 -> None
    d < len(v) and v[d] == 46 -> fraction_end(v, at: d + 1)
    else -> exponent_end(v, at: d)
  }
}

fn fraction_end(v: View, at: Int) -> Option[Int] {
  let d = digits_end(v, at)
  match {
    d == at -> None
    else -> exponent_end(v, at: d)
  }
}

fn exponent_end(v: View, at: Int) -> Option[Int] {
  let i = skip(v, at: skip(v, at: at + 1, byte: 43), byte: 45)
  let d = digits_end(v, at: i)
  match {
    at >= len(v) or (v[at] != 101 and v[at] != 69) -> Some(at)
    i > at + 2 or d == i -> None
    else -> Some(d)
  }
}

// at + 1 when v[at] is `byte`, else at.
fn skip(v: View, at: Int, byte: Int) -> Int {
  match {
    at < len(v) and v[at] == byte -> at + 1
    else -> at
  }
}

// The string whose body starts at `at` (after the opening quote), decoded. A string without escapes is returned
// as a view of the input; one with escapes is decoded into new memory.
fn json_text(v: View, at: Int) -> JsonText {
  text_end(v, from: at, at, clean: True)
}

fn text_end(v: View, from: Int, at: Int, clean: Bool) -> JsonText {
  match json_char(v, at) {
    Char(next, escaped) -> text_end(v, from, at: next, clean: clean and not escaped)
    Quote(next) if clean -> JsonText(text: slice(v, from, to: at), next)
    Quote(next) -> JsonText(text: freeze(decode_text(v, at: from, out: buf())), next)
    BadChar -> BadText
  }
}

fn decode_text(v: View, at: Int, out: Buf) -> Buf {
  match json_char(v, at) {
    Char(code, next) -> decode_text(v, at: next, out: write_code(out, code))
    _ -> out
  }
}

fn json_char(v: View, at: Int) -> JsonChar {
  match {
    at >= len(v) -> BadChar
    v[at] == 34 -> Quote(next: at + 1)
    v[at] == 92 -> escape(v, at: at + 1)
    v[at] < 32 -> BadChar
    v[at] < 128 -> Char(code: v[at], next: at + 1, escaped: False)
    else -> utf8_char(found: utf8_at(v, at))
  }
}

fn utf8_char(found: Utf8) -> JsonChar {
  match found {
    Utf8(code, next) -> Char(code, next, escaped: False)
    BadUtf8 -> BadChar
  }
}

// `at` is the byte after the backslash.
fn escape(v: View, at: Int) -> JsonChar {
  match {
    at >= len(v) -> BadChar
    v[at] == 117 -> unicode(v, at: at + 5, unit: hex4(v, at: at + 1))
    else -> simple(code: unescape(v[at]), next: at + 1)
  }
}

fn unescape(b: Int) -> Option[Int] {
  match b {
    34 -> Some(34)
    92 -> Some(92)
    47 -> Some(47)
    98 -> Some(8)
    102 -> Some(12)
    110 -> Some(10)
    114 -> Some(13)
    116 -> Some(9)
    _ -> None
  }
}

fn simple(code: Option[Int], next: Int) -> JsonChar {
  match code {
    Some(value) -> Char(code: value, next, escaped: True)
    None -> BadChar
  }
}

// `at` is the position after \uXXXX. A high surrogate needs a low surrogate escape right after it.
fn unicode(v: View, at: Int, unit: Option[Int]) -> JsonChar {
  match unit {
    Some(value) if value >= 55296 and value < 56320 -> low_half(
      high: value,
      low: low_unit(v, at),
      next: at + 6
    )
    Some(value) if value >= 56320 and value < 57344 -> BadChar
    Some(value) -> Char(code: value, next: at, escaped: True)
    None -> BadChar
  }
}

fn low_unit(v: View, at: Int) -> Option[Int] {
  match {
    has(v, at, word: "\\u") -> hex4(v, at: at + 2)
    else -> None
  }
}

fn low_half(high: Int, low: Option[Int], next: Int) -> JsonChar {
  match low {
    Some(value) if value >= 56320 and value < 57344 -> Char(
      code: 65536 + ((high - 55296) << 10) + (value - 56320),
      next,
      escaped: True
    )
    _ -> BadChar
  }
}

fn hex4(v: View, at: Int) -> Option[Int] {
  match {
    at + 4 <= len(v) and is_hex(v[at]) and is_hex(v[at + 1]) and is_hex(v[at + 2]) and is_hex(
      v[at + 3]
    ) -> Some(
      (hex(v[at]) << 12) | (hex(v[at + 1]) << 8) | (hex(v[at + 2]) << 4) | hex(v[at + 3])
    )
    else -> None
  }
}

fn is_hex(b: Int) -> Bool {
  is_digit(b) or (b >= 97 and b <= 102) or (b >= 65 and b <= 70)
}

fn hex(b: Int) -> Int {
  match {
    b <= 57 -> b - 48
    b >= 97 -> b - 87
    else -> b - 55
  }
}

// ---------- writing ----------

// Appends text as a JSON string, escaped exactly as JSON.stringify escapes it.
fn write_json_string(out: Buf, text: View) -> Buf {
  push(buf: write_chars(out: push(buf: out, byte: 34), text, from: 0, at: 0), byte: 34)
}

// Copies runs of plain bytes whole; `from` is the start of the current run.
fn write_chars(out: Buf, text: View, from: Int, at: Int) -> Buf {
  match {
    at >= len(text) -> append(buf: out, view: slice(v: text, from, to: at))
    text[at] >= 32 and text[at] != 34 and text[at] != 92 -> write_chars(out, text, from, at: at + 1)
    else -> write_chars(
      out: write_escape(out: append(buf: out, view: slice(v: text, from, to: at)), b: text[at]),
      text,
      from: at + 1,
      at: at + 1
    )
  }
}

fn write_escape(out: Buf, b: Int) -> Buf {
  match b {
    34 -> append(buf: out, view: "\\\"")
    92 -> append(buf: out, view: "\\\\")
    8 -> append(buf: out, view: "\\b")
    12 -> append(buf: out, view: "\\f")
    10 -> append(buf: out, view: "\\n")
    13 -> append(buf: out, view: "\\r")
    9 -> append(buf: out, view: "\\t")
    _ -> push(
      buf: push(buf: append(buf: out, view: "\\u00"), byte: hex_digit(b >> 4)),
      byte: hex_digit(b & 15)
    )
  }
}

fn hex_digit(d: Int) -> Int {
  match {
    d < 10 -> 48 + d
    else -> 87 + d
  }
}

// ---------- records inside records, and lists ----------
// decode and write_json take records whose fields are records and lists as well; the compiler writes the functions
// that do it from the three types and the helpers below. The host hands a nested value over as text for a second
// decode: an object as it stands (WireObject); an array as its elements, one to a line (WireItems when they are
// objects, WireValues when they are other values, each then written as {"value": …}).

type WireObject = View where len(self) >= 0

type WireItems = View where len(self) >= 0

type WireValues = View where len(self) >= 0

fn write_bool(out: Buf, value: Bool) -> Buf {
  match value {
    True -> append(buf: out, view: "true")
    False -> append(buf: out, view: "false")
  }
}

// A key that was there: its decoded value as Some.
fn wire_some[T](decoded: Result[T, View]) -> Result[Option[T], View] {
  match decoded {
    Ok(value) -> Ok(value: Some(value))
    Err(error) -> Err(error)
  }
}

// The elements of an array, each decoded by `by`, in order. The first that fails is the reason, with its index.
fn wire_each[T](items: View, by: Fn[View, Result[T, View]]) -> Result[List[T], View] {
  wire_each_from(items, by, at: 0, acc: Nil)
}

fn wire_each_from[T](
  items: View,
  by: Fn[View, Result[T, View]],
  at: Int,
  acc: List[T]
) -> Result[List[T], View] {
  match items {
    "" -> Ok(value: reverse(list: acc))
    item ++ "\n" ++ rest -> wire_each_next(decoded: by(item), rest, by, at, acc)
    _ -> Err(error: ": not an array as the host hands one over")
  }
}

fn wire_each_next[T](
  decoded: Result[T, View],
  rest: View,
  by: Fn[View, Result[T, View]],
  at: Int,
  acc: List[T]
) -> Result[List[T], View] {
  match decoded {
    Ok(value) -> wire_each_from(items: rest, by, at: at + 1, acc: Cons(head: value, tail: acc))
    Err(error) -> Err(error: wire_at(at, error))
  }
}

// "[2]: reason", or "[2][0]: reason" when the element was itself a list.
fn wire_at(at: Int, error: View) -> View {
  match error {
    "[" ++ rest -> "[" ++ decimal_text(value: at) ++ "]" ++ error
    _ -> "[" ++ decimal_text(value: at) ++ "]: " ++ error
  }
}

// An element that is not an object is handed over as {"value": …}: its reason without that key.
fn wire_plain(error: View) -> View {
  match error {
    "value: " ++ why -> why
    "value" ++ why -> why
    _ -> error
  }
}

// Every row of a query as a JSON array, each row written as write_json writes it.
fn write_rows[T](out: Buf, rows: Rows[T]) -> Buf {
  write_rows_from(out: push(buf: out, byte: 91), rows, first: True)
}

fn write_rows_from[T](out: Buf, rows: Rows[T], first: Bool) -> Buf {
  match next(rows) {
    Next(value, rest) if first -> write_rows_from(
      out: write_json(out, value),
      rows: rest,
      first: False
    )
    Next(value, rest) -> write_rows_from(
      out: write_json(out: push(buf: out, byte: 44), value),
      rows: rest,
      first: False
    )
    End -> push(buf: out, byte: 93)
  }
}
