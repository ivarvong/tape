// blog.tape: a long-running blog on Durable Object SQLite. The renderer is write_doc from md.tape
// (packed beside this file). Routes work under /p/:account/:name/ and /:account/:name/v/:version/.
//
//   PUT    /posts/:slug     Markdown body; x-title, x-date (YYYY-MM-DD), idempotency-key required
//   POST   /posts/:slug     create only (409 if the slug exists); same headers
//   GET    /posts/:slug     HTML page (article body is write_doc output, cached by content hash)
//   GET    /posts/:slug/body  the article HTML alone, byte-identical to md.tape POST /render
//   DELETE /posts/:slug     idempotency-key required; 204 if it was or is gone on a replay
//   GET    /                index, newest published first, ?page= (page_size)
//   GET    /feed.xml        Atom of the newest feed_size posts
//
// Writes are operator-only. Rendered HTML is cached in SQLite under a FNV-1a content hash of the
// Markdown; GET answers ETag and Cache-Control so the edge may cache reads (eventually consistent).

flag page_size: Int = 20
flag feed_size: Int = 100

migration 1 "posts" {
  CREATE TABLE posts(
    slug TEXT PRIMARY KEY NOT NULL CHECK (length(slug) BETWEEN 1 AND 80),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    published TEXT NOT NULL CHECK (length(published) = 10),
    markdown TEXT NOT NULL,
    hash TEXT NOT NULL,
    updated_ms INTEGER NOT NULL,
    created_ms INTEGER NOT NULL
  );
  CREATE TABLE renders(
    hash TEXT PRIMARY KEY NOT NULL,
    html TEXT NOT NULL
  );
  CREATE TABLE ops(
    key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
    method TEXT NOT NULL CHECK (method IN ('PUT', 'POST', 'DELETE')),
    slug TEXT NOT NULL,
    status INTEGER NOT NULL CHECK (status BETWEEN 200 AND 499),
    req_hash TEXT NOT NULL
  );
  CREATE INDEX posts_newest ON posts(published DESC, slug DESC)
}

type Slug = View where slug_ok(self) else "1-80 of [a-z0-9-], not starting or ending with -"
type Title = View where title_ok(self) else "1-200 bytes, no CR LF NUL"
type Day = View where day_ok(self) else "YYYY-MM-DD"
type ClientKey = View where key_ok(self) else "1-128 visible bytes"

type Post {
  Post(
    slug: View,
    title: View,
    published: View,
    markdown: View,
    hash: View,
    updated_ms: Int,
    created_ms: Int
  )
}

type Render { Render(hash: View, html: View) }
type Op { Op(key: View, method: View, slug: View, status: Int, req_hash: View) }
type Stamp { Stamp(n: Int, updated_ms: Int) }
type Issue { Issue(error: View) }

type Check {
  Fine(slug: Slug, title: Title, published: Day, key: ClientKey)
  Bad(status: Int, reason: View)
}

type Outcome {
  Created(post: Post)
  Written(post: Post)
  Shown(post: Post, html: View)
  Article(html: View, hash: View)
  Home(rows: Rows[Post], page: Int, total: Int, updated_ms: Int)
  Feed(rows: Rows[Post], total: Int, updated_ms: Int)
  Removed(slug: View)
  NotModified(etag: View)
  Problem(status: Int, reason: View)
}

// clock is the grant now() reads. The compiler passes it into now by that name.
fn handle(raw: View, db: Sql, clock: Clock) -> Buf {
  answered(r: request(raw), db)
}

fn answered(r: Request, db: Sql) -> Buf {
  match r {
    Request(method: "GET", path: "/", query) -> listed(query, r, db)
    Request(method: "GET", path: "/feed.xml") -> fed(r, db)
    Request(method: "GET", path: "/posts/" ++ slug ++ "/body") -> article(slug, r, db)
    Request(method: "GET", path: "/posts/" ++ slug) -> shown(slug, r, db)
    Request(method: "PUT", path: "/posts/" ++ slug, body, caller: Operator) -> put(
      slug,
      title: header_of(request: r, name: "x-title"),
      published: header_of(request: r, name: "x-date"),
      markdown: body,
      key: header_of(request: r, name: "idempotency-key"),
      r,
      db
    )
    Request(method: "POST", path: "/posts/" ++ slug, body, caller: Operator) -> post(
      slug,
      title: header_of(request: r, name: "x-title"),
      published: header_of(request: r, name: "x-date"),
      markdown: body,
      key: header_of(request: r, name: "idempotency-key"),
      r,
      db
    )
    Request(method: "DELETE", path: "/posts/" ++ slug, caller: Operator) -> deleted(
      slug,
      key: header_of(request: r, name: "idempotency-key"),
      r,
      db
    )
    Request(method: "PUT", path: "/posts/" ++ slug) -> render(
      o: Problem(status: 403, reason: "writes are operator-only"),
      r,
      db
    )
    Request(method: "POST", path: "/posts/" ++ slug) -> render(
      o: Problem(status: 403, reason: "writes are operator-only"),
      r,
      db
    )
    Request(method: "DELETE", path: "/posts/" ++ slug) -> render(
      o: Problem(status: 403, reason: "writes are operator-only"),
      r,
      db
    )
    _ -> render(o: Problem(status: 404, reason: "no such page"), r, db)
  }
}

fn listed(query: Option[View], r: Request, db: Sql) -> Buf {
  match page_of(query) {
    None -> render(o: Problem(status: 400, reason: "page must be an integer >= 1"), r, db)
    Some(value: page) -> {
      let Stamp(n: total, updated_ms) = stamp(db)
      let tag = "i:" ++ decimal_text(value: total) ++ ":" ++ decimal_text(value: updated_ms)
      match if_match(r, tag) {
        True -> render(o: NotModified(etag: tag), r, db)
        False -> render(
          o: Home(
            rows: sql_all(
              db,
              row: Post,
              query: "SELECT * FROM posts ORDER BY published DESC, slug DESC LIMIT :lim \
                  OFFSET :off",
              lim: flags.page_size,
              off: (page - 1) * flags.page_size
            ),
            page: page,
            total: total,
            updated_ms: updated_ms
          ),
          r,
          db
        )
      }
    }
  }
}

fn fed(r: Request, db: Sql) -> Buf {
  let Stamp(n: total, updated_ms) = stamp(db)
  let tag = "f:" ++ decimal_text(value: total) ++ ":" ++ decimal_text(value: updated_ms)
  match if_match(r, tag) {
    True -> render(o: NotModified(etag: tag), r, db)
    False -> render(
      o: Feed(
        rows: sql_all(
          db,
          row: Post,
          query: "SELECT * FROM posts ORDER BY published DESC, slug DESC LIMIT :lim",
          lim: flags.feed_size
        ),
        total: total,
        updated_ms: updated_ms
      ),
      r,
      db
    )
  }
}

fn shown(slug: View, r: Request, db: Sql) -> Buf {
  match load(slug, db) {
    None -> render(o: Problem(status: 404, reason: "no such post"), r, db)
    Some(value: post) -> {
      let tag = page_tag(post)
      match if_match(r, tag) {
        True -> render(o: NotModified(etag: tag), r, db)
        False -> render(
          o: Shown(post, html: html_of(hash: post.hash, markdown: post.markdown, db)),
          r,
          db
        )
      }
    }
  }
}

fn article(slug: View, r: Request, db: Sql) -> Buf {
  match load(slug, db) {
    None -> render(o: Problem(status: 404, reason: "no such post"), r, db)
    Some(value: post) -> match if_match(r, tag: post.hash) {
      True -> render(o: NotModified(etag: post.hash), r, db)
      False -> render(
        o: Article(html: html_of(hash: post.hash, markdown: post.markdown, db), hash: post.hash),
        r,
        db
      )
    }
  }
}

fn put(
  slug: View,
  title: Option[View],
  published: Option[View],
  markdown: View,
  key: Option[View],
  r: Request,
  db: Sql
) -> Buf {
  match fields(slug, title, published, key) {
    Bad(status, reason) -> render(o: Problem(status, reason), r, db)
    Fine(slug: s, title: t, published: d, key: k) -> saved(
      s,
      title: t,
      published: d,
      markdown,
      key: k,
      r,
      db
    )
  }
}

fn post(
  slug: View,
  title: Option[View],
  published: Option[View],
  markdown: View,
  key: Option[View],
  r: Request,
  db: Sql
) -> Buf {
  match fields(slug, title, published, key) {
    Bad(status, reason) -> render(o: Problem(status, reason), r, db)
    Fine(slug: s, title: t, published: d, key: k) -> created(
      s,
      title: t,
      published: d,
      markdown,
      key: k,
      r,
      db
    )
  }
}

fn fields(slug: View, title: Option[View], published: Option[View], key: Option[View]) -> Check {
  match slug {
    Slug(s) -> match title {
      Some(value: Title(t)) -> match published {
        Some(value: Day(d)) -> match key {
          Some(value: ClientKey(k)) -> Fine(slug: s, title: t, published: d, key: k)
          _ -> Bad(status: 428, reason: "idempotency-key is required")
        }
        _ -> Bad(status: 400, reason: "x-date is required, YYYY-MM-DD")
      }
      _ -> Bad(status: 400, reason: "x-title is required, 1-200 bytes, no CR LF NUL")
    }
    _ -> Bad(status: 400, reason: "slug is 1-80 of [a-z0-9-], not starting or ending with -")
  }
}

fn created(
  slug: View,
  title: View,
  published: View,
  markdown: View,
  key: View,
  r: Request,
  db: Sql
) -> Buf {
  let req_hash = digest(
    text: "POST\n" ++ slug ++ "\n" ++ title ++ "\n" ++ published ++ "\n" ++ markdown
  )
  match claimed(key, method: "POST", slug, req_hash, status: 201, db) {
    Some(value: op) -> replayed(op, req_hash, r, db)
    None -> match load(slug, db) {
      Some(value: _) -> render(
        o: Problem(status: 409, reason: "a post with this slug exists"),
        r,
        db
      )
      None -> render(o: insert(slug, title, published, markdown, db), r, db)
    }
  }
}

fn saved(
  slug: View,
  title: View,
  published: View,
  markdown: View,
  key: View,
  r: Request,
  db: Sql
) -> Buf {
  let req_hash = digest(
    text: "PUT\n" ++ slug ++ "\n" ++ title ++ "\n" ++ published ++ "\n" ++ markdown
  )
  match claimed(key, method: "PUT", slug, req_hash, status: 200, db) {
    Some(value: op) -> replayed(op, req_hash, r, db)
    None -> match load(slug, db) {
      Some(value: was) -> render(o: update(was, title, published, markdown, db), r, db)
      None -> {
        do sql_exec(db, query: "UPDATE ops SET status = 201 WHERE key = :key", key)
        render(o: insert(slug, title, published, markdown, db), r, db)
      }
    }
  }
}

fn deleted(slug: View, key: Option[View], r: Request, db: Sql) -> Buf {
  match slug {
    Slug(s) -> match key {
      Some(value: ClientKey(k)) -> removed(s, key: k, r, db)
      _ -> render(o: Problem(status: 428, reason: "idempotency-key is required"), r, db)
    }
    _ -> render(
      o: Problem(status: 400, reason: "slug is 1-80 of [a-z0-9-], not starting or ending with -"),
      r,
      db
    )
  }
}

fn removed(slug: View, key: View, r: Request, db: Sql) -> Buf {
  let req_hash = digest(text: "DELETE\n" ++ slug)
  match claimed(key, method: "DELETE", slug, req_hash, status: 204, db) {
    Some(value: op) -> replayed(op, req_hash, r, db)
    None -> match load(slug, db) {
      None -> {
        do sql_exec(db, query: "UPDATE ops SET status = 404 WHERE key = :key", key)
        render(o: Problem(status: 404, reason: "no such post"), r, db)
      }
      Some(value: _) -> {
        do sql_exec(db, query: "DELETE FROM posts WHERE slug = :slug", slug)
        render(o: Removed(slug), r, db)
      }
    }
  }
}

// INSERT the idempotency row; None means the key was already present (return the stored op).
fn claimed(
  key: View,
  method: View,
  slug: View,
  req_hash: View,
  status: Int,
  db: Sql
) -> Option[Op] {
  match sql_first(
    db,
    row: Op,
    query: "INSERT INTO ops(key, method, slug, status, req_hash) \
        VALUES (:key, :method, :slug, :status, :req_hash) ON CONFLICT(key) DO NOTHING RETURNING *",
    key,
    method,
    slug,
    status,
    req_hash
  ) {
    Some(value: _) -> None
    None -> sql_first(db, row: Op, query: "SELECT * FROM ops WHERE key = :key", key)
  }
}

fn replayed(op: Op, req_hash: View, r: Request, db: Sql) -> Buf {
  let Op(key, method, slug, status, req_hash: stored) = op
  match {
    stored != req_hash -> render(
      o: Problem(status: 409, reason: "idempotency-key was reused with a different request"),
      r,
      db
    )
    method == "DELETE" and status == 204 -> render(o: Removed(slug), r, db)
    method == "DELETE" -> render(o: Problem(status, reason: "no such post"), r, db)
    else -> match load(slug, db) {
      None -> render(
        o: Problem(status: 409, reason: "idempotency-key refers to a missing post"),
        r,
        db
      )
      Some(value: post) if status == 201 -> render(o: Created(post), r, db)
      Some(value: post) -> render(o: Written(post), r, db)
    }
  }
}

fn insert(slug: View, title: View, published: View, markdown: View, db: Sql) -> Outcome {
  let h = digest(markdown)
  do ensure_cached(hash: h, markdown, db)
  let t = now()
  match sql_first(
    db,
    row: Post,
    query: "INSERT INTO posts(slug, title, published, markdown, hash, updated_ms, created_ms) \
        VALUES (:slug, :title, :published, :markdown, :h, :t, :t) RETURNING *",
    slug,
    title,
    published,
    markdown,
    h,
    t,
    t
  ) {
    Some(value: post) -> Created(post)
    None -> Problem(status: 500, reason: "insert did not return a row")
  }
}

fn update(was: Post, title: View, published: View, markdown: View, db: Sql) -> Outcome {
  let h = digest(markdown)
  do ensure_cached(hash: h, markdown, db)
  let t = now()
  match sql_first(
    db,
    row: Post,
    query: "UPDATE posts SET title = :title, published = :published, markdown = :markdown, hash = \
        :h, updated_ms = :t WHERE slug = :slug RETURNING *",
    title,
    published,
    markdown,
    h,
    t,
    slug: was.slug
  ) {
    Some(value: post) -> Written(post)
    None -> Problem(status: 500, reason: "update did not return a row")
  }
}

fn cached(hash: View, markdown: View, db: Sql) -> View {
  match sql_first(db, row: Render, query: "SELECT * FROM renders WHERE hash = :hash", hash) {
    Some(value: Render(hash: stored, html)) -> html
    None -> {
      let html = freeze(buf: write_doc(out: buf(), text: markdown))
      do sql_exec(db, query: "INSERT INTO renders(hash, html) VALUES (:hash, :html)", hash, html)
      html
    }
  }
}

fn ensure_cached(hash: View, markdown: View, db: Sql) -> Int {
  len(cached(hash, markdown, db))
}

fn html_of(hash: View, markdown: View, db: Sql) -> View {
  cached(hash, markdown, db)
}

fn load(slug: View, db: Sql) -> Option[Post] {
  sql_first(db, row: Post, query: "SELECT * FROM posts WHERE slug = :slug", slug)
}

fn stamp(db: Sql) -> Stamp {
  match sql_first(
    db,
    row: Stamp,
    query: "SELECT count(*) AS n, ifnull(max(updated_ms), 0) AS updated_ms FROM posts"
  ) {
    Some(value: s) -> s
    None -> Stamp(n: 0, updated_ms: 0)
  }
}

fn if_match(r: Request, tag: View) -> Bool {
  match header_of(request: r, name: "if-none-match") {
    Some(value: given) if etag_matches(given, tag) -> True
    _ -> False
  }
}

// RFC 9110: a quoted tag, a weak tag, a comma-separated list, or *
fn etag_matches(given: View, tag: View) -> Bool {
  match {
    given == "*" -> True
    else -> etag_one(given, tag, at: 0)
  }
}

fn when(b: Bool, yes: Int, no: Int) -> Int {
  match b {
    True -> yes
    False -> no
  }
}

fn etag_one(given: View, tag: View, at: Int) -> Bool {
  let start = skip_ws(t: given, at)
  match {
    start >= len(given) -> False
    else -> {
      let weak = start + 1 < len(given) and given[start] == 'W' and given[start + 1] == '/'
      let from = start + when(weak, yes: 2, no: 0)
      let quoted = from < len(given) and given[from] == '"'
      let body = from + when(quoted, yes: 1, no: 0)
      let end = etag_stop(t: given, at: body, quoted)
      let value = slice(v: given, from: body, to: end)
      let past = end + when(quoted, yes: 1, no: 0)
      let rest = after_comma(t: given, at: past)
      value == tag or value == "*" or (rest >= 0 and etag_one(given, tag, at: rest))
    }
  }
}

fn etag_stop(t: View, at: Int, quoted: Bool) -> Int {
  match {
    at >= len(t) -> at
    quoted and t[at] == '"' -> at
    not quoted and (t[at] == ',' or t[at] == ' ' or t[at] == '\t') -> at
    else -> etag_stop(t, at: at + 1, quoted)
  }
}

fn after_comma(t: View, at: Int) -> Int {
  let s = skip_ws(t, at: at)
  match {
    s < len(t) and t[s] == ',' -> skip_ws(t, at: s + 1)
    else -> -1
  }
}

fn skip_ws(t: View, at: Int) -> Int {
  match {
    at < len(t) and (t[at] == ' ' or t[at] == '\t') -> skip_ws(t, at: at + 1)
    else -> at
  }
}

fn page_tag(post: Post) -> View {
  post.hash ++ ":" ++ decimal_text(value: post.updated_ms)
}

fn quoted(tag: View) -> View {
  "\"" ++ tag ++ "\""
}

// tape-base is the URL the program's / is at; without it the path is the whole location
fn place(r: Request, path: View) -> View {
  match header_of(request: r, name: "tape-base") {
    Some(value: base) -> base ++ path
    None -> path
  }
}

fn render(o: Outcome, r: Request, db: Sql) -> Buf {
  match o {
    Created(post) -> post_headers(out: json_ok(status: 201, post), tag: post.hash, store: False)
      |> header(name: "location", value: place(r, path: "/posts/" ++ post.slug))
    Written(post) -> post_headers(out: json_ok(status: 200, post), tag: post.hash, store: False)
    Shown(post, html) -> post_headers(out: page_post(post, html), tag: page_tag(post), store: True)
    Article(html, hash) -> post_headers(
      out: respond_as(status: 200, content: Html) |> append(view: html),
      tag: hash,
      store: True
    )
    Home(rows, page, total, updated_ms) -> post_headers(
      out: page_home(rows, page, total),
      tag: "i:" ++ decimal_text(value: total) ++ ":" ++ decimal_text(value: updated_ms),
      store: True
    )
    Feed(rows, total, updated_ms) -> post_headers(
      out: atom(rows, updated_ms, db),
      tag: "f:" ++ decimal_text(value: total) ++ ":" ++ decimal_text(value: updated_ms),
      store: True
    )
    Removed(slug) -> respond(status: 204) |> header(name: "cache-control", value: "no-store")
    NotModified(etag) -> respond(status: 304)
      |> header(name: "etag", value: quoted(etag))
      |> header(name: "cache-control", value: "public, max-age=60")
    Problem(status: 404, reason) -> post_headers(
      out: html_error(status: 404, title: "Not found", reason),
      tag: "missing",
      store: False
    )
    Problem(status, reason) -> json_error(status, reason)
      |> header(name: "cache-control", value: "no-store")
  }
}

fn post_headers(out: Buf, tag: View, store: Bool) -> Buf {
  let etag = quoted(tag)
  match store {
    True -> out
      |> header(name: "etag", value: etag)
      |> header(name: "cache-control", value: "public, max-age=60")
    False -> out
      |> header(name: "etag", value: etag)
      |> header(name: "cache-control", value: "no-store")
  }
}

type ShownPost {
  ShownPost(slug: View, title: View, published: View, hash: View, updated_ms: Int, created_ms: Int)
}

fn json_ok(status: Int, post: Post) -> Buf {
  respond_as(status, content: Json)
    |> write_json(value: ShownPost(
      slug: post.slug,
      title: post.title,
      published: post.published,
      hash: post.hash,
      updated_ms: post.updated_ms,
      created_ms: post.created_ms
    ))
}

fn json_error(status: Int, reason: View) -> Buf {
  respond_as(status, content: Json) |> write_json(value: Issue(error: reason))
}

fn page_shell(status: Int, title: View) -> Buf {
  respond_as(status, content: Html)
    |> append(view: "<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport \
        content=\"width=device-width,initial-scale=1\"><title>")
    |> write_html(text: title)
    |> append(view: "</title><style>body{font:16px/1.5 \
        system-ui,sans-serif;max-width:46rem;margin:1.5rem auto;padding:0 \
        1rem;color:#1d1d1f}h1{font-size:1.6rem}p.meta,.note{color:#666}nav{margin-bottom:1rem}ol{padding-left:1.2rem}li{margin:.35rem 0}a{color:#0b57d0}article :first-child{margin-top:0}</style></head><body>")
}

fn page_end(out: Buf) -> Buf {
  append(buf: out, view: "</body></html>")
}

fn posts_word(total: Int) -> View {
  match total {
    1 -> " post, page "
    _ -> " posts, page "
  }
}

fn page_home(rows: Rows[Post], page: Int, total: Int) -> Buf {
  let pages = pages_of(total)
  page_shell(status: 200, title: "Blog")
    |> append(view: "<nav><a href=\"./\">Blog</a> &middot; <a \
        href=\"./feed.xml\">Atom</a></nav><h1>Blog</h1><p class=note>")
    |> append(view: decimal_text(value: total))
    |> append(view: posts_word(total))
    |> append(view: decimal_text(value: page))
    |> append(view: " of ")
    |> append(view: decimal_text(value: pages))
    |> append(view: "</p><ol>")
    |> write_index(rows)
    |> append(view: "</ol>")
    |> write_pager(page, pages)
    |> page_end
}

fn write_index(out: Buf, rows: Rows[Post]) -> Buf {
  match next(rows) {
    End -> out
    Next(
      value: Post(slug, title, published, markdown, hash, updated_ms, created_ms),
      rest
    ) -> write_index(
      out: out
        |> append(view: "<li><a href=\"./posts/")
        |> write_html(text: slug)
        |> append(view: "\">")
        |> write_html(text: title)
        |> append(view: "</a> <span class=note>")
        |> write_html(text: published)
        |> append(view: "</span></li>"),
      rows: rest
    )
  }
}

fn write_pager(out: Buf, page: Int, pages: Int) -> Buf {
  match {
    pages <= 1 -> out
    else -> next_link(out: prev_link(out, page), page, pages)
  }
}

fn prev_link(out: Buf, page: Int) -> Buf {
  match {
    page <= 1 -> out
    else -> out
      |> append(view: "<p><a href=\"./?page=")
      |> append(view: decimal_text(value: page - 1))
      |> append(view: "\">Previous</a></p>")
  }
}

fn next_link(out: Buf, page: Int, pages: Int) -> Buf {
  match {
    page >= pages -> out
    else -> out
      |> append(view: "<p><a href=\"./?page=")
      |> append(view: decimal_text(value: page + 1))
      |> append(view: "\">Next</a></p>")
  }
}

fn page_post(post: Post, html: View) -> Buf {
  let Post(slug, title, published, markdown, hash, updated_ms, created_ms) = post
  page_shell(status: 200, title)
    |> append(
      view: "<nav><a href=\"../\">Blog</a> &middot; <a href=\"../feed.xml\">Atom</a></nav><h1>"
    )
    |> write_html(text: title)
    |> append(view: "</h1><p class=meta>")
    |> write_html(text: published)
    |> append(view: " &middot; ")
    |> write_html(text: slug)
    |> append(view: "</p><article>")
    |> append(view: html)
    |> append(view: "</article>")
    |> page_end
}

fn html_error(status: Int, title: View, reason: View) -> Buf {
  page_shell(status, title)
    |> append(view: "<nav><a href=\"./../\">Blog</a></nav><h1>")
    |> write_html(text: title)
    |> append(view: "</h1><p>")
    |> write_html(text: reason)
    |> append(view: "</p>")
    |> page_end
}

fn atom(rows: Rows[Post], updated_ms: Int, db: Sql) -> Buf {
  respond_as(status: 200, content: Atom)
    |> append(view: "<?xml version=\"1.0\" encoding=\"utf-8\"?><feed \
        xmlns=\"http://www.w3.org/2005/Atom\"><title>Blog</title><id>tag:tape.blog,2026:feed</id><updated>")
    |> append(view: iso_utc(updated_ms))
    |> append(view: "</updated>")
    |> write_atom_entries(rows, db)
    |> append(view: "</feed>")
}

fn write_atom_entries(out: Buf, rows: Rows[Post], db: Sql) -> Buf {
  match next(rows) {
    End -> out
    Next(value: post, rest) -> write_atom_entries(
      out: write_atom_entry(out, post, db),
      rows: rest,
      db
    )
  }
}

fn write_atom_entry(out: Buf, post: Post, db: Sql) -> Buf {
  let Post(slug, title, published, markdown, hash, updated_ms, created_ms) = post
  out
    |> append(view: "<entry><title>")
    |> write_html(text: title)
    |> append(view: "</title><id>tag:tape.blog,2026:")
    |> write_html(text: slug)
    |> append(view: "</id><updated>")
    |> append(view: iso_utc(updated_ms))
    |> append(view: "</updated><published>")
    |> write_html(text: published)
    |> append(view: "T00:00:00Z</published><link href=\"posts/")
    |> write_html(text: slug)
    |> append(view: "\"/><content type=\"html\"><![CDATA[")
    |> append(view: html_of(hash, markdown: post.markdown, db))
    |> append(view: "]]></content></entry>")
}

fn pages_of(total: Int) -> Int {
  match total {
    0 -> 1
    _ -> (total + flags.page_size - 1) / flags.page_size
  }
}

fn page_of(query: Option[View]) -> Option[Int] {
  match query {
    None -> Some(value: 1)
    Some(value: q) -> match form_field(body: q, name: "page") {
      None -> Some(value: 1)
      Some(value: t) -> match parse_int(text: t) {
        Some(value: n) if n >= 1 and page_fits(n) -> Some(value: n)
        _ -> None
      }
    }
  }
}

// (page - 1) * page_size traps when the page is past what an Int can hold
fn page_fits(n: Int) -> Bool {
  flags.page_size >= 1 and (n == 1 or n - 1 <= 9223372036854775807 / flags.page_size)
}

fn slug_ok(s: View) -> Bool {
  let n = len(s)
  n >= 1 and n <= 80 and s[0] != '-' and s[n - 1] != '-' and every_byte(v: s, keep: slug_byte)
}

fn slug_byte(b: Int) -> Bool {
  is_digit(b) or b == '-' or (b >= 'a' and b <= 'z')
}

fn title_ok(s: View) -> Bool {
  len(s) >= 1 and len(s) <= 200 and every_byte(v: s, keep: text_byte)
}

fn text_byte(b: Int) -> Bool {
  b != 0 and b != '\n' and b != '\r'
}

fn key_ok(s: View) -> Bool {
  len(s) >= 1 and len(s) <= 128 and every_byte(v: s, keep: visible)
}

fn visible(b: Int) -> Bool {
  b >= '!' and b <= '~'
}

fn day_ok(s: View) -> Bool {
  len(s) == 10 and s[4] == '-' and s[7] == '-' and ymd_ok(s)
}

fn digits(s: View) -> Bool {
  every_byte(v: s, keep: is_digit)
}

fn ymd_ok(s: View) -> Bool {
  let y = slice(v: s, from: 0, to: 4)
  let m = slice(v: s, from: 5, to: 7)
  let d = slice(v: s, from: 8, to: 10)
  match {
    not digits(y) or not digits(m) or not digits(d) -> False
    else -> match parse_int(text: y) {
      None -> False
      Some(value: year) -> match parse_int(text: m) {
        None -> False
        Some(value: month) -> match parse_int(text: d) {
          None -> False
          Some(value: day) -> year >= 1
            and month >= 1
            and month <= 12
            and day >= 1
            and day <= days_in(year, month)
        }
      }
    }
  }
}

fn days_in(year: Int, month: Int) -> Int {
  match month {
    2 if leap(year) -> 29
    2 -> 28
    4 -> 30
    6 -> 30
    9 -> 30
    11 -> 30
    _ -> 31
  }
}

fn leap(y: Int) -> Bool {
  y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
}

fn fnv_step(h: Int, byte: Int) -> Int {
  wrapping_mul(a: h ^ byte, b: 1099511628211)
}

fn digest(text: View) -> View {
  decimal_text(value: digest_from(text, at: 0, h: -3750763034362895579))
}

fn digest_from(text: View, at: Int, h: Int) -> Int {
  let n = len(text)
  match {
    at >= n -> h
    else -> digest_from(
      text,
      at: min(a: at + 2048, b: n),
      h: digest_span(text, at, end: min(a: at + 2048, b: n), h)
    )
  }
}

fn digest_span(text: View, at: Int, end: Int, h: Int) -> Int {
  match {
    at >= end -> h
    else -> digest_span(text, at: at + 1, end, h: fnv_step(h, byte: text[at]))
  }
}

// civil date-time in UTC from milliseconds since 1970, as YYYY-MM-DDTHH:MM:SSZ (std's civil; rfc3339 would add
// the milliseconds)
fn iso_utc(ms: Int) -> View {
  match {
    ms <= 0 -> "1970-01-01T00:00:00Z"
    else -> {
      let Civil(year, month, day, hour, minute, second) = civil(ms)
      let out = buf()
        |> pad4(n: year)
        |> push(byte: '-')
        |> pad2(n: month)
        |> push(byte: '-')
        |> pad2(n: day)
        |> push(byte: 'T')
        |> pad2(n: hour)
        |> push(byte: ':')
        |> pad2(n: minute)
        |> push(byte: ':')
        |> pad2(n: second)
        |> push(byte: 'Z')
      freeze(buf: out)
    }
  }
}

fn pad2(out: Buf, n: Int) -> Buf {
  match {
    n < 10 -> append(buf: out, view: "0") |> append(view: decimal_text(value: n))
    else -> append(buf: out, view: decimal_text(value: n))
  }
}

fn pad4(out: Buf, n: Int) -> Buf {
  match {
    n < 10 -> append(buf: out, view: "000") |> append(view: decimal_text(value: n))
    n < 100 -> append(buf: out, view: "00") |> append(view: decimal_text(value: n))
    n < 1000 -> append(buf: out, view: "0") |> append(view: decimal_text(value: n))
    else -> append(buf: out, view: decimal_text(value: n))
  }
}
