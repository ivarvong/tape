// bench/suite/trace-gen.ts: OTLP/JSON traces of any size, made the way apps/trace/fixtures/make.ts makes big.json
// (a tree of fan-outs over six services, children inside their parents, a few errors and events), from a seed.
export function traceOf(n: number, seed0: number): string {
  let seed = (0x7ace + seed0 * 7919) % 2147483648;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const hex = (k: number): string =>
    Array.from({ length: k }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
  const T0 = 1763800000000000000n;
  const services = ['edge/router', 'api/orders', 'api/payments', 'db/postgres', 'cache/redis', 'api/search'];
  const attr = (key: string, v: string | number | boolean): unknown => ({
    key,
    value:
      typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : { intValue: String(v) },
  });
  type S = { id: string; parent: string; start: bigint; end: bigint; depth: number; svc: number };
  const trace = hex(32);
  const root: S = { id: hex(16), parent: '', start: T0, end: T0 + 1_800_000_000n, depth: 0, svc: 0 };
  const all: S[] = [root];
  for (let i = 1; i < n; i++) {
    const p = all[Math.floor(rand() * Math.min(all.length, 400))] ?? root;
    const len = p.end - p.start;
    const a = p.start + (len * BigInt(Math.floor(rand() * 900))) / 1000n;
    const b = a + ((p.end - a) * BigInt(Math.floor(rand() * 1000))) / 1000n;
    all.push({
      id: hex(16),
      parent: p.id,
      start: a,
      end: b,
      depth: p.depth + 1,
      svc: (p.svc + 1 + Math.floor(rand() * 2)) % services.length,
    });
  }
  const spanOf = (s: S, i: number): unknown => ({
    traceId: trace,
    spanId: s.id,
    ...(s.parent === '' ? {} : { parentSpanId: s.parent }),
    name: s.depth === 0 ? 'GET /checkout' : `${['SELECT', 'GET', 'POST', 'call', 'render'][i % 5]} step ${i}`,
    kind: 1 + (i % 3),
    startTimeUnixNano: String(s.start),
    endTimeUnixNano: String(s.end),
    attributes: [attr('i', i), attr('ok', i % 7 !== 0)],
    events:
      i % 11 === 0
        ? [
            {
              timeUnixNano: String((s.start + s.end) / 2n),
              name: 'db.query',
              attributes: [attr('db.query.text', 'SELECT 1')],
            },
          ]
        : [],
    status: i % 97 === 0 ? { code: 2, message: `failure ${i}` } : { code: 0 },
  });
  const byService = services.map((name, k) => ({
    resource: { attributes: [attr('service.name', name)] },
    scopeSpans: [{ scope: { name: 'synthetic' }, spans: all.flatMap((s, i) => (s.svc === k ? [spanOf(s, i)] : [])) }],
  }));
  return `${JSON.stringify({ resourceSpans: byService }, null, 1)}\n`;
}
