// std/map.tape: an immutable map from text to any value, kept in key order (an AVL tree). `put` returns a new
// map that shares all but one path with the old one; the old map is unchanged. Walk it in order by matching on
// Node(left, key, value, right) and Empty.

// A map from text keys to values of type V. Start from Empty; put and get.
type Map[V] {
  Node(left: Map[V], key: View, value: V, right: Map[V], height: Int)
  Empty
}

// Does a sort before b, byte by byte?
fn before(a: View, b: View) -> Bool {
  before_from(a, b, at: 0)
}

// Internal: the loop of before.
fn before_from(a: View, b: View, at: Int) -> Bool {
  match {
    at >= len(b) -> False
    at >= len(a) -> True
    a[at] < b[at] -> True
    a[at] > b[at] -> False
    else -> before_from(a, b, at: at + 1)
  }
}

// The value under `key`, if there is one.
//
//   > Empty |> put(key: "lamp", value: 3) |> put(key: "desk", value: 1) |> get(key: "lamp")
//   Some(value: 3)
//   > Empty |> put(key: "lamp", value: 3) |> get(key: "rug")
//   None
fn get[V](map: Map[V], key: View) -> Option[V] {
  match map {
    Empty -> None
    Node(left, key: k) if before(a: key, b: k) -> get(map: left, key)
    Node(key: k, right) if before(a: k, b: key) -> get(map: right, key)
    Node(value) -> Some(value)
  }
}

// A map with `key` set to `value`; the old map is unchanged. Setting a key again replaces its value.
//
//   > Empty |> put(key: "a", value: 1) |> put(key: "a", value: 2) |> get(key: "a")
//   Some(value: 2)
fn put[V](map: Map[V], key: View, value: V) -> Map[V] {
  match map {
    Empty -> Node(left: Empty, key, value, right: Empty, height: 1)
    Node(left, key: k, value: v, right) if before(a: key, b: k) -> balance(
      left: put(map: left, key, value),
      key: k,
      value: v,
      right
    )
    Node(left, key: k, value: v, right) if before(a: k, b: key) -> balance(
      left,
      key: k,
      value: v,
      right: put(map: right, key, value)
    )
    Node(left, key: k, right, height) -> Node(left, key: k, value, right, height)
  }
}

// How many keys.
//
//   > Empty |> put(key: "a", value: 1) |> put(key: "b", value: 2) |> put(key: "a", value: 3) |> count
//   2
fn count[V](map: Map[V]) -> Int {
  match map {
    Empty -> 0
    Node(left, right) -> count(map: left) + 1 + count(map: right)
  }
}

// Internal: a tree's height.
fn height[V](map: Map[V]) -> Int {
  match map {
    Empty -> 0
    Node(height) -> height
  }
}

// Internal: a node with its height computed.
fn node[V](left: Map[V], key: View, value: V, right: Map[V]) -> Map[V] {
  match {
    height(map: left) > height(map: right) -> Node(
      left,
      key,
      value,
      right,
      height: height(map: left) + 1
    )
    else -> Node(left, key, value, right, height: height(map: right) + 1)
  }
}

// Internal: a node, rotated when one side is more than one taller.
fn balance[V](left: Map[V], key: View, value: V, right: Map[V]) -> Map[V] {
  match {
    height(map: left) > height(map: right) + 1 -> lean_right(left, key, value, right)
    height(map: right) > height(map: left) + 1 -> lean_left(left, key, value, right)
    else -> node(left, key, value, right)
  }
}

// Internal: a rotation when the left side is taller.
fn lean_right[V](left: Map[V], key: View, value: V, right: Map[V]) -> Map[V] {
  match left {
    Node(left: ll, key: lk, value: lv, right: lr) if height(map: ll) >= height(map: lr) -> node(
      left: ll,
      key: lk,
      value: lv,
      right: node(left: lr, key, value, right)
    )
    Node(
      left: ll,
      key: lk,
      value: lv,
      right: Node(left: lrl, key: lrk, value: lrv, right: lrr)
    ) -> node(
      left: node(left: ll, key: lk, value: lv, right: lrl),
      key: lrk,
      value: lrv,
      right: node(left: lrr, key, value, right)
    )
    _ -> node(left, key, value, right)
  }
}

// Internal: a rotation when the right side is taller.
fn lean_left[V](left: Map[V], key: View, value: V, right: Map[V]) -> Map[V] {
  match right {
    Node(left: rl, key: rk, value: rv, right: rr) if height(map: rr) >= height(map: rl) -> node(
      left: node(left, key, value, right: rl),
      key: rk,
      value: rv,
      right: rr
    )
    Node(
      left: Node(left: rll, key: rlk, value: rlv, right: rlr),
      key: rk,
      value: rv,
      right: rr
    ) -> node(
      left: node(left, key, value, right: rll),
      key: rlk,
      value: rlv,
      right: node(left: rlr, key: rk, value: rv, right: rr)
    )
    _ -> node(left, key, value, right)
  }
}
