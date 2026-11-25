// std/math.tape: Float's constants. Its functions (sqrt, sin, cos, tan, asin, acos, atan2, exp, log, pow) and its
// operators (+ - * / %) are built in, compiled into the module so they give the same bits everywhere: docs/std.md
// lists them with the built-ins.

// pi, as the Float nearest it (0x400921FB54442D18, which JavaScript's Math.PI is). A function, as std has no
// constants: `deg * pi() / 180f` is radians.
//
//   > pi()
//   3.141592653589793f
//   > acos(x: -1f) == pi()
//   True
//   > 2f * asin(x: 1f) == pi()
//   True
fn pi() -> Float {
  3.141592653589793f
}
