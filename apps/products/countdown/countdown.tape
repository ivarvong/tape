// countdown.tape: a page that counts down to an event. The time left is computed on the server from the clock
// when the page is asked for (`now()`, recorded in the request's log), and a ring shows how much of the wait,
// from when the countdown was made to the event, has gone.
//
//   GET  /                  the next events, and how to make one
//   POST /events            {"key","name","at"}: at is UTC, "2026-12-31T23:59:59Z", "…T23:59Z" or "2026-12-31",
//                           from now to ten years ahead. 201 {"id","name","at","at_ms"}; the same key again
//                           answers the countdown it made (200)
//   GET  /events/<id>       the page, counted when it is loaded (a public page is sandboxed: it cannot reload itself)
//   GET  /events/<id>.json  {"id","name","at","left_ms","days","done"}: days is a Dec[2] of the time left

migration 1 "events" {
  CREATE TABLE events(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    at TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    created INTEGER NOT NULL CHECK (created <= at_ms)
  )
}

invariant "an event is in the ten years after the countdown was made" {
  SELECT id FROM events WHERE at_ms < created OR at_ms > created + 315576000000
}

type Key = View where len(self) >= 1 and len(self) <= 64 else "1 to 64 bytes"
type Name = View where char_count(v: self) >= 1 and char_count(v: self) <= 80
type NewEvent { NewEvent(key: Key, name: Name, at: View) }
type Event { Event(id: Int, name: View, at: View, at_ms: Int, created: Int) }
type Made { Made(id: Int, name: View, at: View, at_ms: Int) }
type Left { Left(id: Int, name: View, at: View, left_ms: Int, days: Dec[2], done: Bool) }

fn handle(raw: View, db: Sql, clock: Clock) -> Response {
  match request(raw) {
    Request(method: Get, path: "/") -> home(at: now())
    Request(method: Post, path: "/events", body) -> made(body)
    Request(
      method: Get,
      path: "/events/" ++ decimal(id) ++ ".json"
    ) -> left(found: load(id), at: now())
    Request(method: Get, path: "/events/" ++ decimal(id)) -> page(found: load(id), at: now())
    _ -> problem(status: 404, detail: "no such route")
  }
}

fn load(id: Int) -> Option[Event] {
  sql_first(row: Event, query: "SELECT * FROM events WHERE id = :id", id)
}

fn made(body: View) -> Response {
  let Ok(value: NewEvent(key, name, at)) = decode(json: body, as: NewEvent) else {
    Err(error) -> problem(status: 400, detail: error)
  }
  let Some(value: at_ms) = utc_ms(at) else -> problem(
    status: 400,
    detail: "at: a UTC time, 2026-12-31T23:59:59Z, 2026-12-31T23:59Z or 2026-12-31"
  )
  let created = now()
  let True = at_ms >= created
    and at_ms <= created + 315576000000 else -> problem(
      status: 400,
      detail: "at: from now to ten years ahead"
    )
  match sql_first(
    row: Event,
    query: "INSERT INTO events(client, name, at, at_ms, created) \
        VALUES (:key, :name, :at, :at_ms, :created) ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    name,
    at,
    at_ms,
    created
  ) {
    Some(value) -> shown_made(status: 201, event: value)
    None -> match sql_first(row: Event, query: "SELECT * FROM events WHERE client = :key", key) {
      Some(value) -> shown_made(status: 200, event: value)
      None -> problem(status: 500, detail: "the countdown is gone")
    }
  }
}

fn shown_made(status: Int, event: Event) -> Response {
  let Event(id, name, at, at_ms) = event
  json(status, value: Made(id, name, at, at_ms)) |> header(name: "location", value: "events/\(id)")
}

fn left(found: Option[Event], at: Int) -> Response {
  match found {
    Some(value: Event(id, name, at: when, at_ms)) -> {
      let ms = max(a: at_ms - at, b: 0)
      json(
        status: 200,
        value: Left(
          id,
          name,
          at: when,
          left_ms: ms,
          days: div(a: dec(n: ms, scale: 2), by: 86400000, scale: 2, rounding: Down),
          done: ms == 0
        )
      )
        |> header(name: "cache-control", value: "no-store")
    }
    None -> problem(status: 404, detail: "no such countdown")
  }
}

fn page(found: Option[Event], at: Int) -> Response {
  match found {
    Some(value: Event(name, at: when, at_ms, created)) -> {
      let ms = at_ms - at
      let gone = fraction(done: at - created, of: at_ms - created)
      shell(title: name)
        |> append(view: "<div class=card>")
        |> ring(gone)
        |> append(view: "<div><p class=big>")
        |> append(view: match {
          ms > 0 -> spelled(ms)
          else -> "It is here"
        })
        |> append(view: "</p><p class=meta>")
        |> append(view: match {
          ms > 0 -> "until "
          else -> "it happened at "
        })
        |> write_html(text: when)
        |> append(view: " · \(percent(gone))% of the wait has gone</p></div></div>")
        |> append(view: "<p class=meta>Counted on the server when this page was loaded; load it \
            again to count again.</p>")
        |> foot(status: 200)
    }
    None -> shell(title: "no such countdown")
      |> append(view: "<p><a href=\"../\">All countdowns</a></p>")
      |> foot(status: 404)
  }
}

// how much of [0, of] `done` is, from 0 to 1; all of it when the wait was nothing
//
//   > fraction(done: 1, of: 4)
//   0.25f
//   > fraction(done: 9, of: 4)
//   1f
//   > fraction(done: 5, of: 0)
//   1f
fn fraction(done: Int, of: Int) -> Float {
  match {
    of <= 0 -> 1f
    else -> min(a: max(a: float(done) / float(of), b: 0f), b: 1f)
  }
}

//   > percent(0.3333f)
//   33.3
fn percent(x: Float) -> Dec[1] {
  to_dec(x * 100f, scale: 1, rounding: Down)
}

// an SVG ring: a track, and an arc over the fraction gone, clockwise from the top; a whole circle once the wait
// is over (an arc that ends where it starts draws nothing)
fn ring(out: Buf, gone: Float) -> Buf {
  out
    |> append(view: "<svg viewBox=\"0 0 120 120\" width=120 height=120 aria-hidden=true>")
    |> append(
      view: "<circle cx=60 cy=60 r=52 fill=none style=\"stroke:var(--box)\" stroke-width=12 />"
    )
    |> append(view: arc(gone))
    |> append(view: "</svg>")
}

//   > arc(0.25f)
//   "<path d=\"M 60 8 A 52 52 0 0 1 112.00 60.00\" " ++ _
//   > arc(1f)
//   "<circle " ++ _
fn arc(gone: Float) -> View {
  let angle = 2f * 3.141592653589793f * gone
  let x = to_dec(60f + 52f * sin(angle), scale: 2, rounding: HalfEven)
  let y = to_dec(60f - 52f * cos(angle), scale: 2, rounding: HalfEven)
  let large = match {
    gone > 0.5f -> 1
    else -> 0
  }
  match {
    gone >= 0.9999f -> "<circle cx=60 cy=60 r=52 fill=none style=\"stroke:var(--bar)\" \
        stroke-width=12 />"
    else -> "<path d=\"M 60 8 A 52 52 0 \(large) 1 \(x) \(y)\" \
        style=\"fill:none;stroke:var(--bar)\" stroke-width=12 stroke-linecap=round />"
  }
}

// a time left, spelled: "3 days 4 h 05 min 09 s"
//
//   > spelled(ms: 273909000)
//   "3 days 04 h 05 min 09 s"
//   > spelled(ms: 86400000)
//   "1 day 00 h 00 min 00 s"
//   > spelled(ms: 3723999)
//   "1 h 02 min 03 s"
//   > spelled(ms: 59000)
//   "59 s"
fn spelled(ms: Int) -> View {
  let s = ms / 1000
  let days = s / 86400
  let h = s / 3600 % 24
  let m = s / 60 % 60
  let sec = s % 60
  match {
    days == 1 -> "1 day \(two(h)) h \(two(m)) min \(two(sec)) s"
    days > 1 -> "\(days) days \(two(h)) h \(two(m)) min \(two(sec)) s"
    h > 0 -> "\(h) h \(two(m)) min \(two(sec)) s"
    m > 0 -> "\(m) min \(two(sec)) s"
    else -> "\(sec) s"
  }
}

fn two(n: Int) -> View {
  match {
    n < 10 -> "0\(n)"
    else -> "\(n)"
  }
}

// a UTC time as milliseconds since 1970: "2026-12-31T23:59:59Z", "2026-12-31T23:59Z" or "2026-12-31"
//
//   > utc_ms("1970-01-01")
//   Some(value: 0)
//   > utc_ms("2000-03-01T00:00Z")
//   Some(value: 951868800000)
//   > utc_ms("2026-12-31T23:59:59Z")
//   Some(value: 1798761599000)
//   > utc_ms("2026-02-30")
//   None
//   > utc_ms("2026-12-31T24:00Z")
//   None
//   > utc_ms("tomorrow")
//   None
fn utc_ms(text: View) -> Option[Int] {
  match text {
    d ++ "T" ++ t ++ "Z" -> match date_days(d) {
      Some(value: days) -> match clock_s(t) {
        Some(value: s) -> Some(value: (days * 86400 + s) * 1000)
        None -> None
      }
      None -> None
    }
    d -> match date_days(d) {
      Some(value: days) -> Some(value: days * 86400000)
      None -> None
    }
  }
}

// "HH:MM" or "HH:MM:SS" as seconds into the day
fn clock_s(t: View) -> Option[Int] {
  match t {
    hh ++ ":" ++ mm ++ ":" ++ ss -> hms(h: digits2(hh), m: digits2(mm), s: digits2(ss))
    hh ++ ":" ++ mm -> hms(h: digits2(hh), m: digits2(mm), s: Some(value: 0))
    _ -> None
  }
}

fn hms(h: Option[Int], m: Option[Int], s: Option[Int]) -> Option[Int] {
  match h {
    Some(value: hours) if hours < 24 -> match m {
      Some(value: minutes) if minutes < 60 -> match s {
        Some(value: seconds) if seconds < 60 -> Some(value: hours * 3600 + minutes * 60 + seconds)
        _ -> None
      }
      _ -> None
    }
    _ -> None
  }
}

// "YYYY-MM-DD" as days since 1970-01-01, for a real date of 1970 to 9999
fn date_days(d: View) -> Option[Int] {
  match d {
    yyyy ++ "-" ++ mm ++ "-" ++ dd if len(yyyy) == 4 -> civil(
      y: number(yyyy),
      m: digits2(mm),
      d: digits2(dd)
    )
    _ -> None
  }
}

fn civil(y: Option[Int], m: Option[Int], d: Option[Int]) -> Option[Int] {
  match y {
    Some(value: year) if year >= 1970 -> match m {
      Some(value: month) if month >= 1 and month <= 12 -> match d {
        Some(value: day) if day >= 1
          and day <= month_days(year, month) -> Some(
            value: days_from_civil(y: year, m: month, d: day)
          )
        _ -> None
      }
      _ -> None
    }
    _ -> None
  }
}

fn month_days(year: Int, month: Int) -> Int {
  match month {
    2 -> match {
      year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) -> 29
      else -> 28
    }
    4 -> 30
    6 -> 30
    9 -> 30
    11 -> 30
    _ -> 31
  }
}

// days since 1970-01-01 of a date in the proleptic Gregorian calendar (H. Hinnant's days_from_civil)
//
//   > days_from_civil(y: 2026, m: 11, d: 23)
//   20780
fn days_from_civil(y: Int, m: Int, d: Int) -> Int {
  let yy = match {
    m <= 2 -> y - 1
    else -> y
  }
  let era = yy / 400
  let yoe = yy - era * 400
  let mp = (m + 9) % 12
  let doy = (153 * mp + 2) / 5 + d - 1
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
  era * 146097 + doe - 719468
}

// exactly two digits
fn digits2(v: View) -> Option[Int] {
  match {
    len(v) == 2 and is_digit(v[0]) and is_digit(v[1]) -> Some(value: (v[0] - 48) * 10 + v[1] - 48)
    else -> None
  }
}

// digits only, any number of them up to 9
fn number(v: View) -> Option[Int] {
  match {
    len(v) >= 1 and len(v) <= 9 and every_byte(v, keep: is_digit) -> parse_int(v)
    else -> None
  }
}

fn home(at: Int) -> Response {
  let out = shell(title: "countdowns")
    |> append(
      view: "<p>A page that counts down to an event, computed on the server at each load.</p>"
    )
    |> append(view: "<pre>curl -H 'content-type: application/json' \\\n  -d '{\"key\":\"ny-2027\",")
    |> append(view: "\"name\":\"New year\",\"at\":\"2027-01-01T00:00Z\"}' \\\n")
    |> append(
      view: "  https://tape.ivar.workers.dev/p/demo/countdown/events</pre><h2>Next</h2><ul>"
    )
  upcoming(
    out,
    rows: sql_all(
      row: Event,
      query: "SELECT * FROM events WHERE at_ms > :at ORDER BY at_ms LIMIT 20",
      at
    ),
    at
  )
    |> append(view: "</ul>")
    |> foot(status: 200)
}

fn upcoming(out: Buf, rows: Rows[Event], at: Int) -> Buf {
  rows
    |> fold_rows(from: out, by: fn(o: Buf, event: Event) -> Buf {
      o
        |> append(view: "<li><a href=\"events/\(event.id)\">")
        |> write_html(text: event.name)
        |> append(view: "</a> <span class=meta>in \(spelled(ms: event.at_ms - at))</span></li>")
    })
}

fn shell(title: View) -> Buf {
  buf()
    |> append(view: "<!doctype html><html lang=en><meta charset=utf-8>")
    |> append(view: "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>")
    |> write_html(text: title)
    |> append(view: "</title><style>")
    |> append(view: ":root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fbfbf8;--mute:#6b6b6b;")
    |> append(
      view: "--box:#e6e4dc;--bar:#c0562f}@media (prefers-color-scheme:dark){:root{--fg:#e8e6e1;"
    )
    |> append(view: "--bg:#151514;--mute:#9a978f;--box:#2c2b27;--bar:#f08a5d}}body{margin:0 auto;")
    |> append(view: "max-width:720px;padding:24px 16px;background:var(--bg);color:var(--fg);")
    |> append(view: "font:16px/1.5 system-ui,sans-serif}h1{font-size:22px;margin:0 0 16px}")
    |> append(view: "h2{font-size:16px;margin-top:28px}.meta{color:var(--mute);font-size:14px}")
    |> append(
      view: "a{color:inherit}.card{display:flex;gap:20px;align-items:center;flex-wrap:wrap}"
    )
    |> append(
      view: ".big{font-size:28px;font-weight:600;margin:0;font-variant-numeric:tabular-nums}"
    )
    |> append(
      view: "pre{background:var(--box);padding:12px 14px;border-radius:8px;overflow-x:auto;"
    )
    |> append(
      view: "font:13px/1.45 ui-monospace,monospace}footer{margin-top:32px;color:var(--mute);"
    )
    |> append(view: "font-size:13px}</style><h1>")
    |> write_html(text: title)
    |> append(view: "</h1>")
}

fn foot(out: Buf, status: Int) -> Response {
  out
    |> append(view: "<footer>A small program written in <a href=\"/\">Tape</a> · <a \
        href=\"https://github.com/ivarvong/tape/blob/main/apps/products/countdown/countdown.tape\">source</a></footer></html>")
    |> respond_as(status, content: Html)
    |> header(name: "cache-control", value: "no-store")
}
