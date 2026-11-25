// stats.tape: numbers in, a summary out, with immutable lists and functions as values (map, filter, fold from
// the standard library, which is written in Tape).

fn handle(raw: View) -> Response {
  stats(raw) |> respond_as(status: 200, content: Json)
}

fn stats(raw: View) -> Buf {
  summary(numbers: parse(rest: raw, acc: Nil))
}

fn parse(rest: View, acc: List[Int]) -> List[Int] {
  match {
    len(rest) == 0 -> acc
    else -> parse(rest: after(v: rest, byte: 44), acc: item(text: until(v: rest, byte: 44), acc))
  }
}

fn item(text: View, acc: List[Int]) -> List[Int] {
  match text {
    decimal(n) -> Cons(head: n, tail: acc)
    _ -> acc
  }
}

fn larger(a: Int, b: Int) -> Int {
  match {
    a > b -> a
    else -> b
  }
}

fn summary(numbers: List[Int]) -> Buf {
  let total = fold(list: numbers, from: 0, by: fn(sum: Int, x: Int) -> Int { sum + x })
  let largest = fold(list: numbers, from: 0, by: larger)
  let evens = filter(list: numbers, keep: fn(x: Int) -> Bool { x % 2 == 0 })
  let squares = fold(
    list: map(list: evens, by: fn(x: Int) -> Int { x * x }),
    from: 0,
    by: fn(sum: Int, x: Int) -> Int { sum + x }
  )
  let head = write_int(
    out: append(
      buf: write_int(out: append(buf: buf(), view: "{\"count\":"), value: length(list: numbers)),
      view: ",\"sum\":"
    ),
    value: total
  )
  push(
    buf: write_int(
      out: append(
        buf: write_int(out: append(buf: head, view: ",\"largest\":"), value: largest),
        view: ",\"sum_of_even_squares\":"
      ),
      value: squares
    ),
    byte: 125
  )
}
