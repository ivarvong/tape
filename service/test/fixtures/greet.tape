// A program that decodes JSON: its build by the compiler at 93137b6 (greet-93137b6.json) imports env.json, which
// the host no longer has, so the service must rebuild it from this source before it runs (test/rebuild.test.ts).
type Hello { Hello(name: View) }

fn handle(raw: View) -> Response {
  let r = request(raw)
  match decode(json: r.body, as: Hello) {
    Ok(value: Hello(name)) -> buf()
      |> append(view: "hello ")
      |> append(view: name)
      |> respond(status: 200)
    Err(error) -> buf() |> append(view: error) |> respond(status: 400)
  }
}
