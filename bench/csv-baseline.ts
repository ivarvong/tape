// Idiomatic JavaScript: the reference semantics and the JS baseline. handle(bytes) -> Uint8Array.
const dec = new TextDecoder(),
  enc = new TextEncoder();
const TS = /^\d{1,19}$/,
  AMOUNT = /^-?\d{1,12}$/,
  COUNTRY = /^[A-Z]{2}$/;
type Sum = { count: number; total: number; max: number };
export function handle(bytes: Uint8Array): Uint8Array {
  const lines = dec.decode(bytes).split('\n');
  const strip = (l = ''): string => (l.endsWith('\r') ? l.slice(0, -1) : l);
  if (strip(lines[0]) !== 'ts,user,amount,country')
    return enc.encode(
      '{"type":"about:blank","title":"Bad Request","status":400,"detail":"the first line is not the header ts,user,amount,country"}',
    );
  const by = new Map<string, Sum>();
  let rows = 0,
    rejected = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = strip(lines[i]);
    if (line === '') continue;
    const [ts = '', user = '', amountText = '', country = '', ...more] = line.split(',');
    if (
      more.length > 0 ||
      line.split(',').length !== 4 ||
      !TS.test(ts) ||
      user === '' ||
      !AMOUNT.test(amountText) ||
      !COUNTRY.test(country)
    ) {
      rejected++;
      continue;
    }
    rows++;
    const amount = Number(amountText);
    const c = by.get(country) ?? { count: 0, total: 0, max: -Infinity };
    by.set(country, { count: c.count + 1, total: c.total + amount, max: Math.max(c.max, amount) });
  }
  const countries = [...by]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([country, c]) => ({ country, ...c }));
  return enc.encode(JSON.stringify({ rows, rejected, countries }));
}
