// ratelimit.tape: rate limiting as a service. POST /hit/<key>?limit=10&window=60 takes one from the key's budget
// for the current fixed window (window seconds long, aligned to the clock) and answers 200 with what is left, or
// 429 with Retry-After once the budget is spent. X-RateLimit-Limit, -Remaining and -Reset say where the key
// stands either way. GET /peek/<key>?… answers the same without taking anything. A hit sent with an
// idempotency-key header counts once: the same key again answers what the first did. GET / is a dashboard of
// the keys busy in the last minutes.

migration 1 "windows" {
  CREATE TABLE windows(
    key TEXT NOT NULL,
    span INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    lim INTEGER NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY(key, span, slot)
  );
  CREATE TABLE ops(
    key TEXT NOT NULL,
    op TEXT NOT NULL,
    slot INTEGER NOT NULL,
    allowed INTEGER NOT NULL DEFAULT 0,
    remaining INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(key, op)
  )
}

invariant "a window never counts past its limit" {
  SELECT key, slot, n, lim FROM windows WHERE n > lim OR n < 0
}

type Key = View where len(self) >= 1
  and len(self) <= 64
  and every_byte(v: self, keep: key_byte) else "1 to 64 of a-z, A-Z, 0-9 and - _ . :"
type Op = View where len(self) >= 1 and len(self) <= 128

type Count { Count(n: Int) }
type Window { Window(key: View, span: Int, slot: Int, lim: Int, n: Int) }
type Claim { Claim(allowed: Bool, remaining: Int) }

// The rule asked for: `limit` hits a window of `span` ms; the window now, and when it ends (ms since 1970).
type Rule { Rule(limit: Int, span: Int, slot: Int, resets: Int, at: Int) }
type Verdict { Verdict(
  key: View,
  allowed: Bool,
  limit: Int,
  remaining: Int,
  reset: Int,
  window: Int
) }

fn key_byte(b: Int) -> Bool {
  is_alnum(b) or b == 45 or b == 95 or b == 46 or b == 58
}

fn handle(raw: View, db: Sql, clock: Clock) -> Response {
  let r = request(raw)
  match r {
    Request(method: Get, path: "/") -> dashboard(at: now())
    Request(method: Post, path: "/hit/" ++ Key(key), query) -> match rule(query) {
      Ok(value: rule) -> hit(key, rule, op: header_of(request: r, name: "idempotency-key"))
      Err(error) -> problem(status: 400, detail: error)
    }
    Request(method: Get, path: "/peek/" ++ Key(key), query) -> match rule(query) {
      Ok(value: rule) -> peeked(key, rule, n: used(key, rule))
      Err(error) -> problem(status: 400, detail: error)
    }
    Request(path: "/hit/" ++ _) -> problem(
      status: 400,
      detail: "key: 1 to 64 of a-z, A-Z, 0-9 and - _ . :"
    )
    Request(path: "/peek/" ++ _) -> problem(
      status: 400,
      detail: "key: 1 to 64 of a-z, A-Z, 0-9 and - _ . :"
    )
    _ -> problem(status: 404, detail: "no such route")
  }
}

// ?limit= (1 to 100000, 10 when absent) and ?window= in seconds (1 to 86400, 60 when absent).
fn rule(query: Option[View]) -> Result[Rule, View] uses clock {
  let q = match query {
    Some(value) -> value
    None -> ""
  }
  let Some(value: limit) = param(
    q,
    name: "limit",
    absent: 10,
    most: 100000
  ) else -> Err(error: "limit: a whole number from 1 to 100000")
  let Some(value: seconds) = param(
    q,
    name: "window",
    absent: 60,
    most: 86400
  ) else -> Err(error: "window: seconds, a whole number from 1 to 86400")
  let span = seconds * 1000
  let at = now()
  let slot = at / span
  Ok(value: Rule(limit, span, slot, resets: (slot + 1) * span, at))
}

fn param(q: View, name: View, absent: Int, most: Int) -> Option[Int] {
  match form_field(body: q, name) {
    None -> Some(value: absent)
    Some(value: decimal(n)) if n >= 1 and n <= most -> Some(value: n)
    Some -> None
  }
}

// A look: would a hit now be let through?
fn peeked(key: View, rule: Rule, n: Int) -> Response {
  answered(key, rule, allowed: n < rule.limit, used: n, peek: True)
}

fn used(key: View, rule: Rule) -> Int uses db {
  match sql_first(
    row: Count,
    query: "SELECT n FROM windows WHERE key = :key AND span = :span AND slot = :slot",
    key,
    span: rule.span,
    slot: rule.slot
  ) {
    Some(value: Count(n)) -> n
    None -> 0
  }
}

// ---------- a hit ----------

fn hit(key: View, rule: Rule, op: Option[View]) -> Response uses db {
  let _ = sql_exec(
    query: "DELETE FROM windows WHERE key = :key AND slot < :slot - 1",
    key,
    slot: rule.slot
  )
  match op {
    Some(value: Op(o)) -> once(key, rule, o)
    Some -> problem(status: 400, detail: "idempotency-key: 1 to 128 bytes")
    None -> {
      let taken = sql_exec(
        repeat: True,
        query: "INSERT INTO windows(key, span, slot, lim, n) \
            VALUES (:key, :span, :slot, :limit, 1) ON CONFLICT(key, span, slot) \
            DO UPDATE SET n = n + 1, lim = max(lim, :limit) WHERE n < :limit",
        key,
        span: rule.span,
        slot: rule.slot,
        limit: rule.limit
      )
      answered(key, rule, allowed: taken == 1, used: used(key, rule), peek: False)
    }
  }
}

// A hit with an idempotency key: the key is claimed first, so a second run of the same request finds the claim
// and answers the verdict the first one stored.
fn once(key: View, rule: Rule, o: View) -> Response uses db {
  let _ = sql_exec(
    query: "DELETE FROM ops WHERE key = :key AND slot < :slot - 1",
    key,
    slot: rule.slot
  )
  let 1 = sql_exec(
    query: "INSERT INTO ops(key, op, slot) VALUES (:key, :o, :slot) ON CONFLICT(key, op) \
        DO NOTHING",
    key,
    o,
    slot: rule.slot
  ) else -> replayed(
    key,
    rule,
    found: sql_first(
      row: Claim,
      query: "SELECT allowed, remaining FROM ops WHERE key = :key AND op = :o",
      key,
      o
    )
  )
  let taken = sql_exec(
    query: "INSERT INTO windows(key, span, slot, lim, n) VALUES (:key, :span, :slot, :limit, 1) \
        ON CONFLICT(key, span, slot) DO UPDATE SET n = n + 1, lim = max(lim, :limit) \
        WHERE n < :limit",
    key,
    span: rule.span,
    slot: rule.slot,
    limit: rule.limit
  )
  let n = used(key, rule)
  // the claim is this run's own, made above in the same transaction
  let 1 = sql_exec(
    query: "UPDATE ops SET allowed = :allowed, remaining = :remaining WHERE key = :key AND op = :o",
    allowed: taken == 1,
    remaining: max(a: 0, b: rule.limit - n),
    key,
    o
  ) else -> rollback(out: problem(status: 500, detail: "the claim of idempotency-key \(o) is gone"))
  answered(key, rule, allowed: taken == 1, used: n, peek: False)
}

fn replayed(key: View, rule: Rule, found: Option[Claim]) -> Response {
  match found {
    Some(value: Claim(allowed, remaining)) -> answered(
      key,
      rule,
      allowed,
      used: rule.limit - remaining,
      peek: False
    )
    None -> problem(status: 500, detail: "the claim is gone")
  }
}

// The verdict, with the headers a client reads. A peek is a look, so it is 200 whatever it finds.
fn answered(key: View, rule: Rule, allowed: Bool, used: Int, peek: Bool) -> Response {
  let remaining = max(a: 0, b: rule.limit - used)
  let reset = (rule.resets - rule.at + 999) / 1000
  let status = match {
    allowed or peek -> 200
    else -> 429
  }
  let verdict = Verdict(key, allowed, limit: rule.limit, remaining, reset, window: rule.span / 1000)
  let out = json(status, value: verdict)
    |> header(name: "x-ratelimit-limit", value: "\(rule.limit)")
    |> header(name: "x-ratelimit-remaining", value: "\(remaining)")
    |> header(name: "x-ratelimit-reset", value: "\(reset)")
    |> header(name: "cache-control", value: "no-store")
  match status {
    429 -> out |> header(name: "retry-after", value: "\(reset)")
    _ -> out
  }
}

// ---------- the dashboard ----------

fn dashboard(at: Int) -> Response uses db {
  buf()
    |> append(view: "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport \
        content=\"width=device-width,initial-scale=1\"><meta name=robots \
        content=\"noindex\"><title>ratelimit</title><style>:root{color-scheme:light \
        dark;--fg:#1d1f23;--mute:#626873;--bg:#fbfbfa;--card:#fff;--line:#e3e4e6;--ok:#16a34a;--full:#dc2626}@media(prefers-color-scheme:dark){:root{--fg:#e8e9eb;--mute:#9aa0aa;--bg:#15171a;--card:#1d2024;--line:#30343a;--ok:#4ade80;--full:#f87171}}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}main{max-width:48rem;margin:0 auto;padding:2rem 1rem}h1{margin:0}.mute{color:var(--mute)}pre{font:13px/1.45 ui-monospace,Menlo,monospace;overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.75rem}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px}td,th{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}td.k{overflow-wrap:anywhere}.bar{height:8px;border-radius:4px;background:var(--line);min-width:6rem}.bar i{display:block;height:8px;border-radius:4px;background:var(--ok)}.bar i.full{background:var(--full)}</style><main><h1>ratelimit</h1><p class=mute>Fixed windows, counted in SQLite, one Durable Object. Written in <a href=\"/\">Tape</a> (<a href=\"https://github.com/ivarvong/tape/blob/main/apps/products/ratelimit/ratelimit.tape\">source</a>). The counts are as of this load.</p><pre>curl -i -X POST 'https://tape.ivar.workers.dev/p/demo/ratelimit/hit/my-api?limit=5&amp;window=10'</pre><p>Each hit answers 200 with <code>X-RateLimit-Remaining</code>, or 429 with <code>Retry-After</code> once the window's budget is spent. <code>GET peek/&lt;key&gt;?…</code> looks without taking. Send <code>Idempotency-Key</code> and a retried hit counts once.</p><h2>Busy keys</h2>")
    |> rows(
      found: sql_all(
        row: Window,
        query: "SELECT * FROM windows WHERE (slot + 1) * span > :since ORDER BY slot * span \
            DESC, n DESC LIMIT 30",
        since: at - 300000
      ),
      at,
      any: False
    )
    |> append(view: "</main></html>")
    |> respond_as(status: 200, content: Html)
    |> header(name: "cache-control", value: "no-store")
}

fn rows(out: Buf, found: Rows[Window], at: Int, any: Bool) -> Buf {
  match next(rows: found) {
    Next(value: Window(key, span, slot, lim, n), rest) -> {
      let head = match any {
        True -> out
        False -> out
          |> append(view: "<table><tr><th>Key</th><th>Window</th><th>Used</th><th></th><th>Ends \
              in</th></tr>")
      }
      let ends = (slot + 1) * span - at
      head
        |> append(view: "<tr><td class=k>")
        |> write_html(text: key)
        |> append(view: "</td><td>\(span / 1000) s</td><td>\(n) / \(lim)</td><td><div \
            class=bar><i \(full(n, lim)) \
            style=\"width:\(n * 100 / lim)%\"></i></div></td><td>\(ends_in(ms: ends))</td></tr>")
        |> rows(found: rest, at, any: True)
    }
    End if any -> out |> append(view: "</table>")
    End -> out |> append(view: "<p class=mute>No key has been hit in the last five minutes.</p>")
  }
}

fn full(n: Int, lim: Int) -> View {
  match {
    n >= lim -> "class=full"
    else -> ""
  }
}

fn ends_in(ms: Int) -> View {
  match {
    ms <= 0 -> "ended"
    else -> "\((ms + 999) / 1000) s"
  }
}
