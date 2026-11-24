// webhook-inbox.tape: a place to point a webhook while you build against it. POST any JSON (up to 64 KB) to
// /in/<box>; /box/<box> shows the last 50 deliveries, newest first, pretty-printed, and /api/<box> is the same as
// JSON. A delivery that names itself (an idempotency-key, x-delivery-id, x-webhook-id or x-request-id header,
// or a top-level "id" in the body) is kept once: the sender's retry answers 200 with the delivery it repeats.
// One without a name is kept every time it is sent. A box is any name of 2 to 32 of a-z, 0-9 and -; /new picks
// a random one.

migration 1 "deliveries" {
  CREATE TABLE deliveries(
    seq INTEGER PRIMARY KEY,
    box TEXT NOT NULL,
    key TEXT,
    at INTEGER NOT NULL,
    size INTEGER NOT NULL,
    body TEXT NOT NULL,
    UNIQUE(box, key)
  );
  CREATE INDEX deliveries_by_box ON deliveries(box, seq)
}

invariant "a box keeps at most 50 deliveries" {
  SELECT box, count(*) FROM deliveries GROUP BY box HAVING count(*) > 50
}

invariant "a stored delivery is 1 byte to 64 KB" {
  SELECT seq FROM deliveries WHERE size > 65536 OR size < 1 OR size <> length(CAST(body AS BLOB))
}

type Box = View where len(self) >= 2
  and len(self) <= 32
  and every_byte(v: self, keep: box_byte) else "2 to 32 of a-z, 0-9 and -"

type Delivery { Delivery(seq: Int, key: Option[View], at: Int, size: Int, body: View) }
type Stored { Stored(box: View, seq: Int, key: Option[View], duplicate: Bool) }
type Problem { Problem(error: View) }

fn box_byte(b: Int) -> Bool {
  is_lower(b) or is_digit(b) or b == 45
}

fn handle(raw: View, db: Sql, clock: Clock, dice: Entropy) -> Buf {
  let r = request(raw)
  match r {
    Request(method: "GET", path: "/") -> home()
    Request(method: "GET", path: "/new") -> respond(status: 302)
      |> header(name: "location", value: "/p/demo/webhook-inbox/box/\(fresh_box())")
    Request(method: "POST", path: "/in/" ++ Box(box), body) -> deliver(box, body, r)
    Request(method: "GET", path: "/box/" ++ Box(box)) -> shown(box, rows: recent(box))
    Request(
      method: "GET",
      path: "/api/" ++ Box(box) ++ "/" ++ decimal(seq)
    ) -> one(found: sql_first(
      row: Delivery,
      query: "SELECT * FROM deliveries WHERE box = :box AND seq = :seq",
      box,
      seq
    ))
    Request(method: "GET", path: "/api/" ++ Box(box)) -> listed(box, rows: recent(box))
    Request(path: "/in/" ++ _) -> problem(status: 400, error: "box: 2 to 32 of a-z, 0-9 and -")
    Request(path: "/box/" ++ _) -> problem(status: 400, error: "box: 2 to 32 of a-z, 0-9 and -")
    _ -> problem(status: 404, error: "no such route")
  }
}

fn recent(box: View) -> Rows[Delivery] {
  sql_all(
    row: Delivery,
    query: "SELECT * FROM deliveries WHERE box = :box ORDER BY seq DESC LIMIT 50",
    box
  )
}

// Ten random a-z and 0-9.
fn fresh_box() -> View {
  let n = random()
  range(from: 0, to: 10) |> fold(from: buf(), by: fn(out: Buf, i: Int) -> Buf {
    out |> push(byte: alnum_byte(d: n / pow36(k: i) % 36))
  }) |> freeze
}

fn pow36(k: Int) -> Int {
  range(from: 0, to: k) |> fold(from: 1, by: fn(acc: Int, i: Int) -> Int { acc * 36 })
}

fn alnum_byte(d: Int) -> Int {
  match {
    d < 10 -> 48 + d
    else -> 87 + d
  }
}

// ---------- taking a delivery ----------

// The name a delivery gives itself: a header, else a top-level "id" that is text or a number.
fn delivery_key(r: Request, tree: Json_Tree) -> Option[View] {
  let named = first_of(
    a: header_of(request: r, name: "idempotency-key"),
    b: first_of(
      a: header_of(request: r, name: "x-delivery-id"),
      b: first_of(
        a: header_of(request: r, name: "x-webhook-id"),
        b: header_of(request: r, name: "x-request-id")
      )
    )
  )
  match named {
    Some(value: k) if len(k) >= 1 and len(k) <= 200 -> named
    _ -> body_id(tree: json_get(obj: tree, key: "id"))
  }
}

fn first_of(a: Option[View], b: Option[View]) -> Option[View] {
  match a {
    Some -> a
    None -> b
  }
}

fn body_id(tree: Option[Json_Tree]) -> Option[View] {
  match tree {
    Some(value: Json_Str(text)) if len(text) >= 1 and len(text) <= 200 -> Some(value: "id:" ++ text)
    Some(value: Json_Num(text)) -> Some(value: "id:" ++ text)
    _ -> None
  }
}

fn deliver(box: View, body: View, r: Request) -> Buf {
  let True = len(body) > 0 else -> problem(status: 400, error: "empty: send a JSON body")
  let True = len(body) <= 65536 else -> problem(status: 413, error: "the body is over 64 KB")
  let Some(value: tree) = json_tree(body) else -> problem(status: 400, error: "not JSON")
  match delivery_key(r, tree) {
    Some(value: k) -> keyed(box, body, k)
    None -> {
      let Some(value: d) = sql_first(
        row: Delivery,
        repeat: True,
        query: "INSERT INTO deliveries(box, at, size, body) VALUES (:box, :at, :size, :body) \
            RETURNING *",
        box,
        at: now(),
        size: len(body),
        body
      ) else -> problem(status: 500, error: "the delivery was not stored")
      stored(status: 202, box, d, duplicate: False)
    }
  }
}

fn keyed(box: View, body: View, k: View) -> Buf {
  let Some(value: d) = sql_first(
    row: Delivery,
    query: "INSERT INTO deliveries(box, key, at, size, body) \
        VALUES (:box, :k, :at, :size, :body) ON CONFLICT(box, key) DO NOTHING RETURNING *",
    box,
    k,
    at: now(),
    size: len(body),
    body
  ) else -> repeated(
    box,
    found: sql_first(
      row: Delivery,
      query: "SELECT * FROM deliveries WHERE box = :box AND key = :k",
      box,
      k
    )
  )
  stored(status: 202, box, d, duplicate: False)
}

fn repeated(box: View, found: Option[Delivery]) -> Buf {
  match found {
    Some(value) -> respond_as(status: 200, content: Json)
      |> write_json(value: Stored(box, seq: value.seq, key: value.key, duplicate: True))
    None -> problem(status: 500, error: "the delivery it repeats is gone")
  }
}

// A new delivery is kept, and the box is cut back to its newest 50.
fn stored(status: Int, box: View, d: Delivery, duplicate: Bool) -> Buf {
  do sql_exec(
    query: "DELETE FROM deliveries WHERE box = :box AND seq NOT IN (SELECT seq FROM deliveries \
        WHERE box = :box ORDER BY seq DESC LIMIT 50)",
    box
  )
  respond_as(status, content: Json)
    |> write_json(value: Stored(box, seq: d.seq, key: d.key, duplicate))
}

fn problem(status: Int, error: View) -> Buf {
  respond_as(status, content: Json) |> write_json(value: Problem(error))
}

// ---------- the JSON API ----------

fn one(found: Option[Delivery]) -> Buf {
  match found {
    Some(value) -> respond_as(status: 200, content: Json) |> append(view: value.body)
    None -> problem(status: 404, error: "no such delivery")
  }
}

// {"box": …, "deliveries": [{"seq", "key"?, "at", "size", "body": <the JSON as sent>}, …]}: each body was
// checked as JSON when it came, so it is written as it is.
fn listed(box: View, rows: Rows[Delivery]) -> Buf {
  respond_as(status: 200, content: Json)
    |> append(view: "{\"box\":")
    |> write_json_string(text: box)
    |> append(view: ",\"deliveries\":[")
    |> json_items(rows, first: True)
    |> append(view: "]}")
}

fn json_items(out: Buf, rows: Rows[Delivery], first: Bool) -> Buf {
  match next(rows) {
    Next(value: Delivery(seq, key, at, size, body), rest) -> out |> append(view: match first {
      True -> "{\"seq\":"
      False -> ",{\"seq\":"
    }) |> write_int(value: seq) |> json_key(key) |> append(
      view: ",\"at\":\(at),\"size\":\(size),\"body\":"
    ) |> append(
      view: body
    ) |> append(
      view: "}"
    ) |> json_items(
      rows: rest,
      first: False
    )
    End -> out
  }
}

fn json_key(out: Buf, key: Option[View]) -> Buf {
  match key {
    Some(value: k) -> out |> append(view: ",\"key\":") |> write_json_string(text: k)
    None -> out
  }
}

// ---------- pages ----------

fn page(status: Int, title: View) -> Buf {
  respond_as(status, content: Html)
    |> header(name: "cache-control", value: "no-store")
    |> append(view: "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport \
        content=\"width=device-width,initial-scale=1\"><meta name=robots \
        content=\"noindex,nofollow\"><title>")
    |> write_html(text: title)
    |> append(view: " · webhook inbox</title><style>")
    |> append(
    view: ":root{color-scheme:light dark;--fg:#1d1f23;--mute:#626873;--bg:#fbfbfa;--card:#fff;"
  )
    |> append(
    view: "--line:#e3e4e6;--acc:#2856c7;--key:#7a3e9d;--str:#1d7a46;--num:#b4561b;--lit:#2856c7}"
  )
    |> append(
    view: "@media(prefers-color-scheme:dark){:root{--fg:#e8e9eb;--mute:#9aa0aa;--bg:#15171a;"
  )
    |> append(view: "--card:#1d2024;--line:#30343a;--acc:#86a8ff;--key:#d6a5f0;--str:#8fd8a8;--num:#f2b27a;")
    |> append(view: "--lit:#9fb8ff}}body{margin:0;background:var(--bg);color:var(--fg);")
    |> append(view: "font:16px/1.5 system-ui,sans-serif}main{max-width:52rem;margin:0 \
        auto;padding:2rem 1rem}")
    |> append(
    view: "h1{font-size:1.5rem;margin:0 0 .25rem;overflow-wrap:anywhere}a{color:var(--acc)}"
  )
    |> append(view: ".mute{color:var(--mute)}code,pre{font:13px/1.45 ui-monospace,Menlo,monospace}")
    |> append(view: "pre{margin:0;overflow-x:auto;white-space:pre}article{background:var(--card);")
    |> append(
    view: "border:1px solid var(--line);border-radius:10px;margin:1rem 0;overflow:hidden}"
  )
    |> append(
    view: "article header{display:flex;flex-wrap:wrap;gap:.25rem 1rem;padding:.5rem 1rem;"
  )
    |> append(view: "border-bottom:1px solid var(--line);font-size:.875rem;color:var(--mute)}")
    |> append(view: "article pre{padding:.75rem 1rem}.k{color:var(--key)}.s{color:var(--str)}")
    |> append(view: ".n{color:var(--num)}.l{color:var(--lit)}.cmd{background:var(--card);")
    |> append(
    view: "border:1px solid var(--line);border-radius:8px;padding:.75rem;white-space:pre-wrap;"
  )
    |> append(view: "overflow-wrap:anywhere}</style><main><p class=mute>")
    |> append(view: "<a href=\"/p/demo/webhook-inbox/\">webhook inbox</a></p><h1>")
    |> write_html(text: title)
    |> append(view: "</h1>")
}

fn end(out: Buf) -> Buf {
  out
    |> append(view: "<p class=mute>Written in Tape. Bodies are shown as text, never run; a box is \
        public to anyone who knows its name.</p></main></html>")
}

fn home() -> Buf {
  page(status: 200, title: "Webhook inbox")
    |> append(view: "<p>Point a webhook here while you build against it. Every delivery is kept \
        (the last 50 a box) and shown pretty-printed.</p><p><a \
        href=\"/p/demo/webhook-inbox/new\">Open a new box</a>, or use any name of 2 to 32 of a-z, \
        0-9 and -.</p><pre class=cmd>curl \
        https://tape.ivar.workers.dev/p/demo/webhook-inbox/in/my-box \\\n  -H 'x-delivery-id: \
        evt_1' -d '{\"type\": \"invoice.paid\", \"amount\": 1200}'</pre><p>Sent twice with the \
        same <code>x-delivery-id</code> (or <code>idempotency-key</code>, \
        <code>x-webhook-id</code>, <code>x-request-id</code>, or a top-level \
        <code>\"id\"</code>), it is kept once.</p><ul><li><code>GET box/&lt;box&gt;</code> the \
        deliveries, newest first</li><li><code>GET api/&lt;box&gt;</code> the same as \
        JSON</li><li><code>GET api/&lt;box&gt;/&lt;seq&gt;</code> one body as it was \
        sent</li></ul>")
    |> end
}

fn shown(box: View, rows: Rows[Delivery]) -> Buf {
  page(status: 200, title: "Box \(box)")
    |> append(view: "<p class=mute>POST JSON to \
        <code>https://tape.ivar.workers.dev/p/demo/webhook-inbox/in/")
    |> write_html(text: box)
    |> append(view: "</code> · <a href=\"/p/demo/webhook-inbox/api/")
    |> write_html(text: box)
    |> append(view: "\">JSON</a></p>")
    |> cards(rows, any: False)
    |> end
}

fn cards(out: Buf, rows: Rows[Delivery], any: Bool) -> Buf {
  match next(rows) {
    Next(value: Delivery(seq, key, at, size, body), rest) -> out
      |> append(view: "<article><header><span>#\(seq)</span><span>")
      |> append(view: date_time(ms: at))
      |> append(view: " UTC</span><span>\(size) bytes</span>")
      |> key_label(key)
      |> append(view: "</header><pre>")
      |> pretty(v: body, at: 0, depth: 0)
      |> append(view: "</pre></article>")
      |> cards(rows: rest, any: True)
    End if any -> out
    End -> out |> append(view: "<p>Nothing yet. Deliveries show up here as they come.</p>")
  }
}

fn key_label(out: Buf, key: Option[View]) -> Buf {
  match key {
    Some(value: k) -> out
      |> append(view: "<span>")
      |> write_html(text: k)
      |> append(view: "</span>")
    None -> out
  }
}

// ---------- pretty-printing ----------

// JSON that json_tree has accepted, laid out two spaces a level, as HTML: each string, number and literal in a
// span by kind (k a key, s a string, n a number, l true, false or null), and every byte of text escaped. One
// loop over the bytes, so any depth of nesting costs no stack.
//
//   > buf() |> pretty(v: " {\"a\": [1, true], \"b\": {}, \"c\": \"<x>\"}", at: 0, depth: 0) |> freeze
//   "{\n  <span class=k>&quot;a&quot;</span>: [\n    <span class=n>1</span>,\n    <span class=l>true</span>\n  ],\n  <span class=k>&quot;b&quot;</span>: {},\n  <span class=k>&quot;c&quot;</span>: <span class=s>&quot;&lt;x&gt;&quot;</span>\n}"
//   > buf() |> pretty(v: "[]", at: 0, depth: 0) |> freeze
//   "[]"
//   > buf() |> pretty(v: "\"a\\\"b\"", at: 0, depth: 0) |> freeze
//   "<span class=s>&quot;a\\&quot;b&quot;</span>"
fn pretty(out: Buf, v: View, at: Int, depth: Int) -> Buf {
  match {
    at >= len(v) -> out
    else -> {
      let b = v[at]
      match {
        b == 32 or b == 10 or b == 13 or b == 9 -> pretty(out, v, at: at + 1, depth)
        b == 123
          or b == 91 -> opened(out, v, at, depth, close: b + 2, inner: json_ws(v, at: at + 1))
        b == 125 or b == 93 -> out
          |> indent(depth: depth - 1)
          |> push(byte: b)
          |> pretty(v, at: at + 1, depth: depth - 1)
        b == 44 -> out |> push(byte: 44) |> indent(depth) |> pretty(v, at: at + 1, depth)
        b == 58 -> out |> append(view: ": ") |> pretty(v, at: at + 1, depth)
        b == 34 -> quoted(out, v, at, depth, end: string_end(v, at: at + 1))
        else -> word(out, v, at, depth, end: word_end(v, at))
      }
    }
  }
}

// `{` or `[` at `at`; `inner` is the first byte after it that is not whitespace.
fn opened(out: Buf, v: View, at: Int, depth: Int, close: Int, inner: Int) -> Buf {
  match {
    inner < len(v) and v[inner] == close -> out
      |> push(byte: v[at])
      |> push(byte: close)
      |> pretty(v, at: inner + 1, depth)
    else -> out
      |> push(byte: v[at])
      |> indent(depth: depth + 1)
      |> pretty(v, at: inner, depth: depth + 1)
  }
}

// A new line, indented two spaces a level up to 24 levels: past that every level is drawn at 24, so a body nested
// 30,000 deep is not 30,000 lines of 60,000 spaces each.
fn indent(out: Buf, depth: Int) -> Buf {
  range(from: 0, to: min(a: depth, b: 24))
    |> fold(from: out |> push(byte: 10), by: fn(o: Buf, i: Int) -> Buf { o |> append(view: "  ") })
}

// A string from `at` (its opening quote) to `end` (past its closing one): a key when a colon follows.
fn quoted(out: Buf, v: View, at: Int, depth: Int, end: Int) -> Buf {
  let after = json_ws(v, at: end)
  let class = match {
    after < len(v) and v[after] == 58 -> "k"
    else -> "s"
  }
  out
    |> append(view: "<span class=\(class)>")
    |> write_html(text: slice(v, from: at, to: end))
    |> append(view: "</span>")
    |> pretty(v, at: end, depth)
}

// Past the closing quote of the string whose body starts at `at`.
fn string_end(v: View, at: Int) -> Int {
  match {
    at >= len(v) -> at
    v[at] == 92 -> string_end(v, at: at + 2)
    v[at] == 34 -> at + 1
    else -> string_end(v, at: at + 1)
  }
}

// A number or a literal.
fn word(out: Buf, v: View, at: Int, depth: Int, end: Int) -> Buf {
  let class = match {
    v[at] == 45 or is_digit(v[at]) -> "n"
    else -> "l"
  }
  out
    |> append(view: "<span class=\(class)>")
    |> write_html(text: slice(v, from: at, to: end))
    |> append(view: "</span>")
    |> pretty(v, at: end, depth)
}

fn word_end(v: View, at: Int) -> Int {
  match {
    at >= len(v) -> at
    v[at] == 44 or v[at] == 125 or v[at] == 93 or v[at] == 58 or is_space(v[at]) -> at
    else -> word_end(v, at: at + 1)
  }
}

// ---------- dates ----------

// Milliseconds since 1970 as YYYY-MM-DD HH:MM:SS (UTC), by Howard Hinnant's days-to-civil.
//
//   > date_time(ms: 0)
//   "1970-01-01 00:00:00"
//   > date_time(ms: 951825600123)
//   "2000-02-29 12:00:00"
fn date_time(ms: Int) -> View {
  let days = ms / 86400000
  let secs = ms % 86400000 / 1000
  let z = days + 719468
  let era = z / 146097
  let doe = z - era * 146097
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp = (5 * doy + 2) / 153
  let d = doy - (153 * mp + 2) / 5 + 1
  let m = match {
    mp < 10 -> mp + 3
    else -> mp - 9
  }
  let y = yoe + era * 400 + match {
    m <= 2 -> 1
    else -> 0
  }
  "\(y)-\(two(n: m))-\(two(n: d)) \
      \(two(n: secs / 3600)):\(two(n: secs / 60 % 60)):\(two(n: secs % 60))"
}

fn two(n: Int) -> View {
  match {
    n < 10 -> "0\(n)"
    else -> "\(n)"
  }
}
