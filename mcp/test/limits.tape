// limits.tape: a program for mcp/test.ts that goes past the runner's limits when asked: a loop that never ends
// (Tape's step budget), a body longer than the runner gives back, memory past the 64 MB arena, a division by zero
// (a trap that comes at once), and a random draw.
fn handle(raw: View, dice: Entropy) -> Response {
  match request(raw) {
    Request(method: Get, path: "/spin") -> spin(n: 0) |> respond(status: 200)
    Request(method: Get, path: "/div/" ++ by) -> buf()
      |> append(view: "\(100 / len(by))")
      |> respond(status: 200)
    Request(method: Get, path: "/big") -> big(out: buf(), n: 0) |> respond(status: 200)
    Request(method: Get, path: "/huge") -> huge(out: buf(), n: 0) |> respond(status: 200)
    Request(method: Get, path: "/dice") -> buf()
      |> append(view: "\(random(from: dice))")
      |> respond(status: 200)
    _ -> empty(status: 404)
  }
}

fn spin(n: Int) -> Buf {
  spin(n: n + 1)
}

fn big(out: Buf, n: Int) -> Buf {
  match {
    n >= 70000 -> out
    else -> big(out: out |> append(view: "x"), n: n + 1)
  }
}

fn huge(out: Buf, n: Int) -> Buf {
  match {
    n >= 1000000 -> out
    else -> huge(
      out: out
        |> append(view: "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789"),
      n: n + 1
    )
  }
}
