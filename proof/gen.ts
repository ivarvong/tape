// proof/gen.ts: random well-typed Tape programs over numbers, booleans, immutable lists and maps, with function
// values that capture variables and `let`s that are used more than once (so values are shared). program(seed)
// returns the source of `fn f(n: Int) -> Int`.
export const PRELUDE = `fn or_zero(found: Option[Int]) -> Int {
  match found {
    Some(value) -> value
    None -> 0
  }
}
fn first(list: List[Int]) -> Int {
  match list {
    Cons(head) -> head
    Nil -> 0 - 1
  }
}
fn rest_of(list: List[Int]) -> List[Int] {
  match list {
    Cons(tail) -> tail
    Nil -> Nil
  }
}
fn total(list: List[Int]) -> Int {
  fold(list, from: 0, by: plus)
}
fn plus(a: Int, b: Int) -> Int {
  a + b
}
fn none() -> List[Int] {
  Nil
}
fn empty() -> Map[Int] {
  Empty
}
type Box { Box(items: List[Int], table: Map[Int]) }
fn keep(c: Bool, m: Map[Int]) -> Option[Map[Int]] {
  match {
    c -> Some(value: m)
    else -> None
  }
}
fn unwrap(o: Option[Map[Int]]) -> Map[Int] {
  match o {
    Some(value) -> value
    None -> Empty
  }
}
// takes the map out of the option and updates it: with the same option passed twice, the two results must differ
fn grow(o: Option[Map[Int]], v: Int) -> Map[Int] {
  match o {
    Some(value) -> put(map: value, key: "z", value: v)
    None -> Empty
  }
}
fn pick(c: Bool, a: Int, b: Int) -> Int {
  match {
    c -> a
    else -> b
  }
}
fn pick_list(c: Bool, a: List[Int], b: List[Int]) -> List[Int] {
  match {
    c -> a
    else -> b
  }
}
fn pick_map(c: Bool, a: Map[Int], b: Map[Int]) -> Map[Int] {
  match {
    c -> a
    else -> b
  }
}
`;
type Kind = 'I' | 'L' | 'M' | 'X' | 'O';
export function program(seed: number): string {
  let s = (seed * 2654435761 + 1) >>> 0;
  const rnd = (n: number): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return Math.floor((s / 4294967296) * n);
  };
  const one = <T extends string>(xs: readonly T[]): T => {
    const x = xs[rnd(xs.length)];
    if (x === undefined) throw new Error('nothing to choose from');
    return x;
  };
  const vars: Record<Kind, string[]> = { I: ['n'], L: [], M: [], X: [], O: [] };
  let names = 0;
  const key = (): string => `"${one(['a', 'b', 'c', 'd'])}"`;
  const I = (d: number, extra: string[] = []): string => {
    const leaf = (): string => one([String(rnd(10)), String(rnd(10)), ...vars.I, ...extra]);
    if (d <= 0) return leaf();
    // inside a function value: update a captured map, so a second call would see the first call's change if it were done in place
    if (extra.length > 0 && vars.M.length > 0 && rnd(4) === 0)
      return `count(map: put(map: ${one(vars.M)}, key: ${key()}, value: ${one(extra)}))`;
    switch (rnd(13)) {
      case 0:
      case 1:
        return leaf();
      case 2:
        return `(${I(d - 1, extra)} ${one(['+', '-', '*'])} ${I(d - 1, extra)})`;
      case 3:
        return `(${I(d - 1, extra)} ${one(['/', '%'])} ${one([I(d - 1, extra), String(1 + rnd(9))])})`;
      case 4:
        return `or_zero(found: get(map: ${M(d - 1, extra)}, key: ${one([key(), key(), '"z"'])}))`;
      case 5:
        return `count(map: ${M(d - 1, extra)})`;
      case 6:
        return `first(list: ${L(d - 1, extra)})`;
      case 7:
        return `total(list: ${L(d - 1, extra)})`;
      case 8:
        return `length(list: ${L(d - 1, extra)})`;
      case 9:
        return `pick(c: ${B(d - 1, extra)}, a: ${I(d - 1, extra)}, b: ${I(d - 1, extra)})`;
      case 10:
        return `height(map: ${M(d - 1, extra)})`;
      case 11:
        return `fold(list: ${L(d - 1, extra)}, from: ${I(d - 1, extra)}, by: plus)`;
      default:
        return `(0 - ${I(d - 1, extra)})`;
    }
  };
  const B = (d: number, extra: string[] = []): string =>
    d <= 0 || rnd(3) === 0
      ? `${I(d - 1, extra)} ${one(['<', '==', '>=', '!='])} ${I(d - 1, extra)}`
      : rnd(2) !== 0
        ? `not (${B(d - 1, extra)})`
        : `(${B(d - 1, extra)} ${one(['and', 'or'])} ${B(d - 1, extra)})`;
  const L = (d: number, extra: string[] = []): string => {
    const leaf = (): string => one(['none()', ...vars.L, ...vars.L, ...vars.X.map(x => `${x}.items`)]);
    if (d <= 0) return leaf();
    switch (rnd(8)) {
      case 0:
        return leaf();
      case 1:
      case 2:
        return `Cons(head: ${I(d - 1, extra)}, tail: ${L(d - 1, extra)})`;
      case 3:
        return `reverse(list: ${L(d - 1, extra)})`;
      case 4: {
        const x = `x${++names}`;
        return `map(list: ${L(d - 1, extra)}, by: fn(${x}: Int) -> Int { ${I(Math.min(d - 1, 2), [...extra, x])} })`;
      }
      case 5: {
        const x = `x${++names}`;
        return `filter(list: ${L(d - 1, extra)}, keep: fn(${x}: Int) -> Bool { ${B(Math.min(d - 1, 1), [...extra, x])} })`;
      }
      case 6:
        return `rest_of(list: ${L(d - 1, extra)})`;
      default:
        return `pick_list(c: ${B(d - 1, extra)}, a: ${L(d - 1, extra)}, b: ${L(d - 1, extra)})`;
    }
  };
  const M = (d: number, extra: string[] = []): string => {
    const leaf = (): string =>
      one([
        'empty()',
        ...vars.M,
        ...vars.M,
        ...vars.X.map(x => `${x}.table`),
        ...vars.O.map(o => `unwrap(o: ${o})`),
        ...vars.O.map(o => `grow(o: ${o}, v: ${String(rnd(10))})`),
      ]);
    if (d <= 0) return leaf();
    switch (rnd(5)) {
      case 0:
        return leaf();
      case 1:
      case 2:
      case 3:
        return `put(map: ${M(d - 1, extra)}, key: ${key()}, value: ${I(d - 1, extra)})`;
      default:
        return `pick_map(c: ${B(d - 1, extra)}, a: ${M(d - 1, extra)}, b: ${M(d - 1, extra)})`;
    }
  };
  const lets: string[] = [];
  for (let i = 0, n = 2 + rnd(6); i < n; i++) {
    const kind = one<Kind>(['I', 'L', 'L', 'M', 'M', 'X', 'O']),
      name = `${kind.toLowerCase()}${++names}`;
    const value =
      kind === 'I'
        ? I(3)
        : kind === 'L'
          ? L(3)
          : kind === 'M'
            ? M(3)
            : kind === 'X'
              ? `Box(items: ${L(2)}, table: ${M(2)})`
              : `keep(c: ${B(1)}, m: ${M(2)})`;
    lets.push(`  let ${name} = ${value}`);
    vars[kind].push(name);
  }
  return `${PRELUDE}fn f(n: Int) -> Int {\n${lets.join('\n')}\n  ${I(4)}\n}\n`;
}
