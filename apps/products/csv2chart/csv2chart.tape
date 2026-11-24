// csv2chart.tape: POST a CSV, get an SVG line chart back. The first row names the columns: the first column is x
// and every other column is a series (at most 8). An x that is a number places its row on a number axis; when any
// x is not a number, the rows are evenly spaced and the x texts label them. An empty cell is a gap in its line.
// `?title=…` puts a title on top. GET /demo draws a built-in sample, and GET / is a page about it.
//
// The SVG is built from numbers and escaped labels only: every coordinate is computed, and every text from the
// CSV (a column's name, an x label, the title) goes through write_html, so nothing in a CSV can become markup.

type Problem { Problem(error: View) }

// One row as read: its x as text, as a number when it is one, and each series' value.
type Row { Row(label: View, x: Option[Float], values: List[Option[Float]]) }
type Table { Table(names: List[View], rows: List[Row]) }

// What the axes span, and the step between ticks as m * 10^e (so a tick's label is written exactly).
type Axis { Axis(lo: Float, hi: Float, m: Int, e: Int, from: Int, to: Int) }

fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/") -> home()
    Request(method: "GET", path: "/demo") -> drawn(
      text: sample(),
      title: Some(value: "Monthly visits, 2026")
    )
    Request(method: "POST", path: "/", query, body) -> drawn(text: body, title: title_of(query))
    Request(
      method: "POST",
      path: "/chart",
      query,
      body
    ) -> drawn(text: body, title: title_of(query))
    _ -> problem(status: 404, error: "no such route: POST a CSV to / or GET /demo")
  }
}

fn title_of(query: Option[View]) -> Option[View] {
  let Some(value: q) = query else -> None
  match form_field(body: q, name: "title") {
    Some(value: t) if len(t) >= 1 and len(t) <= 120 -> Some(value: t)
    _ -> None
  }
}

fn problem(status: Int, error: View) -> Buf {
  respond_as(status, content: Json) |> write_json(value: Problem(error))
}

fn sample() -> View {
  "month,docs,playground,api\nJan,120,40,12\nFeb,180,52,20\nMar,260,75,31\nApr,240,96,45\nMay,330,130,60\nJun,410,170,88\nJul,390,160,97\nAug,450,205,120\nSep,520,240,150\nOct,610,300,170\nNov,700,350,\n"
}

// ---------- reading the CSV ----------

fn drawn(text: View, title: Option[View]) -> Buf {
  match table(text) {
    Ok(value: t) -> chart(t, title)
    Err(error) -> problem(status: 400, error)
  }
}

fn table(text: View) -> Result[Table, View] {
  let True = len(text) > 0 else -> Err(error: "empty: send a CSV whose first row names the columns")
  let header = line_end(v: text, at: 0)
  let names = fields(v: slice(text, from: 0, to: header), at: 0, out: Nil) |> reverse
  let n = length(list: names)
  let True = n >= 2 else -> Err(error: "line 1: at least two columns, x and a series")
  let True = n <= 9 else -> Err(error: "line 1: at most 8 series")
  let rows = read_rows(text, at: next_line(v: text, at: header), line: 2, n, out: Nil)
  match rows {
    Ok(value: Nil) -> Err(error: "no rows after the first")
    Ok(value: list) -> {
      let True = length(list) <= 5000 else -> Err(error: "at most 5000 rows")
      Ok(value: Table(names, rows: reverse(list)))
    }
    Err(error) -> Err(error)
  }
}

fn read_rows(text: View, at: Int, line: Int, n: Int, out: List[Row]) -> Result[List[Row], View] {
  match {
    at >= len(text) -> Ok(value: out)
    else -> {
      let e = line_end(v: text, at)
      let cells = fields(v: slice(text, from: at, to: e), at: 0, out: Nil) |> reverse
      match cells {
        Cons(head: "", tail: Nil) -> read_rows(
          text,
          at: next_line(v: text, at: e),
          line: line + 1,
          n,
          out
        )
        Cons(
          head: label,
          tail: values
        ) if length(list: cells) == n -> match numbers(values, out: Nil) {
          Some(value: vs) -> read_rows(
            text,
            at: next_line(v: text, at: e),
            line: line + 1,
            n,
            out: Cons(head: Row(label, x: number(t: label), values: reverse(list: vs)), tail: out)
          )
          None -> Err(error: "line \(line): a value that is not a number from -1e12 to 1e12")
        }
        _ -> Err(error: "line \(line): \(length(list: cells)) fields, but the first line has \(n)")
      }
    }
  }
}

// Each cell as a number, None for an empty one; None for the whole row when a cell is neither.
fn numbers(cells: List[View], out: List[Option[Float]]) -> Option[List[Option[Float]]] {
  match cells {
    Nil -> Some(value: out)
    Cons(head: c, tail) if trimmed(t: c) == "" -> numbers(
      cells: tail,
      out: Cons(head: None, tail: out)
    )
    Cons(head: c, tail) -> match number(t: c) {
      Some(value: x) -> numbers(cells: tail, out: Cons(head: Some(value: x), tail: out))
      None -> None
    }
  }
}

// A cell as a number: a sign, digits, a point and an exponent, spaces around it allowed.
//
//   > number(t: " 12.5 ") == None
//   False
//   > number(t: "0x10")
//   None
//   > number(t: "")
//   None
fn number(t: View) -> Option[Float] {
  let s = trimmed(t)
  match {
    len(s) >= 1 and every_byte(v: s, keep: number_byte) -> bounded(found: parse_float(text: s))
    else -> None
  }
}

fn bounded(found: Option[Float]) -> Option[Float] {
  match found {
    Some(value: x) if abs(x) <= 1000000000000f -> found
    _ -> None
  }
}

fn number_byte(b: Int) -> Bool {
  is_digit(b) or b == 46 or b == 45 or b == 43 or b == 101 or b == 69
}

fn trimmed(t: View) -> View {
  let a = skip_spaces(v: t, at: 0)
  slice(t, from: a, to: back_spaces(v: t, at: len(t), least: a))
}

fn skip_spaces(v: View, at: Int) -> Int {
  match {
    at < len(v) and (v[at] == 32 or v[at] == 9) -> skip_spaces(v, at: at + 1)
    else -> at
  }
}

fn back_spaces(v: View, at: Int, least: Int) -> Int {
  match {
    at > least and (v[at - 1] == 32 or v[at - 1] == 9) -> back_spaces(v, at: at - 1, least)
    else -> at
  }
}

// Where the line from `at` ends: at its line feed (or the carriage return before it), or at the end.
fn line_end(v: View, at: Int) -> Int {
  let e = find(v, byte: 10, at)
  match {
    e > at and v[e - 1] == 13 -> e - 1
    else -> e
  }
}

fn next_line(v: View, at: Int) -> Int {
  match {
    at < len(v) and v[at] == 13 -> at + 2
    else -> at + 1
  }
}

// The fields of one line, last first. A field in double quotes may hold commas, and "" for a quote.
//
//   > fields(v: "a,\"b, c\",\"say \"\"hi\"\"\"", at: 0, out: Nil) |> reverse
//   Cons(head: "a", tail: Cons(head: "b, c", tail: Cons(head: "say \"hi\"", tail: Nil)))
//   > fields(v: "1,,3", at: 0, out: Nil) |> reverse
//   Cons(head: "1", tail: Cons(head: "", tail: Cons(head: "3", tail: Nil)))
fn fields(v: View, at: Int, out: List[View]) -> List[View] {
  match {
    at < len(v) and v[at] == 34 -> quoted(v, at: at + 1, text: buf(), out)
    else -> {
      let e = find(v, byte: 44, at)
      match {
        e >= len(v) -> Cons(head: trimmed(t: slice(v, from: at, to: e)), tail: out)
        else -> fields(
          v,
          at: e + 1,
          out: Cons(head: trimmed(t: slice(v, from: at, to: e)), tail: out)
        )
      }
    }
  }
}

fn quoted(v: View, at: Int, text: Buf, out: List[View]) -> List[View] {
  match {
    at >= len(v) -> Cons(head: freeze(buf: text), tail: out)
    v[at] == 34
      and at + 1 < len(v)
      and v[at + 1] == 34 -> quoted(v, at: at + 2, text: text |> push(byte: 34), out)
    v[at] == 34 -> after_quote(v, at: at + 1, out: Cons(head: freeze(buf: text), tail: out))
    else -> quoted(v, at: at + 1, text: text |> push(byte: v[at]), out)
  }
}

fn after_quote(v: View, at: Int, out: List[View]) -> List[View] {
  let e = find(v, byte: 44, at)
  match {
    e >= len(v) -> out
    else -> fields(v, at: e + 1, out)
  }
}

// ---------- scales ----------

// A nice axis over lo..hi: about five steps of 1, 2 or 5 times a power of ten, the ends on a step.
//
//   > axis(lo: 0f, hi: 700f)
//   Axis(m: 1, e: 2, from: 0, to: 7)
//   > axis(lo: 0.12f, hi: 0.49f)
//   Axis(m: 5, e: -2, from: 2, to: 10)
//   > axis(lo: 3f, hi: 3f)
//   Axis(m: 5, e: -1, from: 4, to: 8)
fn axis(lo: Float, hi: Float) -> Axis {
  // at least a millionth of the larger end (and of 1), so a step is never below 10^-8 nor a tick past 10^8; a
  // flatter range is drawn 1 (or a tenth of its value) either side
  let least = max(a: 1f, b: max(a: abs(lo), b: abs(hi))) / 1000000f
  let span = match {
    hi - lo >= least -> hi - lo
    else -> 2f * max(a: 1f, b: abs(lo) / 10f)
  }
  let low = match {
    hi - lo >= least -> lo
    else -> lo - max(a: 1f, b: abs(lo) / 10f)
  }
  let raw = span / 5f
  let e = trunc(floor(log(raw) / log(10f)))
  let f = raw / pow(x: 10f, y: float(e))
  let m = match {
    f < 1.5f -> 1
    f < 3.5f -> 2
    f < 7.5f -> 5
    else -> 10
  }
  let step = float(m) * pow(x: 10f, y: float(e))
  let from = trunc(floor(low / step + 0.000001f))
  let to = trunc(ceil((low + span) / step - 0.000001f))
  Axis(lo: float(from) * step, hi: float(to) * step, m, e, from, to)
}

// The label of tick k: k * m * 10^e, written exactly.
//
//   > tick_text(units: 25, e: -1)
//   "2.5"
//   > tick_text(units: -5, e: -2)
//   "-0.05"
//   > tick_text(units: 12, e: 3)
//   "12000"
fn tick_text(units: Int, e: Int) -> View {
  match {
    e >= 0 -> "\(units * ten(n: e))"
    units < 0 -> "-" ++ tick_text(units: -units, e)
    else -> {
      let p = ten(n: -e)
      let frac = "\(p + units % p)"
      "\(units / p).\(slice(frac, from: 1, to: len(frac)))"
    }
  }
}

fn ten(n: Int) -> Int {
  range(from: 0, to: n) |> fold(from: 1, by: fn(acc: Int, i: Int) -> Int { acc * 10 })
}

// ---------- the chart ----------

// The plot area: x from 64 to 700, y from 48 to 340, in a 720 by 420 picture (the legend below it).
fn px(a: Axis, x: Float) -> Float {
  64f + (x - a.lo) / (a.hi - a.lo) * 636f
}

fn py(a: Axis, y: Float) -> Float {
  340f - (y - a.lo) / (a.hi - a.lo) * 292f
}

fn r1(x: Float) -> Float {
  floor(x * 10f + 0.5f) / 10f
}

fn color(i: Int) -> View {
  match i % 8 {
    0 -> "#2563eb"
    1 -> "#dc2626"
    2 -> "#16a34a"
    3 -> "#d97706"
    4 -> "#7c3aed"
    5 -> "#0891b2"
    6 -> "#db2777"
    _ -> "#4b5563"
  }
}

// Every x is a number: a number axis. Otherwise the rows' positions, labelled by their text.
fn numeric(rows: List[Row]) -> Bool {
  match rows {
    Nil -> True
    Cons(head: Row(x: None)) -> False
    Cons(tail) -> numeric(rows: tail)
  }
}

fn xs(rows: List[Row], numbered: Bool, i: Int, out: List[Float]) -> List[Float] {
  match rows {
    Nil -> reverse(list: out)
    Cons(head: Row(x: Some(value: x)), tail) if numbered -> xs(
      rows: tail,
      numbered,
      i: i + 1,
      out: Cons(head: x, tail: out)
    )
    Cons(tail) -> xs(rows: tail, numbered, i: i + 1, out: Cons(head: float(i), tail: out))
  }
}

type Range { Range(lo: Float, hi: Float, any: Bool) }

fn widen(r: Range, x: Float) -> Range {
  match r {
    Range(any: False) -> Range(lo: x, hi: x, any: True)
    Range(lo, hi) -> Range(lo: min(a: lo, b: x), hi: max(a: hi, b: x), any: True)
  }
}

fn values_range(rows: List[Row], r: Range) -> Range {
  match rows {
    Nil -> r
    Cons(head: Row(values), tail) -> values_range(rows: tail, r: fold(list: values, from: r, by: fn(
      acc: Range,
      v: Option[Float]
    ) -> Range {
        match v {
          Some(value: x) -> widen(r: acc, x)
          None -> acc
        }
    }))
  }
}

fn nth(list: List[Option[Float]], i: Int) -> Option[Float] {
  match list {
    Cons(head, tail) if i == 0 -> head
    Cons(tail) -> nth(list: tail, i: i - 1)
    Nil -> None
  }
}

fn chart(t: Table, title: Option[View]) -> Buf {
  respond_as(status: 200, content: Svg)
    |> header(name: "cache-control", value: "no-store")
    |> drawing(t, title)
}

// The chart as an <svg> element: the whole of an SVG answer, or a figure inside a page.
fn drawing(out: Buf, t: Table, title: Option[View]) -> Buf {
  let Table(names, rows) = t
  let numbered = numeric(rows)
  let x = xs(rows, numbered, i: 0, out: Nil)
  let xr = fold(list: x, from: Range(
    lo: 0f,
    hi: 0f,
    any: False
  ), by: fn(acc: Range, v: Float) -> Range {
      widen(r: acc, x: v)
  })
  let yr = values_range(rows, r: Range(lo: 0f, hi: 0f, any: False))
  let xa = match numbered {
    True -> axis(lo: xr.lo, hi: xr.hi)
    False -> Axis(lo: -0.5f, hi: xr.hi + 0.5f, m: 1, e: 0, from: 0, to: trunc(xr.hi))
  }
  let ya = match yr.any {
    True -> axis(lo: min(a: yr.lo, b: 0f), hi: yr.hi)
    False -> axis(lo: 0f, hi: 1f)
  }
  let series = length(list: names) - 1
  out
    |> append(view: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 720 \
        \(400 + 22 * ((series + 3) / 4))\" font-family=\"system-ui,sans-serif\" \
        font-size=\"12\"><rect width=\"100%\" height=\"100%\" fill=\"#fff\"/>")
    |> titled(title)
    |> y_ticks(a: ya, k: ya.from)
    |> x_ticks(
    a: xa,
    k: xa.from,
    numbered,
    rows,
    every: max(a: 1, b: (length(list: rows) + 9) / 10)
  )
    |> append(view: "<line x1=\"64\" y1=\"340\" x2=\"700\" y2=\"340\" stroke=\"#111\"/><line \
        x1=\"64\" y1=\"48\" x2=\"64\" y2=\"340\" stroke=\"#111\"/>")
    |> lines(rows, x, xa, ya, i: 0, n: series)
    |> legend(names: tail_of(names), i: 0)
    |> append(view: "</svg>")
}

fn tail_of(names: List[View]) -> List[View] {
  match names {
    Cons(tail) -> tail
    Nil -> Nil
  }
}

fn titled(out: Buf, title: Option[View]) -> Buf {
  match title {
    Some(value: t) -> out
      |> append(view: "<text x=\"64\" y=\"28\" font-size=\"16\" font-weight=\"600\" fill=\"#111\">")
      |> write_html(text: t)
      |> append(view: "</text>")
    None -> out
  }
}

fn y_ticks(out: Buf, a: Axis, k: Int) -> Buf {
  match {
    k > a.to -> out
    else -> {
      let y = r1(x: py(a, y: float(k * a.m) * pow(x: 10f, y: float(a.e))))
      out
        |> append(view: "<line x1=\"64\" y1=\"\(y)\" x2=\"700\" y2=\"\(y)\" stroke=\"#e5e7eb\"/>")
        |> append(view: "<text x=\"58\" y=\"\(y + 4f)\" text-anchor=\"end\" fill=\"#374151\">")
        |> append(view: tick_text(units: k * a.m, e: a.e))
        |> append(view: "</text>")
        |> y_ticks(a, k: k + 1)
    }
  }
}

fn x_ticks(out: Buf, a: Axis, k: Int, numbered: Bool, rows: List[Row], every: Int) -> Buf {
  match numbered {
    True -> match {
      k > a.to -> out
      else -> {
        let x = r1(x: px(a, x: float(k * a.m) * pow(x: 10f, y: float(a.e))))
        out
          |> append(view: "<line x1=\"\(x)\" y1=\"340\" x2=\"\(x)\" y2=\"345\" stroke=\"#111\"/>")
          |> append(view: "<text x=\"\(x)\" y=\"360\" text-anchor=\"middle\" fill=\"#374151\">")
          |> append(view: tick_text(units: k * a.m, e: a.e))
          |> append(view: "</text>")
          |> x_ticks(a, k: k + 1, numbered, rows, every)
      }
    }
    False -> labels(out, a, rows, i: 0, every)
  }
}

fn labels(out: Buf, a: Axis, rows: List[Row], i: Int, every: Int) -> Buf {
  match rows {
    Nil -> out
    Cons(head: Row(label), tail) if i % every == 0 -> {
      let x = r1(x: px(a, x: float(i)))
      out
        |> append(view: "<line x1=\"\(x)\" y1=\"340\" x2=\"\(x)\" y2=\"345\" stroke=\"#111\"/>")
        |> append(view: "<text x=\"\(x)\" y=\"360\" text-anchor=\"middle\" fill=\"#374151\">")
        |> write_html(text: short(t: label))
        |> append(view: "</text>")
        |> labels(a, rows: tail, i: i + 1, every)
    }
    Cons(tail) -> labels(out, a, rows: tail, i: i + 1, every)
  }
}

// A label of at most 14 characters, cut with an ellipsis at a character's start (never inside a UTF-8 sequence).
//
//   > short(t: "monthly")
//   "monthly"
//   > short(t: "ééééééééééééééé")
//   "ééééééééééééé…"
fn short(t: View) -> View {
  match {
    char_count(v: t) <= 14 -> t
    else -> slice(t, from: 0, to: char_start(v: t, at: 0, chars: 13)) ++ "…"
  }
}

// The byte where character number `chars` (from 0) starts.
fn char_start(v: View, at: Int, chars: Int) -> Int {
  match {
    at >= len(v) -> at
    v[at] >= 128 and v[at] < 192 -> char_start(v, at: at + 1, chars)
    chars == 0 -> at
    else -> char_start(v, at: at + 1, chars: chars - 1)
  }
}

fn lines(out: Buf, rows: List[Row], x: List[Float], xa: Axis, ya: Axis, i: Int, n: Int) -> Buf {
  match {
    i >= n -> out
    else -> out
      |> append(view: "<path fill=\"none\" stroke=\"\(color(i))\" stroke-width=\"2\" \
          stroke-linejoin=\"round\" d=\"")
      |> path(rows, x, xa, ya, i, pen: False)
      |> append(view: "\"/>")
      |> dots(rows, x, xa, ya, i)
      |> lines(rows, x, xa, ya, i: i + 1, n)
  }
}

// The line of series i: M at the first point after a gap, L after that.
fn path(out: Buf, rows: List[Row], x: List[Float], xa: Axis, ya: Axis, i: Int, pen: Bool) -> Buf {
  match rows {
    Cons(head: Row(values), tail: rest) -> match x {
      Cons(head: xv, tail: xr) -> match nth(list: values, i) {
        Some(value: y) -> out |> append(view: match pen {
          True -> "L"
          False -> "M"
        }) |> append(view: "\(r1(x: px(a: xa, x: xv))) \(r1(x: py(a: ya, y)))") |> path(
          rows: rest,
          x: xr,
          xa,
          ya,
          i,
          pen: True
        )
        None -> path(out, rows: rest, x: xr, xa, ya, i, pen: False)
      }
      Nil -> out
    }
    Nil -> out
  }
}

// A dot at each point when there are few enough to see.
fn dots(out: Buf, rows: List[Row], x: List[Float], xa: Axis, ya: Axis, i: Int) -> Buf {
  match {
    length(list: rows) > 60 -> out
    else -> dot_each(out, rows, x, xa, ya, i)
  }
}

fn dot_each(out: Buf, rows: List[Row], x: List[Float], xa: Axis, ya: Axis, i: Int) -> Buf {
  match rows {
    Cons(head: Row(values), tail: rest) -> match x {
      Cons(head: xv, tail: xr) -> match nth(list: values, i) {
        Some(value: y) -> out
          |> append(view: "<circle cx=\"\(r1(x: px(a: xa, x: xv)))\" \
              cy=\"\(r1(x: py(a: ya, y)))\" r=\"3\" fill=\"\(color(i))\"/>")
          |> dot_each(rows: rest, x: xr, xa, ya, i)
        None -> dot_each(out, rows: rest, x: xr, xa, ya, i)
      }
      Nil -> out
    }
    Nil -> out
  }
}

// Four to a row below the plot: a swatch and the column's name.
fn legend(out: Buf, names: List[View], i: Int) -> Buf {
  match names {
    Nil -> out
    Cons(head: name, tail) -> {
      let x = 64 + i % 4 * 160
      let y = 392 + i / 4 * 22
      out
        |> append(view: "<rect x=\"\(x)\" y=\"\(y - 9)\" width=\"14\" height=\"4\" rx=\"2\" \
            fill=\"\(color(i))\"/>")
        |> append(view: "<text x=\"\(x + 20)\" y=\"\(y - 3)\" fill=\"#111\">")
        |> write_html(text: short(t: name))
        |> append(view: "</text>")
        |> legend(names: tail, i: i + 1)
    }
  }
}

// ---------- the page ----------

// The sample, drawn into the page: the public route's CSP lets a page load images only from data: URLs, so an
// <img src=demo> of the program's own SVG shows nothing.
fn demo_figure(out: Buf) -> Buf {
  match table(text: sample()) {
    Ok(value: t) -> out |> drawing(t, title: Some(value: "Monthly visits, 2026"))
    Err(error) -> out |> write_html(text: error)
  }
}

fn home() -> Buf {
  respond_as(status: 200, content: Html)
    |> append(view: "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport \
        content=\"width=device-width,initial-scale=1\"><title>csv2chart</title><style>:root{color-scheme:light dark;--fg:#1d1f23;--mute:#626873;--bg:#fbfbfa;--line:#e3e4e6}@media(prefers-color-scheme:dark){:root{--fg:#e8e9eb;--mute:#9aa0aa;--bg:#15171a;--line:#30343a}}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}main{max-width:48rem;margin:0 auto;padding:2rem 1rem}figure{margin:1rem 0}figure svg{width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:8px}pre{font:13px/1.45 ui-monospace,Menlo,monospace;overflow-x:auto;border:1px solid var(--line);border-radius:8px;padding:.75rem}.mute{color:var(--mute)}</style><main><h1>csv2chart</h1><p>POST a CSV, get an SVG line chart: the first column is x, every other column a line (up to 8). An x that is not a number makes the rows evenly spaced and labelled; an empty cell is a gap.</p><figure role=img aria-label=\"a sample chart: monthly visits to docs, playground and api\">")
    |> demo_figure
    |> append(view: "</figure><pre>curl --data-binary @data.csv \
        'https://tape.ivar.workers.dev/p/demo/csv2chart/?title=My+chart' -o chart.svg</pre><p \
        class=mute>Written in Tape: the CSV is read, scaled and drawn in the program; labels are \
        escaped, so nothing in a CSV becomes markup.</p></main></html>")
}
