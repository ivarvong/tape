// std/core.tape: the types and functions the compiler itself refers to.

type Option[T] {
  Some(value: T)
  None
}

// What a compare-and-set did (sql_move). Moved: the row was in the state the statement compares, and is now as its
// RETURNING says. Raced: the row is there but was not in that state (another request moved it first); `now` is the
// row as it is. NoRow: there is no such row.
type Move[T] {
  Moved(value: T)
  Raced(now: T)
  NoRow
}

// A value or the reason there is none. Errors are values: match on them, or chain steps with `with`.
type Result[T, E] {
  Ok(value: T)
  Err(error: E)
}

// Why a call to another object or Worker gave no reply. Timeout: the time budget ran out, and for a call that
// changes something the outcome is unknown until it is sent again with the same key. Unreachable: nothing answers
// to that name. Rejected: it refused, and says why. Skew: the two sides disagree, so nothing ran this time: they
// were built from different definitions of the method, or the key was used before for another message (which may
// have run; do not compensate for a Skew as for a refusal). Rejected and Skew are final: the callee runs a key at
// most once and repeats its stored reply, so the same call sent again gets the same answer; a timer that asks
// again does not change it (rules.ts C79 lets such an outcome leave a row for a request to move on).
private type CallError {
  Timeout
  Unreachable
  Rejected(reason: View) final
  Skew(reason: View) final
}

// What the host sends to `export fn woken` when a timer set with wake(timer, after, key) is due: that key.
type Wake {
  Wake(key: Int)
}

// One step through the rows of a query: next(rows) gives Next(value, rest) or End.
type Step[T] {
  Next(value: T, rest: Rows[T])
  End
}

// Text equality, used by == on View and by text patterns.
//
//   > same(a: "lamp", b: "lamp")
//   True
//   > "lamp" == "lamps"
//   False
fn same(a: View, b: View) -> Bool {
  len(a) == len(b) and same_from(a, b, at: 0)
}

fn same_from(a: View, b: View, at: Int) -> Bool {
  match {
    at >= len(a) -> True
    a[at] != b[at] -> False
    else -> same_from(a, b, at: at + 1)
  }
}

// Where sep first occurs in v, at or after at; -1 when it does not. Used by text patterns `p ++ "sep" ++ q`.
//
//   > find_text(v: "/runs/12/advance", sep: "/", at: 1)
//   5
//   > find_text(v: "abc", sep: "x", at: 0)
//   -1
fn find_text(v: View, sep: View, at: Int) -> Int {
  match {
    at + len(sep) > len(v) -> -1
    same(a: slice(v, from: at, to: at + len(sep)), b: sep) -> at
    else -> find_text(v, sep, at: at + 1)
  }
}

// Text joined: `a ++ b` in an expression is concat(a, b). (In a pattern, `"prefix" ++ rest` takes text apart.)
//
//   > "Hello, " ++ "ada" ++ "!"
//   "Hello, ada!"
//   > concat(a: "", b: "")
//   ""
fn concat(a: View, b: View) -> View {
  freeze(append(buf: append(buf: buf(), view: a), view: b))
}
