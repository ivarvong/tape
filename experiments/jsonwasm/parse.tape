// experiments/jsonwasm/parse.tape: candidate B's prototype. The request is JSON; it is parsed into a tree in Wasm
// (strings as views, or decoded when they have escapes; numbers as their text), then the members a decoder of
// webhook's Delivery or crud's Batch would read are looked up and read. Answers how many objects it read and the sum
// of their integers, so nothing can be skipped.

type JNode {
  JNull
  JTrue
  JFalse
  JNum(text: View)
  JStr(text: View)
  JArr(items: List[JNode])
  JObj(members: List[JMember])
}

type JMember { JMember(key: View, value: JNode) }

type JParsed {
  JParsed(node: JNode, next: Int)
  JBad
}

type JMembers {
  JMembers(members: List[JMember], next: Int)
  JMembersBad
}

type JItems {
  JItems(items: List[JNode], next: Int)
  JItemsBad
}

fn handle(raw: View) -> Buf {
  match jvalue(v: raw, at: 0) {
    JParsed(node, next) if json_end(v: raw, at: next) -> buf() |> write_int(value: walk(node))
    _ -> buf() |> append(view: "bad")
  }
}

// the integers of every object in the array under "events" (webhook) or "items" (crud), read as their decoders
// would: each field looked up, and every key checked to be a field
fn walk(node: JNode) -> Int {
  match node {
    JObj(members) -> walk_items(
      list: items_of(found: lookup(list: members, key: "events")),
      acc: 0,
      crud: False
    ) + walk_items(
      list: items_of(found: lookup(list: members, key: "items")),
      acc: 0,
      crud: True
    )
    _ -> 0
  }
}

fn items_of(found: Option[JNode]) -> List[JNode] {
  match found {
    Some(value: JArr(items)) -> items
    _ -> Nil
  }
}

fn walk_items(list: List[JNode], acc: Int, crud: Bool) -> Int {
  match list {
    Cons(head: JObj(members), tail) if crud -> walk_items(
      list: tail,
      acc: acc + 1 + item(members) + known(list: members, crud, n: 0),
      crud
    )
    Cons(head: JObj(members), tail) -> walk_items(
      list: tail,
      acc: acc + 1 + event(members) + known(list: members, crud, n: 0),
      crud
    )
    Cons(tail) -> walk_items(list: tail, acc, crud)
    Nil -> acc
  }
}

fn event(members: List[JMember]) -> Int {
  text_len(found: lookup(list: members, key: "id")) + text_len(
    found: lookup(list: members, key: "kind")
  ) + text_len(
    found: lookup(list: members, key: "account")
  ) + num(
    found: lookup(list: members, key: "amount")
  ) + text_len(
    found: lookup(list: members, key: "note")
  )
}

fn item(members: List[JMember]) -> Int {
  text_len(found: lookup(list: members, key: "key")) + text_len(
    found: lookup(list: members, key: "name")
  ) + num(
    found: lookup(list: members, key: "qty")
  ) + num(
    found: lookup(list: members, key: "cents")
  )
}

fn known(list: List[JMember], crud: Bool, n: Int) -> Int {
  match list {
    Cons(head: JMember(key), tail) if crud and (
      key == "key" or key == "name" or key == "qty" or key == "cents"
    ) -> known(list: tail, crud, n: n + 1)
    Cons(head: JMember(key), tail) if not crud and (
      key == "id" or key == "kind" or key == "account" or key == "amount" or key == "note"
    ) -> known(list: tail, crud, n: n + 1)
    Cons(tail) -> known(list: tail, crud, n)
    Nil -> n
  }
}

fn num(found: Option[JNode]) -> Int {
  match found {
    Some(value: JNum(text)) -> digits_or_zero(text)
    _ -> 0
  }
}

fn digits_or_zero(text: View) -> Int {
  match parse_int(text) {
    Some(value) -> value
    None -> 0
  }
}

fn text_len(found: Option[JNode]) -> Int {
  match found {
    Some(value: JStr(text)) -> len(text)
    _ -> 0
  }
}

// the last member with this key, as JSON.parse keeps the last
fn lookup(list: List[JMember], key: View) -> Option[JNode] {
  lookup_from(list, key, found: None)
}

fn lookup_from(list: List[JMember], key: View, found: Option[JNode]) -> Option[JNode] {
  match list {
    Cons(head: JMember(key: k, value), tail) if k == key -> lookup_from(
      list: tail,
      key,
      found: Some(value)
    )
    Cons(tail) -> lookup_from(list: tail, key, found)
    Nil -> found
  }
}

fn jvalue(v: View, at: Int) -> JParsed {
  let s = json_ws(v, at)
  match {
    s >= len(v) -> JBad
    v[s] == 123 -> jobject(found: jmembers(v, at: json_ws(v, at: s + 1), acc: Nil, first: True))
    v[s] == 91 -> jarray(found: jitems(v, at: json_ws(v, at: s + 1), acc: Nil, first: True))
    v[s] == 34 -> jstring_at(v, at: s + 1, end: plain_end(v, at: s + 1))
    has(v, at: s, word: "true") -> JParsed(node: JTrue, next: s + 4)
    has(v, at: s, word: "false") -> JParsed(node: JFalse, next: s + 5)
    has(v, at: s, word: "null") -> JParsed(node: JNull, next: s + 4)
    else -> jnumber(v, at: s, end: number_end(v, at: s))
  }
}

fn jnumber(v: View, at: Int, end: Option[Int]) -> JParsed {
  match end {
    Some(value) -> JParsed(node: JNum(text: slice(v, from: at, to: value)), next: value)
    None -> JBad
  }
}

// the first position at or after `at` that is a quote, a backslash, a control byte or not ASCII
fn plain_end(v: View, at: Int) -> Int {
  scan_plain(v, at)
}

// a string whose plain run ends at its quote is a view; otherwise it is read run by run
fn jstring_at(v: View, at: Int, end: Int) -> JParsed {
  jstring(found: key_at(v, at, end))
}

fn key_at(v: View, at: Int, end: Int) -> JsonText {
  let e = text_run(v, at: end)
  match {
    e < len(v) and v[e] == 34 -> JsonText(text: slice(v, from: at, to: e), next: e + 1)
    e < len(v) and v[e] == 92 -> escaped(v, at: e, out: append(buf: buf(), view: slice(v, from: at, to: e)))
    else -> BadText
  }
}

// past plain ASCII and well-formed UTF-8 sequences: the first quote, backslash, control byte or bad byte
fn text_run(v: View, at: Int) -> Int {
  let e = plain_end(v, at)
  match {
    e < len(v) and v[e] >= 128 -> utf8_run(v, at: e, found: utf8_at(v, at: e))
    else -> e
  }
}

fn utf8_run(v: View, at: Int, found: Utf8) -> Int {
  match found {
    Utf8(next) -> text_run(v, at: next)
    BadUtf8 -> at
  }
}

// at: a backslash; out holds what is decoded so far
fn escaped(v: View, at: Int, out: Buf) -> JsonText {
  match json_char(v, at) {
    Char(code, next) -> escaped_more(v, at: next, out: write_code(out, code))
    _ -> bad_text(text: freeze(out))
  }
}

fn escaped_more(v: View, at: Int, out: Buf) -> JsonText {
  let e = text_run(v, at)
  match {
    e < len(v) and v[e] == 34 -> JsonText(text: freeze(append(buf: out, view: slice(v, from: at, to: e))), next: e + 1)
    e < len(v) and v[e] == 92 -> escaped(v, at: e, out: append(buf: out, view: slice(v, from: at, to: e)))
    else -> bad_text(text: freeze(out))
  }
}

fn bad_text(text: View) -> JsonText {
  BadText
}

fn jstring(found: JsonText) -> JParsed {
  match found {
    JsonText(text, next) -> JParsed(node: JStr(text), next)
    BadText -> JBad
  }
}

fn jobject(found: JMembers) -> JParsed {
  match found {
    JMembers(members, next) -> JParsed(node: JObj(members: reverse(list: members)), next)
    JMembersBad -> JBad
  }
}

fn jarray(found: JItems) -> JParsed {
  match found {
    JItems(items, next) -> JParsed(node: JArr(items: reverse(list: items)), next)
    JItemsBad -> JBad
  }
}

// at: the first non-space position after `{` or after a member's `,`
fn jmembers(v: View, at: Int, acc: List[JMember], first: Bool) -> JMembers {
  match {
    first and at < len(v) and v[at] == 125 -> JMembers(members: acc, next: at + 1)
    at < len(v) and v[at] == 34 -> jkey(v, key: key_at(v, at: at + 1, end: plain_end(v, at: at + 1)), acc)
    else -> JMembersBad
  }
}

fn jkey(v: View, key: JsonText, acc: List[JMember]) -> JMembers {
  match key {
    JsonText(text, next) -> jcolon(v, key: text, at: json_ws(v, at: next), acc)
    BadText -> JMembersBad
  }
}

fn jcolon(v: View, key: View, at: Int, acc: List[JMember]) -> JMembers {
  match {
    at < len(v) and v[at] == 58 -> jmember(v, key, value: jvalue(v, at: at + 1), acc)
    else -> JMembersBad
  }
}

fn jmember(v: View, key: View, value: JParsed, acc: List[JMember]) -> JMembers {
  match value {
    JParsed(node, next) -> jafter_member(
      v,
      at: json_ws(v, at: next),
      acc: Cons(head: JMember(key, value: node), tail: acc)
    )
    JBad -> JMembersBad
  }
}

fn jafter_member(v: View, at: Int, acc: List[JMember]) -> JMembers {
  match {
    at < len(v) and v[at] == 125 -> JMembers(members: acc, next: at + 1)
    at < len(v) and v[at] == 44 -> jmembers(v, at: json_ws(v, at: at + 1), acc, first: False)
    else -> JMembersBad
  }
}

fn jitems(v: View, at: Int, acc: List[JNode], first: Bool) -> JItems {
  match {
    first and at < len(v) and v[at] == 93 -> JItems(items: acc, next: at + 1)
    else -> jitem(v, value: jvalue(v, at), acc)
  }
}

fn jitem(v: View, value: JParsed, acc: List[JNode]) -> JItems {
  match value {
    JParsed(node, next) -> jafter_item(
      v,
      at: json_ws(v, at: next),
      acc: Cons(head: node, tail: acc)
    )
    JBad -> JItemsBad
  }
}

fn jafter_item(v: View, at: Int, acc: List[JNode]) -> JItems {
  match {
    at < len(v) and v[at] == 93 -> JItems(items: acc, next: at + 1)
    at < len(v) and v[at] == 44 -> jitems(v, at: json_ws(v, at: at + 1), acc, first: False)
    else -> JItemsBad
  }
}
