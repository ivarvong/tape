// kv.tape: one shard of a sharded key-value store. The service creates a cluster of N of these, one Durable
// Object each (POST /kv/:account/:cluster {"shards": N}), and routes every key to shard fnv1a(key) mod N. Every
// shard runs this same program; what makes it shard i of N is one row, written once when the cluster is created:
//
//   PUT    /placement/<i>?shards=<n>   200 {"shard","shards"}; the same again is 200, anything else 409; never changes
//
// A shard with no placement serves nothing (503), and one that is given a key it does not own refuses it (421),
// so a routing bug is an error, never a key split across two shards.
//
//   GET    /k/<key>                         200 {"key","value","version"}; 404 {"error","key","version"} (version 0: never written)
//   PUT    /k/<key>[?op=<id>][&if=<v>]      the body is the value; 201 on the key's first write, else 200 {"key","version"}
//   DELETE /k/<key>[?op=<id>][&if=<v>]      200 {"key","version"}; 404 when there is nothing to delete
//   (?if=<v> alone works too)
//   GET    /stats                {"shard","shards","keys","live"}
//
// Every write gives the key a new version, one more than the last, deletes included: a deleted key keeps its row
// (a tombstone, `live` 0), so its versions never repeat and `?if=` is one rule: the write happens only when the
// key's version is <v> now (0 for a key never written). Otherwise 409 {"error","key","version","expected"}.
// Keys are 1-256 bytes of A-Z a-z 0-9 - . _ ~ : and %, as they appear in the URL (percent-encoded stays encoded);
// values are UTF-8 text of at most 65536 bytes.
//
// ?op=<id> makes a write idempotent: the first time a write to a key with that id is applied, its reply (status,
// key, version) is stored in the same transaction, and the same id for the same key again answers that reply
// without writing. A client that got no answer can retry with the same id and know the write happened exactly
// once. An op id names one write to one key: the same id on another key is another write (it was 422 when the
// other key was on the same shard and applied when it was not, so the answer depended on the hash; migration 3).
// A write that was not applied (409, 404) stores nothing, so its retry is decided afresh. Op ids are 1-64 of
// A-Z a-z 0-9 - _ and are kept forever (no expiry yet).

migration 1 "kv" {
  CREATE TABLE placement(
    one INTEGER PRIMARY KEY CHECK (one = 1),
    shards INTEGER NOT NULL CHECK (shards BETWEEN 1 AND 64),
    shard INTEGER NOT NULL CHECK (shard >= 0 AND shard < shards)
  );
  CREATE TABLE kv(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    live INTEGER NOT NULL CHECK (live IN (0, 1)),
    CHECK (live = 1 OR value = '')
  ) WITHOUT ROWID
}

migration 2 "ops" {
  CREATE TABLE ops(
    op TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    status INTEGER NOT NULL CHECK (status IN (200, 201)),
    version INTEGER NOT NULL CHECK (version >= 1)
  ) WITHOUT ROWID
}

// Op ids by key (see ?op= above). Table ops (migration 2, op ids by shard) is no longer written; it stays because
// removing a table needs a contract.
migration 3 "op ids by key" {
  CREATE TABLE key_ops(
    op TEXT NOT NULL,
    key TEXT NOT NULL,
    status INTEGER NOT NULL CHECK (status IN (200, 201)),
    version INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY (op, key)
  ) WITHOUT ROWID
}

// shard `shard` of `shards`: the table's CHECKs make anything else unstorable
type Placement { Placement(shard: Int, shards: Int) }

// a row as stored, and what it means
type Row { Row(key: View, value: View, version: Int, live: Int) }
type Found {
  Live(key: View, value: View, version: Int)
  Deleted(key: View, version: Int)
  Missing(key: View)
}

// what a request asks for, once it is valid
type Op {
  Read(key: View)
  Write(key: View, value: View, expect: Expect)
  Remove(key: View, expect: Expect)
}
type Expect {
  Any
  At(version: Int)
}

// the replies
type Value { Value(key: View, value: View, version: Int) }
type Stored { Stored(key: View, version: Int) }
type Absent { Absent(error: View, key: View, version: Int) }
type Mismatch { Mismatch(error: View, key: View, version: Int, expected: Int) }
type Stats { Stats(shard: Int, shards: Int, keys: Int, live: Int) }
type Counts { Counts(keys: Int, live: Int) }
type Problem { Problem(error: View) }
// a write applied under an op id: what it answered
type Done { Done(key: View, status: Int, version: Int) }
type Once { Once(op: View) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Put, path: "/placement/" ++ decimal(shard), query: Some(value: "shards=" ++ decimal(shards))) -> place(db, shard, shards)
    Request(method: Get, path: "/stats") -> stats(place: placement(db), counts: sql_first(db, row: Counts, query: "SELECT count(*) AS keys, coalesce(sum(live), 0) AS live FROM kv"))
    Request(method, path: "/k/" ++ key, query, body) -> checked(db, parsed: parsed(method, key, query, body))
    _ -> problem(status: 404, reason: "no such route; see GET/PUT/DELETE /k/<key>")
  }
}

// A request, validated: the operation (with its op id, "" for none), or the response that refuses it.
type Parsed {
  Valid(op: Op, once: View)
  Invalid(status: Int, reason: View)
}

// The query: its condition and op id, or refused.
type Asked {
  Asked(expect: Expect, once: View)
  Refused
}

fn parsed(method: Method, key: View, query: Option[View], body: View) -> Parsed {
  match {
    len(key) == 0 or len(key) > 256 -> Invalid(status: 400, reason: "a key is 1 to 256 bytes")
    not key_bytes(v: key, at: 0) -> Invalid(status: 400, reason: "a key is A-Z a-z 0-9 - . _ ~ : and %; percent-encode anything else")
    else -> verb(method, key, asked: asked(query), body)
  }
}

fn verb(method: Method, key: View, asked: Asked, body: View) -> Parsed {
  match method {
    Get -> plain(op: Read(key), asked)
    Put -> valued(key, asked, body)
    Delete -> conditional(asked, op: Remove(key, expect: Any))
    _ -> Invalid(status: 405, reason: "a key takes GET, PUT and DELETE")
  }
}

// GET takes no condition and no op id
fn plain(op: Op, asked: Asked) -> Parsed {
  match asked {
    Asked(expect: Any, once: "") -> Valid(op, once: "")
    _ -> Invalid(status: 400, reason: "GET takes no ?if= and no ?op=")
  }
}

fn valued(key: View, asked: Asked, body: View) -> Parsed {
  match {
    len(body) > 65536 -> Invalid(status: 413, reason: "a value is at most 65536 bytes")
    not utf8(v: body, at: 0) -> Invalid(status: 400, reason: "a value is UTF-8 text")
    else -> conditional(asked, op: Write(key, value: body, expect: Any))
  }
}

// the condition and the op id, put into the operation
fn conditional(asked: Asked, op: Op) -> Parsed {
  match asked {
    Asked(expect: e, once) -> Valid(op: with_expect(op, e), once)
    Refused -> Invalid(status: 400, reason: "a write takes ?if=<version>, ?op=<id>, or ?op=<id>&if=<version>; an op id is 1 to 64 of A-Z a-z 0-9 - _")
  }
}

fn with_expect(op: Op, e: Expect) -> Op {
  match op {
    Write(key, value) -> Write(key, value, expect: e)
    Remove(key) -> Remove(key, expect: e)
    Read(key) -> Read(key)
  }
}

// no query is Any; ?if=<digits> is At; ?op=<id> and ?op=<id>&if=<digits> add an op id; anything else is refused
//
//   > asked(query: Some(value: "op=w-1&if=3"))
//   Asked(expect: At(version: 3), once: "w-1")
//   > asked(query: Some(value: "if=3&op=w-1"))
//   Refused
fn asked(query: Option[View]) -> Asked {
  match query {
    None -> Asked(expect: Any, once: "")
    Some(value: "if=" ++ decimal(v)) -> Asked(expect: At(version: v), once: "")
    Some(value: "op=" ++ rest) -> with_once(once: until(v: rest, byte: 38), tail: after(v: rest, byte: 38))
    Some(value) -> Refused
  }
}

fn with_once(once: View, tail: View) -> Asked {
  match {
    len(once) == 0 or len(once) > 64 or not op_bytes(v: once, at: 0) -> Refused
    else -> once_with(once, tail)
  }
}

fn once_with(once: View, tail: View) -> Asked {
  match tail {
    "" -> Asked(expect: Any, once)
    "if=" ++ decimal(v) -> Asked(expect: At(version: v), once)
    _ -> Refused
  }
}

//   > op_bytes(v: "client-3_op-17", at: 0)
//   True
//   > op_bytes(v: "a.b", at: 0)
//   False
fn op_bytes(v: View, at: Int) -> Bool {
  match {
    at >= len(v) -> True
    (v[at] >= 48 and v[at] <= 57) or (v[at] >= 65 and v[at] <= 90) or (v[at] >= 97 and v[at] <= 122) or v[at] == 45 or v[at] == 95 -> op_bytes(v, at: at + 1)
    else -> False
  }
}

fn placement(db: Sql) -> Option[Placement] {
  sql_first(db, row: Placement, query: "SELECT shard, shards FROM placement")
}

// Set once: the first placement is kept (the CHECKs refuse an impossible one), and the reply is what is stored.
fn place(db: Sql, shard: Int, shards: Int) -> Response {
  match {
    shards < 1 or shards > 64 or shard >= shards -> problem(status: 400, reason: "a placement is shard i of n, 0 <= i < n <= 64")
    else -> placed(asked: Placement(shard, shards), now: sql_first(db, row: Placement, query: "INSERT INTO placement(one, shard, shards) VALUES (1, :shard, :shards) ON CONFLICT(one) DO UPDATE SET one = 1 RETURNING shard, shards", shard, shards))
  }
}

fn placed(asked: Placement, now: Option[Placement]) -> Response {
  let Placement(shard, shards) = asked
  match now {
    Some(value: Placement(shard: s, shards: n)) -> placement_reply(same: s == shard and n == shards, stored: Placement(shard: s, shards: n))
    None -> problem(status: 500, reason: "the placement upsert returned no row")
  }
}

fn placement_reply(same: Bool, stored: Placement) -> Response {
  match same {
    True -> write_json(out: buf(), value: stored) |> respond(status: 200)
    False -> write_json(out: buf(), value: stored) |> respond(status: 409)
  }
}

fn checked(db: Sql, parsed: Parsed) -> Response {
  match parsed {
    Valid(op, once) -> owned(db, op, once, place: placement(db))
    Invalid(status, reason) -> problem(status, reason)
  }
}

// A key this shard does not own is refused: the router sends each key to fnv1a(key) mod shards.
fn owned(db: Sql, op: Op, once: View, place: Option[Placement]) -> Response {
  match place {
    Some(value: Placement(shard, shards)) -> mine(db, op, once, shard, at: fnv1a(v: key_of(op)) % shards)
    None -> problem(status: 503, reason: "this shard has no placement yet: its cluster is still being created")
  }
}

fn mine(db: Sql, op: Op, once: View, shard: Int, at: Int) -> Response {
  match {
    at == shard and len(once) == 0 -> run(db, op, once)
    at == shard -> replayed(db, op, once, done: sql_first(db, row: Done, query: "SELECT key, status, version FROM key_ops WHERE op = :once AND key = :key", once, key: key_of(op)))
    else -> problem(status: 421, reason: "this key belongs to shard " ++ decimal_text(value: at) ++ ", not " ++ decimal_text(value: shard))
  }
}

fn key_of(op: Op) -> View {
  match op {
    Read(key) -> key
    Write(key) -> key
    Remove(key) -> key
  }
}

// A write under an op id that was applied to this key before answers what it answered then, and writes nothing.
fn replayed(db: Sql, op: Op, once: View, done: Option[Done]) -> Response {
  match done {
    Some(value: Done(key, status, version)) -> write_json(out: buf(), value: Stored(key, version)) |> respond(status)
    None -> run(db, op, once)
  }
}

fn run(db: Sql, op: Op, once: View) -> Response {
  match op {
    Read(key) -> read(found: found(key, row: load(db, key)))
    Write(key, value, expect: Any) -> stored(key, once, expect: Any, wrote: sql_first(db, row: Row, query: "INSERT INTO kv(key, value, version, live) VALUES (:key, :value, 1, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1, live = 1 RETURNING key, value, version, live", key, value), db)
    Write(key, value, expect: At(version: 0)) -> stored(key, once, expect: At(version: 0), wrote: sql_first(db, row: Row, query: "INSERT INTO kv(key, value, version, live) VALUES (:key, :value, 1, 1) ON CONFLICT(key) DO NOTHING RETURNING key, value, version, live", key, value), db)
    Write(key, value, expect: At(version)) -> stored(key, once, expect: At(version), wrote: sql_first(db, row: Row, query: "UPDATE kv SET value = :value, version = version + 1, live = 1 WHERE key = :key AND version = :version RETURNING key, value, version, live", value, key, version), db)
    Remove(key, expect: Any) -> removed(key, once, expect: Any, gone: sql_first(db, row: Row, query: "UPDATE kv SET value = '', version = version + 1, live = 0 WHERE key = :key AND live = 1 RETURNING key, value, version, live", key), db)
    Remove(key, expect: At(version)) -> removed(key, once, expect: At(version), gone: sql_first(db, row: Row, query: "UPDATE kv SET value = '', version = version + 1, live = 0 WHERE key = :key AND live = 1 AND version = :version RETURNING key, value, version, live", key, version), db)
  }
}

fn load(db: Sql, key: View) -> Option[Row] {
  sql_first(db, row: Row, query: "SELECT key, value, version, live FROM kv WHERE key = :key", key)
}

fn found(key: View, row: Option[Row]) -> Found {
  match row {
    Some(value: Row(value, version, live: 1)) -> Live(key, value, version)
    Some(value: Row(version)) -> Deleted(key, version)
    None -> Missing(key)
  }
}

fn version_of(f: Found) -> Int {
  match f {
    Live(version) -> version
    Deleted(version) -> version
    Missing -> 0
  }
}

fn read(found: Found) -> Response {
  match found {
    Live(key, value, version) -> write_json(out: buf(), value: Value(key, value, version)) |> respond(status: 200)
    Deleted(key, version) -> absent(key, version)
    Missing(key) -> absent(key, version: 0)
  }
}

fn absent(key: View, version: Int) -> Response {
  write_json(out: buf(), value: Absent(error: "no such key", key, version)) |> respond(status: 404)
}

// A write that happened, or (when its condition failed) the version the key has now.
fn stored(key: View, once: View, expect: Expect, wrote: Option[Row], db: Sql) -> Response {
  match wrote {
    Some(value: Row(version: 1)) -> applied(db, key, once, status: 201, version: 1)
    Some(value: Row(version)) -> applied(db, key, once, status: 200, version)
    None -> mismatch(key, expect, now: version_of(f: found(key, row: load(db, key))))
  }
}

// The reply to a write that was applied; under an op id, the reply is stored with the write (one transaction).
fn applied(db: Sql, key: View, once: View, status: Int, version: Int) -> Response {
  match {
    len(once) == 0 -> write_json(out: buf(), value: Stored(key, version)) |> respond(status)
    else -> remembered(key, status, version, kept: sql_first(db, row: Once, query: "INSERT INTO key_ops(op, key, status, version) VALUES (:once, :key, :status, :version) RETURNING op", once, key, status, version))
  }
}

fn remembered(key: View, status: Int, version: Int, kept: Option[Once]) -> Response {
  match kept {
    Some(value: Once(op)) -> write_json(out: buf(), value: Stored(key, version)) |> respond(status)
    None -> problem(status: 500, reason: "the op id was not stored")
  }
}

// 409 for a condition that failed; an unconditional write always returns its row, so None there is a bug (500)
fn mismatch(key: View, expect: Expect, now: Int) -> Response {
  match expect {
    At(version) -> write_json(out: buf(), value: Mismatch(error: "version mismatch", key, version: now, expected: version)) |> respond(status: 409)
    Any -> problem(status: 500, reason: "an unconditional write returned no row")
  }
}

fn removed(key: View, once: View, expect: Expect, gone: Option[Row], db: Sql) -> Response {
  match gone {
    Some(value: Row(version)) -> applied(db, key, once, status: 200, version)
    None -> not_removed(key, expect, found: found(key, row: load(db, key)))
  }
}

// nothing to delete (404), or a condition that failed (409)
fn not_removed(key: View, expect: Expect, found: Found) -> Response {
  match found {
    Live(version) -> mismatch(key, expect, now: version)
    Deleted(version) -> absent(key, version)
    Missing -> absent(key, version: 0)
  }
}

fn stats(place: Option[Placement], counts: Option[Counts]) -> Response {
  match place {
    Some(value: Placement(shard, shards)) -> counted(shard, shards, counts)
    None -> problem(status: 503, reason: "this shard has no placement yet")
  }
}

fn counted(shard: Int, shards: Int, counts: Option[Counts]) -> Response {
  match counts {
    Some(value: Counts(keys, live)) -> write_json(out: buf(), value: Stats(shard, shards, keys, live)) |> respond(status: 200)
    None -> problem(status: 500, reason: "count(*) returned no row")
  }
}

fn problem(status: Int, reason: View) -> Response {
  write_json(out: buf(), value: Problem(error: reason)) |> respond(status)
}

// FNV-1a, 32 bits, over the key's bytes. The router computes the same (service/src/kv.js) to pick the shard.
//
//   > fnv1a(v: "")
//   2166136261
//   > fnv1a(v: "a")
//   3826002220
//   > fnv1a(v: "foobar")
//   3214735720
fn fnv1a(v: View) -> Int {
  fnv_from(v, at: 0, h: 2166136261)
}

fn fnv_from(v: View, at: Int, h: Int) -> Int {
  match {
    at >= len(v) -> h
    else -> fnv_from(v, at: at + 1, h: ((h ^ v[at]) * 16777619) & 4294967295)
  }
}

//   > key_bytes(v: "user:42%2Fa_b-c.d~e", at: 0)
//   True
//   > key_bytes(v: "a b", at: 0)
//   False
fn key_bytes(v: View, at: Int) -> Bool {
  match {
    at >= len(v) -> True
    key_byte(b: v[at]) -> key_bytes(v, at: at + 1)
    else -> False
  }
}

fn key_byte(b: Int) -> Bool {
  (b >= 48 and b <= 58) or (b >= 65 and b <= 90) or (b >= 97 and b <= 122) or b == 45 or b == 46 or b == 95 or b == 126 or b == 37
}

// Valid UTF-8, the whole of v from `at`.
//
//   > utf8(v: "héllo ✓", at: 0)
//   True
fn utf8(v: View, at: Int) -> Bool {
  match {
    at >= len(v) -> True
    v[at] < 128 -> utf8(v, at: at + 1)
    else -> utf8_step(v, step: utf8_at(v, at))
  }
}

fn utf8_step(v: View, step: Utf8) -> Bool {
  match step {
    Utf8(next) -> utf8(v, at: next)
    BadUtf8 -> False
  }
}
