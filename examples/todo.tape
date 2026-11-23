// todo.tape: the todo API (SPEC.md) on Durable Object SQLite.
// Every value is parsed where it enters: a pattern either proves what it binds or the arm does not match.

// A todo is created once per client key: POST /todos with a key seen before answers that todo (200), so a client
// that got no answer can send it again. Without a key a retried POST made a second todo (rules.ts, C55).
schema "CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, title \
    TEXT NOT NULL, done INTEGER NOT NULL)"

// The longest title, in bytes. A flag: the host can change it between requests without a deploy.
flag title_limit: Int = 200

type Id = Int where self >= 1 and self <= 9007199254740991
type Title = View where len(self) >= 1 and len(self) <= flags.title_limit
type Key = View where len(self) >= 1 and len(self) <= 64

type Todo {
  Todo(id: Int, title: View, done: Bool)
}

// The body of POST /todos: the client's key, the title, and maybe whether it is done.
type NewTodo {
  NewTodo(key: Key, title: Title, done: Option[Bool])
}

// The body of PATCH /todos/ID: one of these three shapes, so an empty change cannot exist.
type Changes {
  Retitle(title: Title)
  Mark(done: Bool)
  Both(title: Title, done: Bool)
}

type Filter {
  Everything
  Only(done: Bool)
}

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/todos", query: filter(which)) -> list(which)
    Request(method: "POST", path: "/todos", query: blank(_), body) -> create(body)
    Request(method, path: "/todos") if method == "GET" or method == "POST" -> error(status: 400)
    Request(path: "/todos") -> error(status: 405)
    Request(method: "GET", path: item(id), query: blank(_)) -> one(
      status: 200,
      found: sql_first(row: Todo, query: "SELECT * FROM todos WHERE id = :id", id)
    )
    Request(method: "PATCH", path: item(id), query: blank(_), body) -> update(id, body)
    Request(
      method: "DELETE",
      path: item(id),
      query: blank(_)
    ) -> deleted(id, count: sql_exec(query: "DELETE FROM todos WHERE id = :id", id))
    Request(method, path: item(id)) if method == "GET"
      or method == "PATCH"
      or method == "DELETE" -> error(status: 400)
    Request(path: item(id)) -> error(status: 405)
    _ -> error(status: 404)
  }
}

// "/todos/7" is the item with Id 7.
fn item(path: View) -> Option[Id] {
  match path {
    "/todos/" ++ decimal(Id(id)) -> Some(id)
    _ -> None
  }
}

// No query, or an empty one.
fn blank(query: Option[View]) -> Option[Bool] {
  match query {
    None -> Some(True)
    Some(value: "") -> Some(True)
    _ -> None
  }
}

fn filter(query: Option[View]) -> Option[Filter] {
  match query {
    None -> Some(Everything)
    Some(value: "") -> Some(Everything)
    Some(value: "done=true") -> Some(Only(True))
    Some(value: "done=false") -> Some(Only(False))
    _ -> None
  }
}

fn list(which: Filter) -> Buf {
  match which {
    Everything -> todos(rows: sql_all(row: Todo, query: "SELECT * FROM todos ORDER BY id"))
    Only(done) -> todos(
      rows: sql_all(row: Todo, query: "SELECT * FROM todos WHERE done = :done ORDER BY id", done)
    )
  }
}

fn create(body: View) -> Buf {
  match decode(json: body, as: NewTodo) {
    Ok(value: NewTodo(key, title, done: Some(value: done))) -> insert(key, title, done)
    Ok(value: NewTodo(key, title, done: None)) -> insert(key, title, done: False)
    Err(error) -> error(status: 400)
  }
}

fn insert(key: Key, title: Title, done: Bool) -> Buf {
  made(
    key,
    found: sql_first(
      row: Todo,
      query: "INSERT INTO todos(key, title, done) VALUES (:key, :title, :done) ON CONFLICT(key) \
          DO NOTHING RETURNING *",
      key,
      title,
      done
    )
  )
}

// 201 with the todo this request made, or 200 with the one an earlier request with the same key made.
fn made(key: Key, found: Option[Todo]) -> Buf {
  match found {
    Some(value) -> one(status: 201, found)
    None -> one(
      status: 200,
      found: sql_first(row: Todo, query: "SELECT * FROM todos WHERE key = :key", key)
    )
  }
}

fn update(id: Id, body: View) -> Buf {
  match decode(json: body, as: Changes) {
    Ok(value: Retitle(title)) -> one(
      status: 200,
      found: sql_first(
        row: Todo,
        query: "UPDATE todos SET title = :title WHERE id = :id RETURNING *",
        title,
        id
      )
    )
    Ok(value: Mark(done)) -> one(
      status: 200,
      found: sql_first(
        row: Todo,
        query: "UPDATE todos SET done = :done WHERE id = :id RETURNING *",
        done,
        id
      )
    )
    Ok(value: Both(title, done)) -> one(
      status: 200,
      found: sql_first(
        row: Todo,
        query: "UPDATE todos SET title = :title, done = :done WHERE id = :id RETURNING *",
        title,
        done,
        id
      )
    )
    Err(error) -> error(status: 400)
  }
}

// ---------- responses ----------

fn error(status: Int) -> Buf {
  match status {
    400 -> append(buf: respond(status), view: "{\"error\":\"bad_request\"}")
    404 -> append(buf: respond(status), view: "{\"error\":\"not_found\"}")
    _ -> append(buf: respond(status), view: "{\"error\":\"method_not_allowed\"}")
  }
}

fn one(status: Int, found: Option[Todo]) -> Buf {
  match found {
    Some(value) -> write_json(out: respond(status), value)
    None -> error(status: 404)
  }
}

fn deleted(id: Id, count: Int) -> Buf {
  match count {
    0 -> error(status: 404)
    _ -> push(
      buf: write_int(out: append(buf: respond(status: 200), view: "{\"deleted\":"), value: id),
      byte: 125
    )
  }
}

fn todos(rows: Rows[Todo]) -> Buf {
  push(
    buf: write_rows(out: append(buf: respond(status: 200), view: "{\"todos\":"), rows),
    byte: 125
  )
}

invariant "a todo is done or not, and has a title" {
  SELECT id FROM todos WHERE done NOT IN (0, 1) OR length(title) < 1
}
