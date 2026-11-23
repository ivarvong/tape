// std/text.tape: bytes and text.

// The part of v before the first `byte`, or all of v when it has none.
//
//   > until(v: "key=value", byte: 61)
//   "key"
//   > "no equals sign" |> until(byte: 61)
//   "no equals sign"
fn until(v: View, byte: Int) -> View {
  slice(v, from: 0, to: find(v, byte, at: 0))
}

// The part of v after the first `byte`, or nothing when it has none.
//
//   > after(v: "key=value", byte: 61)
//   "value"
//   > after(v: "key", byte: 61)
//   ""
fn after(v: View, byte: Int) -> View {
  let at = find(v, byte, at: 0)
  match {
    at < len(v) -> slice(v, from: at + 1, to: len(v))
    else -> ""
  }
}

// The position of the first `byte` at or after `at`, or len(v).
fn find(v: View, byte: Int, at: Int) -> Int {
  match {
    at >= len(v) or v[at] == byte -> at
    else -> find(v, byte, at: at + 1)
  }
}

// Does v begin with `prefix`?
//
//   > starts_with(v: "/todos/7", prefix: "/todos/")
//   True
//   > "/todo" |> starts_with(prefix: "/todos/")
//   False
fn starts_with(v: View, prefix: View) -> Bool {
  len(v) >= len(prefix) and slice(v, from: 0, to: len(prefix)) == prefix
}

// Is `word` at position `at` of v?
fn has(v: View, at: Int, word: View) -> Bool {
  at + len(word) <= len(v) and slice(v, from: at, to: at + len(word)) == word
}

// Is the byte an ASCII digit, 0-9?
//
//   > is_digit(b: 55)
//   True
//   > is_digit(b: 97)
//   False
fn is_digit(b: Int) -> Bool {
  b >= 48 and b <= 57
}

// Is the byte an ASCII lower-case letter, a-z?
//
//   > is_lower(b: "a"[0])
//   True
fn is_lower(b: Int) -> Bool {
  b >= 97 and b <= 122
}

// Is the byte an ASCII upper-case letter, A-Z?
//
//   > is_upper(b: "a"[0])
//   False
fn is_upper(b: Int) -> Bool {
  b >= 65 and b <= 90
}

// Is the byte an ASCII letter, a-z or A-Z?
//
//   > is_alpha(b: "_"[0])
//   False
fn is_alpha(b: Int) -> Bool {
  is_lower(b) or is_upper(b)
}

// Is the byte an ASCII letter or digit?
//
//   > is_alnum(b: "Z"[0])
//   True
fn is_alnum(b: Int) -> Bool {
  is_alpha(b) or is_digit(b)
}

// Is the byte white space: a space, a tab, a line feed or a carriage return?
//
//   > is_space(b: 9)
//   True
fn is_space(b: Int) -> Bool {
  b == 32 or b == 9 or b == 10 or b == 13
}

// Does every byte of v pass `keep`? True for "" (nothing fails). For a slug, a key or a code of a fixed alphabet:
//
//   > every_byte(v: "order-17", keep: fn(b: Int) -> Bool { is_lower(b) or is_digit(b) or b == 45 })
//   True
//   > every_byte(v: "Order 17", keep: is_alnum)
//   False
fn every_byte(v: View, keep: Fn[Int, Bool]) -> Bool {
  every_from(v, keep, at: 0)
}

// Internal: every_byte from position `at`.
fn every_from(v: View, keep: Fn[Int, Bool], at: Int) -> Bool {
  match {
    at >= len(v) -> True
    keep(v[at]) -> every_from(v, keep, at: at + 1)
    else -> False
  }
}

// How many characters v holds: its code points, each UTF-8 sequence counted once, where `len` counts bytes ("é" is
// 2 bytes and 1 character). For a limit a spec states in characters: `type Name = View where char_count(v: self)
// <= 64`. Text that is not valid UTF-8 counts each byte that does not continue a sequence.
//
//   > char_count(v: "日本語")
//   3
//   > char_count(v: "é!")
//   2
fn char_count(v: View) -> Int {
  chars_from(v, at: 0, n: 0)
}

// Internal: char_count from position `at`, n counted so far.
fn chars_from(v: View, at: Int, n: Int) -> Int {
  match {
    at >= len(v) -> n
    (v[at] & 192) == 128 -> chars_from(v, at: at + 1, n)
    else -> chars_from(v, at: at + 1, n: n + 1)
  }
}

// The square root of `n`, rounded down: the largest r with r * r <= n. None when n is negative. Exact for every
// Int, up to the largest (whose root is 3037000499). For fixed point, scale first: the root of 2 to 3 places is
// isqrt(2 * 1000 * 1000), 1414 thousandths.
//
//   > isqrt(n: 17)
//   Some(value: 4)
//   > isqrt(n: 2 * 1000 * 1000)
//   Some(value: 1414)
//   > isqrt(n: -1)
//   None
fn isqrt(n: Int) -> Option[Int] {
  match {
    n < 0 -> None
    else -> Some(value: root_between(n, lo: 0, hi: 3037000499))
  }
}

// Internal: isqrt's search; the root is in lo..hi, and hi * hi never overflows.
fn root_between(n: Int, lo: Int, hi: Int) -> Int {
  let mid = lo + (hi - lo + 1) / 2
  match {
    lo >= hi -> lo
    mid * mid <= n -> root_between(n, lo: mid, hi)
    else -> root_between(n, lo, hi: mid - 1)
  }
}

// The position of the first byte at or after `at` that is not a digit.
fn digits_end(v: View, at: Int) -> Int {
  match {
    at < len(v) and is_digit(v[at]) -> digits_end(v, at: at + 1)
    else -> at
  }
}

// A canonical decimal number: digits only, no leading zero, at most 16 digits.
//
//   > decimal(v: "42")
//   Some(value: 42)
//   > decimal(v: "042")
//   None
//   > decimal(v: "12a")
//   None
fn decimal(v: View) -> Option[Int] {
  match {
    len(v) == 0 or len(v) > 16 or digits_end(v, at: 0) < len(v) -> None
    v[0] == 48 and len(v) > 1 -> None
    else -> Some(decimal_value(v, at: 0, value: 0))
  }
}

// Internal: the loop of decimal.
fn decimal_value(v: View, at: Int, value: Int) -> Int {
  match {
    at >= len(v) -> value
    else -> decimal_value(v, at: at + 1, value: value * 10 + v[at] - 48)
  }
}

// An integer as people write one: an optional sign (`-` or `+`), then one or more digits, leading zeros and all;
// None for anything else, and for a number an Int cannot hold. For a value from a form, a query or a CSV field.
// `decimal` is the strict one, for ids in a path: no sign, no leading zero, so "/orders/007" is not order 7.
//
//   > parse_int(text: "007")
//   Some(value: 7)
//   > parse_int(text: "-42")
//   Some(value: -42)
//   > parse_int(text: "+5")
//   Some(value: 5)
//   > parse_int(text: "-9223372036854775808")
//   Some(value: -9223372036854775808)
//   > parse_int(text: "9223372036854775808")
//   None
//   > parse_int(text: "1.5")
//   None
//   > parse_int(text: "-")
//   None
fn parse_int(text: View) -> Option[Int] {
  match text {
    "-" ++ rest -> int_digits(text: rest, at: 0, value: 0, negative: True)
    "+" ++ rest -> int_digits(text: rest, at: 0, value: 0, negative: False)
    _ -> int_digits(text, at: 0, value: 0, negative: False)
  }
}

// Internal: parse_int's digits from `at` on, added to `value`, kept negative for a negative number so that the
// least Int fits.
fn int_digits(text: View, at: Int, value: Int, negative: Bool) -> Option[Int] {
  match {
    len(text) == 0 or not is_digit(text[at]) -> None
    else -> int_more(text, at, value, negative)
  }
}

// Internal: parse_int's digits after the first.
fn int_more(text: View, at: Int, value: Int, negative: Bool) -> Option[Int] {
  match {
    at >= len(text) -> Some(value)
    not is_digit(text[at]) -> None
    negative and value < (-9223372036854775808 + (text[at] - 48)) / 10 -> None
    negative -> int_more(text, at: at + 1, value: value * 10 - (text[at] - 48), negative)
    value > (9223372036854775807 - (text[at] - 48)) / 10 -> None
    else -> int_more(text, at: at + 1, value: value * 10 + (text[at] - 48), negative)
  }
}

// A number in decimal, as text.
//
//   > decimal_text(value: 2000)
//   "2000"
//   > "attempt " ++ decimal_text(value: -3)
//   "attempt -3"
fn decimal_text(value: Int) -> View {
  buf() |> write_int(value) |> freeze
}

// Appends a number in decimal.
//
//   > buf() |> append(view: "n=") |> write_int(value: -305) |> freeze
//   "n=-305"
fn write_int(out: Buf, value: Int) -> Buf {
  match {
    value < 0 -> write_digits(
      out: push(buf: out, byte: 45),
      value: 0 - (value / 10),
      last: 0 - (value % 10)
    )
    else -> write_digits(out, value: value / 10, last: value % 10)
  }
}

// Internal: the loop of write_int.
fn write_digits(out: Buf, value: Int, last: Int) -> Buf {
  match {
    value > 0 -> push(buf: write_digits(out, value: value / 10, last: value % 10), byte: 48 + last)
    else -> push(buf: out, byte: 48 + last)
  }
}

// Internal: units · 10^-scale with exactly `scale` digits after the point, as a hole and write_json write a Dec
// (1230 at scale 2 is 12.30). The least Int is written without being negated.
//
//   > buf() |> write_units(units: -5, scale: 2) |> freeze
//   "-0.05"
//   > buf() |> write_units(units: 1230, scale: 0) |> freeze
//   "1230"
//   > buf() |> write_units(units: -9223372036854775808, scale: 18) |> freeze
//   "-9.223372036854775808"
fn write_units(out: Buf, units: Int, scale: Int) -> Buf {
  let n = units_digits(units: units / 10, scale, n: 1)
  let signed = match {
    units < 0 -> push(buf: out, byte: 45)
    else -> out
  }
  write_places(out: signed, units, at: n - 1, p: ten_power(n: n - 1, p: 1), scale)
}

// Internal: how many digits write_units writes: those of the units (here divided by 10 once already), and at least
// one more than the scale.
fn units_digits(units: Int, scale: Int, n: Int) -> Int {
  match {
    units != 0 or n <= scale -> units_digits(units: units / 10, scale, n: n + 1)
    else -> n
  }
}

// Internal: p · 10^n.
fn ten_power(n: Int, p: Int) -> Int {
  match {
    n <= 0 -> p
    else -> ten_power(n: n - 1, p: p * 10)
  }
}

// Internal: the digit worth p (10^at) and those after it, with the point after the digit worth 10^scale.
fn write_places(out: Buf, units: Int, at: Int, p: Int, scale: Int) -> Buf {
  let d = units / p % 10
  let digit = push(buf: out, byte: 48 + match {
    d < 0 -> 0 - d
    else -> d
  })
  match {
    at == 0 -> digit
    at == scale -> write_places(
      out: push(buf: digit, byte: 46),
      units,
      at: at - 1,
      p: p / 10,
      scale
    )
    else -> write_places(out: digit, units, at: at - 1, p: p / 10, scale)
  }
}

// Appends text: append(buf: out, view: text) with the names write_* use.
fn write_text(out: Buf, text: View) -> Buf {
  append(buf: out, view: text)
}

// Appends a code point as UTF-8.
fn write_code(out: Buf, code: Int) -> Buf {
  match {
    code < 128 -> push(buf: out, byte: code)
    code < 2048 -> push(buf: push(buf: out, byte: 192 | (code >> 6)), byte: 128 | (code & 63))
    code < 65536 -> push(
      buf: push(buf: push(buf: out, byte: 224 | (code >> 12)), byte: 128 | ((code >> 6) & 63)),
      byte: 128 | (code & 63)
    )
    else -> push(
      buf: push(
        buf: push(buf: push(buf: out, byte: 240 | (code >> 18)), byte: 128 | ((code >> 12) & 63)),
        byte: 128 | ((code >> 6) & 63)
      ),
      byte: 128 | (code & 63)
    )
  }
}

// One UTF-8 sequence starting at a byte >= 128 (RFC 3629: no overlong forms, no surrogates, nothing above U+10FFFF).
type Utf8 {
  Utf8(code: Int, next: Int)
  BadUtf8
}

// The code point that starts at `at` (a byte of 128 or more), and where the next one starts; BadUtf8 when it is not
// valid UTF-8.
fn utf8_at(v: View, at: Int) -> Utf8 {
  let b = v[at]
  match {
    b >= 194 and b < 224 and cont(v, at: at + 1) -> Utf8(
      code: ((b & 31) << 6) | (v[at + 1] & 63),
      next: at + 2
    )
    b >= 224 and b < 240 and cont(v, at: at + 1) and cont(v, at: at + 2) and second_of_3(
      b,
      c: v[at + 1]
    ) -> Utf8(
      code: ((b & 15) << 12) | ((v[at + 1] & 63) << 6) | (v[at + 2] & 63),
      next: at + 3
    )
    b >= 240 and b <= 244 and cont(v, at: at + 1) and cont(v, at: at + 2) and cont(
      v,
      at: at + 3
    ) and second_of_4(
      b,
      c: v[at + 1]
    ) -> Utf8(
      code: ((b & 7) << 18) | ((v[at + 1] & 63) << 12) | ((v[at + 2] & 63) << 6) | (v[at + 3] & 63),
      next: at + 4
    )
    else -> BadUtf8
  }
}

// Internal: is the byte at `at` a UTF-8 continuation byte?
fn cont(v: View, at: Int) -> Bool {
  at < len(v) and (v[at] & 192) == 128
}

// Internal: the second byte of a three-byte sequence is allowed after `b` (no overlong forms, no surrogates).
fn second_of_3(b: Int, c: Int) -> Bool {
  (b != 224 or c >= 160) and (b != 237 or c <= 159)
}

// Internal: the second byte of a four-byte sequence is allowed after `b` (no overlong forms, nothing above U+10FFFF).
fn second_of_4(b: Int, c: Int) -> Bool {
  (b != 240 or c >= 144) and (b != 244 or c <= 143)
}
