// bench/md-after.tape: the walks of bench/md-before.tape, each one call of scan. The sets are the bytes those loops
// stop on: a backslash, a backtick, < [ ] ; a backslash, a backtick, * _ [ ! < and a newline; and & < > ".
fn next_special(t: View, at: Int) -> Int {
  scan(t, at, set: "\\`<[]")
}

fn next_plain(t: View, at: Int) -> Int {
  scan(t, at, set: "\\`*_[!<\n")
}

fn next_esc(t: View, at: Int) -> Int {
  scan(t, at, set: "&<>\"")
}

fn specials(t: View, at: Int, acc: Int) -> Int {
  let j = next_special(t, at)
  match {
    j >= len(t) -> acc
    else -> specials(t, at: j + 1, acc: acc + j)
  }
}

fn plains(t: View, at: Int, acc: Int) -> Int {
  let j = next_plain(t, at)
  match {
    j >= len(t) -> acc
    else -> plains(t, at: j + 1, acc: acc + j)
  }
}

fn escs(t: View, at: Int, acc: Int) -> Int {
  let j = next_esc(t, at)
  match {
    j >= len(t) -> acc
    else -> escs(t, at: j + 1, acc: acc + j)
  }
}

fn count_specials(raw: View) -> Int {
  specials(raw, at: 0, acc: 0)
}

fn count_plains(raw: View) -> Int {
  plains(raw, at: 0, acc: 0)
}

fn count_escs(raw: View) -> Int {
  escs(raw, at: 0, acc: 0)
}

fn count_all(raw: View) -> Int {
  count_specials(raw) + count_plains(raw) + count_escs(raw)
}
