// pastebin.tape: post text, get a short id, read it back as a page. A paste lives 24 hours (or fewer minutes, if
// asked): the request that makes it sets a timer in the same commit, and the timer's run deletes it.
//
//   GET  /                 a page that says how to use it
//   POST /[?minutes=N]     the body is the text (1 to 16384 bytes); N is 1 to 1440 (default 1440):
//                          201 {"id","bytes","expires"}, location: <id>; 400 empty or a bad N; 413 too big
//   GET  /<id>             the paste as an HTML page, its text escaped
//   GET  /<id>/raw         the paste as text/plain
//
// A paste's id is the FNV-1a hash of its text (40 bits, 8 characters of base 36), so a retried POST, or the same
// text posted again while it lives, is the same paste: the INSERT names its primary key and does nothing on a
// conflict. Two texts with one id (one in about a million at a million pastes) answer 409.

migration 1 "pastes" {
  CREATE TABLE pastes(
    id INTEGER PRIMARY KEY,
    body TEXT NOT NULL CHECK (length(body) >= 1),
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  )
}

invariant "a paste lives a whole number of minutes, from one to a day" {
  SELECT id FROM pastes WHERE expires - created NOT BETWEEN 60000 AND 86400000
    OR (expires - created) % 60000 <> 0
}

flag max_bytes: Int = 16384

type Paste { Paste(id: Int, body: View, created: Int, expires: Int) }
type Made { Made(id: View, bytes: Int, expires: Int) }
type Gone { Gone(deleted: Int) }
type Problem { Problem(error: View) }

fn handle(raw: View, db: Sql, clock: Clock, timer: Timer) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/") -> home()
    Request(method: "POST", path: "/", query, body) -> made(body, minutes: minutes_of(query))
    Request(method: "GET", path: "/" ++ paste_id(id) ++ "/raw") -> raw_text(found: live(id))
    Request(method: "GET", path: "/" ++ paste_id(id)) -> page(found: live(id))
    _ -> problem(status: 404, error: "no such paste")
  }
}

// the timer set when a paste was made: the paste goes
export fn woken(db: Sql, message: Wake) -> Result[Gone, View] {
  let Wake(key) = message
  Ok(value: Gone(deleted: sql_exec(query: "DELETE FROM pastes WHERE id = :key", key)))
}

// ?minutes=N, 1 to 1440; a day when there is no query; None for anything else
//
//   > minutes_of(None)
//   Some(value: 1440)
//   > minutes_of(Some(value: "minutes=5"))
//   Some(value: 5)
//   > minutes_of(Some(value: "minutes=0"))
//   None
//   > minutes_of(Some(value: "minutes=soon"))
//   None
fn minutes_of(query: Option[View]) -> Option[Int] {
  let Some(value: q) = query else -> Some(value: 1440)
  match form_field(body: q, name: "minutes") {
    Some(value: decimal(n)) if n >= 1 and n <= 1440 -> Some(value: n)
    None -> Some(value: 1440)
    _ -> None
  }
}

fn made(body: View, minutes: Option[Int]) -> Buf {
  let Some(value: m) = minutes else -> problem(status: 400, error: "minutes: 1 to 1440")
  let ttl = m * 60000
  let True = len(body) >= 1 else -> problem(status: 400, error: "empty paste")
  let True = len(body) <= flags.max_bytes else -> problem(
    status: 413,
    error: "a paste is at most \(flags.max_bytes) bytes; this one is \(len(body))"
  )
  let id = fnv(v: body, at: 0, h: -3750763034362895579) & 1099511627775
  let at = now()
  let Some(value: paste) = sql_first(
    row: Paste,
    query: "INSERT INTO pastes(id, body, created, expires) VALUES (:id, :body, :at, :expires) \
        ON CONFLICT(id) DO NOTHING RETURNING *",
    id,
    body,
    at,
    expires: at + ttl
  ) else -> again(
    body,
    found: sql_first(row: Paste, query: "SELECT * FROM pastes WHERE id = :id", id)
  )
  do wake(after: ttl, key: id)
  answered(status: 201, paste)
}

// the id was taken: by this text (a retry, or the same text posted again), or by another
fn again(body: View, found: Option[Paste]) -> Buf {
  match found {
    Some(value: paste) if paste.body == body -> answered(status: 200, paste)
    Some(value) -> problem(
      status: 409,
      error: "another paste has this id; change the text by a byte"
    )
    None -> problem(
      status: 503,
      error: "the paste was deleted while this request ran; send it again"
    )
  }
}

fn answered(status: Int, paste: Paste) -> Buf {
  respond_as(status, content: Json)
    |> header(name: "location", value: id_text(paste.id))
    |> write_json(
      value: Made(id: id_text(paste.id), bytes: len(paste.body), expires: paste.expires)
    )
}

// a paste whose time is up is gone, even before its timer has run
fn live(id: Int) -> Option[Paste] {
  sql_first(
    row: Paste,
    query: "SELECT * FROM pastes WHERE id = :id AND expires > :at",
    id,
    at: now()
  )
}

fn raw_text(found: Option[Paste]) -> Buf {
  match found {
    Some(value: paste) -> respond_as(status: 200, content: Text)
      |> header(name: "cache-control", value: "no-store")
      |> append(view: paste.body)
    None -> problem(status: 404, error: "no such paste, or it has expired")
  }
}

fn page(found: Option[Paste]) -> Buf {
  match found {
    Some(value: paste) -> {
      let id = id_text(paste.id)
      shell(status: 200, title: "paste \(id)")
        |> append(view: "<p class=meta><b>\(id)</b> · \(len(paste.body)) bytes · ")
        |> append(view: "expires in \(remaining(ms: paste.expires - now())) · <a \
            href=\"\(id)/raw\">raw</a></p>")
        |> append(view: "<pre>")
        |> write_html(text: paste.body)
        |> append(view: "</pre>")
        |> foot
    }
    None -> shell(status: 404, title: "no such paste")
      |> append(view: "<p>There is no paste here, or it has expired. Pastes live for 24 hours.</p>")
      |> append(view: "<p><a href=\"./\">How to make one</a></p>")
      |> foot
  }
}

fn home() -> Buf {
  shell(status: 200, title: "pastebin")
    |> append(view: "<p>Post text, get a short link. A paste is deleted 24 hours after it is \
        made, by a timer ")
    |> append(view: "set in the same commit. At most \(flags.max_bytes) bytes; the same text \
        again is the same ")
    |> append(view: "paste.</p>")
    |> append(view: "<pre>curl --data-binary @notes.txt \
        https://tape.ivar.workers.dev/p/demo/pastebin/</pre>")
    |> append(view: "<p>The answer is <code>{\"id\",\"bytes\",\"expires\"}</code>; the page is at ")
    |> append(view: "<code>/p/demo/pastebin/&lt;id&gt;</code> and the text at \
        <code>&lt;id&gt;/raw</code>.</p>")
    |> foot
}

fn shell(status: Int, title: View) -> Buf {
  respond_as(status, content: Html)
    |> header(name: "cache-control", value: "no-store")
    |> append(view: "<!doctype html><html lang=en><meta charset=utf-8>")
    |> append(view: "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>")
    |> write_html(text: title)
    |> append(view: "</title><style>")
    |> append(
      view: ":root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fbfbf8;--mute:#6b6b6b;--box:#f0efe9}"
    )
    |> append(
      view: "@media (prefers-color-scheme:dark){:root{--fg:#e8e6e1;--bg:#151514;--mute:#9a978f;"
    )
    |> append(view: "--box:#22221f}}body{margin:0 auto;max-width:860px;padding:24px \
        16px;background:var(--bg);")
    |> append(
      view: "color:var(--fg);font:16px/1.5 system-ui,sans-serif}h1{font-size:20px;margin:0 0 8px}"
    )
    |> append(
      view: ".meta{color:var(--mute);font-size:14px}a{color:inherit}pre{background:var(--box);"
    )
    |> append(view: "padding:12px 14px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;")
    |> append(
      view: "word-break:break-word;font:13px/1.45 ui-monospace,monospace}footer{margin-top:32px;"
    )
    |> append(view: "color:var(--mute);font-size:13px}</style><h1>")
    |> write_html(text: title)
    |> append(view: "</h1>")
}

fn foot(out: Buf) -> Buf {
  out |> append(view: "<footer>A small program written in Tape.</footer></html>")
}

fn problem(status: Int, error: View) -> Buf {
  respond_as(status, content: Json) |> write_json(value: Problem(error))
}

// "23 h 59 min", "4 min", "less than a minute"
//
//   > remaining(ms: 86399999)
//   "23 h 59 min"
//   > remaining(ms: 240000)
//   "4 min"
//   > remaining(ms: 59999)
//   "less than a minute"
fn remaining(ms: Int) -> View {
  let minutes = ms / 60000
  match {
    minutes < 1 -> "less than a minute"
    minutes < 60 -> "\(minutes) min"
    else -> "\(minutes / 60) h \(minutes % 60) min"
  }
}

// 64-bit FNV-1a of v from byte `at`
//
//   > fnv(v: "a", at: 0, h: -3750763034362895579)
//   -5808556873153909620
fn fnv(v: View, at: Int, h: Int) -> Int {
  match {
    at >= len(v) -> h
    else -> fnv(v, at: at + 1, h: wrapping_mul(a: h ^ v[at], b: 1099511628211))
  }
}

// an id as 8 characters of base 36
//
//   > id_text(0)
//   "00000000"
//   > id_text(1099511627775)
//   "e13wu1of"
fn id_text(id: Int) -> View {
  freeze(buf: digits36(out: buf(), n: id, left: 8))
}

fn digits36(out: Buf, n: Int, left: Int) -> Buf {
  match {
    left <= 0 -> out
    else -> digits36(out, n: n / 36, left: left - 1) |> push(byte: digit36(n % 36))
  }
}

fn digit36(d: Int) -> Int {
  match {
    d < 10 -> 48 + d
    else -> 87 + d
  }
}

// 8 characters of 0-9 and a-z, back to an id
//
//   > paste_id("e13wu1of")
//   Some(value: 1099511627775)
//   > paste_id("E13WU1OF")
//   None
//   > paste_id("abc")
//   None
fn paste_id(v: View) -> Option[Int] {
  match {
    len(v) != 8 -> None
    else -> base36(v, at: 0, n: 0)
  }
}

fn base36(v: View, at: Int, n: Int) -> Option[Int] {
  match {
    at >= len(v) -> Some(value: n)
    is_digit(v[at]) -> base36(v, at: at + 1, n: n * 36 + v[at] - 48)
    is_lower(v[at]) -> base36(v, at: at + 1, n: n * 36 + v[at] - 87)
    else -> None
  }
}
