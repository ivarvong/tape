// ledger.tape: a small double-entry ledger of play money. Every transfer writes two entries, one taking the amount
// from an account and one giving it to another, so the entries of the whole ledger always sum to zero. Amounts are
// exact (Dec[2]); an account may not go below zero, except an external one (a bank, the world), which is where
// money comes from.
//
//   GET  /                         a page of the balances and the latest transfers
//   POST /accounts                 {"id","external"?}: 201 {"id","external","balance"}; the same id again is 200
//   GET  /accounts                 every account and its balance, as JSON
//   GET  /accounts/<id>            one account, with its entries
//   POST /transfers                {"key","from","to","amount","memo"?}: amount "12.50" (or 12.5), 0.01 to
//                                  1000000.00. 201 the transfer; the same key again answers it (200), or 409 if
//                                  the key was used for another transfer; 409 when the balance is short
//   GET  /transfers.csv            every transfer, as CSV
//   GET  /accounts.csv             every balance, as CSV
//
// A transfer claims its key first (transfers.client UNIQUE): its retry stops at the claim and answers the first.

migration 1 "ledger" {
  CREATE TABLE accounts(
    id TEXT PRIMARY KEY NOT NULL,
    external INTEGER NOT NULL DEFAULT 0 CHECK (external IN (0, 1)),
    balance INTEGER NOT NULL DEFAULT 0,
    CHECK (external = 1 OR balance >= 0)
  ) WITHOUT ROWID;
  CREATE TABLE transfers(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    src TEXT NOT NULL REFERENCES accounts(id),
    dst TEXT NOT NULL REFERENCES accounts(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    memo TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL,
    CHECK (src <> dst)
  );
  CREATE TABLE entries(
    transfer INTEGER NOT NULL REFERENCES transfers(id),
    account TEXT NOT NULL REFERENCES accounts(id),
    amount INTEGER NOT NULL CHECK (amount <> 0),
    PRIMARY KEY (transfer, account)
  ) WITHOUT ROWID
}

// three accounts to start with: money comes in from the bank
migration 2 "seed" {
  INSERT INTO accounts(id, external) VALUES ('bank', 1), ('alice', 0), ('bob', 0)
}

invariant "the entries of the ledger sum to zero" {
  SELECT total FROM (SELECT coalesce(sum(amount), 0) AS total FROM entries) AS s WHERE total <> 0
}

invariant "a balance is the sum of its account's entries" {
  SELECT a.id FROM accounts AS a
    WHERE a.balance <> (SELECT coalesce(sum(e.amount), 0) FROM entries AS e WHERE e.account = a.id)
}

invariant "a transfer is two entries: its amount out of src and into dst" {
  SELECT t.id FROM transfers AS t
    WHERE (SELECT count(*) FROM entries AS e WHERE e.transfer = t.id) <> 2
    OR NOT EXISTS (SELECT 1 FROM entries AS e WHERE e.transfer = t.id AND e.account = t.src AND e.amount = -t.amount)
    OR NOT EXISTS (SELECT 1 FROM entries AS e WHERE e.transfer = t.id AND e.account = t.dst AND e.amount = t.amount)
}

type Name = View where len(self) >= 1
  and len(self) <= 32
  and every_byte(v: self, keep: name_byte) else "1 to 32 of a-z, 0-9, - and _"
type Key = View where len(self) >= 1 and len(self) <= 64 else "1 to 64 bytes"
type Amount = Dec[2] where self >= 0.01 and self <= 1000000.00
type Memo = View where char_count(v: self) <= 140

type NewAccount { NewAccount(id: Name, external: Option[Bool]) }
type NewTransfer { NewTransfer(key: Key, from: Name, to: Name, amount: Amount, memo: Option[Memo]) }

type Account { Account(id: View, external: Bool, balance: Dec[2]) }
type Transfer { Transfer(
  id: Int,
  client: View,
  src: View,
  dst: View,
  amount: Dec[2],
  memo: View,
  at: Int
) }
type Entry { Entry(transfer: Int, amount: Dec[2], memo: View, at: Int) }
type Shown { Shown(id: View, external: Bool, balance: Dec[2], entries: List[Entry]) }
type Sent { Sent(id: Int, key: View, from: View, to: View, amount: Dec[2], memo: View, at: View) }
type Problem { Problem(error: View) }

fn name_byte(b: Int) -> Bool {
  is_lower(b) or is_digit(b) or b == 45 or b == 95
}

fn handle(raw: View, db: Sql, clock: Clock) -> Response {
  match request(raw) {
    Request(method: Get, path: "/") -> home()
    Request(method: Post, path: "/accounts", body) -> opened(body)
    Request(method: Get, path: "/accounts") -> buf()
      |> write_rows(rows: sql_all(row: Account, query: "SELECT * FROM accounts ORDER BY id"))
      |> respond_as(status: 200, content: Json)
      |> header(name: "cache-control", value: "no-store")
    Request(method: Get, path: "/accounts.csv") -> balances_csv()
    Request(method: Get, path: "/accounts/" ++ Name(id)) -> account(id)
    Request(method: Post, path: "/transfers", body) -> sent(body)
    Request(method: Get, path: "/transfers.csv") -> transfers_csv()
    _ -> problem(status: 404, error: "no such route")
  }
}

fn opened(body: View) -> Response {
  let Ok(value: NewAccount(id, external)) = decode(json: body, as: NewAccount) else {
    Err(error) -> problem(status: 400, error)
  }
  let outside = match external {
    Some(value: True) -> True
    _ -> False
  }
  match sql_first(
    row: Account,
    query: "INSERT INTO accounts(id, external) VALUES (:id, :outside) ON CONFLICT(id) \
        DO NOTHING RETURNING *",
    id,
    outside
  ) {
    Some(value) -> json(status: 201, value)
    None -> match sql_first(row: Account, query: "SELECT * FROM accounts WHERE id = :id", id) {
      Some(value: a) if a.external == outside -> json(status: 200, value: a)
      Some(value) -> problem(status: 409, error: "account \(id) exists, and is not that kind")
      None -> problem(status: 500, error: "the account is gone")
    }
  }
}

fn account(id: View) -> Response {
  let Some(value: Account(external, balance)) = sql_first(
    row: Account,
    query: "SELECT * FROM accounts WHERE id = :id",
    id
  ) else -> problem(status: 404, error: "no account \(id)")
  json(
    status: 200,
    value: Shown(
      id,
      external,
      balance,
      entries: entries(rows: sql_all(
        row: Entry,
        query: "SELECT e.transfer AS transfer, e.amount AS amount, t.memo AS memo, t.at AS at \
            FROM entries AS e JOIN transfers AS t ON t.id = e.transfer WHERE e.account = :id \
            ORDER BY e.transfer DESC LIMIT 100",
        id
      ))
    )
  )
    |> header(name: "cache-control", value: "no-store")
}

fn entries(rows: Rows[Entry]) -> List[Entry] {
  match next(rows) {
    Next(value, rest) -> Cons(head: value, tail: entries(rows: rest))
    End -> Nil
  }
}

fn sent(body: View) -> Response {
  let Ok(
    value: NewTransfer(key, from, to, amount, memo)
  ) = decode(json: body, as: NewTransfer) else {
    Err(error) -> problem(status: 400, error)
  }
  let note = match memo {
    Some(value) -> value
    None -> ""
  }
  let True = from != to else -> problem(status: 400, error: "to: another account than from")
  let Some(value: t) = sql_first(
    row: Transfer,
    query: "INSERT INTO transfers(client, src, dst, amount, memo, at) \
        SELECT :key, :from, :to, :amount, :note, :at WHERE EXISTS (SELECT 1 FROM accounts \
        WHERE id = :from) AND EXISTS (SELECT 1 FROM accounts WHERE id = :to) ON CONFLICT(client) \
        DO NOTHING RETURNING *",
    key,
    from,
    to,
    amount,
    note,
    at: now()
  ) else -> again(key, from, to, amount, note)
  let 1 = take(from, amount) else -> rollback(
    out: problem(status: 409, error: "\(from) has less than \(amount)")
  )
  // the transfer's row was made only if both accounts were there; the credit still reads its count, so a credit that
  // finds no account undoes the debit rather than lose the amount
  let 1 = sql_exec(
    query: "UPDATE accounts SET balance = balance + :amount WHERE id = :to",
    to,
    amount
  ) else -> rollback(
    out: problem(status: 404, error: "no account \(to) to credit")
  )
  let _ = sql_exec(
    query: "INSERT INTO entries(transfer, account, amount) \
        VALUES (:id, :from, -:amount), (:id, :to, :amount)",
    id: t.id,
    from,
    to,
    amount
  )
  shown_transfer(status: 201, t)
}

// out of an account: down to zero for one of ours, without a floor for an external one
fn take(from: View, amount: Dec[2]) -> Int {
  match sql_first(row: Account, query: "SELECT * FROM accounts WHERE id = :from", from) {
    Some(value: Account(external: True)) -> sql_exec(
      query: "UPDATE accounts SET balance = balance - :amount WHERE id = :from AND external = 1",
      from,
      amount,
      no_floor: True
    )
    _ -> sql_exec(
      query: "UPDATE accounts SET balance = balance - :amount WHERE id = :from AND external = 0 \
          AND balance >= :amount",
      from,
      amount
    )
  }
}

// the key was claimed: by this transfer (a retry), by another, or nothing was made (an account is missing)
fn again(key: View, from: View, to: View, amount: Dec[2], note: View) -> Response {
  match sql_first(row: Transfer, query: "SELECT * FROM transfers WHERE client = :key", key) {
    Some(value: t) if t.src == from
      and t.dst == to
      and t.amount == amount
      and t.memo == note -> shown_transfer(status: 200, t)
    Some(value) -> problem(status: 409, error: "key \(key) was used for another transfer")
    None -> problem(status: 404, error: "no such account: both \(from) and \(to) must exist")
  }
}

fn shown_transfer(status: Int, t: Transfer) -> Response {
  json(
    status,
    value: Sent(
      id: t.id,
      key: t.client,
      from: t.src,
      to: t.dst,
      amount: t.amount,
      memo: t.memo,
      at: iso(ms: t.at)
    )
  )
}

fn transfers_csv() -> Response {
  buf()
    |> append(view: "id,at,from,to,amount,memo,key\r ")
    |> csv_rows(rows: sql_all(row: Transfer, query: "SELECT * FROM transfers ORDER BY id"))
    |> respond_as(status: 200, content: Csv)
    |> header(name: "cache-control", value: "no-store")
    |> header(name: "content-disposition", value: "attachment; filename=transfers.csv")
}

fn csv_rows(out: Buf, rows: Rows[Transfer]) -> Buf {
  rows
    |> fold_rows(from: out, by: fn(o: Buf, t: Transfer) -> Buf {
      o
        |> append(view: "\(t.id),\(iso(ms: t.at)),\(t.src),\(t.dst),\(t.amount),")
        |> csv_field(text: t.memo)
        |> append(view: ",")
        |> csv_field(text: t.client)
        |> append(view: "\r\n")
    })
}

fn balances_csv() -> Response {
  buf()
    |> append(view: "account,external,balance\r ")
    |> balance_rows(rows: sql_all(row: Account, query: "SELECT * FROM accounts ORDER BY id"))
    |> respond_as(status: 200, content: Csv)
    |> header(name: "cache-control", value: "no-store")
}

fn balance_rows(out: Buf, rows: Rows[Account]) -> Buf {
  rows
    |> fold_rows(from: out, by: fn(o: Buf, a: Account) -> Buf {
      o |> append(view: "\(a.id),\(yes_no(a.external)),\(a.balance)\r\n")
    })
}

fn yes_no(b: Bool) -> View {
  match b {
    True -> "yes"
    False -> "no"
  }
}

// a CSV field (RFC 4180): as it is, or in double quotes, each quote doubled, when it holds a comma, a quote, a CR
// or an LF; a field that starts with = + - or @ gets a ' first, so a spreadsheet does not run it as a formula
//
//   > freeze(buf: csv_field(out: buf(), text: "rent"))
//   "rent"
//   > freeze(buf: csv_field(out: buf(), text: "rent, march"))
//   "\"rent, march\""
//   > freeze(buf: csv_field(out: buf(), text: "a \"b\""))
//   "\"a \"\"b\"\"\""
//   > freeze(buf: csv_field(out: buf(), text: "=1+1"))
//   "'=1+1"
fn csv_field(out: Buf, text: View) -> Buf {
  let safe = match {
    len(text) > 0
      and (text[0] == 61 or text[0] == 43 or text[0] == 45 or text[0] == 64) -> "'" ++ text
    else -> text
  }
  match {
    needs_quotes(v: safe, at: 0) -> quoted(out: out |> push(byte: 34), v: safe, at: 0)
      |> push(byte: 34)
    else -> out |> append(view: safe)
  }
}

fn needs_quotes(v: View, at: Int) -> Bool {
  match {
    at >= len(v) -> False
    v[at] == 44 or v[at] == 34 or v[at] == 10 or v[at] == 13 -> True
    else -> needs_quotes(v, at: at + 1)
  }
}

fn quoted(out: Buf, v: View, at: Int) -> Buf {
  match {
    at >= len(v) -> out
    v[at] == 34 -> quoted(out: out |> push(byte: 34) |> push(byte: 34), v, at: at + 1)
    else -> quoted(out: out |> push(byte: v[at]), v, at: at + 1)
  }
}

// milliseconds since 1970 as a UTC time, to the second (H. Hinnant's civil_from_days)
//
//   > iso(ms: 0)
//   "1970-01-01T00:00:00Z"
//   > iso(ms: 1798761599000)
//   "2026-12-31T23:59:59Z"
//   > iso(ms: 951782400000)
//   "2000-02-29T00:00:00Z"
fn iso(ms: Int) -> View {
  let s = ms / 1000
  let z = s / 86400 + 719468
  let era = z / 146097
  let doe = z - era * 146097
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp = (5 * doy + 2) / 153
  let d = doy - (153 * mp + 2) / 5 + 1
  let m = match {
    mp < 10 -> mp + 3
    else -> mp - 9
  }
  let y = yoe + era * 400 + match {
    m <= 2 -> 1
    else -> 0
  }
  let t = s % 86400
  "\(y)-\(two(m))-\(two(d))T\(two(t / 3600)):\(two(t / 60 % 60)):\(two(t % 60))Z"
}

fn two(n: Int) -> View {
  match {
    n < 10 -> "0\(n)"
    else -> "\(n)"
  }
}

fn problem(status: Int, error: View) -> Response {
  json(status, value: Problem(error))
}

fn home() -> Response {
  let out = buf()
    |> append(view: "<!doctype html><html lang=en><meta charset=utf-8>")
    |> append(view: "<meta name=viewport \
        content=\"width=device-width,initial-scale=1\"><title>ledger</title>")
    |> append(
      view: "<style>:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fbfbf8;--mute:#6b6b6b;"
    )
    |> append(
      view: "--line:#e2e0d8}@media (prefers-color-scheme:dark){:root{--fg:#e8e6e1;--bg:#151514;"
    )
    |> append(
      view: "--mute:#9a978f;--line:#33322d}}body{margin:0 auto;max-width:760px;padding:24px 16px;"
    )
    |> append(view: "background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}")
    |> append(view: "h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin-top:28px}")
    |> append(view: ".meta{color:var(--mute);font-size:14px}a{color:inherit}")
    |> append(
      view: ".scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}"
    )
    |> append(view: "td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}")
    |> append(view: ".n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}")
    |> append(view: "footer{margin-top:32px;color:var(--mute);font-size:13px}</style>")
    |> append(view: "<h1>ledger</h1><p class=meta>Play money, double entry: every transfer is two ")
    |> append(view: "entries that sum to zero. <a href=\"accounts.csv\">balances.csv</a> · ")
    |> append(
      view: "<a href=\"transfers.csv\">transfers.csv</a> · <a href=\"accounts\">JSON</a></p>"
    )
    |> append(
      view: "<h2>Balances</h2><div class=scroll><table><tr><th>account<th class=n>balance</tr>"
    )
  let balances = balance_cells(
    out,
    rows: sql_all(row: Account, query: "SELECT * FROM accounts ORDER BY id")
  )
    |> append(
      view: "</table></div><h2>Latest transfers</h2><div class=scroll><table><tr><th>#<th>at"
    )
    |> append(view: "<th>from<th>to<th class=n>amount<th>memo</tr>")
  transfer_cells(
    out: balances,
    rows: sql_all(row: Transfer, query: "SELECT * FROM transfers ORDER BY id DESC LIMIT 25")
  )
    |> append(view: "</table></div><footer>A small program written in <a href=\"/\">Tape</a> · <a \
        href=\"https://github.com/ivarvong/tape/blob/main/apps/products/ledger/ledger.tape\">source</a></footer></html>")
    |> respond_as(status: 200, content: Html)
    |> header(name: "cache-control", value: "no-store")
}

fn balance_cells(out: Buf, rows: Rows[Account]) -> Buf {
  rows
    |> fold_rows(from: out, by: fn(o: Buf, a: Account) -> Buf {
      o
        |> append(view: "<tr><td>")
        |> write_html(text: a.id)
        |> append(view: match a.external {
          True -> " <span class=meta>external</span>"
          False -> ""
        })
        |> append(view: "<td class=n>\(a.balance)</tr>")
    })
}

fn transfer_cells(out: Buf, rows: Rows[Transfer]) -> Buf {
  rows
    |> fold_rows(from: out, by: fn(o: Buf, t: Transfer) -> Buf {
      o
        |> append(view: "<tr><td>\(t.id)<td class=meta>\(iso(ms: t.at))<td>")
        |> write_html(text: t.src)
        |> append(view: "<td>")
        |> write_html(text: t.dst)
        |> append(view: "<td class=n>\(t.amount)<td>")
        |> write_html(text: t.memo)
        |> append(view: "</tr>")
    })
}
