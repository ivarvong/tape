// depth.tape: GET /depth/<n> recurses n deep (not a tail call) and answers n (a report's program, 993c816ece2a).
fn handle(raw: View) -> Response {
  match request(raw) {
    Request(method: Get, path: "/depth/" ++ decimal(n)) -> buf()
      |> write_int(value: depth(n))
      |> respond(status: 200)
    _ -> empty(status: 404)
  }
}

fn depth(n: Int) -> Int {
  match {
    n <= 0 -> 0
    else -> 1 + depth(n - 1)
  }
}
