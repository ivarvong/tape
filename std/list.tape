// std/list.tape: an immutable list. Adding to the front shares the rest; nothing is ever changed in place.

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
