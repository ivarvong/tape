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

type Slug = View where slug_ok(self)
type Title = View where title_ok(self)
type Day = View where day_ok(self)
type ClientKey = View where key_ok(self)

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
  Fine
  Bad(status: Int, reason: View)
}

type Outcome {
  Created(post: Post)
  Written(post: Post)
  Shown(post: Post, html: View)
  Article(html: View, hash: View)
  Home(rows: Rows[Post], page: Int, total: Int)
  Feed(rows: Rows[Post])
  Removed(slug: View)
  NotModified(etag: View)
  Problem(status: Int, reason: View)
}

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
      db
    )
    Request(method: "POST", path: "/posts/" ++ slug, body, caller: Operator) -> post(
      slug,
      title: header_of(request: r, name: "x-title"),
      published: header_of(request: r, name: "x-date"),
      markdown: body,
      key: header_of(request: r, name: "idempotency-key"),
      db
    )
    Request(method: "DELETE", path: "/posts/" ++ slug, caller: Operator) -> deleted(
      slug,
      key: header_of(request: r, name: "idempotency-key"),
      db
    )
    Request(method: "PUT", path: "/posts/" ++ slug) -> render(
      o: Problem(status: 403, reason: "writes are operator-only"),
      db
    )
    Request(method: "POST", path: "/posts/" ++ slug) -> render(
      o: Problem(status: 403, reason: "writes are operator-only"),
      db
    )
    Request(method: "DELETE", path: "/posts/" ++ slug) -> render(
      o: Problem(status: 403, reason: "writes are operator-only"),
      db
    )
    _ -> render(o: Problem(status: 404, reason: "no such page"), db)
  }
}

fn listed(query: Option[View], r: Request, db: Sql) -> Buf {
  match page_of(query) {
    None -> render(o: Problem(status: 400, reason: "page must be an integer >= 1"), db)
    Some(value: page) -> {
      let Stamp(n: total, updated_ms) = stamp(db)
      let tag = "i:" ++ decimal_text(value: total) ++ ":" ++ decimal_text(value: updated_ms)
      match if_match(r, tag) {
        True -> render(o: NotModified(etag: tag), db)
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
            total: total
          ),
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
    True -> render(o: NotModified(etag: tag), db)
    False -> render(
      o: Feed(rows: sql_all(
        db,
        row: Post,
        query: "SELECT * FROM posts ORDER BY published DESC, slug DESC LIMIT :lim",
        lim: flags.feed_size
      )),
      db
    )
  }
}

fn shown(slug: View, r: Request, db: Sql) -> Buf {
  match load(slug, db) {
    None -> render(o: Problem(status: 404, reason: "no such post"), db)
    Some(value: post) -> match if_match(r, tag: post.hash) {
      True -> render(o: NotModified(etag: post.hash), db)
      False -> render(
        o: Shown(post, html: html_of(hash: post.hash, markdown: post.markdown, db)),
        db
      )
    }
  }
}

fn article(slug: View, r: Request, db: Sql) -> Buf {
  match load(slug, db) {
    None -> render(o: Problem(status: 404, reason: "no such post"), db)
    Some(value: post) -> match if_match(r, tag: post.hash) {
      True -> render(o: NotModified(etag: post.hash), db)
      False -> render(
        o: Article(html: html_of(hash: post.hash, markdown: post.markdown, db), hash: post.hash),
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
  db: Sql
) -> Buf {
  match fields(slug, title, published, key) {
    Bad(status, reason) -> render(o: Problem(status, reason), db)
    Fine -> saved(
      slug,
      title: title_of(title),
      published: day_of(published),
      markdown,
      key: key_of(key),
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
  db: Sql
) -> Buf {
  match fields(slug, title, published, key) {
    Bad(status, reason) -> render(o: Problem(status, reason), db)
    Fine -> created(
      slug,
      title: title_of(title),
      published: day_of(published),
      markdown,
      key: key_of(key),
      db
    )
  }
}

fn fields(slug: View, title: Option[View], published: Option[View], key: Option[View]) -> Check {
  match {
    not slug_ok(slug) -> Bad(
      status: 400,
      reason: "slug is 1-80 of [a-z0-9-], not starting or ending with -"
    )
    not some_ok(v: title, ok: title_ok) -> Bad(
      status: 400,
      reason: "x-title is required, 1-200 bytes, no CR LF NUL"
    )
    not some_ok(v: published, ok: day_ok) -> Bad(
      status: 400,
      reason: "x-date is required, YYYY-MM-DD"
    )
    not some_ok(v: key, ok: key_ok) -> Bad(status: 428, reason: "idempotency-key is required")
    else -> Fine
  }
}

fn created(slug: View, title: View, published: View, markdown: View, key: View, db: Sql) -> Buf {
  let req_hash = digest(
    text: "POST\n" ++ slug ++ "\n" ++ title ++ "\n" ++ published ++ "\n" ++ markdown
  )
  match claimed(key, method: "POST", slug, req_hash, status: 201, db) {
    Some(value: op) -> replayed(op, req_hash, db)
    None -> match load(slug, db) {
      Some(value: _) -> render(o: Problem(status: 409, reason: "a post with this slug exists"), db)
      None -> render(o: insert(slug, title, published, markdown, db), db)
    }
  }
}

fn saved(slug: View, title: View, published: View, markdown: View, key: View, db: Sql) -> Buf {
  let req_hash = digest(
    text: "PUT\n" ++ slug ++ "\n" ++ title ++ "\n" ++ published ++ "\n" ++ markdown
  )
  match claimed(key, method: "PUT", slug, req_hash, status: 200, db) {
    Some(value: op) -> replayed(op, req_hash, db)
    None -> match load(slug, db) {
      Some(value: was) -> render(o: update(was, title, published, markdown, db), db)
      None -> {
        do sql_exec(db, query: "UPDATE ops SET status = 201 WHERE key = :key", key)
        render(o: insert(slug, title, published, markdown, db), db)
      }
    }
  }
}

fn deleted(slug: View, key: Option[View], db: Sql) -> Buf {
  match {
    not slug_ok(slug) -> render(
      o: Problem(status: 400, reason: "slug is 1-80 of [a-z0-9-], not starting or ending with -"),
      db
    )
    not some_ok(v: key, ok: key_ok) -> render(
      o: Problem(status: 428, reason: "idempotency-key is required"),
      db
    )
    else -> removed(slug, key: key_of(key), db)
  }
}

fn removed(slug: View, key: View, db: Sql) -> Buf {
  let req_hash = digest(text: "DELETE\n" ++ slug)
  match claimed(key, method: "DELETE", slug, req_hash, status: 204, db) {
    Some(value: op) -> replayed(op, req_hash, db)
    None -> match load(slug, db) {
      None -> {
        do sql_exec(db, query: "UPDATE ops SET status = 404 WHERE key = :key", key)
        render(o: Problem(status: 404, reason: "no such post"), db)
      }
      Some(value: _) -> {
        do sql_exec(db, query: "DELETE FROM posts WHERE slug = :slug", slug)
        render(o: Removed(slug), db)
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

fn replayed(op: Op, req_hash: View, db: Sql) -> Buf {
  let Op(key, method, slug, status, req_hash: stored) = op
  match {
    stored != req_hash -> render(
      o: Problem(status: 409, reason: "idempotency-key was reused with a different request"),
      db
    )
    method == "DELETE" and status == 204 -> render(o: Removed(slug), db)
    method == "DELETE" -> render(o: Problem(status, reason: "no such post"), db)
    else -> match load(slug, db) {
      None -> render(
        o: Problem(status: 409, reason: "idempotency-key refers to a missing post"),
        db
      )
      Some(value: post) if status == 201 -> render(o: Created(post), db)
      Some(value: post) -> render(o: Written(post), db)
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
  match sql_first(db, row: Render, query: "SELECT * FROM renders WHERE hash = :hash", hash) {
    Some(value: Render(hash: stored, html)) -> 0
    None -> {
      let html = freeze(buf: write_doc(out: buf(), text: markdown))
      sql_exec(db, query: "INSERT INTO renders(hash, html) VALUES (:hash, :html)", hash, html)
    }
  }
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
    Some(value: given) if etag_of(given) == tag -> True
    _ -> False
  }
}

fn etag_of(t: View) -> View {
  match {
    len(t) >= 2 and t[0] == 34 and t[len(t) - 1] == 34 -> slice(v: t, from: 1, to: len(t) - 1)
    else -> t
  }
}

fn render(o: Outcome, db: Sql) -> Buf {
  match o {
    Created(post) -> post_headers(out: json_ok(status: 201, post), tag: post.hash, store: False)
      |> header(name: "location", value: "/posts/" ++ post.slug)
    Written(post) -> post_headers(out: json_ok(status: 200, post), tag: post.hash, store: False)
    Shown(post, html) -> post_headers(out: page_post(post, html), tag: post.hash, store: True)
    Article(html, hash) -> post_headers(
      out: respond_as(status: 200, content: Html) |> append(view: html),
      tag: hash,
      store: True
    )
    Home(rows, page, total) -> {
      let Stamp(n, updated_ms) = stamp(db)
      let tag = "i:" ++ decimal_text(value: total) ++ ":" ++ decimal_text(value: updated_ms)
      post_headers(out: page_home(rows, page, total), tag, store: True)
    }
    Feed(rows) -> {
      let Stamp(n: total, updated_ms: at) = stamp(db)
      let feed_tag = "f:" ++ decimal_text(value: total) ++ ":" ++ decimal_text(value: at)
      post_headers(out: atom(rows, updated_ms: at, db), tag: feed_tag, store: True)
    }
    Removed(slug) -> respond(status: 204) |> header(name: "cache-control", value: "no-store")
    NotModified(etag) -> respond(status: 304)
      |> header(name: "etag", value: etag)
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
  match store {
    True -> out
      |> header(name: "etag", value: tag)
      |> header(name: "cache-control", value: "public, max-age=60")
    False -> out
      |> header(name: "etag", value: tag)
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

fn page_home(rows: Rows[Post], page: Int, total: Int) -> Buf {
  let pages = pages_of(total)
  page_shell(status: 200, title: "Blog")
    |> append(view: "<nav><a href=\"./\">Blog</a> &middot; <a \
        href=\"./feed.xml\">Atom</a></nav><h1>Blog</h1><p class=note>")
    |> append(view: decimal_text(value: total))
    |> append(view: " posts, page ")
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
  respond(status: 200)
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
    |> append(view: "T00:00:00Z</published><link href=\"/posts/")
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
        Some(value: n) if n >= 1 -> Some(value: n)
        _ -> None
      }
    }
  }
}

fn some_ok(v: Option[View], ok: Fn[View, Bool]) -> Bool {
  match v {
    Some(value: s) -> ok(s)
    None -> False
  }
}

fn title_of(v: Option[View]) -> View {
  match v {
    Some(value: s) -> s
    None -> ""
  }
}

fn day_of(v: Option[View]) -> View {
  match v {
    Some(value: s) -> s
    None -> ""
  }
}

fn key_of(v: Option[View]) -> View {
  match v {
    Some(value: s) -> s
    None -> ""
  }
}

fn slug_ok(s: View) -> Bool {
  let n = len(s)
  n >= 1 and n <= 80 and s[0] != 45 and s[n - 1] != 45 and every_byte(v: s, keep: slug_byte)
}

fn slug_byte(b: Int) -> Bool {
  is_digit(b) or b == 45 or (b >= 97 and b <= 122)
}

fn title_ok(s: View) -> Bool {
  len(s) >= 1 and len(s) <= 200 and every_byte(v: s, keep: text_byte)
}

fn text_byte(b: Int) -> Bool {
  b != 0 and b != 10 and b != 13
}

fn key_ok(s: View) -> Bool {
  len(s) >= 1 and len(s) <= 128 and every_byte(v: s, keep: visible)
}

fn visible(b: Int) -> Bool {
  b >= 33 and b <= 126
}

fn day_ok(s: View) -> Bool {
  len(s) == 10 and s[4] == 45 and s[7] == 45 and ymd_ok(s)
}

fn ymd_ok(s: View) -> Bool {
  match parse_int(text: slice(v: s, from: 0, to: 4)) {
    None -> False
    Some(value: y) -> match parse_int(text: slice(v: s, from: 5, to: 7)) {
      None -> False
      Some(value: m) -> match parse_int(text: slice(v: s, from: 8, to: 10)) {
        None -> False
        Some(value: d) -> y >= 1
          and m >= 1
          and m <= 12
          and d >= 1
          and d <= days_in(year: y, month: m)
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

// civil date-time in UTC from milliseconds since 1970, as YYYY-MM-DDTHH:MM:SSZ
fn iso_utc(ms: Int) -> View {
  match {
    ms <= 0 -> "1970-01-01T00:00:00Z"
    else -> {
      let s = ms / 1000
      let z = s / 86400
      let rem = s % 86400
      freeze(buf: write_civil(
        out: buf(),
        days: z
      )
          |> push(byte: 84)
          |> pad2(n: rem / 3600)
          |> push(byte: 58)
          |> pad2(n: rem % 3600 / 60)
          |> push(byte: 58)
          |> pad2(n: rem % 60)
          |> push(byte: 90))
    }
  }
}

fn pad2(out: Buf, n: Int) -> Buf {
  match {
    n < 10 -> append(buf: out, view: "0") |> append(view: decimal_text(value: n))
    else -> append(buf: out, view: decimal_text(value: n))
  }
}

fn write_civil(out: Buf, days: Int) -> Buf {
  shift_year(out, days: days, year: 1970)
}

fn shift_year(out: Buf, days: Int, year: Int) -> Buf {
  let span = days_in_year(year)
  match {
    days >= span -> shift_year(out, days: days - span, year: year + 1)
    else -> shift_month(out, days, year, month: 1)
  }
}

fn days_in_year(year: Int) -> Int {
  match leap(year) {
    True -> 366
    False -> 365
  }
}

fn shift_month(out: Buf, days: Int, year: Int, month: Int) -> Buf {
  let span = days_in(year, month)
  match {
    days >= span -> shift_month(out, days: days - span, year, month: month + 1)
    else -> pad4(out, n: year)
      |> push(byte: 45)
      |> pad2(n: month)
      |> push(byte: 45)
      |> pad2(n: days + 1)
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
