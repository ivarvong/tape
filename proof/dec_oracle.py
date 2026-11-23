"""proof/dec_oracle.py: Dec[s] cases and what Python's decimal module says of each, by hand, not in the gate.

    python3 -I proof/dec_oracle.py > testdata/dec/golden.jsonl

Each line is one call: the function (its operation and scales, as test/decs.ts writes it in Tape), its rounding,
its arguments (a Dec as its count, the Int count of 10^-s; a Float as the hex of its bits) and the answer: a count,
true or false, a Float's bits, or the trap (6 integer overflow, 4 division by zero). Every value is computed with
decimal at 200 digits from the exact operands, then quantized once with the rounding named; a Float with
Decimal(float), which is exact, and float(Decimal), which is correctly rounded. test/decs.ts reads the file, so the
gate needs no Python. The operands are edge-biased (0, ±1, ties at every scale, powers of ten and their
neighbours, the least and most counts) and the rest random, from a fixed seed.
"""
import json
import random
import struct
from decimal import (
    ROUND_CEILING,
    ROUND_DOWN,
    ROUND_FLOOR,
    ROUND_HALF_EVEN,
    ROUND_HALF_UP,
    ROUND_UP,
    Decimal,
    getcontext,
)

getcontext().prec = 200
MODES = {
    'HalfEven': ROUND_HALF_EVEN,
    'HalfUp': ROUND_HALF_UP,
    'Down': ROUND_DOWN,
    'Up': ROUND_UP,
    'Floor': ROUND_FLOOR,
    'Ceiling': ROUND_CEILING,
}
MIN, MAX = -(2**63), 2**63 - 1
rng = random.Random(20261123)

# the functions: an operation and its scales (test/decs.ts `source` writes each in Tape)
CATALOGUE = (
    [('add', [s]) for s in (0, 2, 18)]
    + [('sub', [s]) for s in (2, 9)]
    + [('times', [s]) for s in (0, 2)]
    + [('prod', ab) for ab in ([2, 2], [0, 18], [9, 9])]
    + [('neg', [2]), ('abs', [4])]
    + [(op, ab) for op in ('lt', 'eq', 'ge') for ab in ([2, 2], [0, 18], [2, 5], [9, 3])]
    + [('rescale', st) for st in ([0, 2], [2, 9], [0, 18], [17, 18])]
    + [('round', st) for st in ([1, 0], [3, 1], [2, 0], [18, 0], [18, 17], [9, 2])]
    + [('to_int', [s]) for s in (1, 2, 18)]
    + [('dec', [t]) for t in (0, 2, 18)]
    + [('mul', sut) for sut in ([2, 2, 2], [9, 9, 9], [2, 4, 2], [18, 18, 18], [0, 0, 5], [2, 3, 0])]
    + [('mulint', st) for st in ([2, 2], [4, 2])]
    + [('div', sut) for sut in ([2, 2, 2], [0, 0, 18], [18, 0, 0], [9, 9, 9], [2, 2, 18], [18, 2, 2], [0, 18, 0])]
    + [('divint', st) for st in ([2, 2], [4, 2], [0, 3])]
    + [('to_dec', [t]) for t in (0, 2, 9, 18)]
    + [('float', [s]) for s in (0, 2, 9, 18)]
)
ROUNDS = {'round', 'to_int', 'mul', 'mulint', 'div', 'divint', 'to_dec'}


def count(scale):
    """An edge-biased count for a Dec of this scale."""
    p = 10**scale
    edges = [0, 1, -1, 5, -5, 15, -15, 25, -25, MAX, MIN, MAX - 1, MIN + 1, p, -p, p - 1, p + 1, -p - 1]
    edges += [p // 2, -(p // 2), 3 * p // 2, -(3 * p // 2), 5 * p // 2, -(5 * p // 2), MAX // p, MIN // p]
    edges += [MAX // p + 1, -(MAX // p) - 1, 2**53, -(2**53), 2**53 + 1, 2**32, 2**32 - 1]
    r = rng.random()
    if r < 0.45:
        return rng.choice([e for e in edges if MIN <= e <= MAX])
    bits = rng.randint(1, 63)
    v = rng.getrandbits(bits)
    if r < 0.6:
        # a tie or a near-tie at some scale
        k = rng.randint(1, 18)
        v = (v // 10**k) * 10**k + 5 * 10 ** (k - 1) + rng.choice([-1, 0, 0, 1])
    return max(MIN, min(MAX, v if rng.random() < 0.5 else -v))


def small():
    return rng.choice([0, 1, -1, 2, 3, -3, 7, 8, 10, 100, -100, 12345, MAX, MIN, rng.randint(-(10**6), 10**6)])


def double():
    r = rng.random()
    if r < 0.3:
        x = rng.choice([0.0, -0.0, 0.5, -0.5, 1.5, 2.5, -2.5, 2.675, 1.005, 0.1, 0.125, 1e-5, -1e-19, 5e-324, 1e18,
                        9.2e18, 9.3e18, -9.3e18, 123.456, 1e-300, 92233720368547758.07, 0.015, -0.025])
    elif r < 0.7:
        x = rng.uniform(-1, 1) * 10 ** rng.randint(-20, 20)
    else:
        # a tie at some scale, as near as a double gets
        k = rng.randint(0, 6)
        x = (rng.randint(-10**6, 10**6) + 0.5) / 10**k
    return x


def hexof(x):
    return struct.pack('>d', x).hex()


def fits(v):
    return MIN <= v <= MAX


def at(m, s):
    return Decimal(m).scaleb(-s)


def quantized(value, t, mode):
    """The count of a Dec[t] nearest value, as the mode rounds; None beyond the counts."""
    q = int(value.scaleb(t).quantize(Decimal(1), rounding=MODES[mode]))
    return q if fits(q) else None


def answer(op, sc, mode, args):
    trap = 'trap 6'
    if op in ('add', 'sub'):
        v = args[0] + args[1] if op == 'add' else args[0] - args[1]
    elif op in ('times', 'prod'):
        v = args[0] * args[1]
    elif op == 'neg':
        v = -args[0]
    elif op == 'abs':
        v = abs(args[0])
    elif op in ('lt', 'eq', 'ge'):
        a, b = at(args[0], sc[0]), at(args[1], sc[1])
        return {'lt': a < b, 'eq': a == b, 'ge': a >= b}[op]
    elif op == 'rescale':
        v = args[0] * 10 ** (sc[1] - sc[0])
    elif op == 'round':
        v = quantized(at(args[0], sc[0]), sc[1], mode)
    elif op == 'to_int':
        v = quantized(at(args[0], sc[0]), 0, mode)
    elif op == 'dec':
        v = args[0] * 10 ** sc[0]
    elif op in ('mul', 'mulint'):
        s, u, t = (sc[0], sc[1], sc[2]) if op == 'mul' else (sc[0], 0, sc[1])
        v = quantized(at(args[0], s) * at(args[1], u), t, mode)
    elif op in ('div', 'divint'):
        s, u, t = (sc[0], sc[1], sc[2]) if op == 'div' else (sc[0], 0, sc[1])
        if args[1] == 0:
            return 'trap 4'
        v = quantized(at(args[0], s) / at(args[1], u), t, mode)
    elif op == 'to_dec':
        v = quantized(Decimal(args[0]), sc[0], mode)
    elif op == 'float':
        return hexof(float(at(args[0], sc[0])))
    else:
        raise ValueError(op)
    return trap if v is None or not fits(v) else str(v)


def operands(op, sc):
    if op in ('add', 'sub', 'prod') or op in ('lt', 'eq', 'ge'):
        return [count(sc[0]), count(sc[-1] if op != 'add' and op != 'sub' else sc[0])]
    if op in ('times', 'mulint', 'divint'):
        return [count(sc[0]), small()]
    if op in ('mul', 'div'):
        return [count(sc[0]), count(sc[1]) if rng.random() < 0.7 else small()]
    if op == 'dec':
        return [small() if rng.random() < 0.5 else count(0)]
    if op == 'to_dec':
        return [double()]
    return [count(sc[0])]


for op, sc in CATALOGUE:
    for n in range(60):
        mode = rng.choice(list(MODES)) if op in ROUNDS else None
        args = operands(op, sc)
        want = answer(op, sc, mode, args)
        shown = [hexof(a) if isinstance(a, float) else str(a) for a in args]
        line = {'op': op, 'scales': sc, 'args': shown, 'want': want}
        if mode:
            line['rounding'] = mode
        print(json.dumps(line, separators=(',', ':')))
