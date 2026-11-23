"""proof/float_oracle.py: the math library (compiler/math) against mpmath, by hand. mpmath is not part of the gate.

    node proof/float-oracle.ts 100000 > runs.jsonl                         # inputs, and what the library gives
    python3 -I proof/float_oracle.py --mpmath DIR < runs.jsonl             # the largest error of each function, in ulps
    python3 -I proof/float_oracle.py --mpmath DIR --golden 200 < runs.jsonl > testdata/float/golden.jsonl

DIR is where mpmath is installed (`python3 -m pip install --target DIR mpmath`): -I ignores PYTHONPATH. Each value
is computed with 256 bits more than its magnitude needs (mpmath reduces a huge trigonometric argument exactly at
that precision). A result is NaN or infinite where the true value is not a finite double: the language traps there.
The golden file holds the first inputs of each function (its edge cases) and every 500th after, and for each the
true value to 30 significant digits, or "trap", and musl's result when the runs have it; test/float-math.ts reads
it, so the gate needs neither Python nor musl.
"""
import json
import math
import struct
import sys

args = sys.argv[1:]
if '--mpmath' in args:
    sys.path.insert(0, args[args.index('--mpmath') + 1])
import mpmath  # noqa: E402
from mpmath import mp, mpf  # noqa: E402

golden = int(args[args.index('--golden') + 1]) if '--golden' in args else 0


def double(h):
    return struct.unpack('>d', bytes.fromhex(h))[0]


def exact(fn, x, y):
    """The true value, or None when it is not a real number (the language traps there)."""
    mp.prec = 256 + max(64, abs(math.frexp(x)[1]), abs(math.frexp(y)[1]))
    X, Y = mpf(x), mpf(y)
    if fn == 'sin':
        return mpmath.sin(X)
    if fn == 'cos':
        return mpmath.cos(X)
    if fn == 'exp':
        return mpmath.exp(X)
    if fn == 'log':
        return mpmath.log(X) if x > 0 else None
    if fn == 'atan2':
        # mpmath has no -0: with a zero, IEEE 754's answer (0, pi or pi/2, signed), which math.atan2 gives exactly
        if x == 0 or y == 0:
            z = math.atan2(x, y)
            return mpf(0) if z == 0 else math.copysign(1, z) * (mp.pi if abs(z) > 2 else mp.pi / 2)
        return mpmath.atan2(X, Y)
    if fn == 'pow':
        if x == 0:
            return None if y < 0 else (mpf(1) if y == 0 else mpf(0))
        if x < 0 and Y != mpmath.floor(Y):
            return None
        return mpmath.power(X, Y)
    raise ValueError(fn)


MAXD = mpf(2) ** 1024 * (1 - mpf(2) ** -54)  # from here a value rounds to infinity


def ulps(r, v):
    """|r - v| in units of the last place of v (2^-1074 at least)."""
    if v == 0:
        return 0.0 if r == 0 else float('inf')
    e = mpmath.frexp(abs(v))[1]  # |v| in [2^(e-1), 2^e)
    ulp = mpf(2) ** max(e - 53, -1074)
    return float(abs(mpf(r) - v) / ulp)


worst = {}
kept = {}
for line in sys.stdin:
    run = json.loads(line)
    fn, x = run['f'], double(run['x'])
    y = double(run['y']) if 'y' in run else 0.0
    r = double(run['r'])
    v = exact(fn, x, y)
    finite = v is not None and abs(v) < MAXD
    ok = r == r and abs(r) != float('inf')
    err = (0.0 if not ok else float('inf')) if not finite else (ulps(r, v) if ok else float('inf'))
    w = worst.get(fn)
    if w is None or err > w[0]:
        worst[fn] = (err, run, mpmath.nstr(v, 20) if finite else 'not finite')
    worst.setdefault(fn + '#', [0])[0] += 1
    seen = kept.get(fn, 0)
    kept[fn] = seen + 1
    if golden and (seen < golden or seen % 500 == 0):
        out = {'f': fn, 'x': run['x']}
        if 'y' in run:
            out['y'] = run['y']
        if 'm' in run:
            out['m'] = run['m']
        # below 2^-1100 a value is 0 to within 2^-26 ulp, and its decimal exponent would need millions of places
        tiny = finite and abs(v) < mpf(2) ** -1100
        out['v'] = ('0' if tiny else mpmath.nstr(v, 30, min_fixed=1, max_fixed=0)) if finite else 'trap'
        print(json.dumps(out))

if not golden:
    for fn in sorted(k for k in worst if not k.endswith('#')):
        err, run, v = worst[fn]
        print(f'{fn}: {worst[fn + "#"][0]} inputs, max error {err:.4f} ulp, at {run} (true {v})')
