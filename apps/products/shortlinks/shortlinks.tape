// shortlinks.tape: short names for long https links. POST /links {"slug": "docs", "url": "https://…"} makes
// /s/docs; the slug is the client's key, so the same POST again is the same link (200), and a slug already
// taken by another URL is a 409. /s/<slug> does not redirect on its own: it shows where the link goes and
// counts the visit, so nobody lands somewhere they did not see first. /stats lists the links by visits, and
// /api/links/<slug> is one link as JSON.

migration 1 "links" {
  CREATE TABLE links(
    slug TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL,
    created INTEGER NOT NULL,
    clicks INTEGER NOT NULL DEFAULT 0
  )
}

invariant "a link's visits are never negative" {
  SELECT slug, clicks FROM links WHERE clicks < 0
}

type Slug = View where len(self) >= 2
  and len(self) <= 32
  and every_byte(v: self, keep: slug_byte) else "2 to 32 of a-z, 0-9 and -"
type Url = View where len(self) >= 12
  and len(self) <= 2000
  and starts_with(v: self, prefix: "https://")
  and every_byte(
  v: self,
  keep: url_byte
) else "an https:// URL, 12 to 2000 bytes, without spaces, quotes or angle brackets"

type NewLink { NewLink(slug: Slug, url: Url) }
type Link { Link(slug: View, url: View, created: Int, clicks: Int) }
type Made { Made(link: Link, new: Bool, short: View) }
type Problem { Problem(error: View) }

// a-z, 0-9 and -
fn slug_byte(b: Int) -> Bool {
  is_lower(b) or is_digit(b) or b == 45
}

// Printable ASCII but space, " ' < > \ and `: a URL that cannot break out of an attribute or a tag.
//
//   > every_byte(v: "https://example.com/a?b=1#c", keep: url_byte)
//   True
//   > every_byte(v: "https://x.io/\"><script>", keep: url_byte)
//   False
fn url_byte(b: Int) -> Bool {
  b > 32 and b < 127 and b != 34 and b != 39 and b != 60 and b != 62 and b != 92 and b != 96
}

fn handle(raw: View, db: Sql, clock: Clock) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/") -> home()
    Request(method: "POST", path: "/links", body) -> create(body)
    Request(method: "GET", path: "/s/" ++ Slug(slug)) -> visit(found: sql_first(
      row: Link,
      repeat: True,
      query: "UPDATE links SET clicks = clicks + 1 WHERE slug = :slug RETURNING *",
      slug
    ))
    Request(method: "GET", path: "/api/links/" ++ Slug(slug)) -> as_json(found: load(slug))
    Request(method: "GET", path: "/stats/" ++ Slug(slug)) -> stats_one(found: load(slug))
    Request(method: "GET", path: "/stats") -> stats_all(
      rows: sql_all(row: Link, query: "SELECT * FROM links ORDER BY clicks DESC, slug LIMIT 50")
    )
    Request(method: "GET", path: "/s/" ++ _) -> visit(found: None)
    _ -> problem(status: 404, error: "no such route")
  }
}

fn load(slug: View) -> Option[Link] {
  sql_first(row: Link, query: "SELECT * FROM links WHERE slug = :slug", slug)
}

// POST /links: the slug is claimed by the INSERT; a second run (a retry) finds it and answers what is there.
fn create(body: View) -> Buf {
  let Ok(value: NewLink(slug, url)) = decode(json: body, as: NewLink) else {
    Err(error) -> problem(status: 400, error)
  }
  let Some(value: link) = sql_first(
    row: Link,
    query: "INSERT INTO links(slug, url, created) VALUES (:slug, :url, :created) \
        ON CONFLICT(slug) DO NOTHING RETURNING *",
    slug,
    url,
    created: now()
  ) else -> again(url, found: load(slug))
  made(status: 201, link, new: True)
}

fn again(url: View, found: Option[Link]) -> Buf {
  match found {
    Some(value: link = Link(url: had)) if had == url -> made(status: 200, link, new: False)
    Some(value) -> problem(status: 409, error: "slug \(value.slug) is taken by another URL")
    None -> problem(status: 500, error: "the link vanished")
  }
}

fn made(status: Int, link: Link, new: Bool) -> Buf {
  respond_as(status, content: Json) |> write_json(value: Made(link, new, short: "/s/\(link.slug)"))
}

fn as_json(found: Option[Link]) -> Buf {
  match found {
    Some(value) -> respond_as(status: 200, content: Json) |> write_json(value)
    None -> problem(status: 404, error: "no such link")
  }
}

fn problem(status: Int, error: View) -> Buf {
  respond_as(status, content: Json) |> write_json(value: Problem(error))
}

// ---------- pages ----------

fn page(status: Int, title: View) -> Buf {
  respond_as(status, content: Html)
    |> header(name: "cache-control", value: "no-store")
    |> append(view: "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport \
        content=\"width=device-width,initial-scale=1\"><meta name=robots \
        content=\"noindex,nofollow\"><title>")
    |> write_html(text: title)
    |> append(view: " · shortlinks</title><style>:root{color-scheme:light \
        dark;--fg:#1d1f23;--mute:#626873;--bg:#fbfbfa;--card:#fff;--line:#e3e4e6;--acc:#2856c7}@media(prefers-color-scheme:dark){:root{--fg:#e8e9eb;--mute:#9aa0aa;--bg:#15171a;--card:#1d2024;--line:#30343a;--acc:#86a8ff}}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}main{max-width:44rem;margin:0 auto;padding:2rem 1rem}h1{font-size:1.6rem;margin:0 0 .25rem}a{color:var(--acc)}.mute{color:var(--mute)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem 1.25rem;margin:1rem 0;overflow-wrap:anywhere}pre,code{font:13px/1.45 ui-monospace,Menlo,monospace}pre{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.75rem}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.go{display:inline-block;margin-top:.5rem;padding:.5rem 1rem;border-radius:8px;background:var(--acc);color:var(--bg);text-decoration:none;font-weight:600}</style><main><p class=mute><a href=\"/p/demo/shortlinks/\">shortlinks</a> · <a href=\"/p/demo/shortlinks/stats\">stats</a></p><h1>")
    |> write_html(text: title)
    |> append(view: "</h1>")
}

fn end(out: Buf) -> Buf {
  out
    |> append(view: "<p class=mute>Written in Tape. Links go only to https URLs, and every link \
        shows its destination before you follow it.</p></main></html>")
}

fn home() -> Buf {
  page(status: 200, title: "Short links")
    |> append(view: "<p>Give a long https link a short name. Each visit is counted, and every \
        short link shows where it goes before you follow it.</p><h2>Make one</h2><pre>curl -X \
        POST https://tape.ivar.workers.dev/p/demo/shortlinks/links \\\n  -d '{\"slug\": \
        \"tape-guide\", \"url\": \"https://github.com/ivarvong/tape\"}'</pre><p>The slug is 2 to \
        32 of a-z, 0-9 and -. Sending the same POST again answers the same link (<code>\"new\": \
        false</code>); a slug taken by another URL is a 409.</p><h2>Read</h2><ul><li><code>GET \
        s/&lt;slug&gt;</code> the link, counted</li><li><code>GET stats/&lt;slug&gt;</code> its \
        page of numbers</li><li><code>GET api/links/&lt;slug&gt;</code> the same as \
        JSON</li><li><code>GET stats</code> the 50 most visited</li></ul>")
    |> end
}

fn visit(found: Option[Link]) -> Buf {
  match found {
    Some(value: Link(slug, url, clicks)) -> page(status: 200, title: slug)
      |> append(view: "<div class=card><p class=mute>This short link goes to</p><p><code>")
      |> write_html(text: url)
      |> append(view: "</code></p><a class=go rel=\"nofollow noopener noreferrer\" href=\"")
      |> write_html(text: url)
      |> append(view: "\">Continue</a></div><p class=mute>Visited \(clicks) \(times(n: clicks)). \
          <a href=\"/p/demo/shortlinks/stats/\(slug)\">Stats</a></p>")
      |> end
    None -> page(status: 404, title: "No such link")
      |> append(view: "<p>Nothing is called that. <a href=\"/p/demo/shortlinks/stats\">See the \
          links</a>.</p>")
      |> end
  }
}

fn stats_one(found: Option[Link]) -> Buf {
  match found {
    Some(value: Link(slug, url, created, clicks)) -> page(status: 200, title: "Stats for \(slug)")
      |> append(view: "<div class=card><table><tr><th>Destination</th><td><code>")
      |> write_html(text: url)
      |> append(
      view: "</code></td></tr><tr><th>Visits</th><td>\(clicks)</td></tr><tr><th>Made</th><td>"
    )
      |> append(view: date_time(ms: created))
      |> append(view: " UTC</td></tr><tr><th>Short link</th><td><a \
          href=\"/p/demo/shortlinks/s/\(slug)\">s/\(slug)</a></td></tr></table></div>")
      |> end
    None -> page(status: 404, title: "No such link") |> end
  }
}

fn stats_all(rows: Rows[Link]) -> Buf {
  page(status: 200, title: "The most visited links")
    |> append(view: "<div class=card><table><tr><th>Slug</th><th>Destination</th><th \
        class=n>Visits</th></tr>")
    |> stat_rows(rows)
    |> append(view: "</table></div>")
    |> end
}

fn stat_rows(out: Buf, rows: Rows[Link]) -> Buf {
  match next(rows) {
    Next(value: Link(slug, url, clicks), rest) -> out
      |> append(
      view: "<tr><td><a href=\"/p/demo/shortlinks/stats/\(slug)\">\(slug)</a></td><td><code>"
    )
      |> write_html(text: url)
      |> append(view: "</code></td><td class=n>\(clicks)</td></tr>")
      |> stat_rows(rows: rest)
    End -> out
  }
}

fn times(n: Int) -> View {
  match n {
    1 -> "time"
    _ -> "times"
  }
}

// ---------- dates ----------

// Milliseconds since 1970 as YYYY-MM-DD HH:MM (UTC), by Howard Hinnant's days-to-civil.
//
//   > date_time(ms: 0)
//   "1970-01-01 00:00"
//   > date_time(ms: 1795392000000)
//   "2026-11-23 00:00"
//   > date_time(ms: 951825600000)
//   "2000-02-29 12:00"
fn date_time(ms: Int) -> View {
  let days = ms / 86400000
  let minutes = ms % 86400000 / 60000
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
  "\(y)-\(two(n: m))-\(two(n: d)) \(two(n: minutes / 60)):\(two(n: minutes % 60))"
}

fn two(n: Int) -> View {
  match {
    n < 10 -> "0\(n)"
    else -> "\(n)"
  }
}
