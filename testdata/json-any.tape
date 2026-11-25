// testdata/json-any.tape: what test/json-any.ts sends std's is_json, json_member and decode of a scalar. A request
// is a letter, then what it is given:
//   j<json>                  is_json: "1" or "0"
//   c<json>                  "1", without reading the JSON: what a request costs before is_json
//   m<4 digits><key><json>   json_member, the key that many bytes long: "none", or "some " and the raw value
//   t<json> i<json> b<json>  decode as View, Int, Bool: "ok " and the value, or "error " and the reason
//   n<json>                  decode as Name, a refined View

type Name = View where len(self) >= 1 and len(self) <= 8

fn handle(raw: View) -> Buf {
  match raw {
    "j" ++ json -> buf()
      |> append(view: match {
        is_json(text: json) -> "1"
        else -> "0"
      })
    "c" ++ json -> buf() |> append(view: "1")
    "m" ++ rest -> member(rest, n: digits(v: slice(v: rest, from: 0, to: 4), at: 0, n: 0))
    "t" ++ json -> said(found: decode(json, as: View))
    "n" ++ json -> said_name(found: decode(json, as: Name))
    "i" ++ json -> match decode(json, as: Int) {
      Ok(value) -> buf() |> append(view: "ok ") |> write_int(value)
      Err(error) -> buf() |> append(view: "error ") |> append(view: error)
    }
    "b" ++ json -> match decode(json, as: Bool) {
      Ok(value) -> buf() |> append(view: "ok ") |> write_bool(value)
      Err(error) -> buf() |> append(view: "error ") |> append(view: error)
    }
    _ -> buf()
  }
}

fn digits(v: View, at: Int, n: Int) -> Int {
  match {
    at >= len(v) -> n
    else -> digits(v, at: at + 1, n: n * 10 + v[at] - 48)
  }
}

fn member(rest: View, n: Int) -> Buf {
  let key = slice(v: rest, from: 4, to: 4 + n)
  match json_member(json: slice(v: rest, from: 4 + n, to: len(rest)), key) {
    Some(value) -> buf() |> append(view: "some ") |> append(view: value)
    None -> buf() |> append(view: "none")
  }
}

fn said(found: Result[View, View]) -> Buf {
  match found {
    Ok(value) -> buf() |> append(view: "ok ") |> append(view: value)
    Err(error) -> buf() |> append(view: "error ") |> append(view: error)
  }
}

fn said_name(found: Result[Name, View]) -> Buf {
  match found {
    Ok(value) -> buf() |> append(view: "ok ") |> append(view: value)
    Err(error) -> buf() |> append(view: "error ") |> append(view: error)
  }
}
