// std/http.tape: a request, parsed. The host passes METHOD SP TARGET LF BODY; the target is PATH or PATH?QUERY.
// A request that came through a published name's public route (no token: anyone) ends its line with a word,
// METHOD SP TARGET SP public, and `caller` is Anyone; every other request is the operator's.
// `query` is None when the target has no `?`, and Some("") when it ends with one: they are different requests.

// Who sent a request: the operator (with the token), or Anyone, through a published name's public route.
type Caller {
  Operator
  Anyone
}

// A request as `request(raw)` gives it. `path` is the target before `?`, as sent (percent-encoding is not undone);
// `query` the raw text after `?` (read one parameter with `form_field(body: q, name: "limit")`); `body` what
// follows the first line feed. There are no headers.
//
//   match request(raw) {
//     Request(method: "GET", path: "/items/" ++ decimal(id)) -> …
//     Request(method: "POST", path: "/items", body) -> …
//   }
type Request {
  Request(method: View, path: View, query: Option[View], body: View, caller: Caller)
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
fn request(raw: View) -> Request {
  let line = until(v: raw, byte: 10)
  let rest = after(v: line, byte: 32)
  let open = len(rest) >= 7 and has(v: rest, at: len(rest) - 7, word: " public")
  let target = slice(v: rest, from: 0, to: len(rest) - 7 * opened(open))
  Request(
    method: until(v: line, byte: 32),
    path: until(v: target, byte: 63),
    query: asked(target),
    body: after(v: raw, byte: 10),
    caller: caller_of(open)
  )
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

// A response: the status, a line feed, then the body written by the caller. It is served as text/plain.
fn respond(status: Int) -> Buf {
  push(buf: write_int(out: buf(), value: status), byte: 10)
}

// The content types the service serves: respond_as(status: 200, content: Html) answers text/html.
type Content {
  Html
  Json
  Text
  Css
  Svg
}

// A response with a content type: the status, then the body written by the caller. respond_as(status: 200,
// content: Json) answers application/json; `respond` answers text/plain.
//
//   > respond_as(status: 201, content: Json) |> append(view: "{}") |> freeze
//   "201 application/json\n{}"
fn respond_as(status: Int, content: Content) -> Buf {
  push(
    buf: append(
      buf: push(buf: write_int(out: buf(), value: status), byte: 32),
      view: content_type(content)
    ),
    byte: 10
  )
}

// The media type a Content is served as.
//
//   > content_type(content: Json)
//   "application/json"
fn content_type(content: Content) -> View {
  match content {
    Html -> "text/html"
    Json -> "application/json"
    Text -> "text/plain"
    Css -> "text/css"
    Svg -> "image/svg+xml"
  }
}

// One field of an application/x-www-form-urlencoded body (what an HTML form POSTs), decoded: `+` is a space and
// %XX a byte. None when the form has no such field; the first one when it has several.
//
//   > form_field(body: "qty=2&buyer=ada+l%C3%B6", name: "buyer")
//   Some(value: "ada lö")
//   > form_field(body: "qty=2", name: "buyer")
//   None
fn form_field(body: View, name: View) -> Option[View] {
  form_from(body, name, at: 0)
}

// Internal: form_field, from the pair that starts at `at`.
fn form_from(body: View, name: View, at: Int) -> Option[View] {
  let end = find(v: body, byte: 38, at)
  let pair = slice(v: body, from: at, to: end)
  match {
    same(
      a: form_decoded(raw: until(v: pair, byte: 61)),
      b: name
    ) -> Some(value: form_decoded(raw: after(v: pair, byte: 61)))
    end >= len(body) -> None
    else -> form_from(body, name, at: end + 1)
  }
}

// Internal: one name or value of a form, `+` and %XX decoded.
fn form_decoded(raw: View) -> View {
  freeze(buf: form_bytes(out: buf(), raw, at: 0))
}

// Internal: the loop of form_decoded.
fn form_bytes(out: Buf, raw: View, at: Int) -> Buf {
  match {
    at >= len(raw) -> out
    raw[at] == 43 -> form_bytes(out: push(buf: out, byte: 32), raw, at: at + 1)
    raw[at] == 37 and at + 2 < len(raw) and is_hex(raw[at + 1]) and is_hex(
      raw[at + 2]
    ) -> form_bytes(
      out: push(buf: out, byte: (hex(raw[at + 1]) << 4) | hex(raw[at + 2])),
      raw,
      at: at + 3
    )
    else -> form_bytes(out: push(buf: out, byte: raw[at]), raw, at: at + 1)
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
