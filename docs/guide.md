# A guide to Tape

The language, one feature at a time, with the before and after of each. [`LANGUAGE.md`](../LANGUAGE.md) is the
definition and wins where the two differ; this guide explains; [`std.md`](std.md) lists every function the standard
library has. Paths are relative to the repository root, and every command runs from there on Node 25. It starts
with [a whole REST service](#a-whole-rest-service-worked); the sections after it take one feature each.

## A whole REST service, worked

One program with the parts most services need: routes with an id in the path, a query string, validation that
answers 400 with the reason, JSON in and out (lists too), SQL with `:name` parameters (insert, select, update), a
POST a client can retry safely, and 404, 405 and 409. `test/guide.ts` compiles this program with the rules on,
checks it is in `tape fmt`'s layout, and sends it the requests below, so the answers shown are the ones it gives.
The functions it uses are in [the std reference](std.md).

```tape items.tape
migration 1 "items" {
  CREATE TABLE items(
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty >= 0),
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE tags(
    item INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (item, tag)
  )
}

type Id = Int where self >= 1 and self <= 9007199254740991
type Key = View where len(self) >= 1 and len(self) <= 64
type Name = View where len(self) >= 1 and len(self) <= 80
type Qty = Int where self >= 0 and self <= 1000000
type Limit = Int where self >= 1 and self <= 100
type Tag = View where len(self) >= 1 and len(self) <= 20 and tag_from(v: self, at: 0)

// What a client sends: POST /items, PATCH /items/ID, PUT /items/ID/tags.
type NewItem { NewItem(key: Key, name: Name, qty: Qty, tags: Option[List[Tag]]) }
type Change { Change(qty: Qty, version: Int) }
type Tags { Tags(tags: List[Tag]) }

// What it gets back.
type Item { Item(id: Int, key: View, name: View, qty: Int, version: Int) }
type Page { Page(items: List[Item], next: Int) }
type TagRow { TagRow(tag: View) }
type Problem { Problem(error: View) }
type Paging { Paging(after: Int, limit: Int) }

type Outcome {
  Shown(status: Int, item: Item)
  Failed(status: Int, reason: View)
}

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/items", query) -> listed(paged: paging(query))
    Request(method: "POST", path: "/items", body) -> created(body) |> rendered
    Request(method: "GET", path: "/items/" ++ decimal(Id(id))) -> found(item: load(id)) |> rendered
    Request(method: "PATCH", path: "/items/" ++ decimal(Id(id)), body) -> changed(id, body)
      |> rendered
    Request(method: "GET", path: "/items/" ++ decimal(Id(id)) ++ "/tags") -> tags_of(id)
    Request(method: "PUT", path: "/items/" ++ decimal(Id(id)) ++ "/tags", body) -> tagged(id, body)
    Request(path: "/items/" ++ decimal(Id(id))) -> rendered(
      outcome: Failed(status: 405, reason: "GET or PATCH")
    )
    Request(
      path: "/items/" ++ decimal(Id(id)) ++ "/tags"
    ) -> rendered(outcome: Failed(status: 405, reason: "GET or PUT"))
    Request(path: "/items/" ++ _) -> rendered(
      outcome: Failed(status: 400, reason: "an item is /items/ID, ID a whole number from 1")
    )
    _ -> rendered(outcome: Failed(status: 404, reason: "no such route"))
  }
}

// GET /items?after=ID&limit=N: both optional; anything else is a 400 that says which and why
fn paging(query: Option[View]) -> Result[Paging, View] {
  let q = query_text(query)
  let Some(value: after) = number(
    q,
    name: "after",
    none: 0
  ) else -> Err(error: "after: not a whole number")
  let Some(value: Limit(limit)) = number(q, name: "limit", none: 10) else {
    _ -> Err(error: "limit: not a whole number from 1 to 100")
  }
  Ok(value: Paging(after, limit))
}

fn query_text(query: Option[View]) -> View {
  match query {
    Some(value) -> value
    None -> ""
  }
}

// the parameter `name` as a number: `none` when it is absent, None when it is there but not a number
fn number(q: View, name: View, none: Int) -> Option[Int] {
  match form_field(body: q, name) {
    None -> Some(value: none)
    Some(value: decimal(n)) -> Some(value: n)
    _ -> None
  }
}

// a page of items by id, as {"items": [...], "next": ID}: pass `next` as ?after= for the next page; 0 at the end
fn listed(paged: Result[Paging, View]) -> Buf {
  let Ok(value: Paging(after, limit)) = paged else {
    Err(error) -> rendered(outcome: Failed(status: 400, reason: error))
  }
  let items = collect(rows: sql_all(
    row: Item,
    query: "SELECT * FROM items WHERE id > :after ORDER BY id LIMIT :limit",
    after,
    limit
  ))
  respond_as(status: 200, content: Json)
    |> write_json(value: Page(items, next: next_after(items, limit)))
}

fn collect(rows: Rows[Item]) -> List[Item] {
  match next(rows) {
    Next(value, rest) -> Cons(head: value, tail: collect(rows: rest))
    End -> Nil
  }
}

fn next_after(items: List[Item], limit: Int) -> Int {
  match {
    length(list: items) < limit -> 0
    else -> last_id(items)
  }
}

fn last_id(items: List[Item]) -> Int {
  match items {
    Cons(head: Item(id), tail: Nil) -> id
    Cons(tail) -> last_id(items: tail)
    Nil -> 0
  }
}

// POST /items: made once per client key. The same key again answers the item it made (200), so a client that
// got no answer can send it again; the same key with another name is a conflict (409).
fn created(body: View) -> Outcome {
  let Ok(value: NewItem(key, name, qty, tags)) = decode(json: body, as: NewItem) else {
    Err(error) -> Failed(status: 400, reason: error)
  }
  let Some(value: item) = sql_first(
    row: Item,
    query: "INSERT INTO items(key, name, qty) VALUES (:key, :name, :qty) ON CONFLICT(key) \
        DO NOTHING RETURNING *",
    key,
    name,
    qty
  ) else {
    None -> again(
      key,
      name,
      found: sql_first(row: Item, query: "SELECT * FROM items WHERE key = :key", key)
    )
  }
  do insert_tags(item: item.id, tags: listed_tags(tags))
  Shown(status: 201, item)
}

fn again(key: Key, name: Name, found: Option[Item]) -> Outcome {
  match found {
    Some(value: item = Item(name: had)) if had == name -> Shown(status: 200, item)
    Some(value) -> Failed(status: 409, reason: "key \(key) was used for another item")
    None -> Failed(status: 500, reason: "the key is taken but its item is gone")
  }
}

fn listed_tags(tags: Option[List[Tag]]) -> List[Tag] {
  match tags {
    Some(value) -> value
    None -> Nil
  }
}

// PATCH /items/ID {"qty": 3, "version": 1}: a compare-and-set on the version, so two clients that read version
// 1 cannot both write; the second gets 409 and reads again.
fn changed(id: Id, body: View) -> Outcome {
  let Ok(value: Change(qty, version)) = decode(json: body, as: Change) else {
    Err(error) -> Failed(status: 400, reason: error)
  }
  match sql_move(
    row: Item,
    query: "UPDATE items SET qty = :qty, version = version + 1 WHERE id = :id \
        AND version = :version RETURNING *",
    qty,
    id,
    version
  ) {
    Moved(value) -> Shown(status: 200, item: value)
    Raced(now) -> Failed(status: 409, reason: "the item is at version \(now.version)")
    NoRow -> Failed(status: 404, reason: "no such item")
  }
}

// PUT /items/ID/tags {"tags": ["red", "big"]}: the item's tags become these (a list in, rows out)
fn tagged(id: Id, body: View) -> Buf {
  let Ok(value: Tags(tags)) = decode(json: body, as: Tags) else {
    Err(error) -> rendered(outcome: Failed(status: 400, reason: error))
  }
  let Some(value: item) = load(id) else -> rendered(
    outcome: Failed(status: 404, reason: "no such item")
  )
  do sql_exec(query: "DELETE FROM tags WHERE item = :id", id)
  do insert_tags(item: item.id, tags)
  tags_of(id)
}

fn insert_tags(item: Int, tags: List[Tag]) -> Int {
  match tags {
    Cons(head, tail) -> sql_exec(
      query: "INSERT INTO tags(item, tag) VALUES (:item, :head) ON CONFLICT DO NOTHING",
      item,
      head
    ) + insert_tags(item, tags: tail)
    Nil -> 0
  }
}

fn tags_of(id: Id) -> Buf {
  respond_as(status: 200, content: Json)
    |> write_rows(
    rows: sql_all(row: TagRow, query: "SELECT tag FROM tags WHERE item = :id ORDER BY tag", id)
  )
}

fn load(id: Int) -> Option[Item] {
  sql_first(row: Item, query: "SELECT * FROM items WHERE id = :id", id)
}

fn found(item: Option[Item]) -> Outcome {
  match item {
    Some(value) -> Shown(status: 200, item: value)
    None -> Failed(status: 404, reason: "no such item")
  }
}

fn rendered(outcome: Outcome) -> Buf {
  match outcome {
    Shown(status, item) -> respond_as(status, content: Json) |> write_json(value: item)
    Failed(status, reason) -> respond_as(status, content: Json)
      |> write_json(value: Problem(error: reason))
  }
}

// a tag: a-z, 0-9 and -
fn tag_from(v: View, at: Int) -> Bool {
  match {
    at >= len(v) -> True
    (v[at] >= 97 and v[at] <= 122) or is_digit(v[at]) or v[at] == 45 -> tag_from(v, at: at + 1)
    else -> False
  }
}
```

What to notice:

- **Routes** are one `match request(raw)`. `"/items/" ++ decimal(Id(id))` takes the path apart, parses the number
  and checks its range in one pattern; a path that does not fit falls through to the next arm, so the 405 and 400
  arms come after the ones that serve.
- **The query** is `Request(query)`: the raw text after `?`. `form_field(body: q, name: "limit")` reads one
  parameter; `number` says absent (the default) apart from present but wrong (a 400 that names it).
- **Validation** is the types: `decode(json: body, as: NewItem)` checks every refined field (`Qty`, `Tag`, each
  element of `tags`), leaves a key it does not name unread (clients send more than a service reads), and its `Err`
  is a sentence that names the field. It goes back as the 400's body as it is.
- **JSON out** is `respond_as(status, content: Json)` and then `write_json` of a record (a `List` field is an
  array) or `write_rows` of a query. A `List` cannot be written on its own: `Page` wraps it.
- **SQL** names each value: `WHERE id = :id`, and the argument `id`. A row type's fields name the columns
  (`SELECT *` is `Item`'s five).
- **A retried POST** makes nothing twice: the client's `key` is `UNIQUE`, the INSERT is `ON CONFLICT(key) DO
  NOTHING RETURNING *`, and when it returns no row the request looks the key up and answers what the first one
  made. Take away the `UNIQUE` and the `ON CONFLICT`, and a retried POST would make a second item: the compiler
  refuses that INSERT (C55).
- **A lost update** is a 409: PATCH sends the version it read, and `sql_move` sets the row only if it is still at
  that version (`Raced` when it is not, `NoRow` when there is no row).

The requests, in order on one database, and what each answers (a request line, its body after the target, then
the status and body of the answer; every answer is `application/json`):

```text items.tape
POST /items {"key":"a1","name":"lamp","qty":2,"tags":["red","big"]}
201 {"id":1,"key":"a1","name":"lamp","qty":2,"version":1}
POST /items {"key":"a1","name":"lamp","qty":2,"tags":["red","big"]}
200 {"id":1,"key":"a1","name":"lamp","qty":2,"version":1}
POST /items {"key":"a1","name":"desk","qty":1}
409 {"error":"key a1 was used for another item"}
POST /items {"key":"b2","name":"desk","qty":-1}
400 {"error":"qty: not a valid Qty"}
POST /items {"key":"b2","name":"desk","qty":1,"color":"red"}
201 {"id":2,"key":"b2","name":"desk","qty":1,"version":1}
POST /items {"key":"b2","name":"desk","qty":1,"tags":["Red"]}
400 {"error":"tags[0]: not a valid Tag"}
POST /items {"key":"b2","name":"desk","qty":1}
200 {"id":2,"key":"b2","name":"desk","qty":1,"version":1}
GET /items/1
200 {"id":1,"key":"a1","name":"lamp","qty":2,"version":1}
GET /items/9
404 {"error":"no such item"}
GET /items/abc
400 {"error":"an item is /items/ID, ID a whole number from 1"}
DELETE /items/1
405 {"error":"GET or PATCH"}
GET /items?limit=1
200 {"items":[{"id":1,"key":"a1","name":"lamp","qty":2,"version":1}],"next":1}
GET /items?after=1&limit=1
200 {"items":[{"id":2,"key":"b2","name":"desk","qty":1,"version":1}],"next":2}
GET /items?after=2
200 {"items":[],"next":0}
GET /items?limit=500
400 {"error":"limit: not a whole number from 1 to 100"}
PATCH /items/1 {"qty":5,"version":1}
200 {"id":1,"key":"a1","name":"lamp","qty":5,"version":2}
PATCH /items/1 {"qty":6,"version":1}
409 {"error":"the item is at version 2"}
PATCH /items/9 {"qty":6,"version":1}
404 {"error":"no such item"}
GET /items/1/tags
200 [{"tag":"big"},{"tag":"red"}]
PUT /items/1/tags {"tags":["blue"]}
200 [{"tag":"blue"}]
GET /nothing
404 {"error":"no such route"}
```

To try it: save the program as `items.tape` and run `node tape.ts items.tape 'GET /items'`, or send it to the
hosted `run` tool ([docs/mcp.md](mcp.md)) with these requests (there, a body goes after a line feed:
`"POST /items\n{\"key\":\"a1\",…}"`).

## Patterns

A pattern is a parser: it can fail, and it binds what it proves. Patterns nest everywhere they appear (`match`
arms, `let … else` steps, destructuring `let`), and a field can hold any pattern: a constructor, a number or text
literal, `"prefix" ++ rest`, a refined type, or a function returning `Option`.

| Pattern | Matches | Binds |
| --- | --- | --- |
| `Order(id, state: "done")` | an `Order` whose `state` is `done` | `id` |
| `Some(value: Order(id, qty: 1))` | a present order of one item | `id` |
| `order = Order(state: "done")` | the same test as the pattern after `=` | `order`, the whole value |
| `Some(value: order = Order(state: "done"))` | a present, finished order | `order` |
| `Link(head, tail: rest = Link(head: second))` | a list of at least two | `head`, `rest`, `second` |

`name = Pattern` is how an arm keeps the whole value it took apart. `examples/fulfillment.tape` used to read a
finished order from SQLite a second time just to show it, because its arm could match `state: "done"` but not
bind the order:

```
Some(value: Order(id, state: "done")) -> show(status: 201, found: load(db, id))   // before: one more query
Some(value: order = Order(state: "done")) -> shown(status: 201, order)            // now: the value in hand
```

`let` takes a value apart when the pattern cannot fail: a type with one constructor, with names, `_` or more such
patterns inside.

```
let Pair(left: left = Order(id, qty), right) = pair
```

A pattern that can fail is refused at compile time, naming the part, because the cases it misses need an arm:

```
let Some(value: Order(id)) = found       C48 this let pattern can fail: Some, but the value can also be None
let Order(id, state: "done") = order     C48 this let pattern can fail: the text "done" (in field state)
```

Text patterns capture in the middle too. `P ++ "text"` matches text that ends in "text", with P matching what is
before it; `P ++ "sep" ++ Q` splits at the first "sep". With a prefix that gives routes such as:

```
Request(method: "POST", path: "/runs/" ++ decimal(id) ++ "/advance") -> …
Request(method: "GET", path: "/runs/" ++ decimal(run) ++ "/steps/" ++ decimal(n)) -> …
Request(path: "/files/" ++ name ++ ".json") -> …
```

Exhaustiveness looks through `=`: a `match` that misses a case is still refused with the value it misses
(`C24 match does not cover Some(value: Order)`). A name is bound once per function, as everywhere else.

## Pipes and `++`

`a |> f(b: 1)` is `f(<first parameter of f>: a, b: 1)`. The first parameter is the first one in `f`'s
definition, whatever it is called; nothing else about the call changes, and the module is the same as for the
nested call. The right side is one call, or a function's name when nothing else is passed (`n |> double`).

```
// before
push(buf: write_int(out: append(buf: append(buf: append(buf: respond(status: 200), view: "Hello again, "), view: name), view: " #"), value: n), byte: 33)
// after
respond(status: 200) |> append(view: "Hello again, ") |> append(view: name) |> append(view: " #") |> write_int(value: n) |> push(byte: 33)
```

So that the rule has something to work with, every function in std, and every built-in, takes the value it works
on first: `append(buf, view)`, `write_int(out, value)`, `until(v, byte)`, `get(map, key)`, `fold(list, from, by)`,
`sql_first(db, …)`, `decode(json, as)`, `call(to, …)`. A new function should do the same. `|>` binds tighter than
comparisons and looser than arithmetic: `x + 1 |> f()` pipes `x + 1`, and `x |> f() == 3` compares the result.
Errors say what went wrong: naming the first parameter again is `C12 … The value before |> is already scale's
first parameter, amount`; a right side that is not a call is `P07`.

`++` joins two texts into a new `View` (`"Hello, " ++ name`). It is `concat` in `std/core.tape`, written in
Tape; in a pattern, `"prefix" ++ rest` still takes text apart. A `Buf` is not joined but grown
(`out |> append(view: text)`), and a number is written into a `Buf` with `write_int`; `++` on either is refused
with that hint. `examples/fulfillment.tape` used SQL's `||` to join a note's parts, because Tape could not; it
now writes `stall: step ++ " was refused while compensating: " ++ reason`.

## Tooling: `fmt` and `test`

```
node tape.ts fmt [--check] files…     # rewrite in the canonical layout; --check only reports, and exits 1
node tape.ts test [files…]            # run the examples in comments (default: std/ and examples/)
```

`fmt` (`fmt.ts`) keeps your line breaks (one statement, arm or step per line, as the grammar requires) and fixes
everything within a line: one space around binary operators, `->`, `=`, `|>` and `++`; one after `,` and
`:`; none inside brackets or before the `(` of a call; two spaces of indentation per line that left a bracket
open; at most one blank line, none after `{` or before `}`. Comments, text literals and migration SQL are kept as
written. It refuses a file that does not parse, with the compiler's error. Every file in this repository is in
this layout (`npm test` checks it), formatting any of them twice changes nothing, and the parsed program is the
same before and after.

```
// before                                          // after
fn   total( o :Order , n:Int )->Int{                fn total(o: Order, n: Int) -> Int {
let a=-n+o.id*2                                       let a = -n + o.id * 2
    whole=Order( state : "x" ) -> whole.id            whole = Order(state: "x") -> whole.id
```

`test` (`doctest.ts`) runs examples written in comments. A line `//   > expression` is an example; the next
comment line is the pattern its value must match, so `_` stands for what does not matter:

```
// The part of v before the first `byte`, or all of v when it has none.
//
//   > until(v: "key=value", byte: 61)
//   "key"
//   > "no equals sign" |> until(byte: 61)
//   "no equals sign"
fn until(v: View, byte: Int) -> View {
```

Each example is compiled into its own file, so it calls what that file can call, and the compiled code decides.
A failure shows what it gave, computed by `interp.ts`; an example that does not compile shows the compiler's
error, and one that traps says why:

```
FAIL  dt.tape:9  > Order(id: double(n: 3), state: "done")
        expected  Order(id: 7, state: _)
        got       Order(id: 6, state: "done")
FAIL  dt.tape:11  > double(n: "x")
        C14 argument n should be Int but is View
```

`std/` carries 40 examples, and `examples/` 17 more. Examples run pure code: nothing that needs a capability.

## Steps: `let P = e else { … }`

A step names the case it goes on with and hands every other case to `else`. When `e` matches `P`, the names `P`
binds are in scope for the rest of the block; otherwise the first `else` arm that matches is the block's value.
`else -> value` takes every other case.

```
fn advance(run: Run) -> Outcome {
  match run {
    Run(id, step, tool, input, state: "acting") -> {
      let Ok(value: Used(output)) = call(to: tools, method: "tool", send: Use(tool, input), reply: Used, within: 50, once: AtStep(run: id, step)) else {
        Err(error: Rejected(reason)) -> carry(id, found: told(id, last: "error: " ++ reason))
        Err(error) -> show(status: 202, found: load(id))
      }
      carry(id, found: told(id, last: output))
    }
    _ -> Shown(status: 200, run)
  }
}
```

It is read as `match e { P -> rest of the block, arms… }`, so the arms are checked like any match: with `P` they
must cover every value (C24). There is nothing new to trust: exhaustiveness, ownership and the rules see the
match. A `match` (and so a step) is an expression wherever a value is (0.3): a function's or an arm's value, a
`let`'s value, an argument, an operand. There are no loops: a workflow that repeats is a function that calls itself
with what the step left (`advance` above, through `carry`), which compiles to a jump.

## JSON: records, lists, and records inside records

`decode(json, as: T)` gives `Result[T, View]` and `write_json(out, value)` writes one; a message between programs
is the same thing in each direction. This is the one way to read a body: a body that may be one of several shapes
decodes as a type with several constructors (`examples/todo.tape`), and the pattern `json(T(…))` that used to do
this is refused (C35). A field of a JSON type is:

- `Int`, `Bool`, `View`, or a refinement of one (`type Qty = Int where self >= 1`);
- a record of such fields;
- `List[…]` of any of these, lists of lists included;
- `Option[…]` of any of these, for a key that may be absent.

```
type NewTier { NewTier(key: Key, name: Name, price: Money, capacity: Seats) }
type NewEvent { NewEvent(key: Key, name: Name, starts: Name, tiers: Option[List[NewTier]]) }
```

A key that is a reserved word, such as a webhook's `"type"`, is a field like any other. A pattern binds it under
another name (`type: kind`), since a reserved word cannot name a variable:

```tape
type Hook { Hook(id: View, type: View) }

fn handle(raw: View) -> Buf {
  let Ok(value: Hook(id, type: kind)) = decode(json: request(raw).body, as: Hook) else {
    Err(error) -> respond(status: 400) |> append(view: error)
  }
  respond(status: 200) |> append(view: "\(id) is a \(kind)")
}
```

A value that does not fit is refused with the path to what is wrong: `tiers[1]: price: not a valid Money`,
`grid[1][1]: expected a whole number`. Every level is read as the top one is: a missing key, a wrong kind and a
refinement that fails are each a reason, and a key no field names is left unread. A fingerprint covers the
whole message, so two programs that disagree about a field three records down answer `Skew` and run nothing. An
exported method's JSON Schema goes through records and lists too.

`write_rows(out, rows: sql_all(row: R, query: …))` writes every row of a query as a JSON array.

How it is built: the host decodes one flat object at a time and hands a nested value over as text; for each type
with a nested field the compiler writes the functions that decode it level by level and write it field by field
(`compiler.ts`, `wireSource`; helpers in `std/json.tape`). A flat record compiles exactly as before, and a
program with no nested JSON has none of these functions in its module. `test/json.ts` checks the decoder against
`JSON.parse`: 300 generated values come back as `JSON.stringify` writes them, and the same 300 with one thing
wrong somewhere inside are refused. It costs a second parse per level; nothing here has been measured for speed.

## Steps that only do something: `do`

A block is steps followed by one expression. A step is `let name = e`, or, when the call is made for what it does
and its value is not wanted, `do call(…)`:

```
Moved(value) -> {
  do wake(after: 5000, key: id)
  refund_hold(hold: value)
}
```

`do` takes a call, and drops only an `Int` (rows written, a timer's delay, an id): a `Result`, a `Move` or an
`Option` has outcomes that must be read, so `do call(to: …)` and `do sql_move(…)` are refused (C82).

It is the one way to run something for what it does, so the order of effects is the order of the lines. The three
older ways are refused. "A call" below is one that does something: `sql_*`, `wake`, `call`, `ask`, `now`,
`random`, `rollback`, or a function that reaches one.

| | Refused | Instead |
|---|---|---|
| C83 | `let set = wake(…)` where `set` is never read | `do wake(…)` |
| C84 | `later(hold, set: wake(…))` where `later` never reads `set` | `do wake(…)` on the line before; drop the parameter |
| C85 | `seat + 1 + 0 * sql_exec(…)` | `do sql_exec(…)` on the line before |

A name or a parameter that is never read and holds no such call is dead, not hidden work, and is left alone.
Every program in this repository is written this way. A version uploaded before these rules keeps running in the
service; `?rules` lists it as one that would be refused today.

## Capabilities by name

A capability (`Sql`, a `Remote`, `Timer`, `Clock`, `Entropy`, an interface) is granted by the host to an entry
point, `handle` or an exported function, which declares it as a parameter. Any other function may use it by the
name the entry point declares, without listing it: the compiler adds the parameter to each function that reads
it or calls one that does, and passes it at each call. A built-in that takes one (`sql_*`'s `db`, `now`'s
`clock`, `random`'s `from`, `wake`'s `timer`) is given it when the program names exactly one of that type.

```
fn handle(raw: View, db: Sql, payments: Remote) -> Buf {
  routed(raw) |> rendered
}

fn load(id: Int) -> Option[Sub] {
  sql_first(row: Sub, query: "SELECT … FROM subs WHERE id = :id", id)
}
```

The check stays static. An entry point that reaches a capability it does not declare is refused with the call
path (`C72 peek uses the capability db (peek → twice → count) but does not declare it`); a name no entry point
declares is an unknown name; a name declared with two types is not ambient, and must be passed. Passing one
explicitly still works and wins.

## Row types name their columns: `*`

In `sql_first`, `sql_all` or `sql_move` with `row: R`, a `*` in the SELECT list or in RETURNING is R's fields, in
R's order. Each field is the column of that name in the statement's one table, or an item the list gives as
`expr AS field`:

```
type Sub { Sub(id: Int, card: View, price: Int, state: View, paid_through: Int, charging: Int, invoices: Int) }

sql_first(row: Sub, query: "SELECT *, (SELECT count(*) FROM invoices WHERE sub = subs.id) AS invoices FROM subs WHERE id = :id", id)
// is read as SELECT id, card, price, state, paid_through, charging, (SELECT count(*) …) AS invoices FROM subs …
```

The compiler rewrites the query text before anything else reads it, so the SQL checker (C69), the rules and the
module's statement list all see the columns. A column the table has and R does not is left out. C75 refuses a
field that is neither a column nor a given item, an item that is not a field, a second `*`, and a bare `*` over a
join or a subquery. `t.*` names its table, so it may stand in a join: `SELECT w.* FROM waitlist AS w JOIN tiers AS
t ON …` is W's fields from `waitlist`, written out as `w.id, w.tier, …`. With `sql_exec`, which reads no row, `*` is SQL's own.

## Names: a program's own wins over std's

A program may define a name std also defines: a type (`Step`), a constructor (`Next`, `End`), a function
(`after`) or a pure built-in (`next`, `len`, `slice`, `buf`, `push`, `append`, `freeze`, `size`). In the
program's files the program's definition is the one used. std's code keeps std's: std's type or constructor is
renamed `std.Step`, `std.Next`, and a call from std reaches std's function or the built-in. So a program can
have its own `Step` type and still loop over rows with std's `Next(value, rest)` and `End`.

What is still refused, each with a hint:
- C01 or C03 for the types the compiler reads by name: `Option`, `Result`, `Move`, `CallError`, `Wake` and their
  constructors (`Some`, `Ok`, `Moved`, `Timeout`, …);
- C04 for a built-in the rules read (`sql_*`, `call`, `ask`, `decode`, `now`, `random`, `wake`, `remote`,
  `rollback`, `write_json`), and for two definitions of one name in one file;
- C03 for one constructor name in two of the program's own files, and C45 for a call from a third file to a
  function two of the program's files define;
- C76 where the program's own name meets std's value: `Next(n) -> …` written for a row loop when the program has
  its own `Next` ("Step has its own Next (std.Next), which this program's Next shadows").

## Rules: writes that survive a retry, migrations that only add

Every build runs the rules in `rules.ts` after type-checking. Each rejects a kind of defect this project shipped
([`docs/design.md`](design.md)), and each is a compile error with a code, a line and a hint:

| Code | Refuses |
|---|---|
| C51 | a migration that is not `contract` with anything but CREATE TABLE, CREATE INDEX, ALTER TABLE … ADD COLUMN, INSERT INTO t(cols) |
| C52 | a query over two or more tables with an unqualified column |
| C53 | `schema` statements and migrations in one program |
| C54 | an UPDATE or upsert reached from `handle` or `woken` whose new values depend on the row (`n = n + 1`), unless its WHERE is a compare-and-set on a column it changes, or an op-id guard |
| C55 | an INSERT reached from `handle` or `woken` that names no whole unique key (a client key, an op id) |
| C56 | an op-id guard that does not name the row it protects (the same op id on another key) |
| C64, C65 | a command's `once:` key that is a number, a Bool or an Option (C64); one that is the same every time it is sent, or made only of what its message carries (C65), so two commands with the same message are one (a charge keyed by its amount). A key that names the row by its primary key is taken even when the message carries the id; otherwise key it by a key the client sent, or by the message itself (`once:` the same record as `send:`) |
| C71 | a command (`call`) built from a row whose key does not name that row (its primary key), or, after a `sql_move`, does not carry what the move wrote (the period being charged) |
| C73 | an UPDATE that takes from a column (`n = n - e`) with no top-level floor guard in its WHERE (`n >= e`), or one too weak for the column's CHECK floor |
| C74 | an UPDATE that sets a column some other write guards as a state (`AND state = 'paid'`) without saying which states it moves from, when no machine declares the column |
| C75 | a `*` the row type does not account for (section "Row types name their columns") |
| C76 | a program's type or constructor used where std's, which it shadows, is meant |
| C77 | a machine state that nothing leaves: no write moves a row out of it; or a write that puts a row in a state the program must leave itself (every exit follows a call, or a timer leaves it at a deadline) without setting a timer in the same commit, when no client and no later timer's run comes back for it ([design](design.md#timers-c77-to-c80)) |
| C78 | a timer that C77 counts, or that a timer's run sets again, whose key is not the row's key: a literal, another row's or table's key, a key computed from the row's (`id + 1`), or the row's key negated when woken reads it as `key` (or the reverse); a table that no timer's run reads by the timer's key; or a key that woken's guards (`key < 0 -> …`, in woken or in a function it passes the key to) send down an arm that does not read it back; and, for a timer set with any write of the table (a move to a final state too: a cancel that leaves refunds to a timer), a key computed from the row's, or one that woken uses only as another table's key ([design](design.md#timers-c77-to-c80)) |
| C79 | in a timer's run, an outcome of a remote call that leaves the row in a timed state while another outcome moves it out, or an arm that picks the row by a timed state, when some path through it neither moves the row out nor sets the timer again (a call counts only through its own outcomes); a path may end at a `final` constructor (Rejected, Skew, GaveUp) when a request can still move the row and, if it is matched, the value is a `call`'s reply (not an `ask`'s); or at the None of a read that lets a row in that state through ([design](design.md#timers-c77-to-c80)) |
| C81 | a state named in a pattern on a row (`Hold(state: "x")`) that its machine does not declare: the arm can never be taken. |
| C82 | `do` followed by something that is not a call, or a call whose value is not an Int. |
| C83-C85 | a call run for what it does and hidden: bound to a name never read, passed to a parameter never read, or multiplied by 0. Write `do call(…)`. |
| C86 | an invariant that is not one SELECT without placeholders over the schema's tables, or a name used twice. |
| C87 | a match on a call's reply where one arm takes a refusal (`Rejected`) together with no answer and sets a timer: the same key gets the same refusal, so it asks for ever. Give the refusal its own arm. |
| C88 | `repeat: True` or `no_floor: True` on a call whose statement the rule it answers (C54 and C55, or C73) would accept anyway. The argument is a claim about the write, so it is refused where it is not true. |
| C80 | a constructor declared `final` made where a second run may decide otherwise: a condition, guard or match subject on the way to it (in its function, or in a caller that answers with it) reads the clock in a way that can flip (`now() > t` is allowed on its own arm, `now() < t` on the arms after it), or an `ask`'s reply ([design](design.md#timers-c77-to-c80)) |

C54 does not count an assignment that settles on its first run: `col = max(col, e)`, `min(col, e)`,
`coalesce(col, e)` or `ifnull(col, e)`, where e reads no column the write changes. A write that takes from a
column with no floor says so in the call with `no_floor: True`. A write that may leave any state says so by listing them:
`AND live IN (0, 1)`.

A request is retried: by a client that got no answer, by a timer that fires at least once. So a POST that creates
carries the client's key (`{"key":"o-1",…}`, stored `UNIQUE`, with `ON CONFLICT … DO NOTHING`), and the same key
again answers with what the first made. A write meant to count every attempt in SQL (a visit counter or a rate limit's
`used = used + 1`), or an INSERT meant to make a new row each time (no client key, a create clients never retry),
says so in the call with `repeat: True`, the one opt-out. A write that sets its columns to values computed in Tape
(`used = :used`, from a row the request read) needs none: a retried request reads again, and C88 refuses it. Exported methods are not
checked: the host answers a repeated `once` key from the reply it stored. A repeat that arrives while the first run waits on a
call finds the key claimed and waits for that run's reply; when it does not come within the repeat's budget the
answer is `Unreachable`, and sending it again is safe.

The service runs the same compiler on every upload. A version uploaded before a rule existed keeps running: when a
newer compiler is deployed it is rebuilt from its source without asking the rules again; `GET /:account/:name?rules` shows, for each version, `"passes"` or the problems that would refuse it today,
and an upload beside such a version says so in `live_failing_rules`.

## Machines: the moves a status column may make

A table whose rows go through states declares them, and the moves between them; the first state named is where every
row starts (`examples/fulfillment.tape`, `tickets.tape`, `orders.tape`, `bump.tape`):

```
machine sales.state {
  "pending" -> "paid"
  "pending" -> "declined"
}
```

The compiler then reads every query of the program against it:

| Code | Refuses |
|---|---|
| C57 | a machine over a table or column the program does not have; a second machine for one column; a move to itself, or twice |
| C58 | an UPDATE (or an upsert's DO UPDATE) of the table whose WHERE does not name the state it expects: a top-level `AND state = …` or `AND state IN (…)`, not inside an OR. Without one it also writes onto a row another request has moved on (J3: a note on a finished order) |
| C59 | a move the machine does not declare: for every state the guard accepts and every value written, on every call path; an INSERT that does not start in the first state (by its value or the column's DEFAULT) |
| C60 | a write of the column the checker cannot read: a state that is not a literal or a parameter that is a literal at every call site, CASE, a subquery, REPLACE, INSERT … SELECT, several rows at once, WITH, a trigger the program declares. Refused, not passed |
| C61 | a literal compared with the column that is not a state (a misspelt state matches nothing) |

Parameters are traced through call sites one path at a time, so `move(from: "charging", to: "shipping")` and
`move(from: "shipping", to: "refunding")` are two moves, not four. The program's matches narrow a value on the
way: in the arm `"canceled" -> …` of `match state` (or `state == "canceled" -> …` in a condition match) state is
"canceled", and in the arms after it state is not, so `UPDATE … WHERE id = :id AND state = :state` there may move
from every declared state but canceled. A match on a record's field (`Sub(state: "canceled")`), a state tested
inside a called function, and a copy under another name (`let s = state`) are not followed. DELETE is not
checked, nor are a migration's own statements.

The host also installs two SQLite triggers per machine (`_tape_machine_<table>_<column>_start` and `_move`), which
refuse an INSERT in another state and an UPDATE that changes the column by an undeclared move: the request fails and
its transaction rolls back. They are dropped while migrations run and made again after. A write that does not change
the state (J3's note) is no move, so only C58 catches it. On the service the triggers allow the moves of every live
version: a version uploaded before the machine keeps working, and `?rules` lists what it does that the machine does
not declare. An upload is refused (409) when a live version writes the column in a way the checker cannot read, or
when the data holds rows in a state the machine does not declare.

## Invariants: what must hold of the rows

```
invariant "a tier's seats left and seats held add up to its capacity" {
  SELECT t.id FROM tiers AS t WHERE t.left + (SELECT coalesce(sum(h.qty), 0) FROM holds AS h
    WHERE h.tier = t.id AND h.state IN ('held', 'paying', 'confirmed', 'refunding')) <> t.capacity
}

invariant "no hold is left held, paying or refunding" settled {
  SELECT id, state FROM holds WHERE state IN ('held', 'paying', 'refunding')
}
```

An invariant is one SELECT; the rows it returns are what is wrong, so it must return none. It is checked against
the schema like any query (C86: not a SELECT, a placeholder, a table or column the schema lacks, a name used
twice). A plain invariant holds after every commit. A `settled` one holds once nothing is in flight and no timer
is set: it is how a program says that nothing is left half-done. The module lists them (a custom section, absent
when there are none). `app.invariants({ settled })` in `host.ts` returns the ones that do not hold, with the
rows; the simulator runs the plain ones after every step of every script and the settled ones at the end. An
invariant `with` another program reads that program's tables too, as `pay.ledger`:

```
invariant "a hold is charged its amount once it is confirmed, and nothing when it is not" settled with pay {
  SELECT h.id FROM holds AS h WHERE (SELECT coalesce(sum(l.amount), 0) FROM pay.ledger AS l WHERE l.ref = 'hold-' || h.id)
    <> CASE WHEN h.state IN ('confirmed', 'refund_failed') THEN h.amount ELSE 0 END
}
```

Only the simulator has both programs' rows, so only it runs such an invariant (it copies the tables side by side);
a program alone, in the service or in `tape sim` without `pay.tape`, passes it over. It is not checked against the
other program's schema at compile time: a SELECT that cannot run is reported by the simulator.

## A machine's states in a match

A row type read from one table knows the machine on its column. Two things follow.

A state named in a pattern must be one of the machine's states (C81), as C61 already says of SQL:
`Hold(state: "confirmd")` is an arm that can never be taken.

A match that names every state needs no default, and one that misses a state says which (C24):

```
match hold {
  Hold(state: "held") -> …
  Hold(state: "paying") -> charge(hold)
  Hold(state: "refunding") -> refund_hold(hold)
  Hold(state: "confirmed") -> ShowHold(status: 200, hold)
  Hold(state: "expired") -> ShowHold(status: 200, hold)
  Hold(state: "released") -> ShowHold(status: 200, hold)
  Hold(state: "refunded") -> ShowHold(status: 200, hold)
}
```

Add `"refunded" -> "disputed"` to the machine and this stops compiling with `match does not cover
Hold(state: "disputed")`, at the timer's run, which is where both bugs the production fault runs found were. A
default arm (`_`, or `Hold(state)`) is still allowed where "any other state" is what is meant. The set is
trusted from the machine's triggers: a row whose column holds something else (forced into the data past the
triggers, or a row value built by hand with a computed state) traps at the match instead of taking a wrong arm.

## Timers: `Timer`, `wake` and `woken`

A program that needs to do something later takes one more capability, `Timer`, and asks for it:

```
wake(timer, after: 2000, key: id)   // -> 2000: the delay set (kept within 0 ms to 30 days)
```

When the time comes, the host calls the program's own `export fn woken(…capabilities, message: Wake) ->
Result[Reply, View]` with `Wake(key: id)`. That is the whole feature: one capability, one intrinsic, one exported
function, and no syntax. The compiler holds it together: a program that can reach `wake` and exports no
`woken` (or a `woken` that takes something else) is refused with C50, and `wake` without a `Timer` in hand is C14.
A program that never calls it gets no `env.wake` import, so its module is the same as before.

A timer is an effect, recorded on the tape like the time or a call: `{ "wake": 1, "after": 1000, "due": … }`. A
replay answers `wake` from the log and sets nothing. The host keeps timers in the program's SQLite (`_wakes`, one
row per key), written in the same transaction as the request's writes, so a timer exists exactly when the request
that set it committed: a rollback or a trap drops it. Setting a key again moves its time. In the service, the
earliest timer becomes the name's Durable Object alarm; the alarm runs every due `woken` through the latest
version, logged like a request and traced as a child span of the run that set it, so the two are one trace. A
timer's row is removed in the same transaction as its run's last writes: a run cut short (the object reset while it
waited on a call) is woken again, and each run carries on from the data. A run that traps is recorded and not
retried: it would trap again. A run that fails on a storage error such as `SQLITE_BUSY` keeps its timer, set for
later by a wait that doubles with each such failure in a row (1 s, 2 s, … up to 15 minutes), so it too runs at least
once. Other programs cannot call `woken`, and no tool policy grants `Timer`.

Retrying is a library, not a feature: `std/retry.tape` is plain Tape on top of `wake`.

```
type Backoff { Backoff(first: Int, factor: Int, most: Int, tries: Int) }
type Retry { RetryIn(after: Int, attempt: Int)  GaveUp(tries: Int) final }

fn backoff(policy: Backoff, failed: Int) -> Retry                              // pure; doc-tested
fn retry_later(timer: Timer, key: Int, policy: Backoff, failed: Int) -> Retry  // backoff, then wake
```

`examples/fulfillment.tape` used to stop at a step that timed out and wait for `POST /advance/<id>`. Now the
workflow returns an `Outcome` value instead of writing HTTP itself, so the same functions serve a request
(`handle` renders it) and a timer (`woken` returns it):

```
// before: the step stalls, and a person resumes it
Timeout -> show(status: 202, found: noted(db, id, state, step, what: " did not answer in time; POST /advance/<id> resumes from here", reason: ""))

// after: count the failure, and let the timer resume it (1 s, 2 s, 4 s, 8 s; five attempts, then POST /advance)
Timeout -> retrying(db, timer, id, why: step ++ " did not answer in time", found: failed_again(db, id, state))

fn retrying(db: Sql, timer: Timer, id: Int, why: View, found: Option[Order]) -> Outcome {
  match found {
    Some(value: Order(state, retries)) -> show(status: 202, found: noted(db, id, state, stall: why ++ waiting(decided: retry_later(timer, key: id, policy: resume(), failed: retries))))
    None -> show(status: 202, found: load(db, id))
  }
}

export fn woken(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer, message: Wake) -> Result[Order, View] {
  let Wake(key) = message
  advance(db, inventory, payments, shipping, timer, wait: 2000, found: load(db, id: key)) |> settled
}
```

Resuming sends the step again with the same `once:` key, so a step that did run the first time answers from its
stored reply. `GET /:account/:name/wakes` (service) lists the timers set, the alarm, and the latest woken runs with
signed trace links.

`final` after a constructor's fields declares that the outcome is the same when the same thing is asked again:
`GaveUp`, and `CallError`'s `Rejected` and `Skew` (the callee repeats its stored reply for a key). It changes nothing
at run time. C79 lets a timer's run leave a row where a final outcome is matched or made, when a request can still
move the row on; any other path in a timer's run must move the row out of its state or set its timer again
([design](design.md#timers-c77-to-c80)). The compiler checks the declaration (C80): where a final constructor
is made, nothing on the way to it reads the clock in a way that can flip or an `ask`'s reply; where one is matched,
it ends a path only on a `call`'s reply, which carries a once key (C41), so the callee repeats it. Seven programs with a machine and timers, ported from Temporal samples' shapes, are in
`examples/timed/`.

## Numbers: exact, or a trap

An `Int` is 64 bits, and arithmetic that does not fit stops the request instead of wrapping around. Before
22 November 2026, `fact(21)` answered `-4249290049419214848` with status 200; now the request is answered 500
with `trap 6: integer overflow`, its writes undone, and the log says where. Division by zero is trap 4, a shift
amount outside 0 to 63 trap 7. A literal is checked when it is compiled: `-9223372036854775808` is the least Int,
and one digit more is P08.

```tape
fn fact(n: Int) -> Int {
  match {
    n <= 1 -> 1
    else -> n * fact(n - 1)
  }
}
```

`fact(n - 1)` passes its argument bare because `fact` has one parameter; a function of two names the others,
`pow(b, e: e - 1)`, and C10 shows that rewrite when it is missing. A hash or a checksum that means arithmetic
modulo 2^64 says so with `wrapping_add`, `wrapping_sub` or `wrapping_mul`. A loop over text, `at + 1` after
`at >= len(v)` did not hold or after `v[at]` was read, costs no overflow test: the compiler knows `at` is a length
at most ([`compiler/gen/range.ts`](../compiler/gen/range.ts)).

## Examples

| File | What it shows |
| --- | --- |
| `todo.tape` | A todo API over SQLite: routes, ids and JSON bodies matched and typed in one step; refined types bounded by a flag. |
| `todo-decode.tape`, `todo-handparsed.tape` | The same API with `decode` and with a hand-written parser, for comparison and benchmarks. |
| `orders.tape`, `stock.tape` | Two objects that call each other: a keyed `call` with a time budget, retried safely after a timeout. |
| `tickets.tape`, `payments.tape` | A box office: steps that each can fail (`let … else`), a keyed charge to another object, a refined quantity bounded by a flag, undoing a hold when the card is declined. |
| `fulfillment.tape`, `inventory.tape`, `shipping.tape` | A durable workflow: each step a keyed `call`, the next step a CHECK-constrained state in SQLite; a step that does not answer is sent again by a timer (std/retry.tape) without repeating it, and a refused one compensates (refund, then release). |
| `ledger.tape` | Transfers: refined amounts, errors as values, and `rollback` to undo a request's writes. |
| `counter.tape` | A feature flag; each log starts with the flag values the request ran under. |
| `shortener.tape` | `Clock` and `Entropy` as capabilities, both in the log, so a replay makes the same link. |
| `ratelimit.tape` | A windowed rate limit; time is in the log, so a replay gives the same verdict. |
| `webhook.tape` | Crypto and outbound HTTP as Remotes, each with a budget and in the log. |
| `csv.tape` | Aggregation on the immutable `Map`: a pure function, bytes in and bytes out (see `bench/`). |
| `cart.tape` | A JSON body with a list in it, checked as it is decoded by refined types, and a JSON answer (see `bench/`). |
| `words.tape` | Word counts on the immutable `Map`, whose memory is reused in the loop. |
| `stats.tape` | `map`, `filter` and `fold` from std, with functions as values. |
| `git.tape` | A git object parser: byte layouts with ordinary patterns, checked against git. |
| `trap.tape` | Writes a row, then divides by zero: a trap rolls the request back. |
| `../apps/tickets/` | A box office written as a user would (with its friction log): tiers with capacity, holds that expire by timer, checkout through a fake payment program with once keys, refunds, transfers, a waitlist, an admin cancel that refunds everyone, and server-rendered pages on the public route. |
| `../apps/queue/` | A job queue workers pull from, written from `LANGUAGE.md` (with its friction log): a job is made once per key, leased to one worker for a time, acked, nacked with a wait that doubles, or given back by a timer when the lease runs out; dead after its last try until asked for again. Seven invariants, one of them settled. `node test/queue.ts`. |
| `kv.tape` | One shard of the sharded key-value service: per-key versions with tombstones, `?if=` compare-and-set, a placement set once and CHECKed in SQLite, and FNV-1a with doc examples. |

## Migrations

`schema` statements run every time a program starts, so they must be idempotent. A table that changes over time
is written as numbered migrations instead, which run once each, in order:

```
migration 1 "notes" {
  CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)
}
migration 2 "pins" {
  ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0
}
migration 3 "drop the old index" contract {
  DROP INDEX notes_by_body
}
```

The compiler bakes the chain into the module, each migration hashed with every one before it, and checks the
queries against the schema at the end of the chain. `instantiate` applies the missing ones in one transaction and
records them in `schema_migrations(version, name, hash, applied_at)`. Applied migrations are append-only: a stored
hash that differs from the program's (an edited migration) stops the program before anything runs. A migration
that removes a table or column must be marked `contract`, because a version still running may depend on what it
removes. That is judged by what the migration did, comparing the tables and columns before and after it runs, not
by how its statements are written: a `DROP`, a `RENAME` and a table rebuilt without a column all count, while
deleting rows does not. `migrate` refuses an unmarked one and applies nothing; the service also refuses it at
upload, and holds a contract until every older live version is retired.


## The simulator: `tape sim`

```
node tape.ts sim apps/tickets/tickets.tape apps/tickets/pay.tape
```

runs the programs together in one process and makes every choice a deployment leaves to chance: which request
starts next, what happens to each call between programs, when a due timer runs, how far the clock moves. Nothing is
written for it. From the programs it reads:

- **requests**: every path a `match` names, with a body of the type that arm decodes. Values come from each type's
  JSON Schema (a refinement's bounds included); text comes from the programs' own seed rows, so a card or a tier that
  exists is sent; an id or a key from an earlier answer comes back in later requests.
- **what must hold**: the invariants the programs declare (above), a run that fails, and a timer that runs again and
  again once nothing fails any more.
- **the other side of a call**: a file's name is the name its callers reach it by (`pay.tape` is the Remote `pay`).
  A Remote that no file serves is **stood in for**: three times in four it answers with a value of the reply's
  type, otherwise it refuses, and a key seen before gets the reply it got before.

A call is a commit point, so a run can be cut short only at a call. Each call is delivered, lost before it ran,
dropped after it ran, or cut (the caller's object reset, before or after the callee ran). A run is the list of those
choices, a script; the same script and seed give the same run, a failing one is shrunk, and the command prints the
line that runs it again. The search is guided: a run that reaches something new (a machine in a state, a call
waiting, a fault taken on a method) leaves its script as a starting point for later runs, so a confirmed hold or a
refund in flight is somewhere to start from, not luck.

```
programs    tickets, pay; requests go to tickets
requests    18 paths: GET /events, … POST /holds {HoldReq}, * /holds/<n>/checkout {Checkout}, * /holds/<n>/refund, …
invariants  tickets: "a tier's seats left and seats held add up to its capacity"; … 9 in all
ok          500 runs, 24456 choices, nothing wrong (5694 ms)
answered    16 of 18 paths with a 2xx at least once; never: GET /hold?<q>, POST /<form>
states      14 of 15 reached; never: tickets.holds=refund_failed
```

(`refund_failed` needs a payment service that refuses a refund. The real `pay` never does; run
`tape sim apps/tickets/tickets.tape` alone and the stand-in does.)

The command also says what it did not do, so that a clean run is not read as more than it is:

- `answered`: how many paths were answered 2xx at least once, and which never were. A path that only ever got
  404 was not exercised.
- `not read`: match arms on a path it could not turn into requests.
- `states`: which states of each machine were reached, and which never.
- `sent again`: once everything has settled, each request that was answered 2xx is sent a second time, exactly
  as it was, and one that changes a row then is listed. This is a note: a row a request left half-way is moved on
  by its retry, by design.

A request sent twice at once is a failure, not a note. In each run one request that was answered 200, 201 or 204
is picked, and the run is lived twice from that point: once as it went, once with the request sent again straight
after its answer. Both are left to settle. If the rows end up different, the run fails (`repeat`), and the script
that shows it is shrunk like any other. A write marked `repeat: True` is the exception. This found a
link shortener that made a second link on a retry (`POST /links` carries a key now) and a transfer whose
`/resume` answered 200 while starting the work over (it answers 202).

One simulated request in seven is an earlier one sent again while others are in flight, and an id goes where an id
of its kind belongs (`/holds/<n>` gets a hold's id, a field named `tier` a tier's). What a program draws with
`random(from:)` comes from the run's seed.

**Is the model the real thing?** The simulator runs `host.ts` over node:sqlite; the service runs the same
`host.ts` source over a Durable Object's SQLite with calls as RPC. `node proof/sim-transcript.ts` writes down
what the simulator's host answers to 117 requests to `apps/tickets` with `pay`;
`service/test/sim-fidelity.test.ts` asks the real service the same in workerd and requires every status and body
to match. They do. That covers requests one at a time with every call delivered; it does not cover timers,
faults or two requests at once, where the service has its own fault runs (`service/jepsen`).

**What it found here, with nothing written for it** (`node proof/sim-all.ts`: every program in this repository
that has a `handle`, alone and in the groups deployed together: 37 runs of the command, 29 of them with invariants
to check; 61 invariants are declared in 30 files):

- `apps/tickets`, alone: a refund the payment service **refuses** was asked again every five seconds for ever, and
  a canceled event's sweep waited on it for ever. The same shape as the two bugs the production fault runs found,
  and not reachable with the real `pay`. The same in four of the seven `examples/timed`: a void, a refund, a page
  and a mail that the Remote refuses.
- Each now has an arm for the refusal (a state to rest in, for a person), and rule **C87** asks for one: an arm
  that takes `Rejected` together with no answer, and sets a timer, does not compile. The rule also flags the two
  compensation steps of `examples/fulfillment.tape` and one of `examples/timed/transfer.tape`, which retry a
  bounded number of times; they now say so in an arm of their own.
- After that: 36 of 37 are clean, and the other is `examples/trap.tape`, which divides by zero on purpose.
- 115 of 122 paths are answered with a 2xx at least once. The command prints the ones that never are.

**Can each invariant fail?** (`node proof/sim-invariants.ts`: one bug planted against each.) Of 34, 29 are
caught by the invariant meant for them, 3 are refused by the compiler first (C73 twice, C77), and 2 are not
caught: `examples/kv.tape`, which the simulator cannot write a key to, and an off-by-one in `apps/queue` that
needs a job failed and leased again after its wait.

**Against the 52 planted bugs of `apps/tickets`** (`node proof/sim-plants.ts`; each built with
`compile(…, { rules: false })`, 3 do not type-check either way):

| | Plants |
|---|---|
| Found from the programs alone, in 500 guided runs | 40 of 49 |
| of which no rule refuses | 5 |
| Found by the hand-written model (`apps/tickets/sim.ts`, 400 random runs) | 41 of 49 |
| Refused by the rules | 40 of 49 |
| Missed by both the rules and the simulator | 4: tickets issued without ON CONFLICT (which changes nothing: the move before it runs once), a transfer without the owner check, cancel open to anyone, a page that does not escape a name |

The last three need an oracle a SELECT over the rows cannot give: who was allowed to ask.

```
node tape.ts sim files… [--seeds n] [--steps n] [--faults n] [--random] [--exhaust depth] [--no-rules]
node test/sim-core.ts    # the simulator itself: explore, exhaust, shrink, replay
node test/sim-auto.ts    # tape sim: the model from the programs, stand-ins, the guided search, C87
```

What it is not: it runs programs on `host.ts` over node:sqlite, a model of the host, so it says nothing about
workerd or production (`service/jepsen` does). The requests are guesses from the text: a route reached only
through a form is not sent, and a path matched in a way it does not read is missed without a
word. A stood-in Remote answers at random within the reply's type, which is harsher than most real services and
kinder than some.

