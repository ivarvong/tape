// limits.tape: a program for mcp/test.ts that goes past the runner's limits when asked: a loop that never ends
// (Tape's step budget), a body longer than the runner gives back, memory past the 64 MB arena, a division by zero
// (a trap that comes at once), and a random draw.
fn handle(raw: View, dice: Entropy) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/spin") -> spin(n: 0)
    Request(method: "GET", path: "/div/" ++ by) -> respond(status: 200)
      |> append(view: "\(100 / len(by))")
    Request(method: "GET", path: "/big") -> big(out: respond(status: 200), n: 0)
    Request(method: "GET", path: "/huge") -> huge(out: respond(status: 200), n: 0)
    Request(method: "GET", path: "/dice") -> respond(status: 200)
      |> append(view: "\(random(from: dice))")
    _ -> respond(status: 404)
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
