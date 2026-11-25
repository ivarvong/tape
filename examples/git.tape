// git.tape: parse one git object (already inflated): "<kind> <size>\0<payload>". Answers with JSON. Byte layouts
// need no special syntax: a prefix pattern, `until`, `after` and `slice` cover blobs, trees and commits.

fn handle(raw: View) -> Response {
  parsed(raw) |> respond_as(status: 200, content: Json)
}

fn parsed(raw: View) -> Buf {
  match until(v: raw, byte: 0) {
    "blob " ++ decimal(size) -> sized(kind: 1, size, payload: after(v: raw, byte: 0))
    "tree " ++ decimal(size) -> sized(kind: 2, size, payload: after(v: raw, byte: 0))
    "commit " ++ decimal(size) -> sized(kind: 3, size, payload: after(v: raw, byte: 0))
    _ -> problem(reason: "not a git object header")
  }
}

fn sized(kind: Int, size: Int, payload: View) -> Buf {
  match {
    size != len(payload) -> problem(reason: "the size in the header is not the payload's length")
    kind == 1 -> push(
      buf: write_int(out: append(buf: buf(), view: "{\"kind\":\"blob\",\"size\":"), value: size),
      byte: 125
    )
    kind == 2 -> append(
      buf: entries(
        out: append(buf: buf(), view: "{\"kind\":\"tree\",\"entries\":["),
        rest: payload,
        first: True
      ),
      view: "]}"
    )
    else -> push(
      buf: headers(
        out: append(buf: buf(), view: "{\"kind\":\"commit\""),
        rest: payload,
        parents: 0
      ),
      byte: 125
    )
  }
}

// ---------- tree: "<mode> <name>\0<20 bytes of id>" repeated ----------

fn entries(out: Buf, rest: View, first: Bool) -> Buf {
  let mode = until(v: rest, byte: 32)
  let named = after(v: rest, byte: 32)
  let name = until(v: named, byte: 0)
  let id = after(v: named, byte: 0)
  match {
    len(rest) == 0 -> out
    len(id) < 20 -> append(buf: out, view: "{\"error\":\"truncated entry\"}")
    first -> entries(
      out: entry(out, mode, name, id: slice(v: id, from: 0, to: 20)),
      rest: slice(v: id, from: 20, to: len(id)),
      first: False
    )
    else -> entries(
      out: entry(out: push(buf: out, byte: 44), mode, name, id: slice(v: id, from: 0, to: 20)),
      rest: slice(v: id, from: 20, to: len(id)),
      first: False
    )
  }
}

fn entry(out: Buf, mode: View, name: View, id: View) -> Buf {
  let start = append(
    buf: append(buf: append(buf: out, view: "{\"mode\":\""), view: mode),
    view: "\",\"name\":"
  )
  append(
    buf: hex(
      out: append(buf: write_json_string(out: start, text: name), view: ",\"id\":\""),
      bytes: id,
      at: 0
    ),
    view: "\"}"
  )
}

fn hex(out: Buf, bytes: View, at: Int) -> Buf {
  match {
    at == len(bytes) -> out
    else -> hex(
      out: push(
        buf: push(buf: out, byte: nibble(n: bytes[at] / 16)),
        byte: nibble(n: bytes[at] % 16)
      ),
      bytes,
      at: at + 1
    )
  }
}

fn nibble(n: Int) -> Int {
  match {
    n < 10 -> 48 + n
    else -> 87 + n
  }
}

// ---------- commit: header lines, an empty line, the message ----------

fn headers(out: Buf, rest: View, parents: Int) -> Buf {
  match until(v: rest, byte: 10) {
    "tree " ++ id -> headers(
      out: append(buf: append(buf: append(buf: out, view: ",\"tree\":\""), view: id), view: "\""),
      rest: after(v: rest, byte: 10),
      parents
    )
    "parent " ++ id -> headers(out, rest: after(v: rest, byte: 10), parents: parents + 1)
    "author " ++ who -> headers(
      out: write_json_string(
        out: append(buf: out, view: ",\"author\":"),
        text: until(v: who, byte: 60)
      ),
      rest: after(v: rest, byte: 10),
      parents
    )
    "" -> write_json_string(
      out: append(
        buf: write_int(out: append(buf: out, view: ",\"parents\":"), value: parents),
        view: ",\"subject\":"
      ),
      text: until(v: after(v: rest, byte: 10), byte: 10)
    )
    _ -> headers(out, rest: after(v: rest, byte: 10), parents)
  }
}

fn problem(reason: View) -> Buf {
  append(
    buf: write_json_string(out: append(buf: buf(), view: "{\"error\":"), text: reason),
    view: "}"
  )
}
