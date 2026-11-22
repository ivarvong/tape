// todo.tape: the todo API (SPEC.md) on Durable Object SQLite.
// The request is METHOD SP PATH LF BODY; the response is STATUS LF JSON.

schema "CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL)"

type Todo {
  Todo(id: Int, title: View, done: Bool)
}

type Route {
  List
  Item(id: Int)
  NoRoute
}

// The body of POST /todos: `done` may be absent. Unknown keys, wrong types and text that is not well-formed
// make the body invalid; the platform's JSON.parse does the parsing.
type NewTodo {
  NewTodo(title: View, done: Option[Bool])
}

// The body of PATCH /todos/ID.
type Changes {
  Changes(title: Option[View], done: Option[Bool])
}

fn handle(request: View, db: Sql) -> Buf {
  let line = until(v: request, byte: 10)
  let target = after(v: line, byte: 32)
  serve(db, method: until(v: line, byte: 32), route: route(path: until(v: target, byte: 63)), query: after(v: target, byte: 63), body: after(v: request, byte: 10))
}

fn route(path: View) -> Route {
  match {
    path == "/todos" -> List
    starts_with(v: path, prefix: "/todos/") -> item(id: decimal(slice(v: path, from: 7, to: len(path))))
    else -> NoRoute
  }
}

fn item(id: Option[Int]) -> Route {
  match id {
    Some(value) if value >= 1 and value <= 9007199254740991 -> Item(id: value)
    _ -> NoRoute
  }
}

fn serve(db: Sql, method: View, route: Route, query: View, body: View) -> Buf {
  match route {
    NoRoute -> error(status: 404)
    List if method == "GET" -> list(db, query)
    List if method != "POST" -> error(status: 405)
    Item if method != "GET" and method != "PATCH" and method != "DELETE" -> error(status: 405)
    _ if len(query) > 0 -> error(status: 400)
    List -> create(db, body: decode(json: body, as: NewTodo))
    Item(id) if method == "GET" -> one(status: 200, found: sql_first(db, row: Todo, query: "SELECT id, title, done FROM todos WHERE id = :id", id))
    Item(id) if method == "DELETE" -> deleted(id, count: sql_exec(db, query: "DELETE FROM todos WHERE id = :id", id))
    Item(id) -> update(db, id, body: decode(json: body, as: Changes))
  }
}

fn list(db: Sql, query: View) -> Buf {
  match query {
    "" -> todos(rows: sql_all(db, row: Todo, query: "SELECT id, title, done FROM todos ORDER BY id"))
    "done=true" -> todos(rows: sql_all(db, row: Todo, query: "SELECT id, title, done FROM todos WHERE done = :done ORDER BY id", done: True))
    "done=false" -> todos(rows: sql_all(db, row: Todo, query: "SELECT id, title, done FROM todos WHERE done = :done ORDER BY id", done: False))
    _ -> error(status: 400)
  }
}

fn create(db: Sql, body: Option[NewTodo]) -> Buf {
  match body {
    Some(value: NewTodo(title, done: None)) if titled(title) -> insert(db, text: title, done: False)
    Some(value: NewTodo(title, done: Some(value: done))) if titled(title) -> insert(db, text: title, done)
    _ -> error(status: 400)
  }
}

// A title is 1 to 200 bytes of UTF-8.
fn titled(title: View) -> Bool {
  len(title) >= 1 and len(title) <= 200
}

fn insert(db: Sql, text: View, done: Bool) -> Buf {
  one(status: 201, found: sql_first(db, row: Todo, query: "INSERT INTO todos(title, done) VALUES (:text, :done) RETURNING id, title, done", text, done))
}

fn update(db: Sql, id: Int, body: Option[Changes]) -> Buf {
  match body {
    Some(value: Changes(title: Some(value: title), done: None)) if titled(title) -> one(status: 200, found: sql_first(db, row: Todo, query: "UPDATE todos SET title = :title WHERE id = :id RETURNING id, title, done", title, id))
    Some(value: Changes(title: None, done: Some(value: done))) -> one(status: 200, found: sql_first(db, row: Todo, query: "UPDATE todos SET done = :done WHERE id = :id RETURNING id, title, done", done, id))
    Some(value: Changes(title: Some(value: title), done: Some(value: done))) if titled(title) -> one(status: 200, found: sql_first(db, row: Todo, query: "UPDATE todos SET title = :title, done = :done WHERE id = :id RETURNING id, title, done", title, done, id))
    _ -> error(status: 400)
  }
}

// ---------- responses ----------

fn error(status: Int) -> Buf {
  match status {
    400 -> append(buf: buf(), view: "400\n{\"error\":\"bad_request\"}")
    404 -> append(buf: buf(), view: "404\n{\"error\":\"not_found\"}")
    _ -> append(buf: buf(), view: "405\n{\"error\":\"method_not_allowed\"}")
  }
}

fn one(status: Int, found: Option[Todo]) -> Buf {
  match found {
    Some(value) -> write_json(out: push(buf: write_int(out: buf(), value: status), byte: 10), value)
    None -> error(status: 404)
  }
}

fn deleted(id: Int, count: Int) -> Buf {
  match count {
    0 -> error(status: 404)
    _ -> push(buf: write_int(out: append(buf: buf(), view: "200\n{\"deleted\":"), value: id), byte: 125)
  }
}

fn todos(rows: Rows[Todo]) -> Buf {
  append(buf: each_todo(out: append(buf: buf(), view: "200\n{\"todos\":["), rows, first: True), view: "]}")
}

fn each_todo(out: Buf, rows: Rows[Todo], first: Bool) -> Buf {
  match next(rows) {
    Next(value, rest) if first -> each_todo(out: write_json(out, value), rows: rest, first: False)
    Next(value, rest) -> each_todo(out: write_json(out: push(buf: out, byte: 44), value), rows: rest, first: False)
    End -> out
  }
}
