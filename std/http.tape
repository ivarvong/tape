// std/http.tape: a request, parsed. The host passes METHOD SP TARGET LF BODY; the target is PATH or PATH?QUERY.
// A request that came through a published name's public route (no token: anyone) ends its line with a word,
// METHOD SP TARGET SP public, and `caller` is Anyone; every other request is the operator's. The request headers
// the host passes follow on the same line, each after a carriage return, `CR name: value`, names in lower case.
// `query` is None when the target has no `?`, and Some("") when it ends with one: they are different requests.
// What `handle` gives back is a Response (below), never bytes: the host writes the status and the headers from it.

// Who sent a request: the operator (with the token), or Anyone, through a published name's public route.
type Caller {
  Operator
  Anyone
}

// The method of a request. A token HTTP does not name here (`PROPFIND`, a method in lower case: methods are
// case-sensitive) is Other with the token. The service runs a HEAD request as the GET it stands for and sends no
// body, so `handle` sees Get; Head is given only by a host that passes HEAD through.
type Method {
  Get
  Head
  Post
  Put
  Patch
  Delete
  Options
  Other(name: View)
}

// A request as `request(raw)` gives it. `path` is the target before `?`, as sent (percent-encoding is not undone);
// `query` the raw text after `?` (read one parameter with `form_field(body: q, name: "limit")`); `body` what
// follows the first line feed; `headers` the request headers the host passed, read with `header_of`.
//
//   match request(raw) {
//     Request(method: Get, path: "/items/" ++ decimal(id)) -> …
//     Request(method: Post, path: "/items", body) -> …
//   }
type Request {
  Request(
    method: Method,
    path: View,
    query: Option[View],
    body: View,
    caller: Caller,
    headers: View
  )
}

// The request `handle` is given, parsed.
//
//   > request(raw: "POST /holds?x=1 public\nqty=1")
//   Request(method: Post, path: "/holds", query: Some(value: "x=1"), body: "qty=1", caller: Anyone)
//   > request(raw: "PROPFIND /k\n").method
//   Other(name: "PROPFIND")
//   > request(raw: "GET /k/a b\n")
//   Request(path: "/k/a b", caller: Operator)
//   > request(raw: "GET /items?\n")
//   Request(path: "/items", query: Some(value: ""))
//   > request(raw: "GET /items\n")
//   Request(path: "/items", query: None)
//   > request(raw: "GET /k\raccept: text/html\n") |> header_of(name: "Accept")
//   Some(value: "text/html")
fn request(raw: View) -> Request {
  let whole = until(v: raw, byte: '\n')
  let line = until(v: whole, byte: '\r')
  let rest = after(v: line, byte: ' ')
  let open = len(rest) >= 7 and has(v: rest, at: len(rest) - 7, word: " public")
  let target = slice(v: rest, from: 0, to: len(rest) - 7 * opened(open))
  Request(
    method: method_of(token: until(v: line, byte: ' ')),
    path: until(v: target, byte: '?'),
    query: asked(target),
    body: after(v: raw, byte: '\n'),
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

// header_of's search of the header lines.
private fn header_from(lines: View, name: View) -> Option[View] {
  match lines {
    "" -> None
    _ -> {
      let at = find_text(v: lines, sep: name, at: 0)
      match {
        at < 0 -> None
        else -> Some(
          value: until(v: slice(v: lines, from: at + len(name), to: len(lines)), byte: '\r')
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

// lower from position `at`.
private fn lower_from(out: Buf, text: View, at: Int) -> Buf {
  match {
    at >= len(text) -> out
    is_upper(text[at]) -> lower_from(out: push(buf: out, byte: text[at] + 32), text, at: at + 1)
    else -> lower_from(out: push(buf: out, byte: text[at]), text, at: at + 1)
  }
}

// The Method a request line's first word names.
private fn method_of(token: View) -> Method {
  match token {
    "GET" -> Get
    "HEAD" -> Head
    "POST" -> Post
    "PUT" -> Put
    "PATCH" -> Patch
    "DELETE" -> Delete
    "OPTIONS" -> Options
    _ -> Other(name: token)
  }
}

// Only the last word, and only `public`, names the caller: a target with a space in it (never sent by
// the service, which passes the URL's percent-encoded path) is read as before.
private fn opened(open: Bool) -> Int {
  match {
    open -> 1
    else -> 0
  }
}

// Anyone when the request line ended with ` public`.
private fn caller_of(open: Bool) -> Caller {
  match {
    open -> Anyone
    else -> Operator
  }
}

// The query of a target: None without a `?`, else what follows the first `?`.
private fn asked(target: View) -> Option[View] {
  match {
    find(v: target, byte: '?', at: 0) == len(target) -> None
    else -> Some(after(v: target, byte: '?'))
  }
}

// The content types the service serves: respond_as(body: b, status: 200, content: Html) answers text/html. Atom,
// Rss and Xml answer application/atom+xml, application/rss+xml and application/xml. The host labels those three,
// and the text types, charset=utf-8, which overrides an encoding declaration in the document. Chrome renders these
// as pages: a script in the XHTML namespace runs, and nosniff does not stop it. The service's
// content-security-policy does, and any host that serves these types must send that policy.
// application/xhtml+xml is not a Content: a page is Html. text/xml is not one: it is obsolete and was sniffed.
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

// A response header, as `header` adds one: the name in lower case, and the value as given.
type Header {
  Header(name: View, value: View)
}

// What `handle` answers: a status, the type of the body, the headers set with `header` (the last one set first),
// and the body. The host writes the status line and the headers from these fields, so no byte of the body, from a
// request or a row, can become a status or a header. Build one with respond, respond_as, json, empty or redirect.
// The host refuses (answers 500, and says why) a status outside 200 to 599, a body on 204, 205 or 304, a header
// it sets itself, and a name or a value it would not send.
type Response {
  Response(status: Int, content: Content, headers: List[Header], body: View)
}

// The body written so far, answered as text/plain with a status: the body is written first, from `buf()`, and the
// status is attached last.
//
//   > buf() |> append(view: "ok") |> respond(status: 200)
//   Response(status: 200, content: Text, headers: Nil, body: "ok")
fn respond(body: Buf, status: Int) -> Response {
  Response(status, content: Text, headers: Nil, body: freeze(buf: body))
}

// The body written so far, answered with a status and a content type: `buf() |> write_rows(rows: r) |>
// respond_as(status: 200, content: Json)` answers application/json, `content: Atom` a feed. A value as JSON is
// `json`, one call.
//
//   > buf() |> append(view: "<feed/>") |> respond_as(status: 200, content: Atom)
//   Response(status: 200, content: Atom, body: "<feed/>")
fn respond_as(body: Buf, status: Int, content: Content) -> Response {
  Response(status, content, headers: Nil, body: freeze(buf: body))
}

// A value as JSON, answered as application/json: `json(status: 201, value: order)` is `buf() |> write_json(value:
// order) |> respond_as(status: 201, content: Json)`.
//
//   > json(status: 201, value: Cons(head: 7, tail: Nil))
//   Response(status: 201, content: Json, body: "[7]")
fn json[T](status: Int, value: T) -> Response {
  buf() |> write_json(value) |> respond_as(status, content: Json)
}

// A response with no body: `empty(status: 204)` for a delete, `empty(status: 304)` for a fresh cache.
//
//   > empty(status: 204)
//   Response(status: 204, body: "")
fn empty(status: Int) -> Response {
  Response(status, content: Text, headers: Nil, body: "")
}

// A redirect to `to`, a path or a URL: 303 See Other with a location. 303 is the one a browser follows with a GET
// whatever the request was, which is what answering a form's POST with the page to go to means; 302 lets a client
// send the POST again. Another status is `empty(status: 308) |> header(name: "location", value: to)`.
//
//   > redirect(to: "/links/7")
//   Response(status: 303, headers: Cons(head: Header(name: "location", value: "/links/7"), tail: Nil))
fn redirect(to: View) -> Response {
  empty(status: 303) |> header(name: "location", value: to)
}

// A response header: `respond(body: b, status: 200) |> header(name: "cache-control", value: "no-store")`. The name
// is written in lower case. A name is 1 to 64 token characters (letters, digits, and !#$%&'*+-.^_`|~) and a value
// up to 4096 bytes of printable ASCII, spaces and tabs (no CR, LF, NUL, or byte past ASCII: percent-encode a URL);
// the host refuses any other (the request is answered 500, and says why), and those it sets itself (content-type,
// which is respond_as's, content-length, set-cookie, the security headers…), and more than 32. Adding one copies
// nothing: the body is not touched.
//
//   > empty(status: 302) |> header(name: "Location", value: "/links/7")
//   Response(status: 302, headers: Cons(head: Header(name: "location", value: "/links/7"), tail: Nil))
fn header(out: Response, name: View, value: View) -> Response {
  let Response(status, content, headers, body) = out
  Response(
    status,
    content,
    headers: Cons(head: Header(name: lower(text: name), value), tail: headers),
    body
  )
}

// The answer `handle` gave, as the host reads it (host/run.ts answered, then host.ts responseOf), written by the
// function the compiler generates around `handle`, and by nothing a program can call. A 0 byte and "tap", the
// version (1), the status as 8 bytes, the content as one (its constructor's place in Content, Html 0 to Xml 8), the
// number of headers as 4, then each header in the order it was set: its name's length as 4 bytes, the name, its
// value's length as 4 bytes and the value; then where the body is, its address and its length as 4 bytes each
// (answer_body): the body is not copied after the head, the host reads it where it lies. Every number is
// little-endian and as wide as what it holds, so nothing is cut: a status of 65736 is read as 65736 and refused,
// not as 200.
private fn framed(answer: Response) -> Buf {
  let Response(status, content, headers, body) = answer
  buf()
    |> push(byte: 0)
    |> append(view: "tap")
    |> push(byte: 1)
    |> frame_u32(value: status & 4294967295)
    |> frame_u32(value: (status >> 32) & 4294967295)
    |> push(byte: content_tag(content))
    |> frame_u32(value: header_count(headers, n: 0))
    |> frame_headers(headers)
    |> answer_body(body)
}

// The headers in the order they were set: the list holds the last set first, so the rest is written before it.
private fn frame_headers(out: Buf, headers: List[Header]) -> Buf {
  match headers {
    Cons(head, tail) -> frame_headers(out, headers: tail) |> frame_header(given: head)
    Nil -> out
  }
}

// How many headers there are.
private fn header_count(headers: List[Header], n: Int) -> Int {
  match headers {
    Cons(tail) -> header_count(headers: tail, n: n + 1)
    Nil -> n
  }
}

// One header of the frame.
private fn frame_header(out: Buf, given: Header) -> Buf {
  let Header(name, value) = given
  out
    |> frame_u32(value: len(name))
    |> append(view: name)
    |> frame_u32(value: len(value))
    |> append(view: value)
}

// A number from 0 to 2^32 - 1 as 4 bytes, the least first.
private fn frame_u32(out: Buf, value: Int) -> Buf {
  out
    |> push(byte: value & 255)
    |> push(byte: (value >> 8) & 255)
    |> push(byte: (value >> 16) & 255)
    |> push(byte: (value >> 24) & 255)
}

// A Content's place in the type, as the frame holds it.
private fn content_tag(content: Content) -> Int {
  match content {
    Html -> 0
    Json -> 1
    Text -> 2
    Css -> 3
    Svg -> 4
    Csv -> 5
    Atom -> 6
    Rss -> 7
    Xml -> 8
  }
}

// The media type a Content is served as. The host writes the Content-Type header from it.
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

// form_field, from the pair that starts at `at`. The next `&` or `=` is `scan`, one step per 16 bytes
// read, plus a few steps for the pair, and the pair's name is compared as it is decoded, in place. A lookup
// makes nothing for the pairs it passes, only the value it finds.
private fn form_from(body: View, name: View, at: Int) -> Option[View] {
  match {
    at > len(body) -> None
    else -> form_stop(body, name, at, stop: scan(body, at, set: "&="))
  }
}

// form_from, once the next `&` or `=` is known.
private fn form_stop(body: View, name: View, at: Int, stop: Int) -> Option[View] {
  match {
    stop < len(body) and body[stop] == '=' -> form_value(body, name, at, eq: stop)
    form_named(raw: slice(v: body, from: at, to: stop), name, at: 0, n: 0) -> Some(value: "")
    stop >= len(body) -> None
    else -> form_from(body, name, at: stop + 1)
  }
}

// The pair has an `=`, so the value runs from the byte after it to the next `&`.
private fn form_value(body: View, name: View, at: Int, eq: Int) -> Option[View] {
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

// Whether raw[at..], `+` and %XX decoded as form_bytes decodes them, is name[n..].
private fn form_named(raw: View, name: View, at: Int, n: Int) -> Bool {
  match {
    at >= len(raw) -> n == len(name)
    n >= len(name) -> False
    raw[at] == '+' -> name[n] == ' ' and form_named(raw, name, at: at + 1, n: n + 1)
    raw[at] == '%'
      and at + 2 < len(raw)
      and is_hex(raw[at + 1])
      and is_hex(raw[at + 2]) -> name[n] == (hex_value(raw[at + 1]) << 4) | hex_value(raw[at + 2])
      and form_named(raw, name, at: at + 3, n: n + 1)
    else -> name[n] == raw[at] and form_named(raw, name, at: at + 1, n: n + 1)
  }
}

// One name or value of a form, `+` and %XX decoded. Form encoding, not a path's: `percent_decoded` is
// the path's, where `+` stays a `+`, and it refuses what this passes through (a bad escape, bytes that are not
// UTF-8).
private fn form_decoded(raw: View) -> View {
  freeze(buf: form_bytes(out: buf(), raw, at: 0))
}

// The loop of form_decoded.
private fn form_bytes(out: Buf, raw: View, at: Int) -> Buf {
  match {
    at >= len(raw) -> out
    raw[at] == '+' -> form_bytes(out: push(buf: out, byte: ' '), raw, at: at + 1)
    raw[at] == '%'
      and at + 2 < len(raw)
      and is_hex(raw[at + 1])
      and is_hex(raw[at + 2]) -> form_bytes(
        out: push(buf: out, byte: (hex_value(raw[at + 1]) << 4) | hex_value(raw[at + 2])),
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

// The loop of percent_decoded, from `at`: the bytes up to the next `%` as they are, then its escape. An
// escape without two hex digits is written as 255, a byte UTF-8 never holds, so the check after makes it None.
private fn percent_bytes(out: Buf, text: View, at: Int) -> Buf {
  let p = scan(v: text, at, set: "%")
  let copied = append(buf: out, view: slice(v: text, from: at, to: p))
  match {
    p >= len(text) -> copied
    p + 2 < len(text)
      and is_hex(text[p + 1])
      and is_hex(text[p + 2]) -> percent_bytes(
        out: push(buf: copied, byte: (hex_value(text[p + 1]) << 4) | hex_value(text[p + 2])),
        text,
        at: p + 3
      )
    else -> push(buf: copied, byte: 255)
  }
}

// Is v, from `at`, UTF-8 (RFC 3629)? ASCII is passed 16 bytes at a time (scan_plain stops at a byte of 128 or
// more, and at a quote, a backslash or a control byte, which are ASCII and passed one at a time).
private fn utf8_whole(v: View, at: Int) -> Bool {
  let e = scan_plain(v, at)
  match {
    e >= len(v) -> True
    v[e] < 128 -> utf8_whole(v, at: e + 1)
    else -> utf8_next(v, found: utf8_at(v, at: e))
  }
}

// utf8_whole past one sequence that is UTF-8; False at one that is not.
private fn utf8_next(v: View, found: Utf8) -> Bool {
  match found {
    Utf8(next) -> utf8_whole(v, at: next)
    BadUtf8 -> False
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

// The loop of write_html.
private fn html_from(out: Buf, text: View, at: Int) -> Buf {
  match {
    at >= len(text) -> out
    text[at] == '&' -> html_from(out: append(buf: out, view: "&amp;"), text, at: at + 1)
    text[at] == '<' -> html_from(out: append(buf: out, view: "&lt;"), text, at: at + 1)
    text[at] == '>' -> html_from(out: append(buf: out, view: "&gt;"), text, at: at + 1)
    text[at] == '"' -> html_from(out: append(buf: out, view: "&quot;"), text, at: at + 1)
    text[at] == '\'' -> html_from(out: append(buf: out, view: "&#39;"), text, at: at + 1)
    else -> html_from(out: push(buf: out, byte: text[at]), text, at: at + 1)
  }
}

// The answer to a request `fetch` made: its status, its headers in the order they came (names in lower case), and
// its body, byte for byte.
type HttpReply {
  HttpReply(status: Int, headers: List[Header], body: View)
}

// An HTTP request to another service, through the program's `Http` capability, shaped like `call`: Ok with the
// reply whatever its status (a 404 or a 500 is an answer; a redirect is not followed, its 3xx is the reply), or
// Err(Timeout) when no reply came within `within` ms (the request may have been received), Err(Unreachable) when
// the host has no network for the program, and Err(Rejected(reason)) when the host would not send it: a host not
// on the program's list, a URL that is not https, a header it refuses, a body over 64 KB, a reply over 1 MB.
// A fetch is a commit point, as a call is: what the run wrote before it is committed when it goes out.
//
// Every method but GET and HEAD carries `key: Some(…)`, sent as the Idempotency-Key header, so a request sent
// again after a Timeout is one the other side can tell is a repeat (C100: a POST written with `key: None` does not
// build; a method that is a value and a None key is refused by the host). A run replayed from its log is answered
// from the log: the request is not made again.
//
// The log records the request with each secret the run read (`secret`) written `[secret <name>]` wherever it
// stands in the URL, a header's value or the body, and the reply with each such value kept out of the log: a key
// sent as `authorization: Bearer …` is never in a log, a trace or a span.
//
//   fetch(to: http, method: Post, url: "https://api.stripe.com/v1/refunds",
//     headers: Cons(head: Header(name: "authorization", value: "Bearer " ++ key), tail: Nil),
//     body: "charge=ch_1", within: 2000, key: Some(value: "refund-" ++ id))
fn fetch(
  to: Http,
  method: Method,
  url: View,
  headers: List[Header],
  body: View,
  within: Int,
  key: Option[View]
) -> Result[HttpReply, CallError] {
  let sent = buf()
    |> append(view: "{\"method\":")
    |> write_json(value: method_name(method))
    |> append(view: ",\"url\":")
    |> write_json(value: url)
    |> append(view: ",\"key\":")
    |> key_json(key)
    |> append(view: ",\"headers\":[")
    |> headers_json(headers, first: True)
    |> append(view: "]}")
  match http_send(to, request: freeze(buf: sent), body, within) {
    Ok(value) -> Ok(value: reply_of(wire: value))
    Err(error) -> Err(error)
  }
}

// The key of a fetch, as JSON: its text, or null.
private fn key_json(out: Buf, key: Option[View]) -> Buf {
  match key {
    Some(value) -> write_json(out, value)
    None -> append(buf: out, view: "null")
  }
}

// The headers of a fetch, as JSON: each one [name, value], in the order of the list.
private fn headers_json(out: Buf, headers: List[Header], first: Bool) -> Buf {
  match headers {
    Nil -> out
    Cons(head: Header(name, value), tail) -> {
      let comma = match {
        first -> out
        else -> append(buf: out, view: ",")
      }
      let written = comma
        |> append(view: "[")
        |> write_json(value: name)
        |> append(view: ",")
        |> write_json(value)
        |> append(view: "]")
      headers_json(out: written, headers: tail, first: False)
    }
  }
}

// A Method as its token.
//
//   > method_name(method: Delete)
//   "DELETE"
fn method_name(method: Method) -> View {
  match method {
    Get -> "GET"
    Head -> "HEAD"
    Post -> "POST"
    Put -> "PUT"
    Patch -> "PATCH"
    Delete -> "DELETE"
    Options -> "OPTIONS"
    Other(name) -> name
  }
}

// The reply as the host gives it to http_send: the status and a line feed, each header as `name:value` and a line
// feed, a line feed, then the body. A header's value has no line feed (HTTP has none in one).
private fn reply_of(wire: View) -> HttpReply {
  let first = scan(v: wire, at: 0, set: "\n")
  let status = value_or(given: decimal(slice(v: wire, from: 0, to: first)), otherwise: 0)
  reply_lines(wire, at: min(a: first + 1, b: len(wire)), status, found: Nil)
}

// The header lines from `at`, then the body after the empty line.
private fn reply_lines(wire: View, at: Int, status: Int, found: List[Header]) -> HttpReply {
  let end = scan(v: wire, at, set: "\n")
  let last = end == at or end >= len(wire)
  match {
    last -> HttpReply(
      status,
      headers: reverse(list: found),
      body: slice(v: wire, from: min(a: end + 1, b: len(wire)), to: len(wire))
    )
    else -> {
      let line = slice(v: wire, from: at, to: end)
      let colon = scan(v: line, at: 0, set: ":")
      let value = slice(v: line, from: min(a: colon + 1, b: len(line)), to: len(line))
      reply_lines(
        wire,
        at: end + 1,
        status,
        found: Cons(head: Header(name: slice(v: line, from: 0, to: colon), value), tail: found)
      )
    }
  }
}
