// words.tape: count the words in a text with the immutable Map. Each step replaces one entry (put_with: one walk
// down the tree); because nothing else can see the old map, its memory is reused and the loop allocates almost nothing.

fn handle(raw: View) -> Response {
  counted(raw) |> respond_as(status: 200, content: Json)
}

fn counted(raw: View) -> Buf {
  report(counts: words(rest: raw, counts: Empty))
}

fn words(rest: View, counts: Map[Int]) -> Map[Int] {
  let start = first_letter(v: rest, at: 0)
  let end = word_end(v: rest, at: start)
  match {
    start == len(rest) -> counts
    else -> words(
      rest: slice(v: rest, from: end, to: len(rest)),
      counts: put_with(
        map: counts,
        key: slice(v: rest, from: start, to: end),
        from: 0,
        by: plus_one
      )
    )
  }
}

fn plus_one(n: Int) -> Int {
  n + 1
}

fn letter(byte: Int) -> Bool {
  (byte >= 97 and byte <= 122) or (byte >= 65 and byte <= 90)
}

fn first_letter(v: View, at: Int) -> Int {
  match {
    at == len(v) -> at
    letter(byte: v[at]) -> at
    else -> first_letter(v, at: at + 1)
  }
}

fn word_end(v: View, at: Int) -> Int {
  match {
    at == len(v) -> at
    letter(byte: v[at]) -> word_end(v, at: at + 1)
    else -> at
  }
}

fn report(counts: Map[Int]) -> Buf {
  let open = append(
    buf: write_int(out: append(buf: buf(), view: "{\"distinct\":"), value: count(map: counts)),
    view: ",\"counts\":["
  )
  append(buf: pairs(out: open, counts), view: "]}")
}

fn pairs(out: Buf, counts: Map[Int]) -> Buf {
  walk(start: size(out), out, counts)
}

fn walk(start: Int, out: Buf, counts: Map[Int]) -> Buf {
  match counts {
    Empty -> out
    Node(left, key, value, right) -> walk(
      start,
      out: pair(start, out: walk(start, out, counts: left), key, value),
      counts: right
    )
  }
}

fn pair(start: Int, out: Buf, key: View, value: Int) -> Buf {
  match {
    size(out) == start -> push(
      buf: write_int(
        out: append(buf: write_json_string(out: push(buf: out, byte: 91), text: key), view: ","),
        value
      ),
      byte: 93
    )
    else -> push(
      buf: write_int(
        out: append(
          buf: write_json_string(out: append(buf: out, view: ",["), text: key),
          view: ","
        ),
        value
      ),
      byte: 93
    )
  }
}
