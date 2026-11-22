// todo.tape: the todo API (SPEC.md) on Durable Object SQLite.
// The request is METHOD SP PATH LF BODY; the response is STATUS LF JSON.

// A todo is created once per client key: POST /todos with a key seen before answers that todo (200), so a client
// that got no answer can send it again. Without a key a retried POST made a second todo (rules.ts, C55).
schema "CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, title \
    TEXT NOT NULL, done INTEGER NOT NULL)"

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
  Draft(key: Field[View], title: Field[View], done: Field[Bool])
  Invalid
}

fn handle(request: View, db: Sql) -> Buf {
  let line = until(v: request, byte: 10)
  let target = after(v: line, byte: 32)
  serve(
    method: until(v: line, byte: 32),
    route: route(path: until(v: target, byte: 63)),
    query: after(v: target, byte: 63),
    body: after(v: request, byte: 10)
  )
}

fn route(path: View) -> Route {
  match {
    path == "/todos" -> List
    starts_with(v: path, prefix: "/todos/") -> item(
      id: decimal(slice(v: path, from: 7, to: len(path)))
    )
    else -> NoRoute
  }
}

fn item(id: Option[Int]) -> Route {
  match id {
    Some(value) if value >= 1 and value <= 9007199254740991 -> Item(id: value)
    _ -> NoRoute
  }
}

fn serve(method: View, route: Route, query: View, body: View) -> Buf {
  match route {
    NoRoute -> error(status: 404)
    List if method == "GET" -> list(query)
    List if method != "POST" -> error(status: 405)
    Item if method != "GET" and method != "PATCH" and method != "DELETE" -> error(status: 405)
    _ if len(query) > 0 -> error(status: 400)
    List -> create(draft: draft(body))
    Item(id) if method == "GET" -> one(
      status: 200,
      found: sql_first(row: Todo, query: "SELECT * FROM todos WHERE id = :id", id)
    )
    Item(id) if method == "DELETE" -> deleted(
      id,
      count: sql_exec(query: "DELETE FROM todos WHERE id = :id", id)
    )
    Item(id) -> update(id, draft: draft(body))
  }
}

fn list(query: View) -> Buf {
  match query {
    "" -> todos(rows: sql_all(row: Todo, query: "SELECT * FROM todos ORDER BY id"))
    "done=true" -> todos(rows: sql_all(
      row: Todo,
      query: "SELECT * FROM todos WHERE done = :done ORDER BY id",
      done: True
    ))
    "done=false" -> todos(rows: sql_all(
      row: Todo,
      query: "SELECT * FROM todos WHERE done = :done ORDER BY id",
      done: False
    ))
    _ -> error(status: 400)
  }
}

fn create(draft: Draft) -> Buf {
  match draft {
    Draft(
      key: Set(value: key),
      title: Set(value: text),
      done: Unset
    ) -> insert(key, text, done: False)
    Draft(
      key: Set(value: key),
      title: Set(value: text),
      done: Set(value: done)
    ) -> insert(key, text, done)
    _ -> error(status: 400)
  }
}

fn insert(key: View, text: View, done: Bool) -> Buf {
  made(
    key,
    found: sql_first(
      row: Todo,
      query: "INSERT INTO todos(key, title, done) VALUES (:key, :text, :done) ON CONFLICT(key) \
          DO NOTHING RETURNING *",
      key,
      text,
      done
    )
  )
}

// 201 with the todo this request made, or 200 with the one an earlier request with the same key made.
fn made(key: View, found: Option[Todo]) -> Buf {
  match found {
    Some(value) -> one(status: 201, found)
    None -> one(
      status: 200,
      found: sql_first(row: Todo, query: "SELECT * FROM todos WHERE key = :key", key)
    )
  }
}

fn update(id: Int, draft: Draft) -> Buf {
  match draft {
    Draft(key: Unset, title: Set(value: text), done: Unset) -> one(
      status: 200,
      found: sql_first(
        row: Todo,
        query: "UPDATE todos SET title = :text WHERE id = :id RETURNING *",
        text,
        id
      )
    )
    Draft(key: Unset, title: Unset, done: Set(value: done)) -> one(
      status: 200,
      found: sql_first(
        row: Todo,
        query: "UPDATE todos SET done = :done WHERE id = :id RETURNING *",
        done,
        id
      )
    )
    Draft(key: Unset, title: Set(value: text), done: Set(value: done)) -> one(
      status: 200,
      found: sql_first(
        row: Todo,
        query: "UPDATE todos SET title = :text, done = :done WHERE id = :id RETURNING *",
        text,
        done,
        id
      )
    )
    _ -> error(status: 400)
  }
}

// ---------- the request body ----------

fn draft(body: View) -> Draft {
  fields(body, step: json_first(body), key: Unset, title: Unset, done: Unset)
}

// A repeated key replaces the earlier one, as JSON.parse does; any other key makes the body invalid.
fn fields(
  body: View,
  step: JsonStep,
  key: Field[View],
  title: Field[View],
  done: Field[Bool]
) -> Draft {
  match step {
    Member(key: "key", value, next) -> fields(
      body,
      step: json_next(v: body, at: next),
      key: key_of(value),
      title,
      done
    )
    Member(key: "title", value, next) -> fields(
      body,
      step: json_next(v: body, at: next),
      key,
      title: title_of(value),
      done
    )
    Member(key: "done", value, next) -> fields(
      body,
      step: json_next(v: body, at: next),
      key,
      title,
      done: done_of(value)
    )
    Close(next) if json_end(v: body, at: next) -> Draft(key, title, done)
    _ -> Invalid
  }
}

fn key_of(value: Json) -> Field[View] {
  match value {
    JsonString(text) if len(text) >= 1 and len(text) <= 64 -> Set(text)
    _ -> Wrong
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
    JsonBool(value: b) -> Set(value: b)
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
    Some(value) -> write_todo(
      out: push(buf: write_int(out: buf(), value: status), byte: 10),
      todo: value
    )
    None -> error(status: 404)
  }
}

fn deleted(id: Int, count: Int) -> Buf {
  match count {
    0 -> error(status: 404)
    _ -> push(
      buf: write_int(out: append(buf: buf(), view: "200\n{\"deleted\":"), value: id),
      byte: 125
    )
  }
}

fn todos(rows: Rows[Todo]) -> Buf {
  append(
    buf: each_todo(out: append(buf: buf(), view: "200\n{\"todos\":["), rows, first: True),
    view: "]}"
  )
}

fn each_todo(out: Buf, rows: Rows[Todo], first: Bool) -> Buf {
  match next(rows) {
    Next(value, rest) if first -> each_todo(
      out: write_todo(out, todo: value),
      rows: rest,
      first: False
    )
    Next(value, rest) -> each_todo(
      out: write_todo(out: push(buf: out, byte: 44), todo: value),
      rows: rest,
      first: False
    )
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

invariant "a todo is done or not, and has a title" {
  SELECT id FROM todos WHERE done NOT IN (0, 1) OR length(title) < 1
}
