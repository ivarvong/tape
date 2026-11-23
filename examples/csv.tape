// csv.tape: aggregate a CSV body by country. No database: a pure function from bytes to bytes, built on the
// immutable Map in std. Same behaviour as bench/csv-baseline.ts.

type Stat { Stat(count: Int, total: Int, max: Int) }
type Tally { Tally(rows: Int, rejected: Int, by: Map[Stat]) }

fn handle(raw: View) -> Buf {
  match strip(line: until(v: raw, byte: 10)) {
    "ts,user,amount,country" -> report(
      tally: lines(rest: after(v: raw, byte: 10), tally: Tally(rows: 0, rejected: 0, by: Empty))
    )
    _ -> append(buf: buf(), view: "{\"error\":\"header\"}")
  }
}

fn lines(rest: View, tally: Tally) -> Tally {
  match {
    len(rest) == 0 -> tally
    else -> lines(
      rest: after(v: rest, byte: 10),
      tally: row(line: strip(line: until(v: rest, byte: 10)), tally)
    )
  }
}

fn strip(line: View) -> View {
  match {
    len(line) == 0 -> line
    line[len(line) - 1] == 13 -> slice(v: line, from: 0, to: len(line) - 1)
    else -> line
  }
}

fn row(line: View, tally: Tally) -> Tally {
  let ts = until(v: line, byte: 44)
  let past_ts = after(v: line, byte: 44)
  let user = until(v: past_ts, byte: 44)
  let past_user = after(v: past_ts, byte: 44)
  let amount = until(v: past_user, byte: 44)
  let country = after(v: past_user, byte: 44)
  match {
    len(line) == 0 -> tally
    commas(v: line, at: 0, acc: 0) == 3
      and digits(v: ts, most: 19)
      and len(user) > 0
      and number(v: amount)
      and country_code(v: country) -> accept(tally, country, amount: signed(v: amount))
    else -> Tally(rows: tally.rows, rejected: tally.rejected + 1, by: tally.by)
  }
}

fn accept(tally: Tally, country: View, amount: Int) -> Tally {
  Tally(
    rows: tally.rows + 1,
    rejected: tally.rejected,
    by: put(
      map: tally.by,
      key: country,
      value: bump(found: get(map: tally.by, key: country), amount)
    )
  )
}

fn bump(found: Option[Stat], amount: Int) -> Stat {
  match found {
    Some(value: Stat(count, total, max)) if amount > max -> Stat(
      count: count + 1,
      total: total + amount,
      max: amount
    )
    Some(value: Stat(count, total, max)) -> Stat(count: count + 1, total: total + amount, max)
    None -> Stat(count: 1, total: amount, max: amount)
  }
}

// ---------- fields ----------

fn commas(v: View, at: Int, acc: Int) -> Int {
  match {
    at == len(v) -> acc
    v[at] == 44 -> commas(v, at: at + 1, acc: acc + 1)
    else -> commas(v, at: at + 1, acc)
  }
}

fn digits(v: View, most: Int) -> Bool {
  len(v) >= 1 and len(v) <= most and digits_end(v, at: 0) == len(v)
}

fn number(v: View) -> Bool {
  match {
    len(v) == 0 -> False
    v[0] == 45 -> digits(v: slice(v, from: 1, to: len(v)), most: 12)
    else -> digits(v, most: 12)
  }
}

fn signed(v: View) -> Int {
  match {
    v[0] == 45 -> 0 - natural(v, at: 1, acc: 0)
    else -> natural(v, at: 0, acc: 0)
  }
}

fn natural(v: View, at: Int, acc: Int) -> Int {
  match {
    at == len(v) -> acc
    else -> natural(v, at: at + 1, acc: acc * 10 + v[at] - 48)
  }
}

fn country_code(v: View) -> Bool {
  match {
    len(v) != 2 -> False
    else -> v[0] >= 65 and v[0] <= 90 and v[1] >= 65 and v[1] <= 90
  }
}

// ---------- the response ----------

fn report(tally: Tally) -> Buf {
  let head = write_int(
    out: append(
      buf: write_int(out: append(buf: buf(), view: "{\"rows\":"), value: tally.rows),
      view: ",\"rejected\":"
    ),
    value: tally.rejected
  )
  append(
    buf: countries(out: append(buf: head, view: ",\"countries\":["), map: tally.by),
    view: "]}"
  )
}

fn countries(out: Buf, map: Map[Stat]) -> Buf {
  walk(start: size(out), out, map)
}

// In key order: the left side, this entry, the right side.
fn walk(start: Int, out: Buf, map: Map[Stat]) -> Buf {
  match map {
    Empty -> out
    Node(left, key, value, right) -> walk(
      start,
      out: entry(start, out: walk(start, out, map: left), key, value),
      map: right
    )
  }
}

fn entry(start: Int, out: Buf, key: View, value: Stat) -> Buf {
  match {
    size(out) == start -> item(out, key, value)
    else -> item(out: push(buf: out, byte: 44), key, value)
  }
}

fn item(out: Buf, key: View, value: Stat) -> Buf {
  let country = append(
    buf: append(buf: append(buf: out, view: "{\"country\":\""), view: key),
    view: "\",\"count\":"
  )
  let total = write_int(
    out: append(buf: write_int(out: country, value: value.count), view: ",\"total\":"),
    value: value.total
  )
  push(buf: write_int(out: append(buf: total, view: ",\"max\":"), value: value.max), byte: 125)
}
