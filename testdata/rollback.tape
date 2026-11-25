// testdata/rollback.tape: a claim, then a write that fails and rolls the request back, claim and all. test/forms.ts
// runs it with `node tape.ts`, whose writes must be undone as the service's are.
migration 1 "t" {
  CREATE TABLE claims(key TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE stock(id INTEGER PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 0))
}

type Claim { Claim(key: View) }

fn handle(raw: View, db: Sql) -> Response {
  let r = request(raw)
  match r {
    Request(method: Post, path: "/" ++ key) -> claimed(key)
    Request(method: Get, path: "/type") -> match header_of(request: r, name: "content-type") {
      Some(value) -> buf() |> append(view: value) |> respond(status: 200)
      None -> empty(status: 404)
    }
    _ -> buf()
      |> write_rows(rows: sql_all(row: Claim, query: "SELECT key FROM claims"))
      |> respond(status: 200)
  }
}

fn claimed(key: View) -> Response uses db {
  let 1 = sql_exec(
    query: "INSERT INTO claims(key) VALUES (:key) ON CONFLICT(key) DO NOTHING",
    key
  ) else -> empty(status: 200)
  let 1 = sql_exec(query: "UPDATE stock SET n = n - 1 WHERE id = 1 AND n >= 1") else -> rollback(
    out: empty(status: 409)
  )
  empty(status: 201)
}
