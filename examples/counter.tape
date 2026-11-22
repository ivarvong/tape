// counter.tape: a counter per name. The step is a feature flag: reading it is one load, and the value each
// request ran under is the first line of its log.
//
//   POST /<name>?op=<id>   add the step, once per op id: the same id again (a client that got no answer, retrying)
//                          is the same addition and answers the count as it stands. 428 without an op id.
//   GET  /<name>           the count
//
// Without op ids a retried POST added the step again; the compiler refuses that write now (rules.ts, C54). The op
// id is recorded with the name in the same request, and the addition's own statement checks it.

flag step: Int = 1

schema "CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, n INTEGER NOT NULL)"
schema "CREATE TABLE IF NOT EXISTS counted(op TEXT NOT NULL, name TEXT NOT NULL, \
    PRIMARY KEY (op, name))"

type Count { Count(n: Int) }
type Op = View where len(self) >= 1 and len(self) <= 64

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/" ++ name, query: Some(value: "op=" ++ Op(op))) -> {
      do sql_exec(
        query: "INSERT INTO counters(name, n) VALUES (:name, :step) ON CONFLICT(name) \
            DO UPDATE SET n = n + :step WHERE NOT EXISTS (SELECT 1 FROM counted WHERE op = :op \
            AND name = :name)",
        name,
        step: flags.step,
        op
      )
      add(name, op)
    }
    Request(method: "POST") -> respond(status: 428)
      |> append(view: "{\"error\":\"POST /<name>?op=<id>: an op id makes a retry add once\"}")
    Request(method: "GET", path: "/" ++ name) -> show(
      found: sql_first(row: Count, query: "SELECT n FROM counters WHERE name = :name", name)
    )
    _ -> respond(status: 405) |> append(view: "{\"error\":\"method_not_allowed\"}")
  }
}

// The op id is recorded with the name; a repeat added nothing, and answers the count as it stands.
fn add(name: View, op: View) -> Buf {
  do sql_exec(
    query: "INSERT INTO counted(op, name) VALUES (:op, :name) ON CONFLICT(op, name) DO NOTHING",
    op,
    name
  )
  show(found: sql_first(row: Count, query: "SELECT n FROM counters WHERE name = :name", name))
}

fn show(found: Option[Count]) -> Buf {
  match found {
    Some(value) -> respond(status: 200) |> append(view: "{\"count\":\(value.n)}")
    None -> respond(status: 200) |> append(view: "{\"count\":0}")
  }
}

// What must hold after every commit. (With the step left at 1 a count is also the number of its op ids; the step is
// a flag the host can change, so that is not written as a rule.)
invariant "a count has an op id recorded for it" {
  SELECT c.name, c.n FROM counters AS c WHERE c.n <> 0 AND NOT EXISTS (SELECT 1 FROM counted AS o WHERE o.name = c.name)
}

invariant "an op id recorded has its count" {
  SELECT o.op, o.name FROM counted AS o WHERE NOT EXISTS (SELECT 1 FROM counters AS c WHERE c.name = o.name)
}
