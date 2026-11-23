// depth.tape: GET /depth/<n> recurses n deep (not a tail call) and answers n (a report's program, 993c816ece2a).
fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/depth/" ++ decimal(n)) -> respond(status: 200) |> write_int(value: depth(n))
    _ -> respond(status: 404)
  }
}

fn depth(n: Int) -> Int {
  match {
    n <= 0 -> 0
    else -> 1 + depth(n - 1)
  }
}
