// todo.tape: the todo API (SPEC.md) on Durable Object SQLite.
// Every value is parsed where it enters: a pattern either proves what it binds or the arm does not match.

schema "CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL)"

// The longest title, in bytes. A flag: the host can change it between requests without a deploy.
flag title_limit: Int = 200

type Id = Int where self >= 1 and self <= 9007199254740991
type Title = View where len(self) >= 1 and len(self) <= flags.title_limit

type Todo {
  Todo(id: Int, title: View, done: Bool)
}

// The body of POST /todos.
type NewTodo {
  NewTodo(title: Title, done: Option[Bool])
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
    Request(method: "GET", path: "/todos", query: filter(which)) -> list(db, which)
    Request(method: "POST", path: "/todos", query: blank(_), body) -> create(db, body)
    Request(method, path: "/todos") if method == "GET" or method == "POST" -> error(status: 400)
    Request(path: "/todos") -> error(status: 405)
    Request(method: "GET", path: item(id), query: blank(_)) -> one(status: 200, found: sql_first(db, row: Todo, query: "SELECT id, title, done FROM todos WHERE id = :id", id))
    Request(method: "PATCH", path: item(id), query: blank(_), body) -> update(db, id, body)
    Request(method: "DELETE", path: item(id), query: blank(_)) -> deleted(id, count: sql_exec(db, query: "DELETE FROM todos WHERE id = :id", id))
    Request(method, path: item(id)) if method == "GET" or method == "PATCH" or method == "DELETE" -> error(status: 400)
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

fn list(db: Sql, which: Filter) -> Buf {
  match which {
    Everything -> todos(rows: sql_all(db, row: Todo, query: "SELECT id, title, done FROM todos ORDER BY id"))
    Only(done) -> todos(rows: sql_all(db, row: Todo, query: "SELECT id, title, done FROM todos WHERE done = :done ORDER BY id", done))
  }
}

fn create(db: Sql, body: View) -> Buf {
  match body {
    json(NewTodo(title, done: Some(value: done))) -> insert(db, title, done)
    json(NewTodo(title, done: None)) -> insert(db, title, done: False)
    _ -> error(status: 400)
  }
}

fn insert(db: Sql, title: Title, done: Bool) -> Buf {
  one(status: 201, found: sql_first(db, row: Todo, query: "INSERT INTO todos(title, done) VALUES (:title, :done) RETURNING id, title, done", title, done))
}

fn update(db: Sql, id: Id, body: View) -> Buf {
  match body {
    json(Retitle(title)) -> one(status: 200, found: sql_first(db, row: Todo, query: "UPDATE todos SET title = :title WHERE id = :id RETURNING id, title, done", title, id))
    json(Mark(done)) -> one(status: 200, found: sql_first(db, row: Todo, query: "UPDATE todos SET done = :done WHERE id = :id RETURNING id, title, done", done, id))
    json(Both(title, done)) -> one(status: 200, found: sql_first(db, row: Todo, query: "UPDATE todos SET title = :title, done = :done WHERE id = :id RETURNING id, title, done", title, done, id))
    _ -> error(status: 400)
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
    _ -> push(buf: write_int(out: append(buf: respond(status: 200), view: "{\"deleted\":"), value: id), byte: 125)
  }
}

fn todos(rows: Rows[Todo]) -> Buf {
  append(buf: each_todo(out: append(buf: respond(status: 200), view: "{\"todos\":["), rows, first: True), view: "]}")
}

fn each_todo(out: Buf, rows: Rows[Todo], first: Bool) -> Buf {
  match next(rows) {
    Next(value, rest) if first -> each_todo(out: write_json(out, value), rows: rest, first: False)
    Next(value, rest) -> each_todo(out: write_json(out: push(buf: out, byte: 44), value), rows: rest, first: False)
    End -> out
  }
}
