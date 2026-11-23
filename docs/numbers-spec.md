# Numbers: `Dec` and `Float` (specification, not implemented)

Status: proposal, 22 November 2026. Targets language 0.3, built on 0.2 (Int overflow traps, negative literals,
a one-parameter function's argument passed positionally). Nothing here is in the compiler yet. The LANGUAGE.md
text it would add is in [`numbers-language-draft.md`](numbers-language-draft.md).

The aim is that the easy choice is the right one for a durable service. A literal with a point in it is exact.
Money cannot be divided without naming a rounding. A value that could lose a cent on its way to SQL or JSON is
refused, at compile time where that is possible and at run time otherwise. `Float` is for measurements, and the
rules keep it out of storage, keys and guards.

Every claim about current code cites the file. Claims checked in this session are marked **(checked)**.

---

## 0. Findings that change the brief

| # | Brief said | Evidence | Consequence |
|---|---|---|---|
| F1 | "Tape parses JSON bytes itself (decode.ts)" | It does not. `compiler/gen/decode.ts` calls the host import `env.json`, and `host/memory.ts` `decodeJson` runs `JSON.parse` (header comment: "decodes JSON with the platform's JSON.parse"). `interp/json.ts:70` does the same. Every JSON number passes through a double today. | Exact Dec decode needs the host change in §7.1. It uses `JSON.parse` with a reviver that reads `context.source` and returns `JSON.rawJSON`. Checked on Node 24.18: `12.345678901234567891` keeps all its digits, nested too, and `JSON.stringify` writes it back verbatim **(checked)**. workerd and browsers are unverified (§11, Q1). |
| F2 | "bound as BigInt or within ±2^53" | `sql/analyze.ts` `integerParams`: neither the DO SQL API nor node:sqlite binds a BigInt ("Cannot convert a BigInt value to a number"). Every JS number binds as REAL, so Int is sent as `CAST(?n AS INTEGER)`. `host/memory.ts` `readParams` throws `sql: parameter outside ±2^53`. Its `int()` refuses a cell outside ±2^53. | A BigInt binding is not available. Dec uses Int's path exactly: minor units as a JS number, `CAST(?n AS INTEGER)`, the request stops outside ±2^53, and no digit is lost (§8). The full i64 range would need text binding (Q2). |
| F3 | Rules cite a defect each (docs/design.md, "No rule without a defect behind it") | No Tape program has floats, so no recorded defect exists for C89 to C92. | Each new rule ships with a sim scenario that shows the defect it prevents, planted and caught (§12.4). See Q3. |
| F4 | "Float into any SQL column" and "Float as REAL" | These two conflict. | Specified as follows. A Float is never a SQL parameter (C89). A `REAL` column, or an expression such as `avg(x)`, can be read into a Float field. Q4 asks whether writes should get an opt-out. |
| F5 | "rescale(x, to: 2) exact-only" | Scaling down is exact only for some values, and that is known only at run time. | `rescale` only scales up. It is always exact and traps on overflow. Scaling down is `round` and needs a rounding. There is one way to do each job (§5.4). |
| F6 | JSON: "a number with more decimals than the scale" is refused | Is `12.340` for a `Dec[2]` refused? | Specified by value: refused only when the value is not exactly a `Dec[2]`. `12.340` is accepted and `12.345` is refused. See Q5. |
| F7 | `min`/`max` as new built-ins | `apps/trace/trace.tape:1193,1200` defines `fn max(a: Int, b: Int)` and `fn min`. | Either make the built-ins accept Int too and delete those two functions in the same change, or rename them. See §10. |

---

## 1. Grammar

### 1.1 Literals (lexer, `compiler/lex.ts` `number()`)

```
number   = digits [ "." digits ] [ exponent ] [ "f" ]
digits   = "0".."9" { "0".."9" }
exponent = ( "e" | "E" ) [ "+" | "-" ] digits
```

| Written | Token | Notes |
|---|---|---|
| `42` | `int` 42 | as today |
| `12.30` | `dec` mantissa 1230, scale 2 | the scale is the number of digits after the point. Trailing zeros count |
| `0.5` | `dec` 5, scale 1 | |
| `1.5f`, `2f`, `1e-3f`, `6.02E23f` | `float` | the value is rounded to the nearest f64 once, at compile time, with `Number()` on the digits. ≤ 20 significant digits (§6.6) |
| `1e3`, `1.5e2` | L06 | "an exponent is only for a Float: write `1e3f`, or the digits `1000`" |
| `1.`, `.5`, `1.5x`, `1.5ff` | L06 | "a number is digits, then `.` and digits, then `f` for a Float" |
| `-1.50` | negative `dec` literal | per 0.2's negative literals. `-0.00` is 0 (Dec has no negative zero). `-0f` is the f64 -0, which no Tape operation can tell from 0 (§6.4) |

A digit after `.` is required. That keeps `x.field` and `1.5` apart, since no field name starts with a digit.
The words `Dec` and `Float` are not reserved. They become built-in type names (`compiler/types.ts`
`BUILTIN_TYPES`).

### 1.2 Types (parser, `compiler/parse/decl.ts`; `TypeAst`, `compiler/ast.ts:22`)

```
type_arg = type | digits          (digits only as the argument of Dec)
```

| Written | Meaning | Internal `Type` |
|---|---|---|
| `Dec[2]` | exact decimal, scale 2 | `{ name: 'Dec', args: [{ name: '2', args: [] }] }`, so `key()` gives `Dec[2]` and fingerprints separate scales for free (`compiler/build.ts:134`) |
| `Dec` without a scale | C14: "say the scale: `Dec[2]` for cents" | |
| `Dec[19]`, `Dec[x]` | C14: "a Dec's scale is 0 to 18" | |
| `Float` | IEEE 754 binary64, finite | `T('Float')` |
| `Option[Dec[2]]`, `List[Float]`, `type Money = Dec[2] where self >= 0.01` | as for any type | refinements work unchanged ("not a valid Money") |

v1 has no polymorphism over the scale (no `fn f[s](x: Dec[s])`). Operations that work at any scale are
intrinsics.

### 1.3 Declaration (new; `compiler/parse/decl.ts`)

```
column orders.amount: Dec[2]
```

This says that column `amount` of `orders` holds `Dec[2]` in minor units. `column` is a word that has this
meaning only at the start of a top-level declaration, like `machine`. §8 gives the rules.

### 1.4 Rounding (std, `std/core.tape`)

```
type Rounding { HalfEven  HalfUp  Down  Up  Floor  Ceiling }
```

---

## 2. Type rules

There are no implicit conversions. "Context" means the type `emit` is handed as `expected` (`compiler/gen/expr.ts`
`emit(c, e, expected, tail)`). That covers arguments, constructor fields, a function's result, the other side of
a binary operator, and a match arm against its siblings.

### 2.1 Typing literals

| Literal | No context | Context `Dec[s]` | Context `Float` | Context `Int` |
|---|---|---|---|---|
| `7` | Int | `Dec[s]` 7·10^s (C14 if it overflows) | Float 7 (C14 if \|n\| > 2^53) | Int |
| `12.30` | `Dec[2]` | `Dec[s]` when the value is exact at s (`12.3` fits `Dec[2]` as 12.30). Otherwise C14: "12.345 is not exactly a Dec[2]: write 12.35, or round(…)" | Float, nearest f64 | C14: "12.30 is not an Int" |
| `1.5f` | Float | C14: "a Float is not a Dec: `to_dec(1.5f, scale: 2, rounding: …)`, or write 1.50" | Float | C14 |

A binary operator types the non-literal side first and hands that type to the literal. The literal is a constant
with no effects, so emitting it after the other side keeps Wasm stack order. This makes `price + 1.5`,
`1.5 + price` and `price > 0` all type at `price`'s scale. With two literals and no context, each takes its own
default (`1.5 + 2.25` is `Dec[1] + Dec[2]`, which is C14).

### 2.2 Operators

| Expr | Dec[a] ∘ Dec[b] | Dec[a] ∘ Int / Int ∘ Dec[a] | Float ∘ Float | Float ∘ Int, Dec ∘ Float |
|---|---|---|---|---|
| `+ -` | a = b: `Dec[a]`. a ≠ b: **C14**, "Dec[2] + Dec[3]: the scales differ. Make them equal: `rescale(x, to: 3)` (exact), or `round(y, to: 2, rounding: HalfEven)`" | C14, "an Int is not a Dec: `to_dec(n, scale: 2)`" | Float | C14, naming `to_float(n)` / `to_dec(x, scale:, rounding:)` |
| `*` | `Dec[a+b]`. C14 when a+b > 18: "round one side first" | `Dec[a]` (price × quantity, exact) | Float | C14 |
| `/` `%` | C19, "Dec has no `/`: `div(a, by: b, scale: 2, rounding: HalfEven)`" | C19, the same | `/` Float, `%` C19 | C14 |
| `== != < <= > >=` | Bool, **any** a, b, exact (§5.3) | C14, "compare with a Dec: `n` as `to_dec(n, scale: 0)`" | Bool, IEEE | C14 |
| unary `-` | `Dec[a]` (traps on MIN) | | Float | |
| `& | ^ << >>` | C19 | | C19 | |
| `++`, `\(x)` hole | `\(x)` writes canonical text (§5.7). `++` is C19 as for Int | | `\(x)` writes shortest text (§6.6) | |

### 2.3 Patterns

| Pattern | Rule |
|---|---|
| Dec literal `0.00`, `-1.5` | allowed. It is typed by the subject's scale and must fit exactly (C14). It matches on equal value |
| Float literal | **C19**, "a Float is matched with a guard: `x if x == 0f -> …`". Exact float equality is a value the program should spell out |
| `parse_dec(…)` as a pattern | not possible: it takes two parameters (LANGUAGE.md §5 allows one-parameter functions only) |

---

## 3. Representation

| Type | Wasm value (`compiler/gen/layout.ts` `FIXED`) | In memory (records, rows) | In SQL | In JSON (out) | In JSON (in) |
|---|---|---|---|---|---|
| `Dec[s]` | one `i64` m, value m·10^-s | 8 bytes, `i64.store` | INTEGER m, in a column declared `Dec[s]` (§8) | string `"12.30"` | string or number, exact (§7) |
| `Float` | one `f64` (new valtype 0x7c in `common.ts` next to `I32`/`I64`) | 8 bytes, `f64.store` | read from a REAL value only (§8.3) | shortest round-trip number | number |

Range of `Dec[s]`: m ∈ [-2^63, 2^63-1]. In SQL, m ∈ [-2^53, 2^53] (F2).

| s | Largest Dec[s] | Largest stored in SQL |
|---|---|---|
| 0 | 9,223,372,036,854,775,807 | 9,007,199,254,740,992 |
| 2 | 92,233,720,368,547,758.07 | 90,071,992,547,409.92 (≈ $90 trillion) |
| 4 | 922,337,203,685,477.5807 | 900,719,925,474.0992 |
| 6 | 9,223,372,036,854.775807 | 9,007,199,254.740992 |
| 8 | 92,233,720,368.54775807 | 90,071,992.54740992 (all 21M BTC in satoshi fits) |
| 18 | 9.223372036854775807 | 0.009007199254740992 (wei is not storable; Q2) |

---

## 4. Rounding modes

There is one routine for all of them. The input is an exact quotient: sign σ ∈ {+1, -1}, magnitude quotient q
(truncated), remainder r, and divisor D, with 0 ≤ r < D. The rounded magnitude is q or q+1:

| Mode | q+1 when | Same as |
|---|---|---|
| `Down` | never (toward zero) | Python `ROUND_DOWN`, Java `DOWN` |
| `Up` | r > 0 (away from zero) | `ROUND_UP` |
| `Floor` | r > 0 and σ < 0 | `ROUND_FLOOR` |
| `Ceiling` | r > 0 and σ > 0 | `ROUND_CEILING` |
| `HalfUp` | r ≥ D − r (ties away from zero) | `ROUND_HALF_UP`. **Not** JS `Math.round`, which sends ties toward +∞ |
| `HalfEven` | r > D − r, or r = D − r and q is odd | `ROUND_HALF_EVEN`, IEEE roundTiesToEven |

Comparing r with D − r avoids computing 2r, which could overflow. D − r cannot underflow because r < D.

Worked edge cases (round to scale 0; every cell produced by Python 3.14.6 `decimal.quantize` **(checked)**; Dec
has no negative zero, so Python's `-0` is shown as 0):

| x | HalfEven | HalfUp | Down | Up | Floor | Ceiling |
|---|---|---|---|---|---|---|
| -2.5 | -2 | -3 | -2 | -3 | -3 | -2 |
| -1.5 | -2 | -2 | -1 | -2 | -2 | -1 |
| -0.5 | 0 | -1 | 0 | -1 | -1 | 0 |
| -0.4 | 0 | 0 | 0 | -1 | -1 | 0 |
| 0.5 | 0 | 1 | 0 | 1 | 0 | 1 |
| 1.5 | 2 | 2 | 1 | 2 | 1 | 2 |
| 2.5 | 2 | 3 | 2 | 3 | 2 | 3 |
| 2.49 | 2 | 2 | 2 | 3 | 2 | 3 |
| -2.51 | -3 | -3 | -2 | -3 | -3 | -2 |
| MIN of Dec[2] = -92233720368547758.08 | -92233720368547758 | -92233720368547758 | -92233720368547758 | -92233720368547759 | -92233720368547759 | -92233720368547758 |
| the same, to scale 1 | -92233720368547758.1 | -92233720368547758.1 | -92233720368547758.0 | -92233720368547758.1 | -92233720368547758.1 | -92233720368547758.0 |
| MAX of Dec[2], to scale 1 | 92233720368547758.1 | 92233720368547758.1 | 92233720368547758.0 | 92233720368547758.1 | 92233720368547758.0 | 92233720368547758.1 |

Division (scale 2):

| div(a, by: b) | HalfEven | HalfUp | Down | Up | Floor | Ceiling |
|---|---|---|---|---|---|---|
| 1.00 / 3.00 | 0.33 | 0.33 | 0.33 | 0.34 | 0.33 | 0.34 |
| 2.00 / 3.00 | 0.67 | 0.67 | 0.66 | 0.67 | 0.66 | 0.67 |
| -1.00 / 8 (as Dec[0]) | -0.12 | -0.13 | -0.12 | -0.13 | -0.13 | -0.12 |
| MIN / -1.00 | trap | trap | trap | trap | trap | trap |
| x / 0.00 | trap | trap | trap | trap | trap | trap |

Rounding the magnitude of MIN up at scale 0 never overflows, since |q| ≤ 2^63 / 10. The final step negates an
unsigned magnitude into i64 and traps only when the magnitude exceeds 2^63−1 for σ = +1 or 2^63 for σ = −1.

---

## 5. Dec operations

The notation is m for the mantissa and s for the scale. "Trap" is `TRAP.ARITH` (`compiler/common.ts`): the
request ends, its writes are undone, and the trap is recorded (LANGUAGE.md §10). The Wasm column counts
instructions after operands are on the stack. Cycle figures are estimates for x86-64 V8 Liftoff/TurboFan and have
not been measured (§13, phase 1 measures them).

| Operation | Type | Exact semantics | Traps | Wasm lowering | ≈ cost |
|---|---|---|---|---|---|
| `a + b`, `a - b` | Dec[s]² → Dec[s] | m_a ± m_b | i64 overflow | 0.2's checked `i64.add`/`sub` | 1 op + 0.2's check (~4) |
| `-a` | Dec[s] | −m_a | m_a = MIN | `0 - m` checked | ~4 |
| `a * b` | Dec[s]·Dec[t] → Dec[s+t] | m_a·m_b, scale s+t ≤ 18 (compile time) | overflow | 0.2's checked `i64.mul` | 1 mul + check (~25 if division-checked) |
| `a * n`, `n * a` | Dec[s]·Int → Dec[s] | m_a·n | overflow | the same | the same |
| `==`, `<`, … same scale | | compare m | none | `i64.eq` / `lt_s` … | 1 |
| `==`, `<`, … s < t | | compare m_a·10^(t−s) with m_b | none | §5.3 | ~8 |
| `abs(a)` | Dec[s] | \|m\| | MIN | select | ~5 |
| `min(a, b)`, `max(a, b)` | Dec[s]² (same scale; C14 otherwise) | | none | compare + select | 3 |
| `rescale(a, to: t)` | Dec[s] → Dec[t], t ≥ s (C14 when t < s: "scaling down loses digits: `round(a, to: t, rounding: …)`") | m·10^(t−s) | overflow | checked mul by constant | ~25 |
| `round(a, to: t, rounding: R)` | Dec[s] → Dec[t], t < s (C14 when t ≥ s, naming `rescale`) | §4 with D = 10^(s−t) | none (\|q\| shrinks) | `i64.div_s`, `i64.rem_s`, magnitude, §4 | ~2 div + 12 |
| `div(a, by: b, scale: t, rounding: R)` | Dec[s], Dec[u] → Dec[t] | §5.2 | b = 0; result outside i64 | §5.2 | ~2 `div_u` + 40 (~80–150 cycles) |
| `to_int(a, rounding: R)` | Dec[s] → Int | `round(a, to: 0, …)`'s m | none | as `round` | ~2 div + 12 |
| `to_dec(n, scale: t)` | Int → Dec[t] | n·10^t | overflow | checked mul | ~25 |
| `to_float(a)` | Dec[s] → Float | nearest f64 to m·10^-s, correctly rounded (§6.5) | none | fast path or host | ~5 / host call |
| `\(a)`, `append`, `write_json` | | canonical text (§5.7) | none | std `write_dec(out, m, s)` in Tape | ~ like `write_int` |
| `parse_dec(text, scale: t)` | View → Option[Dec[t]] | §5.6 | none (None instead) | std Tape `dec_of_text` | linear in length |

`R` is any `Rounding` value. When it is a constructor written at the call, the compiler emits only that mode.
Otherwise it emits a `br_table` over the six.

### 5.1 Overflow checks

These reuse 0.2's checked Int ops, whatever lowering 0.2 chose for `+ - *`. Multiplying by a constant 10^k
(rescale, to_dec, cross-scale compare) can use a cheaper check: |m| ≤ ⌊(2^63−1)/10^k⌋, one compare per sign.
There is a corner at MIN: −2^63 is divisible by 10^k only for k = 0, so the negative bound is
⌈−2^63/10^k⌉ = −⌊2^63/10^k⌋, the same magnitude.

### 5.2 `div`: algorithm and correctness

We want q* = (m_a·10^-s) / (m_b·10^-u), rounded at scale t. Let k = t + u − s, so that
q* = m_a·10^k / m_b exactly.

1. If m_b = 0, trap.
2. Compile-time bound: refuse with C14 when k > 18 or k < −18 ("the result's scale is too far from the operands':
   round an operand first"). With s, u, t ≤ 18, k lies in [−18, 36]. The bound keeps the numerator below 2^123.
3. Take σ = sign(m_a)·sign(m_b) and magnitudes A = |m_a|, B = |m_b|, both u64 and ≤ 2^63.
4. If k ≥ 0, set N = A·10^k as a 128-bit (hi, lo) product and D = B. Since N < 2^63·10^18 < 2^123, it fits.
   The product is a 64×64→128 multiply built from four 32×32 `i64.mul`s. If k < 0, set N = A and
   D = B·10^−k (< 2^123). When D ≥ 2^64 (hi ≠ 0), then N < D, so q = 0 and r = N.
5. Divide when D fits in u64 and N is 128-bit. If hi(N) ≥ D, the quotient is ≥ 2^64: trap, which is overflow
   anyway. Otherwise use Hacker's Delight 2nd ed. §9-4 `divlu` (128/64 → 64-bit quotient and remainder): normalise
   so D's top bit is set, then compute two 32-bit quotient digits, each estimated from the top two digits and
   corrected at most twice. This is Knuth TAOCP vol. 2 §4.3.1, Algorithm D, whose Theorem B says the estimate is at
   most 2 too large.
6. Round with §4 using (σ, q, r, D), then check the magnitude against i64 (§4, last paragraph).

The quotient is exact because steps 4–5 compute the true integer quotient and remainder of N by D, and
N/D = |q*|. Every rounding mode needs only q's parity, whether r is 0, and how r compares with D − r. All three
come from exact integers. Under the bound in step 2 no intermediate exceeds 128 bits.

The interpreter does the same in a few lines of BigInt (`N = A * 10n**k; q = N / D; r = N % D`), with none of the
limb arithmetic, so it is an independent check of step 5 (§9).

Cost: 4 `i64.mul` + 2 `i64.div_u` + ~40 simple ops. That is roughly 80–150 cycles (unmeasured), about the cost of
a small std call, and well under one SQL statement.

### 5.3 Comparison across scales

For s < t, set k = t − s and a' = m_a·10^k. If computing a' overflows, the result is decided by sign(m_a): a' is
then outside [−2^63, 2^63−1], so |a'| > |m_b| for every i64 m_b. Otherwise compare a' with m_b. This is exact
and never traps. `1.50 == 1.5` is True.

### 5.4 One way to change a scale

| Job | Form | Otherwise |
|---|---|---|
| Up (more digits) | `rescale(x, to: 3)` | `round` with a larger scale: C14, naming `rescale` |
| Down (fewer digits) | `round(x, to: 2, rounding: HalfEven)` | `rescale` to a smaller scale: C14, naming `round` |
| Divide | `div(a, by: b, scale: 2, rounding: HalfEven)` | `/`: C19 |
| Dec → Int | `to_int(x, rounding: Down)` | |
| Int → Dec | `to_dec(n, scale: 2)` | |
| Float → Dec | `to_dec(x, scale: 2, rounding: HalfEven)` | |
| Split a total into n parts that add up | std `allocate(total, parts: n) -> List[Dec[s]]` (§10). The remainder goes one minor unit at a time to the first parts | `div` n times, which loses cents |

### 5.5 Mixed scales are a type error, not a rule

A mismatch is C14, raised by `need` (`compiler/gen/fn.ts:127`), with the hint given in §2.2. A scale mismatch
says nothing about retries or rows, so it does not belong in `rules/`.

### 5.6 Text → Dec (`parse_dec`, JSON strings and numbers)

The accepted grammar is JSON's number grammar (RFC 8259 §6):
`-? (0 | [1-9][0-9]*) (\.[0-9]+)? ([eE][+-]?[0-9]+)?`. Leading `+`, leading zeros, a bare `.5` or `1.` and any
whitespace are refused. The value is D·10^(e−f), where D is the digit string, f the number of fractional digits
and e the exponent. Strip z trailing zeros from D (D = 0 → value 0), and let shift = e − f + t + z. If shift < 0,
the value is not exact at scale t: refuse. If D' (D without its zeros) has more than 19 digits, or D'·10^shift
overflows i64, refuse. Otherwise m = ±D'·10^shift. The exponent is read with saturation at ±10^6, since anything
beyond that is refused anyway. A refusal is `None` from `parse_dec`, and from `decode` it is
`<path>: not a valid Dec[2]` (§7.1).

| Text, scale 2 | Result |
|---|---|
| `12.3`, `12.30`, `12.300`, `1.23e1`, `1230e-2` | 12.30 |
| `12.345` | refused |
| `-0.00` | 0 |
| `92233720368547758.08` | refused (above MAX) |
| `-92233720368547758.08` | MIN |
| `1e999999999999` | refused, without overflowing the exponent read |
| ` 12`, `+12`, `012`, `12.`, `.5`, `0x10`, `` (empty) | refused |

### 5.7 Dec → text

The form is `-`? integer part, then `.` and exactly s digits (none when s = 0), with no exponent and no `+`.
Examples: `12.30`, `-0.05`, `0.00`, `-92233720368547758.08`. Writing MIN must not negate the mantissa. Following
`std/text.tape` `write_int`, it writes the last digit from `m % 10` before negating `m / 10`.

---

## 6. Float operations

Float is the f64 values that are not NaN and not ±∞. Every operation whose IEEE result would be NaN or ±∞ traps
(`TRAP.ARITH`) before the value can be seen. Every other result is the one the Wasm spec defines.

| Operation | Semantics | Traps | Wasm | Interpreter |
|---|---|---|---|---|
| `+ - * /` | IEEE 754-2019 §5.4.1, roundTiesToEven (Wasm Core 2.0 §4.3.3 `fadd`/`fsub`/`fmul`/`fdiv`) | result non-finite (overflow, x/0, 0/0) | op + finite check | JS `+ - * /`, which ECMA-262 §6.1.6.1 defines as IEEE roundTiesToEven |
| unary `-` | negate | none | `f64.neg` | `-x` |
| `sqrt(x)` | correctly rounded (IEEE §5.4.1; Wasm `fsqrt`) | x < 0 | `f64.sqrt` + check | `Math.sqrt`. ECMA-262 says only "implementation-approximated", so §9 checks it against a BigInt reference |
| `abs`, `floor`, `ceil`, `trunc` | exact (IEEE §5.3.1 roundToIntegral…) | none | `f64.abs/floor/ceil/trunc` | `Math.abs/floor/ceil/trunc` (exact in ECMA-262) |
| `nearest(x)` | roundToIntegralTiesToEven | none | `f64.nearest` | **not** `Math.round` (ties toward +∞). It is written by hand: t = trunc(x), d = x − t (exact), then the §4 HalfEven rule |
| `min`, `max` | Wasm `fmin`/`fmax`: min(−0, +0) = −0 | none | `f64.min/max` | `Math.min/max` (also −0) |
| `== != < <= > >=` | IEEE comparison. With no NaN this is a total preorder in which −0 = +0 | none | `f64.eq/lt/…` | JS comparisons |
| `to_float(n)` | Int → nearest f64, roundTiesToEven | none | `f64.convert_i64_s` (Wasm §4.3.3 `convert`) | `Number(n)`, also correctly rounded (ECMA-262 Number(BigInt) → 𝔽(ℝ)) |
| `to_int(x, rounding: R)` | §4 on the exact value of x | outside i64 | Down `f64.trunc`, Floor `f64.floor`, Ceiling `f64.ceil`, HalfEven `f64.nearest`. Up and HalfUp: t = trunc(x), d = x − t (exact), then §4. After that a range check and `i64.trunc_f64_s` | BigInt from the double's exact bits |
| `to_dec(x, scale: t, rounding: R)` | §6.3 | outside Dec[t] | §6.3 | BigInt from exact bits |
| `\(x)`, `write_json`, `append` | shortest round-trip (§6.6) | none | host import `env.float_text` | the same JS `String` (shared) |
| `parse_float(text)` | §6.6 | none (None) | host import `env.text_float` | the same (shared) |
| `%`, bitwise, `++`, Float literal patterns | C19 | | | |

There is no `pow`, `exp`, `log`, `sin` and so on in v1, because host `Math.*` is implementation-approximated. A
later version can add them as pure Tape in std (correctly rounded or not, but deterministic).

### 6.1 Finite check

After each op that can produce a non-finite value: `local.tee`, `f64.abs`, `f64.const +inf`, `f64.lt`,
`i32.eqz`, `br_if $trap`. That is 5 instructions. A NaN fails `<` and so traps too. Ops that cannot produce one
skip the check: `neg abs floor ceil trunc nearest min max`, comparisons, and `convert`.

### 6.2 Subnormals

The Wasm spec gives subnormals full IEEE semantics with no flush-to-zero, so results are deterministic and
nothing traps. Underflow to 0 is allowed.

### 6.3 Float → Dec, exact

x is m·2^e exactly, with m < 2^53 read from the bits (`i64.reinterpret_f64`). The target is m·2^e·10^t, rounded
by R.

- If e ≥ 0: compute m·10^t as a 128-bit product (< 2^113), shift it left by e, and trap if the result reaches
  2^63 or more. There is no remainder.
- If e < 0: compute N = m·10^t (128-bit) and D = 2^−e. Then q = N >> −e, r = N & (D−1), and round with §4.
  "r vs D − r" becomes "r vs 2^(−e−1)". If −e ≥ 128, q = 0 and r = N.

Worked cases, Python `Decimal(float).quantize` **(checked)**:

| x | to_dec(x, scale: 2, HalfEven) | HalfUp | why |
|---|---|---|---|
| `0.1f` | 0.10 | 0.10 | exact value 0.1000000000000000055511… |
| `2.675f` | 2.67 | **2.67** | exact value 2.67499999999999982236…, below the tie |
| `1.005f` | 1.00 | 1.00 | below the tie |
| `0.1f + 0.2f` | 0.30 | 0.30 | 0.30000000000000004 |

### 6.4 Negative zero

−0 exists in the machine, but no v1 operation can tell it from +0. It compares equal to +0. Division by it traps,
as division by +0 does. `sqrt(−0)` = −0, `min`/`max` return −0 or +0, both equal to 0. Text gives `"0"`
(`String(-0)` is `"0"` **(checked)**), JSON gives `0`, and `to_dec` and `to_int` give 0. So it needs no
canonicalising instruction.

### 6.5 Dec → Float, correctly rounded

If |m| ≤ 2^53, then f64(m) is exact and 10^s (s ≤ 18 < 22) is exact. One IEEE division of two exact operands is
correctly rounded (Clinger's fast path), so the result is `f64.convert_i64_s(m) / 10^s`. If |m| > 2^53, call
`env.text_float` on the Dec's canonical text. That is correctly rounded with ≤ 20 significant digits (§6.6), and m
has at most 19 digits.

### 6.6 Text ↔ Float (host imports; shared with the interpreter)

| Direction | Host does | Why |
|---|---|---|
| text → Float (`parse_float`, JSON) | 1) the text must match the JSON number grammar (§5.6). JS `Number()` alone would accept `""` → 0, `" 1 "`, `"0x1f"` → 31 and `"1."` **(checked)**. 2) **≤ 20 significant digits**, else refused. 3) `Number(text)`. 4) Refused if not finite (`1e400`). Returns NaN to signal "refused", which the module tests with `f64.ne` | ECMA-262 `RoundMVResult` is correctly rounded at 20 significant digits or fewer. Above that it is an implementation-defined choice between two values, so step 2 is what makes it deterministic across engines |
| Float → text | `String(x)`, the same as `JSON.stringify(x)` for finite x | ECMA-262 Number::toString makes the digit count k minimal. When several digit strings of that length round-trip, its Note 2 *recommends* the closest without requiring it. V8 (workerd, Node, Chrome), SpiderMonkey and JavaScriptCore all pick the closest, but that is on trust (§9 cross-checks against Python `repr`, which is shortest-closest) |

Examples: `String(5)` = `5` (not `5.0`), `1e21` → `1e+21`, `1e-7` → `1e-7` **(checked)**. All of them are valid
JSON. The imports are pure functions and are not in the effect log. Replay is deterministic on one engine family,
and on all three in practice (§9.5).

---

## 7. JSON

### 7.1 Decode (`host/memory.ts` `decodeJson`, `interp/json.ts`)

The new shape kinds (`compiler/gen/layout.ts` `jsonKind`) are `d<s>` (`d2` for Dec[2]) and `f`.

| Change | Detail |
|---|---|
| Exact numbers | When a shape anywhere in the decode has `d` or `f`, call `JSON.parse(text, (k, v, ctx) => typeof v === 'number' ? JSON.rawJSON(ctx.source) : v)`. Every number then reaches `fit()` as its source text, and nested values handed on with `JSON.stringify` (`nested()`) keep their digits **(checked on Node 24.18)**. Int fields keep today's check on `Number(src)`. Without a `d` or `f` field the path is today's, with no cost. |
| Feature check | At instantiate, if `JSON.parse('1', (k, v, c) => c?.source)` is not `'1'` or `JSON.rawJSON` is missing, a module whose shapes contain `d` throws `this platform cannot decode Dec exactly`. It refuses rather than lose digits. |
| `d<s>` field | accepts a JSON number (its source) or a JSON string. Both go through the grammar and exactness of §5.6. Otherwise the reason is `amount: not a valid Dec[2]` (the house form, as `decode.ts` `checkRefined` writes `not a valid Money`). In a nested value the existing path prefix applies (`[3].amount: …`, `std/json.tape:440`). |
| `f` field | a JSON number only, as §6.6 (≤ 20 significant digits, finite). Otherwise `x: not a valid Float`. A string is refused, because a client that sends a Float as text has made a decision the type does not record. |
| Written to memory | `d`: an i64 written with `setBigInt64` (the existing `setInt64` takes a JS number ≤ 2^53, and a Dec needs the full i64). `f`: `setFloat64`. |

### 7.2 Encode (`compiler/gen/intrinsic.ts` `writeJson`, `compiler/wire.ts`)

| Type | Written | Why |
|---|---|---|
| `Dec[s]` | `"12.30"` (a JSON string, canonical per §5.7) | A JS client's `JSON.parse` would turn the number `12.30` into a double. A string makes the reader decide, and it decodes exactly in Tape (§7.1), so program-to-program messages are exact either way. Q6 asks whether to offer `as_number` |
| `Float` | shortest round-trip number (§6.6) | JSON has no NaN or ∞, and Float has none either |

Message fingerprints (`compiler/build.ts:134`) already include the type's `key`, so a `Dec[2]` sender and a
`Dec[3]` receiver do not talk (`test/json.ts` gets a case for this).

---

## 8. SQL

### 8.1 Dec columns

| Item | Specification |
|---|---|
| Declaration | `column orders.amount: Dec[2]` next to the migrations. The table and column must exist after the migrations (C68). |
| Storage | INTEGER m (minor units). The column must have INTEGER affinity (`sql/schema.ts` `affinity` → `'int'`). |
| What the SQL sees | `amount` is 1230 for 12.30. `CHECK (amount > 0)` and `SUM(amount)` are in minor units. |
| Binding | parameter kind `d` (`compiler/gen/sql.ts` `bindParams`): the i64 goes in the parameter block as for Int, and `integerParams` (`sql/analyze.ts`) wraps `d` as `CAST(?n AS INTEGER)`, as it does for `i` and `b`. |
| At the ±2^53 boundary | `readParams` already throws past ±2^53. For `d` the message becomes `sql: :amount is 90071992547409.93 as a Dec[2], beyond what the database binds exactly (±90071992547409.92)`. The request stops like a trap: its writes are undone and it is recorded. **No digit is lost.** A row cell past ±2^53 is already refused by `int()`. |
| Reading | a row field `Dec[s]` reads an INTEGER cell as m (kind `d`, `D` for an Option). |
| Upload check | changing a declared column's scale is a `contract` migration (C51's grammar). The service's upload check compares `column` declarations as it compares migrations. |

**C92: a Dec meets a column that does not hold it.** Message text in the house style:

| Case | Message | What to change |
|---|---|---|
| a Dec bound to, or read from, a column with no `column` declaration | `field amount is Dec[2], and orders.amount does not say what it holds: a reader cannot tell 1230 from 12.30, and another query could store it at another scale` | `Declare it: \`column orders.amount: Dec[2]\`, and keep the column INTEGER.` |
| the declared column is REAL or NUMERIC | `orders.amount holds Dec[2] but is declared REAL: SQLite would store 12.30 as a binary fraction, and sums drift` | `Make it INTEGER (minor units: 1230 for 12.30) in a migration.` |
| scale mismatch | `orders.amount holds Dec[2], and :amount is Dec[3]` | `Round it first: \`round(x, to: 2, rounding: HalfEven)\`.` |
| an Int bound to or read from a Dec column | `orders.amount holds Dec[2] in minor units, and :n is Int: 5 would be stored as 0.05` | `Pass a Dec[2]: \`to_dec(n, scale: 2)\`.` |
| SQL arithmetic that changes the scale, on a Dec column in a query: `a * b` with both Dec, `/`, `avg()`, `total()`, a non-zero numeric literal | `amount * rate multiplies two Dec[2] columns: the result is Dec[4], and it is stored in a Dec[2] column` / `avg(amount) is REAL` | `Do it in Tape, where the scale is in the type, and pass the result.` |

Allowed in SQL on Dec columns: comparison with a same-scale Dec column or parameter, `+`/`-` with the same scale,
`*` by an INTEGER column or Int parameter that is not a Dec, `SUM`/`MIN`/`MAX` (scale kept), and `0`. This
extends the expression typing in `sql/check/query.ts` with a scale per column. A rule fires when the checker
cannot tell a scale, as C60 does for SQL it cannot read.

Refused:

```tape
migration 1 "pay" {
  CREATE TABLE pay(id INTEGER PRIMARY KEY, amount REAL NOT NULL)
}
column pay.amount: Dec[2]
```

The fix is `amount INTEGER NOT NULL CHECK (amount > 0)`.

### 8.2 Float never goes into SQL

**C89: a Float as a SQL parameter.** Message: `:x is Float: a binary fraction stored or compared in the database
drifts (0.1 + 0.2 is stored as 0.30000000000000004, and WHERE x = 0.3 misses it)`. What to change: `Store an exact
value: a Dec in INTEGER minor units, \`to_dec(x, scale: 2, rounding: HalfEven)\` and \`column t.c: Dec[2]\`.` This
covers INSERT, UPDATE, WHERE and every statement. A REAL column can still be read (§8.3). Q4 asks about writes.

Refused / accepted:

```tape
// refused C89
let 1 = sql_exec(query: "UPDATE m SET reading = :r WHERE id = :id", r: 21.5f, id) else -> …
// accepted
let 1 = sql_exec(query: "UPDATE m SET reading = :r WHERE id = :id",
  r: to_dec(21.5f, scale: 2, rounding: HalfEven), id) else -> …   // with column m.reading: Dec[2]
```

### 8.3 Reading REAL into Float

A row field `Float` reads a REAL cell (kind `f`). C69's column/field check (`compiler/gen/sql.ts` `checkColumn`)
gains `real` ↔ Float. Use cases are `SELECT avg(score) AS mean` and a legacy REAL column. The host refuses a cell
that is not a finite number (SQLite can return ±Infinity). NULL behaves as today.

### 8.4 Guards on a REAL column

**C91: a take-from-quantity or a compare-and-set on a REAL column.** These are the C73 shape
(`SET c = c - :q WHERE c >= :q`) and an `sql_move` whose WHERE compares a REAL column. Message:
`this write takes from orders.stock, which is REAL: after 0.1 is taken three times from 0.3, the guard \`stock >=
0.1\` refuses the last 0.0000000000000000555 and the quantity is stuck above zero`. What to change: `Hold
quantities in INTEGER: a count, or minor units in a column declared Dec[s].` A Float parameter in such a guard is
already C89, so C91 covers only what SQL literals and columns can still do.

### 8.5 Keys (not SQL, but the same reasoning)

**C90: a Float in a call's key.** This covers `once:` given a Float, or a record with a Float field anywhere
inside it (`compiler/gen/callout.ts`: a key is text or a record written as JSON). Message: `the key of this
command holds a Float (Charge.amount): a retry that computes it again can get 0.30000000000000004 where the first
got 0.3, and is taken for a new command, so the other side runs it twice`. What to change: `Key the command by
what names it, the row's id, and carry amounts as Dec: \`once: ForOrder(order: id)\`.` `wake(key:)` takes an Int,
so it needs no rule.

```tape
// refused C90
call(to: payments, method: "charge", send: Charge(amount: total), reply: Charged, within: 2000,
  once: Pay(order: id, amount: total))          // total: Float
// accepted
call(…, send: Charge(amount: to_dec(total, scale: 2, rounding: HalfEven)), …, once: Pay(order: id))
```

---

## 9. Replay and determinism

Axiom 1 (LANGUAGE.md §1) requires a request to compute the same answer from its log. Dec and Float add no effect.
Every operation is a pure function of its operands.

| Op family | Deterministic because | Across Node, browsers and workerd |
|---|---|---|
| Dec, all of it | integer ops only (`i64.*`), which the Wasm Core spec fully defines. A trap is a trap everywhere | yes, by the Wasm spec |
| Float `+ - * / sqrt` | Wasm Core 2.0 §4.3.3: IEEE 754 roundTiesToEven results. The only non-determinism Wasm lists for scalar floats is NaN bit patterns (§4.3.3, "NaN propagation"; Appendix "Non-determinism"). A NaN can arise, but its bits are never seen: the check of §6.1 traps on any NaN, whatever its bits | yes, by the Wasm spec |
| Float `floor ceil trunc nearest abs neg min max convert compare` | defined exactly by Wasm Core §4.3.3, with no NaN inputs | yes |
| Subnormals | required by Wasm, no flush-to-zero | yes |
| `to_dec`, `to_int`, Dec → Float fast path | integer ops on the exact bits, plus one IEEE division | yes |
| text → Float | `Number()` on ≤ 20 significant digits is correctly rounded by ECMA-262 `RoundMVResult` | yes, by ECMA-262 |
| Float → text | ECMA-262 Number::toString: the digit count is fixed, but the choice between equally short candidates is only recommended (Note 2) | **on trust**: every engine implements the closest. §12.3 cross-checks 10^6 doubles against Python `repr`. See Q7 |
| JSON Dec decode | `rawJSON` source text, then integer parsing | yes, where the feature exists (§7.1 feature check) |

NaN canonicalisation is moot: a NaN either traps or never exists. No Float value reaches the effect log as a Float.
JSON carries the shortest text, and SQL never receives one (C89).

---

## 10. Std and examples

| Change | Where |
|---|---|
| `type Rounding { HalfEven HalfUp Down Up Floor Ceiling }` | `std/core.tape` |
| `write_dec(out, m: Int, scale: Int)` and `dec_of_text(v, scale) -> Option[Int]`: Tape implementations behind the intrinsics, with examples in comments (`tape test`) | `std/text.tape` |
| `allocate(total: Dec[s], parts: Int)` and `allocate_by(total, weights: List[Int])`: splits that add up exactly (a $10.00 bill in 3 is 3.34, 3.33, 3.33) | new `std/money.tape`. Needs scale-polymorphic std functions, so v1 implements them as intrinsics, or for Dec[2] only (Q8) |
| `min`/`max`/`abs` as intrinsics over Int, Dec[s] and Float. Delete the two in `apps/trace/trace.tape:1193-1206` | F7 |
| `decimal(v) -> Option[Int]` stays as it is (path segments) | `std/text.tape:70` |
| Convert `examples/ledger.tape` and `examples/payments.tape` to `Dec[2]` balances (`column accounts.balance: Dec[2]`), keeping their invariants. Add `examples/split.tape` (a bill split with `allocate` and a `settled` invariant that the parts sum to the total) and `examples/sensors.tape` (Float readings averaged with `avg()` into a Float field, and stored as `Dec[2]` via `to_dec`) | examples |
| LANGUAGE.md §8 program: `amount` becomes `Dec[2]` (`type Amount = Dec[2] where self >= 0.01 and self <= 10000.00`, `column orders.amount: Dec[2]`) | draft |

---

## 11. Open questions (objections to the brief, with alternatives)

| # | Question | Recommendation |
|---|---|---|
| Q1 | `JSON.parse` source access and `JSON.rawJSON` are checked on Node 24.18 only. workerd (V8) should have them. Browser support (playground, Safari in particular) is unverified. | Phase 2 starts with a workerd test (`service/test`) and a browser check. Where the feature is missing, the feature check refuses (§7.1). The fallback is a Dec number scanner in the host: about 60 lines, reusing §5.6's grammar. |
| Q2 | SQL is limited to ±2^53 minor units (F2). Dec[18] is not storable in any useful amount. | v1 refuses past ±2^53, with no loss. v2 binds `d` as decimal text with `CAST(?n AS INTEGER)`, which is exact over the full i64, and reads with a rewritten `CAST(col AS TEXT)`. That needs a measurement of what workerd returns for integer cells above 2^53. Also: should C92 refuse declaring `column … : Dec[s]` for s > 12, where the stored range is below 9,007? |
| Q3 | docs/design.md asks for a defect behind each rule, and C89 to C92 have none recorded. | Each rule lands with a planted scenario under `tape sim` that shows the defect (balance drift breaking a `sum = total` invariant, a Float key missing dedup and charging twice, a REAL guard stuck above zero). The scenario counts as the rule's evidence. Without it the rule does not ship. |
| Q4 | Brief: "Float into any SQL column" is refused, and also "Float as REAL". | Writes are refused outright (C89). A `float: True` opt-out on the call, like `repeat: True`, could follow later for telemetry tables if a program needs it. Reads of REAL are allowed. |
| Q5 | "More decimals than the scale": does `12.340` count? | By value: `12.340` is accepted as exact, and `12.345` is refused. Counting digits would refuse an exact value for its spelling, and JSON writers such as Python's `Decimal` emit trailing zeros. |
| Q6 | Dec as a JSON string by default. Some clients (payment APIs) expect numbers. | Keep strings. If needed later, add one form (`write_json(value, dec_as: Number)`) and not a per-type annotation. |
| Q7 | Float → text relies on engines choosing the closest shortest digits (spec Note 2). | Accept for v1, with the Python cross-check in the gate. If replay across engines must be guaranteed, implement Ryu in Wasm (≈ 10 KB of tables) and stop sharing that piece with the interpreter. |
| Q8 | No polymorphism over scale, so std's money helpers are intrinsics or fixed at Dec[2]. | v1: `allocate` as an intrinsic. Consider `fn f[s: Scale]` later. |
| Q9 | Context typing of an unsuffixed `1.5` as Float (brief). This lets the same text mean an exact value in one place and a binary fraction in another. | Keep as decided, since it is convenient for measurements. The stricter alternative is to require the `f` suffix everywhere, so that every Float in the source looks like one. That is one way to write each and costs one character. Recommended if the aim is "never ambiguous". |
| Q10 | `flags` are Int/Bool only. A `flag fee: Dec[2]` is natural. | Out of scope for v1. |
| Q11 | Numeric literals in invariants and migration CHECKs on Dec columns are minor units (`CHECK (amount <= 1000000)` means $10,000.00). C92 refuses them only in program queries. | Document it in §7 of LANGUAGE.md. A later rule could refuse non-zero literals against declared columns everywhere. |
| Q12 | Rule codes C89 to C92 and lexer L06 assume 0.2 takes none. | Renumber at merge if it does. |

---

## 12. Test plan

### 12.1 Oracles

| Oracle | Independent of | How |
|---|---|---|
| A hand reference in the test (`test/numbers.ts`): about 150 lines of BigInt for §4, §5 and §6.3, written from this spec and not from the compiler or interpreter. It uses no decimal.js and no other library | the Wasm lowering and the interpreter | each Wasm build (the three of `proof/verify.ts`) against it |
| The interpreter (`interp/eval.ts`): Dec as `{ m: bigint, s }` with exact BigInt and a range check after each op. Float as a JS number. Values today have no `number` (`interp/value.ts:25`), so the representation is free | the Wasm lowering (no limbs, no divlu, no constant-bound overflow checks) | `proof/verify.ts`, `proof/interp-effects.ts` |
| Python 3.14.6 `decimal` and `float` (present locally **(checked)**) | everything in JS | `test/numbers-golden.ts --regen` writes cases as JSONL, runs `python3 -I test/numbers_oracle.py` (isolated mode: `getcontext().prec = 200`, the six modes mapped to `ROUND_*`, `Decimal(float)` for exact Float→Dec, `float(Decimal)` for Dec→Float, `repr` for Float→text, `math.sqrt`) and commits `testdata/numbers/golden.jsonl`. The gate reads the committed file, so CI needs no Python, and **nothing skips when Python is absent** (unlike `test/git.ts`, STATUS limitation 5). |
| A BigInt correctly-rounded sqrt (integer sqrt of the scaled mantissa) | `Math.sqrt` | 10^5 samples, against the interpreter's `Math.sqrt` and Wasm's `f64.sqrt` |

### 12.2 Cases and counts

| Set | Count | Content |
|---|---|---|
| Golden | 40,000 (20k Dec, 20k Float) | edge-biased: 0, ±1, MIN, MAX, ±10^k ± 1, ties (·5 at every scale), every mode, s and t across 0..18, every §4 to §6 table row |
| Fuzz per gate run | 200,000 ops per build | random op/scale/mode, operand distribution 50 % edge values and 50 % uniform i64 |
| Long fuzz (`--long`, by hand) | 10^7 | the same |
| JSON | 5,000 | §5.6 grammar: accepted and refused strings, nested in records and lists. Each compared with the reference parser. Every refusal's path checked |
| SQL boundary | per scale 0, 2, 8, 18 | ±(2^53 − 1), ±2^53, ±(2^53 + 1) minor units. Exact or refused, never rounded (node:sqlite and, in `service/test`, workerd) |
| Float → text | 10^6 random doubles | `String(x)` against Python `repr`, plus round-trip `Number(String(x)) === x` |
| Rules | each of C89 to C92 and L06 | the smallest refused program and an accepted fix (`test/rules-numbers.ts`, in the style of `test/rules-retries.ts`). LANGUAGE.md edits run by `test/definition.ts` |

### 12.3 Plants (each must be caught by the test named; recorded in the gate as an exact count)

| # | Plant | Caught by |
|---|---|---|
| P1 | HalfEven ties to odd | golden (2.5 → 3) |
| P2 | HalfUp as `Math.round` (ties toward +∞) | golden (−0.5 → 0, −2.5 → −2) |
| P3 | Floor and Ceiling swapped for negatives | golden |
| P4 | Dec `*` overflow check removed | fuzz (MAX·2) |
| P5 | Cross-scale compare without the overflow fallback | golden (MAX of Dec[0] vs Dec[18]) |
| P6 | divlu with one correction step instead of two | fuzz (the divisor-normalisation edge) |
| P7 | Remainder sign taken from `rem_s` for a negative dividend | golden (−1.00 / 8) |
| P8 | JSON Dec decoded with `Number(src)` | JSON set (20-digit input) |
| P9 | Dec bound without `CAST(… AS INTEGER)` | SQL boundary (`'k' \|\| ?1` shape, from `integerParams`'s note) |
| P10 | finite check dropped after `/` | Float golden (1f / 0f must trap) |
| P11 | interpreter `nearest` via `Math.round` | verify (nearest(−2.5f) = −2f) |
| P12 | Float→Dec as `round(x · 10^s)` in f64 | golden (2.675f HalfUp → 2.67) |
| P13 | Dec encoded as a JSON number | `test/json.ts` |
| P14 | C89 disabled | `test/rules-numbers.ts` |
| P15 | column scale not checked (Dec[3] read from a Dec[2] column) | `test/rules-numbers.ts` |
| P16 | write_dec negates MIN | golden (text of MIN) |

### 12.4 Sim scenarios (the evidence for each rule, Q3)

Each scenario is a small program that breaks an invariant under `tape sim` when its rule is turned off, and
compiles clean with the fix. They are added to `proof/sim-invariants.ts`.

| Rule | Scenario |
|---|---|
| C89 | tip jar: 10 requests add `0.1f` to a REAL balance. The invariant `balance = (SELECT count(*) FROM tips) * 0.1` fails |
| C91 | stock of 0.3 taken as 0.1 three times. The settled invariant "stock = 0 once all orders are filled" fails |
| C90 | `once: Charge(amount: a + b)` with Float. A retry recomputes `0.30000000000000004` against `0.3`, and the settled invariant "one charge per order" fails |
| C92 | a Dec[2] written and a Dec[3] read on one column. The invariant `sum(paid) = sum(order.amount)` fails |

### 12.5 Determinism

`proof/interp-effects.ts` and `tape sim` replay programs that use both types. One Float corpus (10^5 ops plus
text) is run in Node, in workerd (`service/test`) and in Chrome via the playground. Per the evidence rule, each
engine is recorded by its run, and "unverified on device" is stated for any engine not run.

---

## 13. Implementation plan

| Phase | Content | Done when | Effort (agent-days) |
|---|---|---|---|
| 0 | Sign-off on §11. Write the hand reference and Python oracle, and commit the golden file | golden committed, reference matches Python 100 % | 0.5 |
| 1 | Dec core: lexer (L06), `Dec[s]` types, literal context typing, `+ - * compare abs min max`, `rescale round div to_int to_dec`, overflow traps, holes and `write_dec`, `parse_dec`. Interpreter. Measure op costs (§5) in `bench/` | golden, fuzz, P1–P7 and P16 caught. `proof/verify.ts` and generated programs include Dec | 4 |
| 2 | Dec at the edges: JSON decode (rawJSON, §7.1, plus feature check), encode as string, fingerprints, SQL kind `d`, the `column` declaration, C92, upload-check scale compare. Convert ledger and payments, add `split.tape` | JSON and SQL boundary sets pass in Node and workerd, P8, P9, P13 and P15 caught, `tape sim` clean on the converted examples | 3 |
| 3 | Float core: f64 slots, literals and `f`, ops with the finite check, `nearest`/`to_int` lowering, `to_dec` (§6.3), Dec→Float (§6.5), host imports `float_text`/`text_float`. Interpreter | Float golden and the sqrt oracle pass, P10–P12 caught | 3 |
| 4 | Float at the edges: JSON `f`, REAL → Float rows (C69), C89, C90, C91, the four sim scenarios. `sensors.tape` | each rule has a refused and an accepted program and its scenario. The Float → text cross-check over 10^6 doubles | 2 |
| 5 | Docs: LANGUAGE.md 0.3 (the draft), guide chapter "Money and measurements", STATUS (claims, floors set to measured, trust items: Float → text, Q1 engines), design.md (the four rules and their evidence), defects.md if a plant found a real bug | `test/definition.ts` green, `proof/all.ts` green | 1.5 |
| | **Total** | | **≈ 14** |

### 13.1 Migration and compatibility

| Area | Effect on 0.2 programs |
|---|---|
| Source | none. `1.5` is a parse error today (P01, **checked**), so no program changes meaning. `Dec`, `Float` and `Rounding` and its six constructors become built-in or std names, and no `.tape` file in the tree defines them (**checked**, grep) |
| `min`/`max` | `apps/trace/trace.tape` defines both; they are deleted when the intrinsics land (F7). Before landing, check how a user function named like an intrinsic resolves today (a user `len` compiled without complaint in a quick test) |
| Wasm and host ABI | additive: new shape kinds, parameter kind `d`, two imports. Old modules keep running as built (LANGUAGE.md §11) |
| Service | upload check learns `column`. Old versions have none, so nothing changes for them |
| Examples converted | ledger and payments move to Dec[2]. Their stored data in the service is test data, and the migration multiplies nothing because the INTEGER values already are cents |

### 13.2 Docs to change

LANGUAGE.md (draft attached), docs/guide.md (new chapter), STATUS.md (claims table: "Dec is exact"; trust: Float
→ text, JSON source access per engine; limitations: SQL ±2^53), docs/design.md (C89 to C92 with their scenarios),
README (one line), and TERMS.md unchanged.
