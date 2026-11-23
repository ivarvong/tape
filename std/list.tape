// std/list.tape: an immutable list. Adding to the front shares the rest; nothing is ever changed in place.

// An immutable list: Cons(head, tail) or Nil. Build one in a function that says its type, `fn items() -> List[Item]`.
type List[T] {
  Cons(head: T, tail: List[T])
  Nil
}

// How many items.
//
//   > length(list: Cons(head: 1, tail: Cons(head: 2, tail: Nil)))
//   2
fn length[T](list: List[T]) -> Int {
  length_from(list, acc: 0)
}

// Internal: the loop of length.
fn length_from[T](list: List[T], acc: Int) -> Int {
  match list {
    Cons(tail) -> length_from(list: tail, acc: acc + 1)
    Nil -> acc
  }
}

// The same items, last first.
//
//   > Cons(head: 1, tail: Cons(head: 2, tail: Nil)) |> reverse
//   Cons(head: 2, tail: Cons(head: 1, tail: Nil))
fn reverse[T](list: List[T]) -> List[T] {
  reverse_onto(list, acc: Nil)
}

// Internal: the loop of reverse.
fn reverse_onto[T](list: List[T], acc: List[T]) -> List[T] {
  match list {
    Cons(head, tail) -> reverse_onto(list: tail, acc: Cons(head, tail: acc))
    Nil -> acc
  }
}

// A new list with `by` applied to every item.
//
//   > Cons(head: 1, tail: Cons(head: 2, tail: Nil)) |> map(by: fn(x: Int) -> Int { x * 10 })
//   Cons(head: 10, tail: Cons(head: 20, tail: Nil))
fn map[A, B](list: List[A], by: Fn[A, B]) -> List[B] {
  reverse(list: map_onto(list, by, acc: Nil))
}

// Internal: the loop of map, last item first.
fn map_onto[A, B](list: List[A], by: Fn[A, B], acc: List[B]) -> List[B] {
  match list {
    Cons(head, tail) -> map_onto(list: tail, by, acc: Cons(head: by(head), tail: acc))
    Nil -> acc
  }
}

// The items for which `keep` is True, in the same order.
//
//   > Cons(head: 1, tail: Cons(head: 2, tail: Cons(head: 3, tail: Nil))) |> filter(keep: fn(x: Int) -> Bool { x % 2 == 1 })
//   Cons(head: 1, tail: Cons(head: 3, tail: Nil))
fn filter[A](list: List[A], keep: Fn[A, Bool]) -> List[A] {
  reverse(list: filter_onto(list, keep, acc: Nil))
}

// Internal: the loop of filter, last item first.
fn filter_onto[A](list: List[A], keep: Fn[A, Bool], acc: List[A]) -> List[A] {
  match list {
    Cons(head, tail) if keep(head) -> filter_onto(list: tail, keep, acc: Cons(head, tail: acc))
    Cons(tail) -> filter_onto(list: tail, keep, acc)
    Nil -> acc
  }
}

// Combine the items left to right, starting from `from`: by(by(from, first), second) and so on.
//
//   > Cons(head: 3, tail: Cons(head: 4, tail: Nil)) |> fold(from: 100, by: fn(acc: Int, x: Int) -> Int { acc - x })
//   93
fn fold[A, B](list: List[A], from: B, by: Fn2[B, A, B]) -> B {
  match list {
    Cons(head, tail) -> fold(list: tail, from: by(from, head), by)
    Nil -> from
  }
}

// Write each item into a Buf, first to last. A Buf has one owner, so it is not kept in a record or a list while a
// list is walked: it is handed from item to item. For a total as well, fold the list a second time.
//
//   > buf() |> write_each(list: Cons(head: 1, tail: Cons(head: 2, tail: Nil)), by: fn(out: Buf, n: Int) -> Buf { out |> write_int(value: n * 10) }) |> freeze
//   "1020"
fn write_each[T](out: Buf, list: List[T], by: Fn2[Buf, T, Buf]) -> Buf {
  match list {
    Cons(head, tail) -> write_each(out: by(out, head), list: tail, by)
    Nil -> out
  }
}

// A JSON array of the items, each written by `by`, with the commas between them: for items that are not records
// as they stand (a line with a computed total, a value formatted by hand). A list of records is `write_json`.
//
//   > buf() |> write_json_list(list: Cons(head: "a", tail: Cons(head: "b", tail: Nil)), by: fn(out: Buf, s: View) -> Buf { out |> write_json_string(text: s) }) |> freeze
//   "[\"a\",\"b\"]"
//   > buf() |> write_json_list(list: Nil, by: fn(out: Buf, n: Int) -> Buf { out |> write_int(value: n) }) |> freeze
//   "[]"
fn write_json_list[T](out: Buf, list: List[T], by: Fn2[Buf, T, Buf]) -> Buf {
  match list {
    Cons(head, tail) -> json_rest(out: by(push(buf: out, byte: 91), head), list: tail, by)
      |> push(byte: 93)
    Nil -> out |> append(view: "[]")
  }
}

// Internal: write_json_list's items after the first, each after a comma.
fn json_rest[T](out: Buf, list: List[T], by: Fn2[Buf, T, Buf]) -> Buf {
  match list {
    Cons(head, tail) -> json_rest(out: by(push(buf: out, byte: 44), head), list: tail, by)
    Nil -> out
  }
}

// The texts with `sep` between each two.
//
//   > join(list: Cons(head: "a", tail: Cons(head: "b", tail: Cons(head: "c", tail: Nil))), sep: ", ")
//   "a, b, c"
//   > join(list: Nil, sep: ", ")
//   ""
fn join(list: List[View], sep: View) -> View {
  match list {
    Cons(head, tail) -> freeze(buf: join_rest(out: buf() |> append(view: head), list: tail, sep))
    Nil -> ""
  }
}

// Internal: join's texts after the first, each after `sep`.
fn join_rest(out: Buf, list: List[View], sep: View) -> Buf {
  match list {
    Cons(head, tail) -> join_rest(
      out: out |> append(view: sep) |> append(view: head),
      list: tail,
      sep
    )
    Nil -> out
  }
}
