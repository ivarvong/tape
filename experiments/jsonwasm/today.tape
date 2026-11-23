// experiments/jsonwasm/today.tape: today's decode (the host's JSON.parse, each list element stringified, split and
// parsed again) of webhook's and crud's bodies, alone: answers how many items decoded and the sum of their integers.

type Id = View where len(self) >= 1 and len(self) <= 64
type Account = View where len(self) >= 1 and len(self) <= 64
type Amount = Int where self >= 0 and self <= 100000000
type Event { Event(id: Id, kind: View, account: Account, amount: Amount, note: View) }
type Delivery { Delivery(source: View, events: List[Event]) }
type Key = View where len(self) >= 1 and len(self) <= 64
type Item { Item(key: Key, name: View, qty: Int, cents: Int) }
type Batch { Batch(batch: View, items: List[Item]) }

fn handle(raw: View) -> Buf {
  match raw {
    "{\"source\"" ++ _ -> events(found: decode(json: raw, as: Delivery))
    _ -> items(found: decode(json: raw, as: Batch))
  }
}

fn events(found: Result[Delivery, View]) -> Buf {
  match found {
    Ok(value: Delivery(events)) -> buf() |> write_int(value: events_sum(list: events, acc: 0))
    Err(error) -> buf() |> append(view: error)
  }
}

fn items(found: Result[Batch, View]) -> Buf {
  match found {
    Ok(value: Batch(items)) -> buf() |> write_int(value: items_sum(list: items, acc: 0))
    Err(error) -> buf() |> append(view: error)
  }
}

fn events_sum(list: List[Event], acc: Int) -> Int {
  match list {
    Cons(head: Event(amount), tail) -> events_sum(list: tail, acc: acc + 1 + amount)
    Nil -> acc
  }
}

fn items_sum(list: List[Item], acc: Int) -> Int {
  match list {
    Cons(head: Item(qty, cents), tail) -> items_sum(list: tail, acc: acc + 1 + qty + cents)
    Nil -> acc
  }
}
