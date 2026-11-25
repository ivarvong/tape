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

// A body field: not given, given and valid, or given and wrong.
type Field[T] {
  Unset
  Set(value: T)
  Wrong
}

type Draft {
  Draft(title: Field[View], done: Field[Bool])
  Invalid
}

fn handle(request: View, db: Sql) -> Response {
  let line = until(v: request, byte: 10)
  let target = after(v: line, byte: 32)
  serve(db, method: until(v: line, byte: 32), route: route(path: until(v: target, byte: 63)), query: after(v: target, byte: 63), body: after(v: request, byte: 10)) |> respond(status: 200)
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
    List -> create(db, draft: draft(body))
    Item(id) if method == "GET" -> one(status: 200, found: sql_first(db, row: Todo, query: "SELECT id, title, done FROM todos WHERE id = :id", id))
    Item(id) if method == "DELETE" -> deleted(id, count: sql_exec(db, query: "DELETE FROM todos WHERE id = :id", id))
    Item(id) -> update(db, id, draft: draft(body))
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

fn create(db: Sql, draft: Draft) -> Buf {
  match draft {
    Draft(title: Set(value: text), done: Unset) -> insert(db, text, done: False)
    Draft(title: Set(value: text), done: Set(value: done)) -> insert(db, text, done)
    _ -> error(status: 400)
  }
}

fn insert(db: Sql, text: View, done: Bool) -> Buf {
  one(status: 201, found: sql_first(db, row: Todo, query: "INSERT INTO todos(title, done) VALUES (:text, :done) RETURNING id, title, done", text, done))
}

fn update(db: Sql, id: Int, draft: Draft) -> Buf {
  match draft {
    Draft(title: Set(value: text), done: Unset) -> one(status: 200, found: sql_first(db, row: Todo, query: "UPDATE todos SET title = :text WHERE id = :id RETURNING id, title, done", text, id))
    Draft(title: Unset, done: Set(value: done)) -> one(status: 200, found: sql_first(db, row: Todo, query: "UPDATE todos SET done = :done WHERE id = :id RETURNING id, title, done", done, id))
    Draft(title: Set(value: text), done: Set(value: done)) -> one(status: 200, found: sql_first(db, row: Todo, query: "UPDATE todos SET title = :text, done = :done WHERE id = :id RETURNING id, title, done", text, done, id))
    _ -> error(status: 400)
  }
}

// ---------- the request body ----------

fn draft(body: View) -> Draft {
  fields(body, step: json_first(body), title: Unset, done: Unset)
}

// A repeated key replaces the earlier one, as JSON.parse does; any other key makes the body invalid.
fn fields(body: View, step: JsonStep, title: Field[View], done: Field[Bool]) -> Draft {
  match step {
    Member(key: "title", value, next) -> fields(body, step: json_next(v: body, at: next), title: title_of(value), done)
    Member(key: "done", value, next) -> fields(body, step: json_next(v: body, at: next), title, done: done_of(value))
    Close(next) if json_end(v: body, at: next) -> Draft(title, done)
    _ -> Invalid
  }
}

fn title_of(value: Json) -> Field[View] {
  match value {
    JsonString(text) if len(text) >= 1 and len(text) <= 200 -> Set(text)
    _ -> Wrong
  }
}

fn done_of(value: Json) -> Field[Bool] {
  match value {
    JsonBool(value) -> Set(value)
    _ -> Wrong
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
    Some(value) -> write_todo(out: push(buf: write_int(out: buf(), value: status), byte: 10), todo: value)
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
    Next(value, rest) if first -> each_todo(out: write_todo(out, todo: value), rows: rest, first: False)
    Next(value, rest) -> each_todo(out: write_todo(out: push(buf: out, byte: 44), todo: value), rows: rest, first: False)
    End -> out
  }
}

fn write_todo(out: Buf, todo: Todo) -> Buf {
  let id = write_int(out: append(buf: out, view: "{\"id\":"), value: todo.id)
  let title = write_json_string(out: append(buf: id, view: ",\"title\":"), text: todo.title)
  match todo.done {
    True -> append(buf: title, view: ",\"done\":true}")
    False -> append(buf: title, view: ",\"done\":false}")
  }
}
