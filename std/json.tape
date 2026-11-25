// std/json.tape: JSON (RFC 8259), read by stepping and written by appending.
//
// Reading an object:   json_first(v) gives the first step, json_next(v, at) the step after a member:
//   Member(key, value, next)   one member; key is decoded; value is a Json; next is where to continue
//   Close(next)                the object ended at next
//   Malformed                  not JSON
// Strings must be valid UTF-8 and well-formed Unicode: a lone surrogate escape is Malformed.
// A repeated key is reported again; the caller decides (JSON.parse keeps the last).

// A value of a member, as json_first and json_next give it: text and booleans; anything else is JsonOther.
type Json {
  JsonString(text: View)
  JsonBool(value: Bool)
  JsonOther
}

// One step through an object: a member, the end of the object, or text that is not JSON.
type JsonStep {
  Member(key: View, value: Json, next: Int)
  Close(next: Int)
  Malformed
}

// Internal: a value and where it ends, or BadValue.
type JsonValue {
  JsonValue(json: Json, next: Int)
  BadValue
}

// Internal: a decoded string and where it ends, or BadText.
type JsonText {
  JsonText(text: View, next: Int)
  BadText
}

// Internal: One character of a string body.
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

// The first position at or after `at` that is not JSON whitespace.
private fn json_ws(v: View, at: Int) -> Int {
  match {
    at < len(v)
      and (v[at] == 32 or v[at] == 10 or v[at] == 13 or v[at] == 9) -> json_ws(v, at: at + 1)
    else -> at
  }
}

// The first step after `{`.
private fn first_member(v: View, at: Int) -> JsonStep {
  let s = json_ws(v, at)
  match {
    s < len(v) and v[s] == 125 -> Close(next: s + 1)
    else -> member(v, at: s)
  }
}

// A member that starts at `at` (its key's quote).
private fn member(v: View, at: Int) -> JsonStep {
  match {
    at < len(v) and v[at] == 34 -> member_key(v, key: json_text(v, at: at + 1))
    else -> Malformed
  }
}

// A member, after its key.
private fn member_key(v: View, key: JsonText) -> JsonStep {
  match key {
    JsonText(text, next) -> member_colon(v, key: text, at: json_ws(v, at: next))
    BadText -> Malformed
  }
}

// A member, at the colon after its key.
private fn member_colon(v: View, key: View, at: Int) -> JsonStep {
  match {
    at < len(v)
      and v[at] == 58 -> member_value(key, value: json_value(v, at: json_ws(v, at: at + 1)))
    else -> Malformed
  }
}

// A member, once its value is read.
private fn member_value(key: View, value: JsonValue) -> JsonStep {
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

// A string as a JsonValue.
private fn string_value(found: JsonText) -> JsonValue {
  match found {
    JsonText(text, next) -> JsonValue(json: JsonString(text), next)
    BadText -> BadValue
  }
}

// A value json_first does not decode (an object, an array, a number, null) as JsonOther.
private fn other(end: Option[Int]) -> JsonValue {
  match end {
    Some(value) -> JsonValue(json: JsonOther, next: value)
    None -> BadValue
  }
}

// Where the object whose first step is `step` ends.
private fn object_end(v: View, step: JsonStep) -> Option[Int] {
  match step {
    Member(next) -> object_end(v, step: json_next(v, at: next))
    Close(next) -> Some(next)
    Malformed -> None
  }
}

// `at` is the first non-space position after `[`.
private fn array_end(v: View, at: Int) -> Option[Int] {
  match {
    at < len(v) and v[at] == 93 -> Some(at + 1)
    else -> element(v, value: json_value(v, at))
  }
}

// An array's element, once its value is read.
private fn element(v: View, value: JsonValue) -> Option[Int] {
  match value {
    JsonValue(next) -> element_end(v, at: json_ws(v, at: next))
    BadValue -> None
  }
}

// After an array's element: `,` or `]`.
private fn element_end(v: View, at: Int) -> Option[Int] {
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

// A number's fraction, after its `.`.
private fn fraction_end(v: View, at: Int) -> Option[Int] {
  let d = digits_end(v, at)
  match {
    d == at -> None
    else -> exponent_end(v, at: d)
  }
}

// A number's exponent, if it has one.
private fn exponent_end(v: View, at: Int) -> Option[Int] {
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

// The loop of json_text; `clean` while no escape has been seen.
private fn text_end(v: View, from: Int, at: Int, clean: Bool) -> JsonText {
  match json_char(v, at) {
    Char(next, escaped) -> text_end(v, from, at: next, clean: clean and not escaped)
    Quote(next) if clean -> JsonText(text: slice(v, from, to: at), next)
    Quote(next) -> JsonText(text: freeze(decode_text(v, at: from, out: buf())), next)
    BadChar -> BadText
  }
}

// A string with escapes, decoded into new memory.
private fn decode_text(v: View, at: Int, out: Buf) -> Buf {
  match json_char(v, at) {
    Char(code, next) -> decode_text(v, at: next, out: write_code(out, code))
    _ -> out
  }
}

// One character of a string body, at `at`.
private fn json_char(v: View, at: Int) -> JsonChar {
  match {
    at >= len(v) -> BadChar
    v[at] == 34 -> Quote(next: at + 1)
    v[at] == 92 -> escape(v, at: at + 1)
    v[at] < 32 -> BadChar
    v[at] < 128 -> Char(code: v[at], next: at + 1, escaped: False)
    else -> utf8_char(found: utf8_at(v, at))
  }
}

// A UTF-8 sequence as a JsonChar.
private fn utf8_char(found: Utf8) -> JsonChar {
  match found {
    Utf8(code, next) -> Char(code, next, escaped: False)
    BadUtf8 -> BadChar
  }
}

// `at` is the byte after the backslash.
private fn escape(v: View, at: Int) -> JsonChar {
  match {
    at >= len(v) -> BadChar
    v[at] == 117 -> unicode(v, at: at + 5, unit: hex4(v, at: at + 1))
    else -> simple(code: unescape(v[at]), next: at + 1)
  }
}

// The byte a one-letter escape stands for (`n` is a line feed).
private fn unescape(b: Int) -> Option[Int] {
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

// A one-letter escape as a JsonChar.
private fn simple(code: Option[Int], next: Int) -> JsonChar {
  match code {
    Some(value) -> Char(code: value, next, escaped: True)
    None -> BadChar
  }
}

// `at` is the position after \uXXXX. A high surrogate needs a low surrogate escape right after it.
private fn unicode(v: View, at: Int, unit: Option[Int]) -> JsonChar {
  match unit {
    Some(value) if value >= 55296
      and value < 56320 -> low_half(high: value, low: low_unit(v, at), next: at + 6)
    Some(value) if value >= 56320 and value < 57344 -> BadChar
    Some(value) -> Char(code: value, next: at, escaped: True)
    None -> BadChar
  }
}

// The \uXXXX after a high surrogate, if there is one.
private fn low_unit(v: View, at: Int) -> Option[Int] {
  match {
    has(v, at, word: "\\u") -> hex4(v, at: at + 2)
    else -> None
  }
}

// A surrogate pair as one code point.
private fn low_half(high: Int, low: Option[Int], next: Int) -> JsonChar {
  match low {
    Some(value) if value >= 56320
      and value < 57344 -> Char(
        code: 65536 + ((high - 55296) << 10) + (value - 56320),
        next,
        escaped: True
      )
    _ -> BadChar
  }
}

// Four hex digits at `at`, as a number.
private fn hex4(v: View, at: Int) -> Option[Int] {
  match {
    at + 4 <= len(v)
      and is_hex(v[at])
      and is_hex(v[at + 1])
      and is_hex(v[at + 2])
      and is_hex(v[at + 3]) -> Some(
        (hex(v[at]) << 12) | (hex(v[at + 1]) << 8) | (hex(v[at + 2]) << 4) | hex(v[at + 3])
      )
    else -> None
  }
}

// Is the byte a hex digit (0-9, a-f, A-F)?
//
//   > is_hex(b: 70)
//   True
//   > is_hex(b: 103)
//   False
fn is_hex(b: Int) -> Bool {
  is_digit(b) or (b >= 97 and b <= 102) or (b >= 65 and b <= 70)
}

// The value of a hex digit (is_hex(b) must hold).
//
//   > hex(b: 102)
//   15
fn hex(b: Int) -> Int {
  match {
    b <= 57 -> b - 48
    b >= 97 -> b - 87
    else -> b - 55
  }
}

// ---------- JSON of any shape ----------

// Is text one JSON value (RFC 8259), with whitespace around it allowed? It accepts what decode accepts: strings
// are UTF-8, and a \u escape of a lone surrogate is allowed, as JSON.parse allows it. One pass over the bytes,
// with no tree built and no stack grown by nesting: on 64 KB of nested JSON, 99,358 steps and 8 bytes of memory
// (test/json-any.ts measures it on each build).
//
//   > is_json(text: " {\"a\": [1, -2.5e3, \"\\u00e9\"], \"b\": {\"c\": null}} ")
//   True
//   > is_json(text: "{\"a\": 1,}")
//   False
//   > is_json(text: "[1] [2]")
//   False
//   > is_json(text: "")
//   False
fn is_json(text: View) -> Bool {
  let end = value_end(v: text, at: json_ws(v: text, at: 0))
  end >= 0 and json_ws(v: text, at: end) == len(text)
}

// The JSON text of the value of member `key` of the object that json holds, without the whitespace around it;
// None when json is not an object, has no member `key`, or is not JSON up to that member. Keys are compared once
// unescaped (`"\u0069d"` is `id`). Of two members with the same key the first is taken, and nothing after it is
// read; decode, like JSON.parse, takes the last. The value is read with decode: `decode(json: raw, as: View)` for
// a string, `as: Int` for a number, `as: T` for an object.
//
//   > json_member(json: "{\"id\": \"a1\", \"n\": [1, 2] }", key: "n")
//   Some(value: "[1, 2]")
//   > json_member(json: "{\"\\u0069d\": 7, \"id\": 8}", key: "id")
//   Some(value: "7")
//   > json_member(json: "{\"id\": \"a1\"}", key: "name")
//   None
//   > json_member(json: "[{\"id\": 1}]", key: "id")
//   None
fn json_member(json: View, key: View) -> Option[View] {
  let s = json_ws(v: json, at: 0)
  match {
    s < len(json) and json[s] == 123 -> named_at(v: json, at: json_ws(v: json, at: s + 1), key)
    else -> None
  }
}

// A member json_member reads, whose key's opening quote is at `at`.
private fn named_at(v: View, at: Int, key: View) -> Option[View] {
  match {
    at < len(v) and v[at] == 34 -> named_colon(v, at, key, end: string_close(v, at: at + 1))
    else -> None
  }
}

// A member whose key's quote is at `at` and ends before `end` (-1: the key is not a string).
private fn named_colon(v: View, at: Int, key: View, end: Int) -> Option[View] {
  match {
    end < 0 -> None
    else -> {
      let colon = json_ws(v, at: end)
      match {
        colon < len(v) and v[colon] == 58 -> {
          let from = json_ws(v, at: colon + 1)
          named_value(v, key, hit: key_is(v, at: at + 1, key), from, to: value_end(v, at: from))
        }
        else -> None
      }
    }
  }
}

// A member's value, from `from` to `to` (-1: not JSON); `hit` when its key is the one asked for.
private fn named_value(v: View, key: View, hit: Bool, from: Int, to: Int) -> Option[View] {
  match {
    to < 0 -> None
    hit -> Some(value: slice(v, from, to))
    else -> {
      let s = json_ws(v, at: to)
      match {
        s < len(v) and v[s] == 44 -> named_at(v, at: json_ws(v, at: s + 1), key)
        else -> None
      }
    }
  }
}

// Is the string whose body starts at `at` (a string string_close has read) `key`, once unescaped? One
// without escapes is compared where it is; one with escapes is decoded first.
private fn key_is(v: View, at: Int, key: View) -> Bool {
  let e = text_run(v, at)
  match {
    e < len(v) and v[e] == 34 -> slice(v, from: at, to: e) == key
    else -> match tree_text(v, at) {
      Json_Got(text) -> text == key
      Json_NoText -> False
    }
  }
}

// Internal: the arrays and objects open around a value, innermost first: `bits` holds the innermost `n` (1 an
// object, 0 an array; the innermost in the lowest bit), at most 60; `rest` the full words of 60 below them.
type Json_Open { Json_Open(bits: Int, n: Int, rest: List[Int]) }

// One more open, an object or an array.
private fn open_push(open: Json_Open, object: Int) -> Json_Open {
  match open {
    Json_Open(bits, n, rest) if n == 60 -> Json_Open(
      bits: object,
      n: 1,
      rest: Cons(head: bits, tail: rest)
    )
    Json_Open(bits, n, rest) -> Json_Open(bits: (bits << 1) | object, n: n + 1, rest)
  }
}

// The innermost one closed.
private fn open_pop(open: Json_Open) -> Json_Open {
  match open {
    Json_Open(n, rest: Cons(head, tail)) if n == 1 -> Json_Open(bits: head, n: 60, rest: tail)
    Json_Open(bits, n, rest) -> Json_Open(bits: bits >> 1, n: n - 1, rest)
  }
}

// Where the JSON value that starts at `at` ends, or -1 when there is none there.
private fn value_end(v: View, at: Int) -> Int {
  next_value(v, at, open: Json_Open(bits: 0, n: 0, rest: Nil))
}

// A value starts at `at` (whitespace skipped), inside what is open.
private fn next_value(v: View, at: Int, open: Json_Open) -> Int {
  match {
    at >= len(v) -> -1
    v[at] == 123 -> opened(v, at: json_ws(v, at: at + 1), open, close: 125)
    v[at] == 91 -> opened(v, at: json_ws(v, at: at + 1), open, close: 93)
    v[at] == 34 -> after_value(v, at: string_close(v, at: at + 1), open)
    has(v, at, word: "true") -> after_value(v, at: at + 4, open)
    has(v, at, word: "false") -> after_value(v, at: at + 5, open)
    has(v, at, word: "null") -> after_value(v, at: at + 4, open)
    else -> after_value(v, at: found_end(end: number_end(v, at)), open)
  }
}

// After `{` (close 125) or `[` (close 93) and whitespace.
private fn opened(v: View, at: Int, open: Json_Open, close: Int) -> Int {
  match {
    at < len(v) and v[at] == close -> after_value(v, at: at + 1, open)
    close == 125 -> next_key(v, at, open: open_push(open, object: 1))
    else -> next_value(v, at, open: open_push(open, object: 0))
  }
}

// A member's key starts at `at`; then its colon and its value.
private fn next_key(v: View, at: Int, open: Json_Open) -> Int {
  match {
    at < len(v) and v[at] == 34 -> {
      let e = string_close(v, at: at + 1)
      let colon = match {
        e < 0 -> len(v)
        else -> json_ws(v, at: e)
      }
      match {
        colon < len(v) and v[colon] == 58 -> next_value(v, at: json_ws(v, at: colon + 1), open)
        else -> -1
      }
    }
    else -> -1
  }
}

// A value ended at `at` (-1: it was not JSON): the end of the whole, or what comes next in what is open.
private fn after_value(v: View, at: Int, open: Json_Open) -> Int {
  match open {
    _ if at < 0 -> -1
    Json_Open(n: 0) -> at
    Json_Open(bits) -> {
      let s = json_ws(v, at)
      match {
        s >= len(v) -> -1
        v[s] == 44 and (bits & 1) == 1 -> next_key(v, at: json_ws(v, at: s + 1), open)
        v[s] == 44 -> next_value(v, at: json_ws(v, at: s + 1), open)
        v[s] == 125 and (bits & 1) == 1 -> after_value(v, at: s + 1, open: open_pop(open))
        v[s] == 93 and (bits & 1) == 0 -> after_value(v, at: s + 1, open: open_pop(open))
        else -> -1
      }
    }
  }
}

// A number's end, or -1.
private fn found_end(end: Option[Int]) -> Int {
  match end {
    Some(value) -> value
    None -> -1
  }
}

// Past the closing quote of the string whose body starts at `at`, or -1 when it is not a string: plain
// bytes and UTF-8 are passed 16 at a time (text_run), and an escape is checked, not decoded.
private fn string_close(v: View, at: Int) -> Int {
  let e = text_run(v, at)
  match {
    e >= len(v) -> -1
    v[e] == 34 -> e + 1
    v[e] != 92 or e + 1 >= len(v) -> -1
    v[e + 1] == 117 -> escape_close(v, at: e + 6, ok: hex4(v, at: e + 2))
    else -> escape_close(v, at: e + 2, ok: unescape(v[e + 1]))
  }
}

// After an escape, which is one when `ok` is Some.
private fn escape_close(v: View, at: Int, ok: Option[Int]) -> Int {
  match ok {
    Some -> string_close(v, at)
    None -> -1
  }
}

// ---------- writing ----------

// Appends text as a JSON string, escaped exactly as JSON.stringify escapes it; bytes that are not UTF-8 are written
// as U+FFFD, one for each maximal part, as TextDecoder reads them, so what is written is always JSON.
//
//   > buf() |> write_json_string(text: "a\nb") |> freeze
//   "\"a\\nb\""
fn write_json_string(out: Buf, text: View) -> Buf {
  push(buf: write_chars(out: push(buf: out, byte: 34), text, from: 0, at: 0), byte: 34)
}

// Copies runs of plain bytes whole; `from` is the start of the current run. A byte of 128 or more starts
// a UTF-8 sequence, copied with the run, or bytes that are not UTF-8, each maximal part of which is written as U+FFFD
// (EF BF BD), as a WHATWG decoder reads them: what is written is always JSON.
private fn write_chars(out: Buf, text: View, from: Int, at: Int) -> Buf {
  match {
    at >= len(text) -> append(buf: out, view: slice(v: text, from, to: at))
    text[at] >= 128 -> {
      let end = utf8_end(v: text, at)
      match {
        end > 0 -> write_chars(out, text, from, at: end)
        else -> write_chars(
          out: append(buf: out, view: slice(v: text, from, to: at))
            |> push(byte: 239)
            |> push(byte: 191)
            |> push(byte: 189),
          text,
          from: 0 - end,
          at: 0 - end
        )
      }
    }
    text[at] >= 32 and text[at] != 34 and text[at] != 92 -> write_chars(out, text, from, at: at + 1)
    else -> write_chars(
      out: write_escape(out: append(buf: out, view: slice(v: text, from, to: at)), b: text[at]),
      text,
      from: at + 1,
      at: at + 1
    )
  }
}

// One byte of a JSON string as its escape.
private fn write_escape(out: Buf, b: Int) -> Buf {
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

// 0-15 as a lowercase hex digit's byte.
private fn hex_digit(d: Int) -> Int {
  match {
    d < 10 -> 48 + d
    else -> 87 + d
  }
}

// Appends true or false.
//
//   > buf() |> write_bool(value: True) |> freeze
//   "true"
fn write_bool(out: Buf, value: Bool) -> Buf {
  match value {
    True -> append(buf: out, view: "true")
    False -> append(buf: out, view: "false")
  }
}

// ---------- decode: JSON read into records ----------
// decode(json, as: T) runs a decoder the compiler writes for T (compiler/wire.ts) from the pieces below: the
// bytes are read once into a tree (json_tree), then each constructor's keys are checked against it and its values
// read. What it accepts and what it says are JSON.parse's and the host's before it, with one difference: a number
// is read exactly from its text. An Int field takes a JSON number whose value is a whole number within
// ±(2^53 - 1) (9007199254740991): 1e3 is 1000 and 2.0 is 2, but 1.0000000000000000001 and 1e-400 are not whole
// numbers (JSON.parse rounds them to 1 and 0). Outside that range decode answers Err("<field>: expected an
// integer") and never rounds. Exact large-integer JSON, the whole 64-bit range, is planned for 0.3; until then
// such a value is sent as text.

// Internal: a JSON value. A string is its decoded bytes; `whole` is False when it holds a lone surrogate (an
// escape JSON.parse takes, written here as its three bytes of WTF-8). A number is its text.
type Json_Tree {
  Json_Null
  Json_Bool(value: Bool)
  Json_Num(text: View)
  Json_Str(text: View, whole: Bool)
  Json_Arr(items: List[Json_Tree])
  Json_Obj(members: List[Json_Member])
}

// Internal: one member of an object, in the order written (a repeated key is there each time).
type Json_Member { Json_Member(key: View, value: Json_Tree) }

// Internal: an array or an object being read, with what it holds so far, last first.
type Json_Frame {
  Json_InArr(items: List[Json_Tree])
  Json_InObj(members: List[Json_Member], key: View)
}

// Internal: a string read: its bytes, whether it is well-formed, and where it ends; or not a string.
type Json_Got {
  Json_Got(text: View, whole: Bool, next: Int)
  Json_NoText
}

// Internal: one character of a string read by json_tree: a code point, and whether it is a lone surrogate.
type Json_Code {
  Json_Code(code: Int, lone: Bool, next: Int)
  Json_NoCode
}

// Internal: whether an object is a constructor (its fields are there, of their kinds; other keys are left
// unread): Json_Hit, or how many of its fields fit before the one that does not, and why.
type Json_Fit {
  Json_Hit
  Json_Miss(depth: Int, why: View)
}

// The JSON value v holds, whitespace around it allowed; None when it is not JSON. Read in one pass with
// a stack of the arrays and objects open, so nesting does not grow the Wasm stack.
private fn json_tree(v: View) -> Option[Json_Tree] {
  tree_value(v, at: json_ws(v, at: 0), stack: Nil)
}

// A value starts at `at` (whitespace skipped).
private fn tree_value(v: View, at: Int, stack: List[Json_Frame]) -> Option[Json_Tree] {
  match {
    at >= len(v) -> None
    v[at] == 123 -> tree_open_object(v, at: json_ws(v, at: at + 1), stack)
    v[at] == 91 -> tree_open_array(v, at: json_ws(v, at: at + 1), stack)
    v[at] == 34 -> tree_string(v, got: tree_text(v, at: at + 1), stack)
    has(v, at, word: "true") -> tree_done(v, node: Json_Bool(True), at: at + 4, stack)
    has(v, at, word: "false") -> tree_done(v, node: Json_Bool(False), at: at + 5, stack)
    has(v, at, word: "null") -> tree_done(v, node: Json_Null, at: at + 4, stack)
    else -> tree_number(v, at, end: number_end(v, at), stack)
  }
}

// After `{` and whitespace.
private fn tree_open_object(v: View, at: Int, stack: List[Json_Frame]) -> Option[Json_Tree] {
  match {
    at < len(v) and v[at] == 125 -> tree_done(v, node: Json_Obj(members: Nil), at: at + 1, stack)
    else -> tree_key(v, at, members: Nil, stack)
  }
}

// After `[` and whitespace.
private fn tree_open_array(v: View, at: Int, stack: List[Json_Frame]) -> Option[Json_Tree] {
  match {
    at < len(v) and v[at] == 93 -> tree_done(v, node: Json_Arr(items: Nil), at: at + 1, stack)
    else -> tree_value(v, at, stack: Cons(head: Json_InArr(items: Nil), tail: stack))
  }
}

// A member's key starts at `at`; then its colon and its value.
private fn tree_key(
  v: View,
  at: Int,
  members: List[Json_Member],
  stack: List[Json_Frame]
) -> Option[Json_Tree] {
  match {
    at < len(v) and v[at] == 34 -> tree_colon(v, got: tree_text(v, at: at + 1), members, stack)
    else -> None
  }
}

// A member's key, read.
private fn tree_colon(
  v: View,
  got: Json_Got,
  members: List[Json_Member],
  stack: List[Json_Frame]
) -> Option[Json_Tree] {
  match got {
    Json_Got(text, next) -> tree_member(v, key: text, at: json_ws(v, at: next), members, stack)
    Json_NoText -> None
  }
}

// at the colon after a member's key.
private fn tree_member(
  v: View,
  key: View,
  at: Int,
  members: List[Json_Member],
  stack: List[Json_Frame]
) -> Option[Json_Tree] {
  match {
    at < len(v)
      and v[at] == 58 -> tree_value(
        v,
        at: json_ws(v, at: at + 1),
        stack: Cons(head: Json_InObj(members, key), tail: stack)
      )
    else -> None
  }
}

// A string value, read.
private fn tree_string(v: View, got: Json_Got, stack: List[Json_Frame]) -> Option[Json_Tree] {
  match got {
    Json_Got(text, whole, next) -> tree_done(v, node: Json_Str(text, whole), at: next, stack)
    Json_NoText -> None
  }
}

// A number, if one ends at `end`.
private fn tree_number(
  v: View,
  at: Int,
  end: Option[Int],
  stack: List[Json_Frame]
) -> Option[Json_Tree] {
  match end {
    Some(value) -> tree_done(
      v,
      node: Json_Num(text: slice(v, from: at, to: value)),
      at: value,
      stack
    )
    None -> None
  }
}

// A value `node` ended at `at`: it is the whole text's, or the next item or member of what is open.
private fn tree_done(
  v: View,
  node: Json_Tree,
  at: Int,
  stack: List[Json_Frame]
) -> Option[Json_Tree] {
  let s = json_ws(v, at)
  match stack {
    Nil if s == len(v) -> Some(value: node)
    Nil -> None
    Cons(head: Json_InArr(items), tail) if s < len(v)
      and v[s] == 44 -> tree_value(
        v,
        at: json_ws(v, at: s + 1),
        stack: Cons(head: Json_InArr(items: Cons(head: node, tail: items)), tail)
      )
    Cons(head: Json_InArr(items), tail) if s < len(v)
      and v[s] == 93 -> tree_done(
        v,
        node: Json_Arr(items: reverse(list: Cons(head: node, tail: items))),
        at: s + 1,
        stack: tail
      )
    Cons(head: Json_InObj(members, key), tail) if s < len(v)
      and v[s] == 44 -> tree_key(
        v,
        at: json_ws(v, at: s + 1),
        members: Cons(head: Json_Member(key, value: node), tail: members),
        stack: tail
      )
    Cons(head: Json_InObj(members, key), tail) if s < len(v)
      and v[s] == 125 -> tree_done(
        v,
        node: Json_Obj(
          members: reverse(list: Cons(head: Json_Member(key, value: node), tail: members))
        ),
        at: s + 1,
        stack: tail
      )
    _ -> None
  }
}

// The string whose body starts at `at`. Plain bytes (and well-formed UTF-8) are found 16 at a time
// (scan_plain, 16 bytes at a time, one step per 16 bytes read); a string without escapes is a view of the input,
// one with escapes is decoded into new memory.
private fn tree_text(v: View, at: Int) -> Json_Got {
  let e = text_run(v, at)
  match {
    e < len(v) and v[e] == 34 -> Json_Got(text: slice(v, from: at, to: e), whole: True, next: e + 1)
    e < len(v)
      and v[e] == 92 -> text_escaped(
        v,
        at: e,
        out: append(buf: buf(), view: slice(v, from: at, to: e)),
        whole: True
      )
    else -> Json_NoText
  }
}

// Past plain ASCII and well-formed UTF-8: the first quote, backslash, control byte or byte that is not
// UTF-8.
private fn text_run(v: View, at: Int) -> Int {
  let e = scan_plain(v, at)
  match {
    e < len(v) and v[e] >= 128 -> utf8_run(v, at: e, found: utf8_at(v, at: e))
    else -> e
  }
}

// A UTF-8 sequence in a string: past it when it is well-formed.
private fn utf8_run(v: View, at: Int, found: Utf8) -> Int {
  match found {
    Utf8(next) -> text_run(v, at: next)
    BadUtf8 -> at
  }
}

// `at` is a backslash; `out` holds the string so far.
private fn text_escaped(v: View, at: Int, out: Buf, whole: Bool) -> Json_Got {
  match tree_escape(v, at: at + 1) {
    Json_Code(code, lone, next) -> text_more(
      v,
      at: next,
      out: write_code(out, code),
      whole: whole and not lone
    )
    Json_NoCode -> no_text(gone: freeze(out))
  }
}

// After an escape.
private fn text_more(v: View, at: Int, out: Buf, whole: Bool) -> Json_Got {
  let e = text_run(v, at)
  match {
    e < len(v)
      and v[e] == 34 -> Json_Got(
        text: freeze(append(buf: out, view: slice(v, from: at, to: e))),
        whole,
        next: e + 1
      )
    e < len(v)
      and v[e] == 92 -> text_escaped(
        v,
        at: e,
        out: append(buf: out, view: slice(v, from: at, to: e)),
        whole
      )
    else -> no_text(gone: freeze(out))
  }
}

// Not a string (what was decoded of it is dropped).
private fn no_text(gone: View) -> Json_Got {
  Json_NoText
}

// The escape whose letter is at `at`. A \u escape of a surrogate without its other half is a lone
// surrogate, as JSON.parse reads it.
private fn tree_escape(v: View, at: Int) -> Json_Code {
  match {
    at >= len(v) -> Json_NoCode
    v[at] == 117 -> tree_unicode(v, at: at + 5, unit: hex4(v, at: at + 1))
    else -> tree_simple(code: unescape(v[at]), next: at + 1)
  }
}

// A one-letter escape.
private fn tree_simple(code: Option[Int], next: Int) -> Json_Code {
  match code {
    Some(value) -> Json_Code(code: value, lone: False, next)
    None -> Json_NoCode
  }
}

// `at` is the position after \uXXXX.
private fn tree_unicode(v: View, at: Int, unit: Option[Int]) -> Json_Code {
  match unit {
    Some(value) if value >= 55296
      and value < 56320 -> tree_pair(high: value, low: low_unit(v, at), at)
    Some(value) if value >= 56320 and value < 57344 -> Json_Code(code: value, lone: True, next: at)
    Some(value) -> Json_Code(code: value, lone: False, next: at)
    None -> Json_NoCode
  }
}

// A high surrogate at the escape before `at`: with the low one after it, one code point; alone, lone.
private fn tree_pair(high: Int, low: Option[Int], at: Int) -> Json_Code {
  match low {
    Some(value) if value >= 56320
      and value < 57344 -> Json_Code(
        code: 65536 + ((high - 55296) << 10) + (value - 56320),
        lone: False,
        next: at + 6
      )
    _ -> Json_Code(code: high, lone: True, next: at)
  }
}

// "empty" or "not JSON", as decode says of bytes that are not JSON.
private fn json_bad(v: View) -> View {
  match {
    len(v) == 0 -> "empty"
    else -> "not JSON"
  }
}

// The object v holds (whitespace around it allowed), or why decode refuses it: "empty", "not JSON" or
// "expected an object". The decoders compiler/wire.ts writes start here.
private fn json_object(v: View) -> Result[Json_Tree, View] {
  match json_tree(v) {
    Some(value: Json_Obj(members)) -> Ok(value: Json_Obj(members))
    None -> Err(error: json_bad(v))
    _ -> Err(error: "expected an object")
  }
}

// The array v holds, or why decode refuses it: "empty", "not JSON" or "expected an array" (decode as
// List[T]).
private fn json_array(v: View) -> Result[Json_Tree, View] {
  match json_tree(v) {
    Some(value: Json_Arr(items)) -> Ok(value: Json_Arr(items))
    None -> Err(error: json_bad(v))
    _ -> Err(error: "expected an array")
  }
}

// The value v holds, or why decode refuses it: "empty" or "not JSON" (decode as Int, View, Bool, Float
// or a refinement of one).
private fn json_whole(v: View) -> Result[Json_Tree, View] {
  match json_tree(v) {
    Some(value) -> Ok(value)
    None -> Err(error: json_bad(v))
  }
}

// The key of an object whose one key it is (`{"Sets": {…}}`, as write_json writes a type with several
// constructors), or "" when it has none or more than one.
private fn json_tag(obj: Json_Tree) -> View {
  match obj {
    Json_Obj(members: Cons(head: Json_Member(key), tail)) if json_all_key(list: tail, key) -> key
    _ -> ""
  }
}

// Is every member named `key`?
private fn json_all_key(list: List[Json_Member], key: View) -> Bool {
  match list {
    Cons(head: Json_Member(key: k), tail) if k == key -> json_all_key(list: tail, key)
    Cons -> False
    Nil -> True
  }
}

// Is the value null?
private fn json_is_null(item: Json_Tree) -> Bool {
  match item {
    Json_Null -> True
    _ -> False
  }
}

// Is the value an object?
private fn json_is_object(item: Json_Tree) -> Bool {
  match item {
    Json_Obj -> True
    _ -> False
  }
}

// A member's value, None when it is absent or null: what an Option field holds.
private fn json_present(found: Option[Json_Tree]) -> Option[Json_Tree] {
  match found {
    Some(value: Json_Null) -> None
    _ -> found
  }
}

// The value of a member that json_check found (null when there is none).
private fn json_value_of(found: Option[Json_Tree]) -> Json_Tree {
  match found {
    Some(value) -> value
    None -> Json_Null
  }
}

// The value of the last member of the object `obj` named `key` (JSON.parse keeps the last).
private fn json_get(obj: Json_Tree, key: View) -> Option[Json_Tree] {
  match obj {
    Json_Obj(members) -> json_get_from(list: members, key, found: None)
    _ -> None
  }
}

// The loop of json_get.
private fn json_get_from(
  list: List[Json_Member],
  key: View,
  found: Option[Json_Tree]
) -> Option[Json_Tree] {
  match list {
    Cons(head: Json_Member(key: k, value), tail) if k == key -> json_get_from(
      list: tail,
      key,
      found: Some(value)
    )
    Cons(tail) -> json_get_from(list: tail, key, found)
    Nil -> found
  }
}

// Whether a field is there with a value of its kind (0 text, 1 true or false, 2 an integer, 3 an object,
// 4 an array; a Float is json_check_float's); `depth` is how many fields fit before it. An optional field may be
// absent or null. The reason is `<name>: missing`, `<name>: null` or `<name>: expected <kind>`.
private fn json_check(
  found: Option[Json_Tree],
  kind: Int,
  name: View,
  optional: Bool,
  depth: Int
) -> Json_Fit {
  match found {
    None if optional -> Json_Hit
    None -> Json_Miss(depth, why: name ++ ": missing")
    Some(value: Json_Null) if optional -> Json_Hit
    Some(value: Json_Null) -> Json_Miss(depth, why: name ++ ": null")
    Some(value: Json_Str(whole)) if kind == 0
      and not whole -> Json_Miss(depth, why: name ++ ": expected text without lone surrogates")
    Some(value: Json_Str) if kind == 0 -> Json_Hit
    Some(value: Json_Bool) if kind == 1 -> Json_Hit
    Some(value: Json_Num(text)) if kind == 2 and is_some(found: json_int(text)) -> Json_Hit
    Some(value: Json_Obj) if kind == 3 -> Json_Hit
    Some(value: Json_Arr) if kind == 4 -> Json_Hit
    _ -> Json_Miss(depth, why: name ++ ": expected " ++ json_kind(kind))
  }
}

// Is there a value?
private fn is_some(found: Option[Int]) -> Bool {
  match found {
    Some -> True
    None -> False
  }
}

// json_check of a Float field: a finite number (parse_float). Apart from json_check so that only a
// program with a Float in its JSON reads one (and imports the host's float_of).
private fn json_check_float(
  found: Option[Json_Tree],
  name: View,
  optional: Bool,
  depth: Int
) -> Json_Fit {
  match found {
    Some(value: Json_Num(text)) if is_float(found: parse_float(text)) -> Json_Hit
    Some(value: Json_Null) -> json_check(found, kind: 0, name, optional, depth)
    Some -> Json_Miss(depth, why: name ++ ": expected a number")
    None -> json_check(found, kind: 0, name, optional, depth)
  }
}

// Is there a Float?
private fn is_float(found: Option[Float]) -> Bool {
  match found {
    Some -> True
    None -> False
  }
}

// What a kind of json_check is called in a reason.
private fn json_kind(kind: Int) -> View {
  match kind {
    0 -> "text"
    1 -> "true or false"
    2 -> "an integer"
    3 -> "an object"
    _ -> "an array"
  }
}

// The first of two fits that misses, or Json_Hit (a key no field names is left unread).
private fn json_and(a: Json_Fit, b: Json_Fit) -> Json_Fit {
  match a {
    Json_Hit -> b
    _ -> a
  }
}

// Is there a member named `key`?
private fn json_has(obj: Json_Tree, key: View) -> Bool {
  match obj {
    Json_Obj(members) -> json_has_in(list: members, key)
    _ -> False
  }
}

// The loop of json_has.
private fn json_has_in(list: List[Json_Member], key: View) -> Bool {
  match list {
    Cons(head: Json_Member(key: k)) if k == key -> True
    Cons(tail) -> json_has_in(list: tail, key)
    Nil -> False
  }
}

// 1 when there is a member named `key`, else 0.
private fn json_one(obj: Json_Tree, key: View) -> Int {
  match {
    json_has(obj, key) -> 1
    else -> 0
  }
}

// Text appended (append, here so a decoder's writer names only std's functions, which a program's own
// cannot take the place of).
private fn json_append(out: Buf, view: View) -> Buf {
  append(buf: out, view)
}

// write_json of a list: an array of its items, each as write_json writes it.
private fn wire_write_list[T](out: Buf, list: List[T]) -> Buf {
  wire_items(out: push(buf: out, byte: 91), list, first: True)
}

// The loop of wire_write_list.
private fn wire_items[T](out: Buf, list: List[T], first: Bool) -> Buf {
  match list {
    Cons(head, tail) if first -> wire_items(
      out: write_json(out, value: head),
      list: tail,
      first: False
    )
    Cons(head, tail) -> wire_items(
      out: write_json(out: push(buf: out, byte: 44), value: head),
      list: tail,
      first: False
    )
    Nil -> push(buf: out, byte: 93)
  }
}

// A key of an object being written, after a comma when something was written before it (`more`).
private fn wire_key(out: Buf, more: Bool, key: View) -> Buf {
  match more {
    True -> append(buf: push(buf: out, byte: 44), view: key)
    False -> append(buf: out, view: key)
  }
}

// An Option field: its key and value when it is there, nothing when it is not.
private fn wire_field[T](out: Buf, more: Bool, key: View, found: Option[T]) -> Buf {
  match found {
    Some(value) -> write_json(out: wire_key(out, more, key), value)
    None -> out
  }
}

// Is an Option field there?
private fn json_there[T](found: Option[T]) -> Bool {
  match found {
    Some -> True
    None -> False
  }
}

// A byte appended (push, likewise).
private fn json_push(out: Buf, byte: Int) -> Buf {
  push(buf: out, byte)
}

// The larger of two counts (text.max, likewise).
private fn json_most(a: Int, b: Int) -> Int {
  match {
    a > b -> a
    else -> b
  }
}

// The constructor at `at` when it names more keys (n) than the best so far (most), else the best.
private fn json_better(best: Int, most: Int, at: Int, n: Int) -> Int {
  match {
    n > most -> at
    else -> best
  }
}

// The text of a value that json_check found to be text.
private fn json_text_of(found: Option[Json_Tree]) -> View {
  match found {
    Some(value: Json_Str(text)) -> text
    _ -> ""
  }
}

// A value that json_check found to be true or false.
private fn json_bool_of(found: Option[Json_Tree]) -> Bool {
  match found {
    Some(value: Json_Bool(value)) -> value
    _ -> False
  }
}

// A value that json_check found to be a whole number.
private fn json_int_of(found: Option[Json_Tree]) -> Int {
  match found {
    Some(value: Json_Num(text)) -> int_or_zero(found: json_int(text))
    _ -> 0
  }
}

// The number, or 0.
private fn int_or_zero(found: Option[Int]) -> Int {
  match found {
    Some(value) -> value
    None -> 0
  }
}

// A value that json_check found to be a number, as a Float.
private fn json_float_of(found: Option[Json_Tree]) -> Float {
  match json_maybe_float(found) {
    Some(value) -> value
    None -> 0f
  }
}

// An optional Float.
private fn json_maybe_float(found: Option[Json_Tree]) -> Option[Float] {
  match found {
    Some(value: Json_Num(text)) -> parse_float(text)
    _ -> None
  }
}

// A Float appended, as write_json writes one (write_float, here so a writer names only std's functions).
private fn json_write_float(out: Buf, value: Float) -> Buf {
  write_float(out, value)
}

// An optional text field (json_check found it absent or text).
private fn json_maybe_text(found: Option[Json_Tree]) -> Option[View] {
  match found {
    Some(value: Json_Str(text)) -> Some(value: text)
    _ -> None
  }
}

// An optional true or false.
private fn json_maybe_bool(found: Option[Json_Tree]) -> Option[Bool] {
  match found {
    Some(value: Json_Bool(value)) -> Some(value)
    _ -> None
  }
}

// json_check of a Dec[scale] field: a number, or text holding one, that is exactly a Dec[scale]
// (json_count). Absent or null is json_check's; anything else is `<name>: expected a number with at most 2
// decimals`.
private fn json_check_dec(
  found: Option[Json_Tree],
  scale: Int,
  name: View,
  optional: Bool,
  depth: Int
) -> Json_Fit {
  match found {
    None -> json_check(found, kind: 0, name, optional, depth)
    Some(value: Json_Null) -> json_check(found, kind: 0, name, optional, depth)
    Some(value: Json_Num(text)) if is_some(found: json_count(text, scale)) -> Json_Hit
    Some(value: Json_Str(text)) if is_some(found: json_count(text, scale)) -> Json_Hit
    _ -> Json_Miss(depth, why: name ++ ": expected " ++ json_dec_kind(scale))
  }
}

// What a Dec[scale] is called in a reason (compiler/wire.ts says the same of a list's element).
private fn json_dec_kind(scale: Int) -> View {
  match scale {
    0 -> "an integer"
    1 -> "a number with at most 1 decimal"
    _ -> "a number with at most " ++ decimal_text(value: scale) ++ " decimals"
  }
}

// The text of a number, or of a string ("" for anything else): what a Dec field is read from.
private fn json_number_text(found: Option[Json_Tree]) -> View {
  match found {
    Some(value: Json_Num(text)) -> text
    Some(value: Json_Str(text)) -> text
    _ -> ""
  }
}

// The count of a Dec[scale] that `text` is, exactly: JSON's number syntax, the whole text, with no more
// digits after the point than the scale but zeros (`12.300` is 1230 at scale 2, `12.345` is None), and a count
// within the Ints. parse_dec and decode read a Dec with it.
//
//   > json_count(text: "12.3", scale: 2)
//   Some(value: 1230)
//   > json_count(text: "1.25e1", scale: 1)
//   Some(value: 125)
//   > json_count(text: "12.345", scale: 2)
//   None
//   > json_count(text: "-92233720368547758.08", scale: 2)
//   Some(value: -9223372036854775808)
//   > json_count(text: "92233720368547758.08", scale: 2)
//   None
//   > json_count(text: "012", scale: 0)
//   None
private fn json_count(text: View, scale: Int) -> Option[Int] {
  match number_end(v: text, at: 0) {
    Some(value: end) if end == len(text) -> count_exact(text, scale)
    _ -> None
  }
}

// json_count of text that is a JSON number.
private fn count_exact(text: View, scale: Int) -> Option[Int] {
  let i = skip(v: text, at: 0, byte: 45)
  let d = digits_end(v: text, at: i)
  let f = skip(v: text, at: d, byte: 46)
  let e = digits_end(v: text, at: f)
  let tail = trailing_zeros(text, from: f, to: e)
  let tz = match {
    tail == e - f -> tail + trailing_zeros(text, from: i, to: d)
    else -> tail
  }
  let head = leading_zeros(text, from: i, to: d)
  let lz = match {
    head == d - i -> head + leading_zeros(text, from: f, to: e)
    else -> head
  }
  let total = (d - i) + (e - f)
  let shift = exponent_of(text, at: e) - (e - f) + tz + scale
  match {
    total - lz - tz <= 0 -> Some(value: 0)
    shift < 0 or total - lz - tz + shift > 19 -> None
    else -> count_signed(
      found: count_shift(
        found: count_fold(text, i, d, f, k: lz, to: total - tz, value: 0),
        n: shift
      ),
      neg: i > 0
    )
  }
}

// Minus the digits of whole ++ fraction from the k-th up to the `to`-th, folded into `value`: negative, so
// that the least Int is reached; None past it.
private fn count_fold(
  text: View,
  i: Int,
  d: Int,
  f: Int,
  k: Int,
  to: Int,
  value: Int
) -> Option[Int] {
  match {
    k >= to -> Some(value)
    k < d - i -> count_digit(text, i, d, f, k, to, value, digit: text[i + k] - 48)
    else -> count_digit(text, i, d, f, k, to, value, digit: text[f + k - (d - i)] - 48)
  }
}

// One step of count_fold, the k-th digit read.
private fn count_digit(
  text: View,
  i: Int,
  d: Int,
  f: Int,
  k: Int,
  to: Int,
  value: Int,
  digit: Int
) -> Option[Int] {
  match {
    value < (-9223372036854775808 + digit) / 10 -> None
    else -> count_fold(text, i, d, f, k: k + 1, to, value: value * 10 - digit)
  }
}

// The (negative) count times 10^n, None past the least Int.
private fn count_shift(found: Option[Int], n: Int) -> Option[Int] {
  match found {
    Some(value) if n <= 0 -> Some(value)
    Some(value) if value >= -922337203685477580 -> count_shift(
      found: Some(value: value * 10),
      n: n - 1
    )
    _ -> None
  }
}

// The count with its sign: the negative one as it is, or negated, which the least Int cannot be.
private fn count_signed(found: Option[Int], neg: Bool) -> Option[Int] {
  match found {
    Some(value) if neg -> Some(value)
    Some(value) if value > -9223372036854775808 -> Some(value: 0 - value)
    _ -> None
  }
}

// An optional whole number.
private fn json_maybe_int(found: Option[Json_Tree]) -> Option[Int] {
  match found {
    Some(value: Json_Num(text)) -> json_int(text)
    _ -> None
  }
}

// A key that was there: its decoded value as Some.
private fn json_some[T](decoded: Result[T, View]) -> Result[Option[T], View] {
  match decoded {
    Ok(value) -> Ok(value: Some(value))
    Err(error) -> Err(error)
  }
}

// The elements of an array, each decoded by `by`, in order. The first that fails is the reason, with its
// index.
private fn json_each[T](
  arr: Json_Tree,
  by: Fn[Json_Tree, Result[T, View]]
) -> Result[List[T], View] {
  match arr {
    Json_Arr(items) -> json_each_from(items, by, at: 0, acc: Nil)
    _ -> Ok(value: Nil)
  }
}

// The loop of json_each.
private fn json_each_from[T](
  items: List[Json_Tree],
  by: Fn[Json_Tree, Result[T, View]],
  at: Int,
  acc: List[T]
) -> Result[List[T], View] {
  match items {
    Cons(head, tail) -> json_each_next(decoded: by(head), rest: tail, by, at, acc)
    Nil -> Ok(value: reverse(list: acc))
  }
}

// json_each, after one element.
private fn json_each_next[T](
  decoded: Result[T, View],
  rest: List[Json_Tree],
  by: Fn[Json_Tree, Result[T, View]],
  at: Int,
  acc: List[T]
) -> Result[List[T], View] {
  match decoded {
    Ok(value) -> json_each_from(items: rest, by, at: at + 1, acc: Cons(head: value, tail: acc))
    Err(error) -> Err(error: json_join(path: "[" ++ decimal_text(value: at) ++ "]", error))
  }
}

// A reason from inside `path` (a field's name, or `[2]`), with the path before it: `items` and
// `[2].price: missing` are `items[2].price: missing`; `price` and `expected an integer` are `price: expected an
// integer`. A reason with no path of its own is one of the problems: missing, null, expected …, not a valid …, or
// `: ` and a refined type's own message (an element's: compiler/rule.ts elementRefusalOf).
private fn json_join(path: View, error: View) -> View {
  match error {
    "missing" -> path ++ ": " ++ error
    "null" -> path ++ ": " ++ error
    "expected " ++ rest -> path ++ ": " ++ error
    "not a valid " ++ rest -> path ++ ": " ++ error
    ": " ++ rest -> path ++ error
    "[" ++ rest -> path ++ error
    _ -> path ++ "." ++ error
  }
}

// An element that is not an object is read as if it were {"value": …}: its reason without that key.
private fn json_plain(error: View) -> View {
  match error {
    "value: " ++ why -> why
    "value" ++ why -> why
    _ -> error
  }
}

// ---------- whole numbers, exactly ----------

// The value of a JSON number's text when it is a whole number within ±(2^53 - 1), read exactly (no rounding);
// None otherwise. `text` must be a JSON number (number_end found it).
//
//   > json_int(text: "1e3")
//   Some(value: 1000)
//   > json_int(text: "-2.50e1")
//   Some(value: -25)
//   > json_int(text: "1.5")
//   None
//   > json_int(text: "9007199254740992")
//   None
fn json_int(text: View) -> Option[Int] {
  let i = skip(v: text, at: 0, byte: 45)
  let d = digits_end(v: text, at: i)
  let f = skip(v: text, at: d, byte: 46)
  let e = digits_end(v: text, at: f)
  let tail = trailing_zeros(text, from: f, to: e)
  let tz = match {
    tail == e - f -> tail + trailing_zeros(text, from: i, to: d)
    else -> tail
  }
  let head = leading_zeros(text, from: i, to: d)
  let lz = match {
    head == d - i -> head + leading_zeros(text, from: f, to: e)
    else -> head
  }
  let total = (d - i) + (e - f)
  int_exact(
    text,
    whole: slice(v: text, from: i, to: d),
    fraction: slice(v: text, from: f, to: e),
    n: total - lz - tz,
    cut: total - tz,
    scale: exponent_of(text, at: e) - (e - f) + tz,
    neg: i > 0
  )
}

// How many 0 digits end text[from..to].
private fn trailing_zeros(text: View, from: Int, to: Int) -> Int {
  to - back_past_zeros(text, from, at: to)
}

// The loop of trailing_zeros: where the 0 digits that end text[from..at] begin.
private fn back_past_zeros(text: View, from: Int, at: Int) -> Int {
  match {
    at > from and text[at - 1] == 48 -> back_past_zeros(text, from, at: at - 1)
    else -> at
  }
}

// How many 0 digits start text[from..to].
private fn leading_zeros(text: View, from: Int, to: Int) -> Int {
  past_zeros(text, at: from, to) - from
}

// The loop of leading_zeros: the first position at or after `at` that is not a 0 digit.
private fn past_zeros(text: View, at: Int, to: Int) -> Int {
  match {
    at < to and text[at] == 48 -> past_zeros(text, at: at + 1, to)
    else -> at
  }
}

// The first `cut` digits of whole ++ fraction (n of them not leading zeros) times 10^scale, when that is
// a whole number within ±(2^53 - 1).
private fn int_exact(
  text: View,
  whole: View,
  fraction: View,
  n: Int,
  cut: Int,
  scale: Int,
  neg: Bool
) -> Option[Int] {
  match {
    n <= 0 -> Some(value: 0)
    scale < 0 or n + scale > 16 -> None
    cut <= len(whole) -> in_range(
      value: times_ten(value: fold_digits(v: whole, at: 0, to: cut, value: 0), n: scale),
      neg
    )
    else -> in_range(
      value: times_ten(
        value: fold_digits(
          v: fraction,
          at: 0,
          to: cut - len(whole),
          value: fold_digits(v: whole, at: 0, to: len(whole), value: 0)
        ),
        n: scale
      ),
      neg
    )
  }
}

// value followed by the digits v[at..to].
private fn fold_digits(v: View, at: Int, to: Int, value: Int) -> Int {
  match {
    at >= to -> value
    else -> fold_digits(v, at: at + 1, to, value: value * 10 + (v[at] - 48))
  }
}

// The exponent after `at` (0 when there is none), held to ±1000000000 so it cannot overflow.
private fn exponent_of(text: View, at: Int) -> Int {
  match {
    at >= len(text) -> 0
    text[at + 1] == 45 -> 0 - exponent_digits(text, at: at + 2, value: 0)
    text[at + 1] == 43 -> exponent_digits(text, at: at + 2, value: 0)
    else -> exponent_digits(text, at: at + 1, value: 0)
  }
}

// The loop of exponent_of.
private fn exponent_digits(text: View, at: Int, value: Int) -> Int {
  match {
    at >= len(text) -> value
    value > 100000000 -> 1000000000
    else -> exponent_digits(text, at: at + 1, value: value * 10 + (text[at] - 48))
  }
}

// value * 10^n.
private fn times_ten(value: Int, n: Int) -> Int {
  match {
    n <= 0 -> value
    else -> times_ten(value: value * 10, n: n - 1)
  }
}

// Some(±value) when value is at most 2^53 - 1.
private fn in_range(value: Int, neg: Bool) -> Option[Int] {
  match {
    value > 9007199254740991 -> None
    neg -> Some(value: 0 - value)
    else -> Some(value)
  }
}

// Every row of a query as a JSON array, each row written as write_json writes it.
fn write_rows[T](out: Buf, rows: Rows[T]) -> Buf {
  let open = push(buf: out, byte: 91)
  let first = size(buf: open)
  rows
    |> fold_rows(from: open, by: fn(o: Buf, value: T) -> Buf {
      match {
        size(buf: o) == first -> write_json(out: o, value)
        else -> write_json(out: push(buf: o, byte: 44), value)
      }
    })
    |> push(byte: 93)
}
