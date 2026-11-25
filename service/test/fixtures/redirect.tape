// A redirect, a header the client sent read back, and a header value that would split the head: the service
// answers the first two as the program says and refuses the third (test/public.test.ts, 0.3 headers).
fn handle(raw: View) -> Response {
  let r = request(raw)
  match r.path {
    "/go/" ++ to -> empty(status: 302) |> header(name: "Location", value: "/to/" ++ to)
    "/echo" -> {
      let key = match header_of(request: r, name: "Idempotency-Key") {
        Some(value) -> value
        None -> "none"
      }
      buf() |> append(view: key) |> respond(status: 200) |> header(name: "x-echo", value: key)
    }
    _ -> empty(status: 200) |> header(name: "x-bad", value: r.body)
  }
}
