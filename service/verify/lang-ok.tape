// VERIFY check 18: as-patterns, a destructuring let, pipes and ++, compiled and run by the deployed service.
type Order { Order(id: Int, state: View) }
fn handle(raw: View) -> Buf {
  match Some(value: Order(id: 7, state: "done")) {
    Some(value: order = Order(state: "done")) -> shown(order)
    _ -> respond(status: 404)
  }
}
fn shown(order: Order) -> Buf {
  let Order(id, state) = order
  respond(status: 200) |> append(view: "order " ++ decimal_text(value: id) ++ " is " ++ state)
}
