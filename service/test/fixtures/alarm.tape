// A program with a timer: POST /set sets one for 3 s; woken counts it. test/rebuild.test.ts sets the timer, then
// gives the version a source this compiler cannot build: the alarm must keep the timer and log no error.
type Count { Count(n: Int) }

fn handle(raw: View, timer: Timer) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/set") -> {
      do wake(after: 3000, key: 1)
      respond(status: 202) |> append(view: "set")
    }
    _ -> respond(status: 200) |> append(view: "hello")
  }
}

export fn woken(timer: Timer, message: Wake) -> Result[Count, View] {
  let Wake(key) = message
  Ok(value: Count(n: key))
}
