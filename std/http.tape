// std/http.tape: a request, parsed. The host passes METHOD SP TARGET LF BODY; the target is PATH or PATH?QUERY.
// A request that came through a published name's public route (no token: anyone) ends its line with a word,
// METHOD SP TARGET SP public, and `caller` is Anyone; every other request is the operator's. The request headers
// the host passes follow on the same line, each after a carriage return, `CR name: value`, names in lower case.
// `query` is None when the target has no `?`, and Some("") when it ends with one: they are different requests.

// Who sent a request: the operator (with the token), or Anyone, through a published name's public route.
type Caller {
  Operator
  Anyone
}

// A request as `request(raw)` gives it. `path` is the target before `?`, as sent (percent-encoding is not undone);
// `query` the raw text after `?` (read one parameter with `form_field(body: q, name: "limit")`); `body` what
// follows the first line feed; `headers` the request headers the host passed, read with `header_of`.
//
//   match request(raw) {
//     Request(method: "GET", path: "/items/" ++ decimal(id)) -> …
//     Request(method: "POST", path: "/items", body) -> …
//   }
type Request {
  Request(method: View, path: View, query: Option[View], body: View, caller: Caller, headers: View)
}

// The request `handle` is given, parsed.
//
//   > request(raw: "POST /holds?x=1 public\nqty=1")
//   Request(method: "POST", path: "/holds", query: Some(value: "x=1"), body: "qty=1", caller: Anyone)
//   > request(raw: "GET /k/a b\n")
//   Request(path: "/k/a b", caller: Operator)
//   > request(raw: "GET /items?\n")
//   Request(path: "/items", query: Some(value: ""))
//   > request(raw: "GET /items\n")
//   Request(path: "/items", query: None)
//   > request(raw: "GET /k\raccept: text/html\n") |> header_of(name: "Accept")
//   Some(value: "text/html")
fn request(raw: View) -> Request {
  let whole = until(v: raw, byte: 10)
  let line = until(v: whole, byte: 13)
  let rest = after(v: line, byte: 32)
  let open = len(rest) >= 7 and has(v: rest, at: len(rest) - 7, word: " public")
  let target = slice(v: rest, from: 0, to: len(rest) - 7 * opened(open))
  Request(
    method: until(v: line, byte: 32),
    path: until(v: target, byte: 63),
    query: asked(target),
    body: after(v: raw, byte: 10),
    caller: caller_of(open),
    headers: slice(v: whole, from: len(line), to: len(whole))
  )
}

// The value of a request header, by its name in any case; the first one when there are several. A host passes
// only the headers it means a program to see (the service's list is in docs/service.md: never cookie or
// authorization), and the service adds one of its own, tape-base: where the program is mounted.
//
//   > request(raw: "POST /\rcontent-type: text/csv\ridempotency-key: 7\nbody") |> header_of(name: "Idempotency-Key")
//   Some(value: "7")
//   > request(raw: "GET /\n") |> header_of(name: "accept")
//   None
//   > request(raw: "GET /\rx-a: 1\n") |> header_of(name: "accept")
//   None
fn header_of(request: Request, name: View) -> Option[View] {
  header_from(lines: request.headers, name: "\r" ++ lower(text: name) ++ ": ")
}

// Internal: header_of's search of the header lines.
fn header_from(lines: View, name: View) -> Option[View] {
  match lines {
    "" -> None
    _ -> {
      let at = find_text(v: lines, sep: name, at: 0)
      match {
        at < 0 -> None
        else -> Some(
          value: until(v: slice(v: lines, from: at + len(name), to: len(lines)), byte: 13)
        )
      }
    }
  }
}

// ASCII letters in lower case; every other byte as it is.
//
//   > lower(text: "Content-Type")
//   "content-type"
fn lower(text: View) -> View {
  freeze(buf: lower_from(out: buf(), text, at: 0))
}

// Internal: lower from position `at`.
fn lower_from(out: Buf, text: View, at: Int) -> Buf {
  match {
    at >= len(text) -> out
    is_upper(text[at]) -> lower_from(out: push(buf: out, byte: text[at] + 32), text, at: at + 1)
    else -> lower_from(out: push(buf: out, byte: text[at]), text, at: at + 1)
  }
}

// Internal: only the last word, and only `public`, names the caller: a target with a space in it (never sent by
// the service, which passes the URL's percent-encoded path) is read as before.
fn opened(open: Bool) -> Int {
  match {
    open -> 1
    else -> 0
  }
}

// Internal: Anyone when the request line ended with ` public`.
fn caller_of(open: Bool) -> Caller {
  match {
    open -> Anyone
    else -> Operator
  }
}

// Internal: the query of a target: None without a `?`, else what follows the first `?`.
fn asked(target: View) -> Option[View] {
  match {
    find(v: target, byte: 63, at: 0) == len(target) -> None
    else -> Some(after(v: target, byte: 63))
  }
}

// A response: the status, a line feed, then the body written by the caller. It is served as text/plain. The status
// line is in the Buf, so text to keep (a body to store, a value to compare) starts from `buf()`, not from here.
//
//   > freeze(buf: respond(status: 200) |> append(view: "ok"))
//   "200\nok"
//   > freeze(buf: buf() |> append(view: "ok"))
//   "ok"
fn respond(status: Int) -> Buf {
  push(buf: write_int(out: buf(), value: status), byte: 10)
}

// A response header, on an answer begun by respond or respond_as: `respond(status: 302) |> header(name: "location",
// value: url)`. The status line carries it, after a carriage return: STATUS[ SP TYPE](CR name: value)* LF BODY. A
// name is 1 to 64 token characters (letters, digits, and !#$%&'*+-.^_`|~) and a value up to 4096 bytes with no CR,
// LF or NUL; the host refuses any other (the request is answered 500 and says why), and those it sets itself
// (content-type, which is respond_as's, content-length, set-cookie, the security headers…).
//
//   > respond(status: 302) |> header(name: "Location", value: "/links/7") |> freeze
//   "302\rlocation: /links/7\n"
//   > respond(status: 200) |> append(view: "hi") |> header(name: "cache-control", value: "no-store") |> freeze
//   "200\rcache-control: no-store\nhi"
fn header(out: Buf, name: View, value: View) -> Buf {
  let all = freeze(buf: out)
  let line = until(v: all, byte: 10)
  buf()
    |> append(view: line)
    |> push(byte: 13)
    |> append(view: header_text(name, value))
    |> append(view: slice(v: all, from: len(line), to: len(all)))
}

// Internal: `name: value`, or, for a name or a value the host would refuse, a part it refuses with the reason.
fn header_text(name: View, value: View) -> View {
  match {
    len(name) == 0
      or len(name) > 64
      or not every_byte(v: name, keep: token_byte) -> "!invalid header name"
    len(value) > 4096
      or not every_byte(
        v: value,
        keep: value_byte
      ) -> "!invalid header value for \(lower(text: name))"
    else -> "\(lower(text: name)): \(value)"
  }
}

// Internal: a token character (RFC 9110): a letter, a digit, or one of !#$%&'*+-.^_`|~.
fn token_byte(b: Int) -> Bool {
  is_alnum(b) or (b >= 35 and b <= 39) or token_mark(b)
}

// Internal: the marks among the token characters.
fn token_mark(b: Int) -> Bool {
  match b {
    33 -> True
    42 -> True
    43 -> True
    45 -> True
    46 -> True
    94 -> True
    95 -> True
    96 -> True
    124 -> True
    126 -> True
    _ -> False
  }
}

// Internal: a byte a header value may hold.
fn value_byte(b: Int) -> Bool {
  b != 0 and b != 10 and b != 13
}

// The content types the service serves. respond_as(status: 200, content: Html) answers text/html. Atom, Rss and
// Xml answer application/atom+xml, application/rss+xml and application/xml. The host labels those three, and the
// text types, charset=utf-8, which overrides an encoding declaration in the document. Chrome renders these as
// pages: a script in the XHTML namespace runs, and nosniff does not stop it. The service's content-security-policy
// does, and any host that serves these types must send that policy. application/xhtml+xml is not a Content: a page
// is Html. text/xml is not one: it is obsolete and was sniffed.
type Content {
  Html
  Json
  Text
  Css
  Svg
  Csv
  Atom
  Rss
  Xml
}

// A response with a content type: the status, then the body written by the caller. respond_as(status: 200,
// content: Json) answers application/json; `respond` answers text/plain. Atom is a feed.
//
//   > respond_as(status: 201, content: Json) |> append(view: "{}") |> freeze
//   "201 application/json\n{}"
//   > respond_as(status: 200, content: Atom) |> append(view: "<feed/>") |> freeze
//   "200 application/atom+xml\n<feed/>"
fn respond_as(status: Int, content: Content) -> Buf {
  push(
    buf: append(
      buf: push(buf: write_int(out: buf(), value: status), byte: 32),
      view: content_type(content)
    ),
    byte: 10
  )
}

// The media type a Content is served as. The host writes the Content-Type header from this token.
//
//   > content_type(content: Json)
//   "application/json"
//   > content_type(content: Atom)
//   "application/atom+xml"
//   > content_type(content: Rss)
//   "application/rss+xml"
//   > content_type(content: Xml)
//   "application/xml"
fn content_type(content: Content) -> View {
  match content {
    Html -> "text/html"
    Json -> "application/json"
    Text -> "text/plain"
    Css -> "text/css"
    Svg -> "image/svg+xml"
    Csv -> "text/csv"
    Atom -> "application/atom+xml"
    Rss -> "application/rss+xml"
    Xml -> "application/xml"
  }
}

// One field of an application/x-www-form-urlencoded body (what an HTML form POSTs), decoded: `+` is a space and
// %XX a byte. None when the form has no such field; the first one when it has several. Finding the field is a
// `scan` of `&` and `=`, one step per 16 bytes read, plus a few steps per pair passed. Only the value found is
// decoded. `+` is a space only in a form or a query: in a path it is a `+`, and a path segment is decoded with
// `percent_decoded`, which leaves it one.
//
//   > form_field(body: "qty=2&buyer=ada+l%C3%B6", name: "buyer")
//   Some(value: "ada lö")
//   > form_field(body: "qty=2", name: "buyer")
//   None
//   > form_field(body: "x=1&done", name: "done")
//   Some(value: "")
fn form_field(body: View, name: View) -> Option[View] {
  form_from(body, name, at: 0)
}

// Internal: form_field, from the pair that starts at `at`. The next `&` or `=` is `scan`, one step per 16 bytes
// read, plus a few steps for the pair, and the pair's name is compared as it is decoded, in place. A lookup
// makes nothing for the pairs it passes, only the value it finds.
fn form_from(body: View, name: View, at: Int) -> Option[View] {
  match {
    at > len(body) -> None
    else -> form_stop(body, name, at, stop: scan(body, at, set: "&="))
  }
}

// Internal: form_from, once the next `&` or `=` is known.
fn form_stop(body: View, name: View, at: Int, stop: Int) -> Option[View] {
  match {
    stop < len(body) and body[stop] == 61 -> form_value(body, name, at, eq: stop)
    form_named(raw: slice(v: body, from: at, to: stop), name, at: 0, n: 0) -> Some(value: "")
    stop >= len(body) -> None
    else -> form_from(body, name, at: stop + 1)
  }
}

// Internal: the pair has an `=`, so the value runs from the byte after it to the next `&`.
fn form_value(body: View, name: View, at: Int, eq: Int) -> Option[View] {
  let end = scan(body, at: eq + 1, set: "&")
  match {
    form_named(
      raw: slice(v: body, from: at, to: eq),
      name,
      at: 0,
      n: 0
    ) -> Some(value: form_decoded(raw: slice(v: body, from: eq + 1, to: end)))
    end >= len(body) -> None
    else -> form_from(body, name, at: end + 1)
  }
}

// Internal: whether raw[at..], `+` and %XX decoded as form_bytes decodes them, is name[n..].
fn form_named(raw: View, name: View, at: Int, n: Int) -> Bool {
  match {
    at >= len(raw) -> n == len(name)
    n >= len(name) -> False
    raw[at] == 43 -> name[n] == 32 and form_named(raw, name, at: at + 1, n: n + 1)
    raw[at] == 37
      and at + 2 < len(raw)
      and is_hex(raw[at + 1])
      and is_hex(raw[at + 2]) -> name[n] == (hex(raw[at + 1]) << 4) | hex(raw[at + 2])
      and form_named(raw, name, at: at + 3, n: n + 1)
    else -> name[n] == raw[at] and form_named(raw, name, at: at + 1, n: n + 1)
  }
}

// Internal: one name or value of a form, `+` and %XX decoded. Form encoding, not a path's: `percent_decoded` is
// the path's, where `+` stays a `+`, and it refuses what this passes through (a bad escape, bytes that are not
// UTF-8).
fn form_decoded(raw: View) -> View {
  freeze(buf: form_bytes(out: buf(), raw, at: 0))
}

// Internal: the loop of form_decoded.
fn form_bytes(out: Buf, raw: View, at: Int) -> Buf {
  match {
    at >= len(raw) -> out
    raw[at] == 43 -> form_bytes(out: push(buf: out, byte: 32), raw, at: at + 1)
    raw[at] == 37
      and at + 2 < len(raw)
      and is_hex(raw[at + 1])
      and is_hex(raw[at + 2]) -> form_bytes(
        out: push(buf: out, byte: (hex(raw[at + 1]) << 4) | hex(raw[at + 2])),
        raw,
        at: at + 3
      )
    else -> form_bytes(out: push(buf: out, byte: raw[at]), raw, at: at + 1)
  }
}

// A path segment with its percent-encoding undone (RFC 3986): each %XX is the byte XX, hex in either case. Apply it
// to a segment the route has already bound, as a pattern: `path: "/users/" ++ percent_decoded(name) ++ "/tickets"`.
// `Request.path` stays as sent, so the route is matched on the encoded path: a `%2F` in a segment cannot become a
// `/` that moves the match, nor `%2e%2e` a `..`. What comes out may hold `/`, `..`, a space or a NUL, so check it
// (a refined type) before it names anything. None when a `%` is not followed by two hex digits, and when the bytes
// are not UTF-8 once decoded: where JavaScript's decodeURIComponent throws. A `+` stays a `+`: it is a space only
// in form encoding, which `form_field` decodes. Its cost is in steps (LANGUAGE.md section 10): a `scan` for `%`,
// one step per 16 bytes read, and two steps an escape; then a check that the result is UTF-8, one step per 16 bytes
// of ASCII and three a character past it. A 1,600-byte segment with no escape takes 200 steps; `%C3%B6` (ö) 100
// times, 702 (test/percent.ts).
//
//   > percent_decoded(text: "ada%20l")
//   Some(value: "ada l")
//   > percent_decoded(text: "a+b%2Fc")
//   Some(value: "a+b/c")
//   > percent_decoded(text: "l%C3%B6")
//   Some(value: "lö")
//   > percent_decoded(text: "100%")
//   None
//   > percent_decoded(text: "%zz")
//   None
//   > percent_decoded(text: "%C3")
//   None
fn percent_decoded(text: View) -> Option[View] {
  let decoded = match {
    scan(v: text, at: 0, set: "%") >= len(text) -> text
    else -> freeze(buf: percent_bytes(out: buf(), text, at: 0))
  }
  match {
    utf8_whole(v: decoded, at: 0) -> Some(value: decoded)
    else -> None
  }
}

// Internal: the loop of percent_decoded, from `at`: the bytes up to the next `%` as they are, then its escape. An
// escape without two hex digits is written as 255, a byte UTF-8 never holds, so the check after makes it None.
fn percent_bytes(out: Buf, text: View, at: Int) -> Buf {
  let p = scan(v: text, at, set: "%")
  let copied = append(buf: out, view: slice(v: text, from: at, to: p))
  match {
    p >= len(text) -> copied
    p + 2 < len(text)
      and is_hex(text[p + 1])
      and is_hex(text[p + 2]) -> percent_bytes(
        out: push(buf: copied, byte: (hex(text[p + 1]) << 4) | hex(text[p + 2])),
        text,
        at: p + 3
      )
    else -> push(buf: copied, byte: 255)
  }
}

// Internal: is v, from `at`, UTF-8 (RFC 3629)? ASCII is passed 16 bytes at a time (text_run's scan_plain).
fn utf8_whole(v: View, at: Int) -> Bool {
  let e = text_run(v, at)
  match {
    e >= len(v) -> True
    v[e] < 128 -> utf8_whole(v, at: e + 1)
    else -> False
  }
}

// Text into HTML, as text: & < > " and ' are written as entities, so a value from a request (a name, a note)
// cannot open a tag or end an attribute.
//
//   > freeze(buf: write_html(out: buf(), text: "<b>Tom & \"Jo\"</b>"))
//   "&lt;b&gt;Tom &amp; &quot;Jo&quot;&lt;/b&gt;"
fn write_html(out: Buf, text: View) -> Buf {
  html_from(out, text, at: 0)
}

// Internal: the loop of write_html.
fn html_from(out: Buf, text: View, at: Int) -> Buf {
  match {
    at >= len(text) -> out
    text[at] == 38 -> html_from(out: append(buf: out, view: "&amp;"), text, at: at + 1)
    text[at] == 60 -> html_from(out: append(buf: out, view: "&lt;"), text, at: at + 1)
    text[at] == 62 -> html_from(out: append(buf: out, view: "&gt;"), text, at: at + 1)
    text[at] == 34 -> html_from(out: append(buf: out, view: "&quot;"), text, at: at + 1)
    text[at] == 39 -> html_from(out: append(buf: out, view: "&#39;"), text, at: at + 1)
    else -> html_from(out: push(buf: out, byte: text[at]), text, at: at + 1)
  }
}
