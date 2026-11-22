// VERIFY check 18: a `let` whose pattern can fail is refused, naming the case it misses.
type Order { Order(id: Int, state: View) }
fn handle(raw: View) -> Buf {
  let Order(id, state: "done") = Order(id: 1, state: "new")
  respond(status: 200) |> write_int(value: id)
}
