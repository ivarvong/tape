// shortener.tape: a link shortener. The id comes from randomness and the timestamp from the clock; both are
// capabilities in `handle`'s parameters and both are in the log, so a replay makes the same link. A new link
// carries the client's key: the same request again (a retry that did not hear the answer) is that link, not a
// second one.

schema "CREATE TABLE IF NOT EXISTS links(id INTEGER PRIMARY KEY, client \
    TEXT NOT NULL UNIQUE, url TEXT NOT NULL, created INTEGER NOT NULL)"

type Key = View where len(self) >= 1 and len(self) <= 64
type Url = View where len(self) >= 8 and len(self) <= 2000
type NewLink { NewLink(key: Key, url: Url) }
type Link { Link(id: Int, url: View, created: Int) }

fn handle(raw: View, db: Sql, clock: Clock, dice: Entropy) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/links", body) -> create(body)
    Request(method: "GET", path: "/" ++ decimal(id)) -> one(
      status: 200,
      found: sql_first(row: Link, query: "SELECT * FROM links WHERE id = :id", id)
    )
    _ -> problem(status: 404, reason: "no such route")
  }
}

fn create(body: View) -> Buf {
  let Ok(value: NewLink(key, url)) = decode(json: body, as: NewLink) else {
    Err(error) -> problem(status: 400, reason: error)
  }
  let Some(value) = sql_first(
    row: Link,
    query: "INSERT INTO links(id, client, url, created) VALUES (:id, :key, :url, :created) \
        ON CONFLICT(client) DO NOTHING RETURNING *",
    id: random(from: dice) % 1000000000,
    key,
    url,
    created: now(clock)
  ) else {
    None -> again(found: sql_first(
      row: Link,
      query: "SELECT * FROM links WHERE client = :key AND url = :url",
      key,
      url
    ))
  }
  respond(status: 201) |> write_json(value)
}

fn again(found: Option[Link]) -> Buf {
  match found {
    Some(value) -> respond(status: 200) |> write_json(value)
    None -> problem(status: 422, reason: "the key was already used for another link")
  }
}

fn one(status: Int, found: Option[Link]) -> Buf {
  match found {
    Some(value) -> respond(status) |> write_json(value)
    None -> problem(status: 404, reason: "no such link")
  }
}

fn problem(status: Int, reason: View) -> Buf {
  respond(status)
    |> append(view: "{\"error\":")
    |> write_json_string(text: reason)
    |> append(view: "}")
}

invariant "a stored link is as long as its type allows" {
  SELECT id FROM links WHERE length(url) < 1 OR length(url) > 2000
}
