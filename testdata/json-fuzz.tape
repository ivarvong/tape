// test/json-fuzz.tape: the types test/json-fuzz.ts decodes generated documents as. A request is the type's name, a
// line feed, then the JSON. The answer is the value written back (write_json, or by hand where a field is an
// Option), or "error: " and decode's reason.

type Name = View where len(self) >= 1 and len(self) <= 8
type Small = Int where self >= -100 and self <= 100
type Point { Point(x: Int, y: Int) }
type Tag { Tag(name: Name, on: Bool) }
type Flat { Flat(id: Int, label: View, ok: Bool, size: Small, x: Float) }
type Box { Box(at: Point, tags: List[Tag], nums: List[Int]) }
type Grid { Grid(rows: List[List[Small]], names: List[Name]) }
type Deep { Deep(box: Box, grid: Grid, note: View) }
type Maybe { Maybe(
  a: Option[Int],
  b: Option[Name],
  c: Option[Point],
  d: Option[List[Tag]],
  e: View
) }
type Shape {
  Circle(r: Small)
  Rect(w: Int, h: Int)
  Label(text: Name, at: Point)
  Square(w: Int, r: Small)
}
type Empty { Empty }

fn handle(raw: View) -> Response {
  answered(raw) |> respond(status: 200)
}

fn answered(raw: View) -> Buf {
  match raw {
    "Flat\n" ++ json -> flat(found: decode(json, as: Flat))
    "Box\n" ++ json -> box(found: decode(json, as: Box))
    "Grid\n" ++ json -> grid(found: decode(json, as: Grid))
    "Deep\n" ++ json -> deep(found: decode(json, as: Deep))
    "Maybe\n" ++ json -> maybe(found: decode(json, as: Maybe))
    "Shape\n" ++ json -> shape(found: decode(json, as: Shape))
    "Empty\n" ++ json -> empty(found: decode(json, as: Empty))
    _ -> buf() |> append(view: "no such type")
  }
}

fn failed(error: View) -> Buf {
  buf() |> append(view: "error: ") |> append(view: error)
}

fn flat(found: Result[Flat, View]) -> Buf {
  match found {
    Ok(value) -> buf() |> write_json(value)
    Err(error) -> failed(error)
  }
}

fn box(found: Result[Box, View]) -> Buf {
  match found {
    Ok(value) -> buf() |> write_json(value)
    Err(error) -> failed(error)
  }
}

fn grid(found: Result[Grid, View]) -> Buf {
  match found {
    Ok(value) -> buf() |> write_json(value)
    Err(error) -> failed(error)
  }
}

fn deep(found: Result[Deep, View]) -> Buf {
  match found {
    Ok(value) -> buf() |> write_json(value)
    Err(error) -> failed(error)
  }
}

fn maybe(found: Result[Maybe, View]) -> Buf {
  match found {
    Ok(value: Maybe(a, b, c, d, e)) -> buf()
      |> append(view: "a=")
      |> opt_int(found: a)
      |> append(view: " b=")
      |> opt_name(found: b)
      |> append(view: " c=")
      |> opt_point(found: c)
      |> append(view: " d=")
      |> opt_tags(found: d)
      |> append(view: " e=")
      |> write_json_string(text: e)
    Err(error) -> failed(error)
  }
}

fn opt_int(out: Buf, found: Option[Int]) -> Buf {
  match found {
    Some(value) -> out |> write_int(value)
    None -> out |> append(view: "-")
  }
}

fn opt_name(out: Buf, found: Option[Name]) -> Buf {
  match found {
    Some(value) -> out |> write_json_string(text: value)
    None -> out |> append(view: "-")
  }
}

fn opt_point(out: Buf, found: Option[Point]) -> Buf {
  match found {
    Some(value) -> out |> write_json(value)
    None -> out |> append(view: "-")
  }
}

fn opt_tags(out: Buf, found: Option[List[Tag]]) -> Buf {
  match found {
    Some(value) -> out |> write_tags(list: value)
    None -> out |> append(view: "-")
  }
}

fn write_tags(out: Buf, list: List[Tag]) -> Buf {
  match list {
    Cons(head, tail) -> write_tags(
      out: out |> write_json(value: head) |> push(byte: 59),
      list: tail
    )
    Nil -> out
  }
}

fn shape(found: Result[Shape, View]) -> Buf {
  match found {
    Ok(value: Circle(r)) -> buf() |> append(view: "circle ") |> write_int(value: r)
    Ok(value: Rect(w, h)) -> buf()
      |> append(view: "rect ")
      |> write_int(value: w)
      |> push(byte: 32)
      |> write_int(value: h)
    Ok(value: Label(text, at)) -> buf()
      |> append(view: "label ")
      |> write_json_string(text)
      |> push(byte: 32)
      |> write_json(value: at)
    Ok(value: Square(w, r)) -> buf()
      |> append(view: "square ")
      |> write_int(value: w)
      |> push(byte: 32)
      |> write_int(value: r)
    Err(error) -> failed(error)
  }
}

fn empty(found: Result[Empty, View]) -> Buf {
  match found {
    Ok -> buf() |> append(view: "empty")
    Err(error) -> failed(error)
  }
}
