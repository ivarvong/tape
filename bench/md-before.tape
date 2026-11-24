// bench/md-before.tape: the per-byte walks a Markdown renderer uses to find the next inline delimiter, the next
// plain-text byte, and the next byte HTML must escape. One step a byte. bench/md-after.tape is the same walks as scan.
fn next_special(t: View, at: Int) -> Int {
  match {
    at >= len(t) -> len(t)
    t[at] == 92 or t[at] == 96 or t[at] == 60 or t[at] == 91 or t[at] == 93 -> at
    else -> next_special(t, at: at + 1)
  }
}

fn next_plain(t: View, at: Int) -> Int {
  match {
    at >= len(t) -> len(t)
    t[at] == 92
      or t[at] == 96
      or t[at] == 42
      or t[at] == 95
      or t[at] == 91
      or t[at] == 33
      or t[at] == 60
      or t[at] == 10 -> at
    else -> next_plain(t, at: at + 1)
  }
}

fn next_esc(t: View, at: Int) -> Int {
  match {
    at >= len(t) -> len(t)
    t[at] == 38 or t[at] == 60 or t[at] == 62 or t[at] == 34 -> at
    else -> next_esc(t, at: at + 1)
  }
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
