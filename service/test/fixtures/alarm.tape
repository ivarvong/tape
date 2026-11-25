// A program with a timer: POST /set sets one for 3 s; woken counts it. test/rebuild.test.ts sets the timer, then
// gives the version a source this compiler cannot build: the alarm must keep the timer and log no error.
type Count { Count(n: Int) }

fn handle(raw: View, timer: Timer) -> Response {
  match request(raw) {
    Request(method: Post, path: "/set") -> {
      do wake(after: 3000, key: 1)
      buf() |> append(view: "set") |> respond(status: 202)
    }
    _ -> buf() |> append(view: "hello") |> respond(status: 200)
  }
}

export fn woken(timer: Timer, message: Wake) -> Result[Count, View] {
  let Wake(key) = message
  Ok(value: Count(n: key))
}
