# Sunset in Integers: Building a VSOP87 Calculator in Tape

*Notes from a week of fixed-point astronomy, November 2026*

I wanted a small, honest test for [Tape](https://github.com/ivarvong/tape "The Tape language"), the
experimental language that compiles to WebAssembly and runs each program as a Durable Object. Toy CRUD apps
exercise the parts of a language that everyone already gets right. So I picked something with real numbers in
it: **when does the Sun set**, to the second, anywhere on Earth, for any day between 1986 and 2149.

The catch is that Tape has *no floating point at all*. An `Int` is a 64-bit signed integer, arithmetic is
exact or it traps, and there is no `Float` yet. Every sine, every square root and every one of the 190 terms of
the planetary theory had to be done in fixed point. This post is about how that went, what broke, and what I
would ask the language to change.

![A sunset over the Hudson, the test site for most of this work](https://example.com/img/hudson-sunset.jpg "Hudson River, June 21")

## Why sunset is harder than it looks

Most sunrise and sunset code you find online uses a short formula with an accuracy of a minute or two. That is
fine for a weather widget. It is not fine if you want to check your work against a real ephemeris, because a
minute of error hides every interesting bug. The serious route has four parts:

1. Find where the Earth is, using a planetary theory such as **VSOP87**.
2. Turn that into the Sun's *apparent* place: correct for light time, aberration and nutation.
3. Turn the place into a local hour angle, which needs sidereal time and therefore **ΔT**, the slowly drifting
   difference between atomic time and the rotation of the Earth.
4. Solve for the moment the upper limb of the Sun touches the horizon, allowing for refraction, the Sun's
   semidiameter and the dip of the horizon for an observer above sea level.

Each step is a few lines in a language with doubles. In a language with only integers, each step is a small
design problem.

### Choosing units

The first decision was the unit for an angle. I settled on *radians times 10^9*, which I called `rad9`. A full
turn is then `6283185307`, which fits comfortably in 63 bits, and one unit is a nanoradian: about 0.0002
arcseconds, far below anything that matters here. Time is milliseconds since 1970, exactly what `now()` gives.

The rule that kept me out of trouble was simple:

> Every product must be bounded below 2^63 *by construction*, not by luck.

So multiplication of two `rad9` values goes through a helper that splits both operands at 10^9 before it
multiplies. It costs a few instructions and it means the overflow trap can only fire on a genuine bug. It fired
exactly once during the build, in the Earth rotation angle, and it was right: I had multiplied a day count by a
rate without reducing it first.

## The planetary theory

VSOP87D gives the Earth's heliocentric longitude, latitude and distance as sums of periodic terms. Each term is
an amplitude, a phase and a frequency, and the series come in powers of time:

    L = L0 + L1*t + L2*t^2 + L3*t^3 + L4*t^4 + L5*t^5
    each Ln = sum of A * cos(B + C*t)

The full theory has 2,425 terms for the Earth alone. That is far more precision than sunset needs, so I wrote a
small generator in JavaScript that truncates it. A term survives if its amplitude, scaled by the size of its
power of time over the date range, is above 10^-7 radians. I also keep the largest term of every power, so that
no series is ever silently empty. The result is **190 terms**, and the generator writes them straight into a
Tape source file:

```js
for (const [series, terms] of Object.entries(vsop)) {
  const kept = terms.filter(([a]) => a * scale(series) >= 1e-7);
  out.push(`fn ${series}(t: Int) -> Int {`);
  out.push(kept.map(term).join(' + ') || '0');
  out.push('}');
}
```

The truncated series are accurate to about 0.28 arcseconds against the full theory. For comparison, the
refraction at the horizon, which nobody can predict better than a few arcminutes, is about 2,000 times larger.

### Cosine without floats

Every one of those 190 terms needs a cosine, so the cosine had to be cheap and exact enough. The version that
shipped does three things:

- reduces the argument modulo 2π, carrying the fractional part of 2π separately so the reduction does not drift;
- folds it into one octant using symmetry;
- evaluates a Taylor polynomial in the reduced argument, with every coefficient pre-scaled to `rad9`.

Later I added shorter polynomials for small terms. A term whose amplitude is below 2.8 x 10^-4 cannot
contribute an error larger than a nanoradian if its cosine is only good to six orders, so it gets a cheaper
polynomial. That one change took the cost per term down by a third.

The arctangent was the most fun. It uses the identity

```
atan(z) = pi/6 + atan((z*sqrt(3) - 1) / (z + sqrt(3)))
```

to pull the argument close to zero, and then a series to the fifteenth power. Arcsine and arccosine go through
the arctangent and an integer square root found by Newton's method.

## Solving for the moment

Sunset is a root-finding problem: find the time when the Sun's altitude equals a target that is a little below
zero. I used Newton's method on the hour angle, starting from local mean noon. The interesting part was
deciding *how much* precision each round needs:

1. The first rounds use a low-precision Sun from the Astronomical Almanac, good to 0.01 degrees, until the step
   is under a minute.
2. Then the solver switches to the full VSOP87 position until the step is under a second.
3. Finally it takes that last step at the solar rate rather than evaluating again.

In Tape this became a small algebraic data type, which is the part of the language I enjoyed most:

```tape
type Phase {
  Start
  Rough
  Fine
}

type Crossing {
  Sets(ms: Int, azimuth: Int, rounds: Int)
  Rises(ms: Int, azimuth: Int, rounds: Int)
  AlwaysUp
  AlwaysDown
  Unsettled(ms: Int)
}
```

Because a `match` must cover every case, there is no way to forget the polar cases. A day without a sunset is a
value, `AlwaysUp`, not a sentinel time of zero that someone forgets to check. Near the pole the solver can
also fail to converge in its fixed eight rounds, and that is a value too: `Unsettled`.

## Checking the answers

I compared every day of 2026 at six sites against [astronomy-engine](https://github.com/cosinekitty/astronomy),
which is itself checked against JPL ephemerides. The sites ran from the equator to Tromsø, including one at
2,000 metres to exercise the dip of the horizon.

- **New York**: worst difference 0.16 s
- **Quito**: worst difference 0.14 s
- **Tromsø**: worst difference 0.17 s, including the days around the end of the midnight sun
  - the polar days come out as `AlwaysUp`, matching astronomy-engine exactly
  - the first sunset after the polar day is within 0.2 s
- **A mountain site at 2,000 m**: worst difference 0.15 s

Most of that residual comes from a single modelling choice: astronomy-engine linearises the refraction constant
in height, and so did I, but with a slightly different reference temperature. When I matched it, the error fell
below a tenth of a second. I left it, because the remaining difference is a choice, not a bug.

The hosted service gives byte-for-byte the same output as my local build. That sounds obvious, but it is worth
saying: the same compiler runs in both places, and the program has no floats whose rounding could differ between
machines. The step counts match too.

### What the trap caught

The overflow trap deserves a paragraph of its own. In a language that wraps, my bug in the Earth rotation angle
would have produced a plausible but wrong sidereal time, and every sunset would have been off by a few seconds in
a way that grows with the date. I would have chased it through the refraction model for a day. Instead the
request failed with `trap 6: integer overflow` at the exact line, and the fix took a minute. Exactness that
fails loudly is worth more than exactness that fails quietly.

## Performance

I did not expect integer astronomy to be fast. It is.

| What | Time per sunset |
|---|---|

That table is a joke at my own expense: tables are not part of the Markdown I support. Here are the numbers as a
list instead.

- The first version took about **40 µs** per sunset.
- Stopping at a one-second step, folding divisions and using cheaper polynomials brought it to **9.5 µs**.
- The same algorithm in JavaScript with doubles takes 6.3 µs, so Tape is about 1.5x slower.
- astronomy-engine takes 49 µs, because it evaluates much more of the theory than sunset needs.

A CPU profile says where the gap to JavaScript goes. Tape emits each small helper as its own WebAssembly
function, and V8 does not inline them, so the per-term call overhead dominates. That is a compiler problem with a
known fix, and I filed it.

---

## What I asked the language to change

Building something real surfaces the small frictions that a tutorial never does. A few that stood out, in the
order I hit them:

1. **No constants.** I wanted `TAU = 6283185307` once. Instead the number appears in several places, each with a
   comment. A top-level `let` would fix it.
2. **No list literals.** Tables of coefficients had to be written as nested `Cons(head: ..., tail: ...)` calls,
   or generated. The generator was the right call for VSOP, but not for a five-entry nutation table.
3. **Steps are not CPU.** Tape counts *steps*, which are entries into recursive functions. The 190-term VSOP sum
   costs zero steps because it is straight-line code. That makes steps useless as a profile, and I asked for real
   per-function counters in the hosted traces.
4. **Reading form fields is quadratic.** The standard library's `form_field` decodes a copy of every key it passes
   on every lookup. An 11 KB form runs out of the 64 MB request memory. That one was a real bug and the
   fix is simple.

None of these is a reason not to use the language. Two of them were fixed within a day of being reported, which
says something good about the people building it.

### On sprawl

A note of caution, too. Every feature request above makes the language bigger. The Tape team has been clear that
they would rather the language got *smaller*, and I think that instinct is right. My test for a request was
whether the workaround cost more than ten lines in a real program. Constants and list literals pass that test
easily; the rest are library fixes, not language changes.

> Tape is small on purpose.
>
> > A form that is here has one meaning and one way to be written.
>
> That line from the language definition is the best argument for saying no.

## Try it

The service answers plain HTTP. With the program deployed, these work:

    GET /sunset?date=2026-06-21&lat=40.7128&lon=-74.006
    GET /sunsets?year=2026&lat=69.65&lon=18.96
    GET /next-sunset?lat=40.7128&lon=-74.006

The source is in the demo repository, and questions are welcome at <https://github.com/ivarvong/tape/issues> or
by mail to <sunset@example.com>. If you find a day where my sunset disagrees with yours by more than a
second, I would love to hear about it\! Please include:

* the date, latitude, longitude and height;
* what you expected, and where the expected value came from;
* what the service answered.

One more thing about escaping. Markdown gives meaning to characters such as \*, \_, \` and \[, so writing them
literally takes a backslash. The renderer behind this page handles that, along with line breaks that you force
with a trailing backslash\
like this one, or with two trailing spaces  
like this one.

*Thanks to the Tape team for the quick fixes, and to the authors of VSOP87, whose tables are still the backbone
of every serious solar ephemeris forty years on.*
