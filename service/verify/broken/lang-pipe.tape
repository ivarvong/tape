// VERIFY check 18: the right side of |> must be a function call. (Under broken/: it does not parse, so `fmt` skips it.)
fn handle(raw: View) -> Buf {
  raw |> Some
}
