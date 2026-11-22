type Order { Order(id: Int, state: View) }

// Double it.
//
//   > double(n: 21)
//   42
//   > double(n: 2)
//   5
//   > Order(id: double(n: 3), state: "done")
//   Order(id: 7, state: _)
//   > double(n: "x")
//   1
//   > 10 / (double(n: 0))
//   0
//   > double(n: 1)
fn double(n: Int) -> Int {
  n * 2
}

fn handle(raw: View) -> Buf {
  respond(status: 200)
}
