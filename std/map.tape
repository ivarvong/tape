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
  compare(a, b) < 0
}

// Where a sorts against b, byte by byte: -1 before it, 0 the same text, 1 after it. A text sorts before every
// longer text it starts.
//
//   > compare(a: "desk", b: "lamp")
//   -1
//   > compare(a: "lamp", b: "lam")
//   1
//   > compare(a: "rug", b: "rug")
//   0
fn compare(a: View, b: View) -> Int {
  compare_from(a, b, at: 0)
}

// The loop of compare.
private fn compare_from(a: View, b: View, at: Int) -> Int {
  match {
    at >= len(b) and at >= len(a) -> 0
    at >= len(b) -> 1
    at >= len(a) -> -1
    a[at] < b[at] -> -1
    a[at] > b[at] -> 1
    else -> compare_from(a, b, at: at + 1)
  }
}

// The value under `key`, if there is one. One comparison of the keys at each node.
//
//   > Empty |> put(key: "lamp", value: 3) |> put(key: "desk", value: 1) |> get(key: "lamp")
//   Some(value: 3)
//   > Empty |> put(key: "lamp", value: 3) |> get(key: "rug")
//   None
fn get[V](map: Map[V], key: View) -> Option[V] {
  match map {
    Empty -> None
    Node(left, key: k, value, right) -> {
      let order = compare(a: key, b: k)
      match {
        order < 0 -> get(map: left, key)
        order > 0 -> get(map: right, key)
        else -> Some(value)
      }
    }
  }
}

// A map with `key` set to `value`; the old map is unchanged. Setting a key again replaces its value. One
// comparison of the keys at each node.
//
//   > Empty |> put(key: "a", value: 1) |> put(key: "a", value: 2) |> get(key: "a")
//   Some(value: 2)
fn put[V](map: Map[V], key: View, value: V) -> Map[V] {
  match map {
    Empty -> Node(left: Empty, key, value, right: Empty, height: 1)
    Node(left, key: k, value: v, right, height) -> {
      let order = compare(a: key, b: k)
      match {
        order < 0 -> balance(left: put(map: left, key, value), key: k, value: v, right)
        order > 0 -> balance(left, key: k, value: v, right: put(map: right, key, value))
        else -> Node(left, key: k, value, right, height)
      }
    }
  }
}

// A map with the value under `key` replaced by `by` of it, or set to `by(from)` when the key is not there: one walk
// down the tree where get and then put take two, and a path whose heights did not change is not balanced again. Counting words is `put_with(map: counts, key: word, from: 0, by: plus_one)`.
//
//   > Empty |> put_with(key: "a", from: 0, by: fn(n: Int) -> Int { n + 1 }) |> put_with(key: "a", from: 0, by: fn(n: Int) -> Int { n + 1 }) |> get(key: "a")
//   Some(value: 2)
//   > Empty |> put_with(key: "a", from: 10, by: fn(n: Int) -> Int { n * 2 }) |> get(key: "a")
//   Some(value: 20)
fn put_with[V](map: Map[V], key: View, from: V, by: Fn[V, V]) -> Map[V] {
  match map {
    Empty -> Node(left: Empty, key, value: by(from), right: Empty, height: 1)
    Node(left, key: k, value: v, right, height) -> {
      let order = compare(a: key, b: k)
      match {
        order < 0 -> {
          let was = height(map: left)
          let l = put_with(map: left, key, from, by)
          match {
            height(map: l) == was -> Node(left: l, key: k, value: v, right, height)
            else -> balance(left: l, key: k, value: v, right)
          }
        }
        order > 0 -> {
          let was = height(map: right)
          let r = put_with(map: right, key, from, by)
          match {
            height(map: r) == was -> Node(left, key: k, value: v, right: r, height)
            else -> balance(left, key: k, value: v, right: r)
          }
        }
        else -> Node(left, key: k, value: by(v), right, height)
      }
    }
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

// A tree's height.
private fn height[V](map: Map[V]) -> Int {
  match map {
    Empty -> 0
    Node(height) -> height
  }
}

// A node with its height computed.
private fn node[V](left: Map[V], key: View, value: V, right: Map[V]) -> Map[V] {
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

// A node, rotated when one side is more than one taller.
private fn balance[V](left: Map[V], key: View, value: V, right: Map[V]) -> Map[V] {
  match {
    height(map: left) > height(map: right) + 1 -> lean_right(left, key, value, right)
    height(map: right) > height(map: left) + 1 -> lean_left(left, key, value, right)
    else -> node(left, key, value, right)
  }
}

// A rotation when the left side is taller.
private fn lean_right[V](left: Map[V], key: View, value: V, right: Map[V]) -> Map[V] {
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

// A rotation when the right side is taller.
private fn lean_left[V](left: Map[V], key: View, value: V, right: Map[V]) -> Map[V] {
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
