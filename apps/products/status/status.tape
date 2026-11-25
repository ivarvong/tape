// status.tape: a status page. Each component has a state, moved only along its machine; an incident has a timeline
// of updates and a state of its own. Anyone can read the page and the feeds; only the operator can write.
//
//   GET  /                          the page: the overall state, each component, open and recent incidents
//   GET  /status.json               {"overall","components":[…],"incidents":[…]} (open ones)
//   GET  /feed.json                 the incident updates as a JSON Feed 1.1
//   POST /components/<slug>         {"state","note"?,"minutes"?} operator: degraded, outage, operational, or
//                                   maintenance for 1 to 1440 minutes, after which a timer makes it operational
//   POST /incidents                 {"key","component","title","impact","body"} operator: impact is degraded or
//                                   outage; the incident starts investigating and moves its component there
//   POST /incidents/<id>/updates    {"key","state","body"} operator: identified, monitoring or resolved; resolving
//                                   it makes its component operational again
//
// A write's key is claimed first, so a retried POST answers what the first did. A move names the states it may
// leave (`AND state IN (…)`): a component in outage cannot go to maintenance, and a move that finds the row in
// another state answers 409 with the state it found.

migration 1 "status" {
  CREATE TABLE components(
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'operational',
    note TEXT NOT NULL DEFAULT '',
    since INTEGER NOT NULL DEFAULT 0,
    until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE incidents(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    component INTEGER NOT NULL REFERENCES components(id),
    title TEXT NOT NULL,
    impact TEXT NOT NULL CHECK (impact IN ('degraded', 'outage')),
    state TEXT NOT NULL DEFAULT 'investigating',
    started INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE updates(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    incident INTEGER NOT NULL REFERENCES incidents(id),
    state TEXT NOT NULL,
    body TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  INSERT INTO components(slug, name) VALUES ('api', 'API'), ('web', 'Website'), ('db', 'Database'),
    ('email', 'Email delivery')
}

machine components.state {
  "operational" -> "degraded"
  "operational" -> "outage"
  "operational" -> "maintenance"
  "degraded" -> "operational"
  "degraded" -> "outage"
  "outage" -> "degraded"
  "outage" -> "operational"
  "maintenance" -> "operational"
}

machine incidents.state {
  "investigating" -> "identified"
  "investigating" -> "monitoring"
  "investigating" -> "resolved"
  "identified" -> "monitoring"
  "identified" -> "resolved"
  "monitoring" -> "identified"
  "monitoring" -> "resolved"
}

invariant "an incident is resolved exactly when it says when" {
  SELECT id FROM incidents WHERE (state = 'resolved') <> (resolved > 0)
}

invariant "every incident has at least its first update" {
  SELECT i.id FROM incidents AS i WHERE NOT EXISTS (SELECT 1 FROM updates AS u WHERE u.incident = i.id)
}

invariant "a component in maintenance knows when it ends" {
  SELECT id FROM components WHERE state = 'maintenance' AND until <= since
}

type Key = View where len(self) >= 1 and len(self) <= 64 else "1 to 64 bytes"
type Text = View where char_count(v: self) >= 1 and char_count(v: self) <= 500
type Title = View where char_count(v: self) >= 1 and char_count(v: self) <= 120
type Minutes = Int where self >= 1 and self <= 1440

type Change { Change(state: View, note: Option[Text], minutes: Option[Minutes]) }
type NewIncident { NewIncident(key: Key, component: View, title: Title, impact: View, body: Text) }
type NewUpdate { NewUpdate(key: Key, state: View, body: Text) }

type Component { Component(
  id: Int,
  slug: View,
  name: View,
  state: View,
  note: View,
  since: Int,
  until: Int
) }
type Incident { Incident(
  id: Int,
  component: Int,
  title: View,
  impact: View,
  state: View,
  started: Int,
  resolved: Int
) }
type Update { Update(id: Int, incident: Int, state: View, body: View, at: Int) }
type Counts { Counts(outage: Int, degraded: Int, maintenance: Int) }
type Status { Status(overall: View, components: List[Component], incidents: List[Incident]) }
type Item { Item(id: View, title: View, content_text: View, date_published: View) }
type Feed { Feed(version: View, title: View, home_page_url: View, items: List[Item]) }
type Line { Line(id: Int, at: Int, title: View, state: View, body: View) }
type Ended { Ended(component: Int, state: View) }
type Problem { Problem(error: View) }

fn handle(raw: View, db: Sql, clock: Clock, timer: Timer) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/") -> page(at: now())
    Request(method: "GET", path: "/status.json") -> respond_as(status: 200, content: Json)
      |> header(name: "cache-control", value: "no-store")
      |> write_json(value: Status(overall: overall(), components: components(), incidents: open()))
    Request(method: "GET", path: "/feed.json") -> feed()
    Request(method: "POST", caller: Anyone) -> problem(
      status: 403,
      error: "only the operator writes here"
    )
    Request(method: "POST", path: "/components/" ++ slug, body) -> changed(slug, body)
    Request(method: "POST", path: "/incidents", body) -> opened(body)
    Request(
      method: "POST",
      path: "/incidents/" ++ decimal(id) ++ "/updates",
      body
    ) -> updated(id, body)
    _ -> problem(status: 404, error: "no such route")
  }
}

// a maintenance window ends: the component is operational again, unless someone moved it first
export fn woken(db: Sql, clock: Clock, message: Wake) -> Result[Ended, View] {
  let Wake(key) = message
  match sql_move(
    row: Component,
    query: "UPDATE components SET state = 'operational', note = '', since = :at, until = 0 \
        WHERE id = :key AND state = 'maintenance' RETURNING *",
    key,
    at: now()
  ) {
    Moved(value) -> Ok(value: Ended(component: key, state: value.state))
    Raced(now) -> Ok(value: Ended(component: key, state: now.state))
    NoRow -> Err(error: "no component \(key)")
  }
}

fn changed(slug: View, body: View) -> Buf {
  let Ok(value: Change(state, note, minutes)) = decode(json: body, as: Change) else {
    Err(error) -> problem(status: 400, error)
  }
  let text = match note {
    Some(value) -> value
    None -> ""
  }
  let at = now()
  match state {
    "maintenance" -> match minutes {
      Some(value: m) -> maintained(
        slug,
        minutes: m,
        moved: sql_move(
          row: Component,
          query: "UPDATE components SET state = 'maintenance', note = :text, since = :at, until = \
              :until WHERE slug = :slug AND state = 'operational' RETURNING *",
          slug,
          text,
          at,
          until: at + m * 60000
        )
      )
      None -> problem(status: 400, error: "minutes: missing")
    }
    "degraded" -> shown(moved: sql_move(
      row: Component,
      query: "UPDATE components SET state = 'degraded', note = :text, since = :at, until = 0 \
          WHERE slug = :slug AND state IN ('operational', 'outage') RETURNING *",
      slug,
      text,
      at
    ))
    "outage" -> shown(moved: sql_move(
      row: Component,
      query: "UPDATE components SET state = 'outage', note = :text, since = :at, until = 0 \
          WHERE slug = :slug AND state IN ('operational', 'degraded') RETURNING *",
      slug,
      text,
      at
    ))
    "operational" -> shown(moved: back(slug, text, at))
    _ -> problem(status: 400, error: "state: degraded, outage, maintenance or operational")
  }
}

fn back(slug: View, text: View, at: Int) -> Move[Component] {
  sql_move(
    row: Component,
    query: "UPDATE components SET state = 'operational', note = :text, since = :at, until = 0 \
        WHERE slug = :slug AND state IN ('degraded', 'outage', 'maintenance') RETURNING *",
    slug,
    text,
    at
  )
}

fn maintained(slug: View, minutes: Int, moved: Move[Component]) -> Buf {
  match moved {
    Moved(value) -> {
      do wake(after: minutes * 60000, key: value.id)
      respond_as(status: 200, content: Json) |> write_json(value)
    }
    _ -> shown(moved)
  }
}

fn shown(moved: Move[Component]) -> Buf {
  match moved {
    Moved(value) -> respond_as(status: 200, content: Json) |> write_json(value)
    Raced(now) -> problem(
      status: 409,
      error: "\(now.slug) is \(now.state), and cannot move there from it"
    )
    NoRow -> problem(status: 404, error: "no such component")
  }
}

fn opened(body: View) -> Buf {
  let Ok(
    value: NewIncident(key, component, title, impact, body: first)
  ) = decode(json: body, as: NewIncident) else {
    Err(error) -> problem(status: 400, error)
  }
  let True = impact == "degraded"
    or impact == "outage" else -> problem(status: 400, error: "impact: degraded or outage")
  let Some(value: c) = sql_first(
    row: Component,
    query: "SELECT * FROM components WHERE slug = :component",
    component
  ) else -> problem(status: 404, error: "no component \(component)")
  let at = now()
  let Some(value: incident) = sql_first(
    row: Incident,
    query: "INSERT INTO incidents(client, component, title, impact, started) \
        VALUES (:key, :id, :title, :impact, :at) ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    id: c.id,
    title,
    impact,
    at
  ) else -> incident_shown(
    status: 200,
    found: sql_first(row: Incident, query: "SELECT * FROM incidents WHERE client = :key", key)
  )
  let _ = sql_exec(
    query: "INSERT INTO updates(client, incident, state, body, at) \
        VALUES (:key, :incident, 'investigating', :first, :at)",
    key,
    incident: incident.id,
    first,
    at
  )
  do moved_or_not(m: match impact {
    "outage" -> sql_move(
      row: Component,
      query: "UPDATE components SET state = 'outage', note = :title, since = :at, until = 0 \
          WHERE id = :id AND state IN ('operational', 'degraded') RETURNING *",
      id: c.id,
      title,
      at
    )
    _ -> sql_move(
      row: Component,
      query: "UPDATE components SET state = 'degraded', note = :title, since = :at, until = 0 \
          WHERE id = :id AND state = 'operational' RETURNING *",
      id: c.id,
      title,
      at
    )
  })
  incident_shown(status: 201, found: Some(value: incident))
}

fn updated(id: Int, body: View) -> Buf {
  let Ok(value: NewUpdate(key, state, body: text)) = decode(json: body, as: NewUpdate) else {
    Err(error) -> problem(status: 400, error)
  }
  let at = now()
  let 1 = sql_exec(
    query: "INSERT INTO updates(client, incident, state, body, at) \
        SELECT :key, :id, :state, :text, :at WHERE EXISTS (SELECT 1 FROM incidents \
        WHERE id = :id) ON CONFLICT(client) DO NOTHING",
    key,
    id,
    state,
    text,
    at
  ) else -> incident_shown(status: 200, found: load(id))
  let moved = match state {
    "identified" -> sql_move(
      row: Incident,
      query: "UPDATE incidents SET state = 'identified' WHERE id = :id AND state \
          IN ('investigating', 'monitoring') RETURNING *",
      id
    )
    "monitoring" -> sql_move(
      row: Incident,
      query: "UPDATE incidents SET state = 'monitoring' WHERE id = :id AND state \
          IN ('investigating', 'identified') RETURNING *",
      id
    )
    "resolved" -> sql_move(
      row: Incident,
      query: "UPDATE incidents SET state = 'resolved', resolved = :at WHERE id = :id AND state \
          IN ('investigating', 'identified', 'monitoring') RETURNING *",
      id,
      at
    )
    _ -> NoRow
  }
  match moved {
    Moved(value: i = Incident(state: "resolved")) -> {
      do moved_or_not(m: sql_move(
        row: Component,
        query: "UPDATE components SET state = 'operational', note = '', since = :at, until = 0 \
            WHERE id = :component AND state IN ('degraded', 'outage') RETURNING *",
        component: i.component,
        at
      ))
      incident_shown(status: 201, found: Some(value: i))
    }
    Moved(value) -> incident_shown(status: 201, found: Some(value))
    Raced(now) -> rollback(out: problem(status: 409, error: "incident \(id) is \(now.state)"))
    NoRow -> rollback(out: problem(
      status: 400,
      error: "state: identified, monitoring or resolved, of an incident that exists"
    ))
  }
}

// a component moved along with an incident; one already there, or past it, stays as it is
fn moved_or_not(m: Move[Component]) -> Done {
  match m {
    Moved -> Done
    _ -> Done
  }
}

fn load(id: Int) -> Option[Incident] {
  sql_first(row: Incident, query: "SELECT * FROM incidents WHERE id = :id", id)
}

fn incident_shown(status: Int, found: Option[Incident]) -> Buf {
  match found {
    Some(value) -> respond_as(status, content: Json) |> write_json(value)
    None -> problem(status: 404, error: "no such incident")
  }
}

fn problem(status: Int, error: View) -> Buf {
  respond_as(status, content: Json) |> write_json(value: Problem(error))
}

fn overall() -> View {
  match sql_first(
    row: Counts,
    query: "SELECT coalesce(sum(state = 'outage'), 0) AS outage, coalesce(sum(state = \
        'degraded'), 0) AS degraded, coalesce(sum(state = 'maintenance'), 0) AS maintenance \
        FROM components"
  ) {
    Some(value: Counts(outage)) if outage > 0 -> "outage"
    Some(value: Counts(degraded)) if degraded > 0 -> "degraded"
    Some(value: Counts(maintenance)) if maintenance > 0 -> "maintenance"
    _ -> "operational"
  }
}

fn components() -> List[Component] {
  listed(rows: sql_all(row: Component, query: "SELECT * FROM components ORDER BY id"))
}

fn open() -> List[Incident] {
  listed(rows: sql_all(
    row: Incident,
    query: "SELECT * FROM incidents WHERE state <> 'resolved' ORDER BY started DESC"
  ))
}

fn listed[T](rows: Rows[T]) -> List[T] {
  match next(rows) {
    Next(value, rest) -> Cons(head: value, tail: listed(rows: rest))
    End -> Nil
  }
}

fn feed() -> Buf {
  let items = listed(rows: sql_all(
    row: Line,
    query: "SELECT u.id AS id, u.at AS at, i.title AS title, u.state AS state, u.body AS body \
        FROM updates AS u JOIN incidents AS i ON i.id = u.incident ORDER BY u.at DESC, u.id \
        DESC LIMIT 50"
  ))
  respond_as(status: 200, content: Json)
    |> header(name: "cache-control", value: "no-store")
    |> write_json(value: Feed(version: "https://jsonfeed.org/version/1.1", title: "Status", home_page_url: "https://tape.ivar.workers.dev/p/demo/status/", items: map(list: items, by: fn(
      l: Line
    ) -> Item {
      Item(
        id: "\(l.id)",
        title: l.title ++ ": " ++ l.state,
        content_text: l.body,
        date_published: iso(ms: l.at)
      )
    })))
}

fn page(at: Int) -> Buf {
  let state = overall()
  let out = respond_as(status: 200, content: Html)
    |> header(name: "cache-control", value: "no-store")
    |> append(view: "<!doctype html><html lang=en><meta charset=utf-8>")
    |> append(view: "<meta name=viewport \
        content=\"width=device-width,initial-scale=1\"><title>Status</title>")
    |> append(view: "<link rel=alternate type=application/feed+json href=feed.json><style>")
    |> append(view: ":root{color-scheme:light \
        dark;--fg:#1d1d1f;--bg:#fbfbf8;--mute:#6b6b6b;--line:#e2e0d8;")
    |> append(
      view: "--operational:#1f7a3d;--degraded:#a86500;--outage:#b3261e;--maintenance:#2f5fb3}"
    )
    |> append(
      view: "@media (prefers-color-scheme:dark){:root{--fg:#e8e6e1;--bg:#151514;--mute:#9a978f;"
    )
    |> append(view: "--line:#33322d;--operational:#6fcf8e;--degraded:#f0b45a;--outage:#f08a80;")
    |> append(view: "--maintenance:#8fb0f0}body .banner{color:#151514}}body{margin:0 \
        auto;max-width:720px;padding:24px 16px;")
    |> append(view: "background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}")
    |> append(view: "h1{font-size:22px;margin:0 0 12px}h1 small{font:14px \
        system-ui,sans-serif;color:var(--mute)}h2{font-size:16px;margin:28px 0 8px}")
    |> append(
      view: ".meta{color:var(--mute);font-size:14px}a{color:inherit}.banner{padding:14px 16px;"
    )
    |> append(view: "border-radius:10px;color:#fff;font-weight:600}.c{display:flex;justify-content:space-between;")
    |> append(view: "gap:12px;padding:10px 0;border-bottom:1px solid \
        var(--line)}.dot{display:inline-block;")
    |> append(
      view: "width:10px;height:10px;border-radius:50%;margin-right:8px}.s{white-space:nowrap}"
    )
    |> append(view: ".i{border-left:3px solid var(--line);padding:2px 0 2px 12px;margin:14px 0}")
    |> append(
      view: ".i p{margin:4px 0}footer{margin-top:32px;color:var(--mute);font-size:13px}</style>"
    )
    |> append(view: "<h1>Status <small>of a made-up service</small></h1><div class=banner \
        style=\"background:var(--\(state))\">")
    |> append(view: banner(state))
    |> append(view: "</div><h2>Components</h2>")
  let listed_out = fold(
    list: components(),
    from: out,
    by: fn(o: Buf, c: Component) -> Buf { row(out: o, c) }
  )
    |> append(view: "<h2>Incidents</h2>")
  incidents_html(
    out: listed_out,
    rows: sql_all(row: Incident, query: "SELECT * FROM incidents ORDER BY started DESC LIMIT 10")
  )
    |> append(view: "<footer>As of \(iso(ms: at)) · <a href=\"status.json\">status.json</a> · ")
    |> append(view: "<a href=\"feed.json\">feed.json</a> · made-up data: a small program written \
        in <a href=\"/\">Tape</a> · <a \
        href=\"https://github.com/ivarvong/tape/blob/main/apps/products/status/status.tape\">source</a></footer></html>")
}

fn banner(state: View) -> View {
  match state {
    "outage" -> "Major outage"
    "degraded" -> "Partial degradation"
    "maintenance" -> "Maintenance in progress"
    _ -> "All systems operational"
  }
}

fn row(out: Buf, c: Component) -> Buf {
  out
    |> append(
      view: "<div class=c><div><span class=dot style=\"background:var(--\(c.state))\"></span>"
    )
    |> write_html(text: c.name)
    |> append(view: match c.note {
      "" -> ""
      _ -> "<div class=meta>"
    })
    |> write_html(text: c.note)
    |> append(view: match c.note {
      "" -> ""
      _ -> "</div>"
    })
    |> append(view: "</div><div class=s style=\"color:var(--\(c.state))\">\(c.state)")
    |> append(view: match c.until > 0 {
      True -> "<div class=meta>until \(iso(ms: c.until))</div>"
      False -> ""
    })
    |> append(view: "</div></div>")
}

fn incidents_html(out: Buf, rows: Rows[Incident]) -> Buf {
  match next(rows) {
    Next(value: i, rest) -> timeline(
      out: out
        |> append(view: "<div class=i><b>")
        |> write_html(text: i.title)
        |> append(view: "</b> <span class=meta>\(i.state) · since \(iso(ms: i.started))</span>"),
      rows: sql_all(
        row: Update,
        query: "SELECT id, incident, state, body, at FROM updates WHERE incident = :id \
            ORDER BY at DESC, id DESC",
        id: i.id
      )
    )
      |> append(view: "</div>")
      |> incidents_html(rows: rest)
    End -> out
  }
}

fn timeline(out: Buf, rows: Rows[Update]) -> Buf {
  rows
    |> fold_rows(from: out, by: fn(o: Buf, u: Update) -> Buf {
      o
        |> append(view: "<p><span class=meta>\(iso(ms: u.at)) · \(u.state)</span><br>")
        |> write_html(text: u.body)
        |> append(view: "</p>")
    })
}

// milliseconds since 1970 as an RFC 3339 time in UTC, to the second (H. Hinnant's civil_from_days)
//
//   > iso(ms: 0)
//   "1970-01-01T00:00:00Z"
//   > iso(ms: 951782400000)
//   "2000-02-29T00:00:00Z"
fn iso(ms: Int) -> View {
  let s = ms / 1000
  let z = s / 86400 + 719468
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
  let t = s % 86400
  "\(y)-\(two(m))-\(two(d))T\(two(t / 3600)):\(two(t / 60 % 60)):\(two(t % 60))Z"
}

fn two(n: Int) -> View {
  match {
    n < 10 -> "0\(n)"
    else -> "\(n)"
  }
}
