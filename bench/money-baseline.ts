// Idiomatic JavaScript for bench/money.tape: amounts as integer cents in Numbers (exact while they stay within
// 2^53, which the bench's carts do), parsed from their decimal text by hand, the tax rounded half to even by hand
// from the exact product, and the amounts written back as text. handle(bytes) -> Uint8Array.
const dec = new TextDecoder(),
  enc = new TextEncoder();
const NUMBER = /^-?(0|[1-9]\d*)(?:\.(\d+))?$/;
/** The amount in units of 10^-scale, when the text has no more digits than that; else null. */
function units(text: unknown, scale: number): number | null {
  const s = typeof text === 'number' ? String(text) : text;
  if (typeof s !== 'string') return null;
  const m = NUMBER.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > scale) return null;
  const v = Number(m[1]) * 10 ** scale + Number(frac.padEnd(scale, '0') || '0');
  return Number.isSafeInteger(v) ? (s.startsWith('-') ? -v : v) : null;
}
const text = (cents: number): string => {
  const a = Math.abs(cents),
    d = String(a % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${Math.floor(a / 100)}.${d}`;
};
/** n / d rounded half to even, for d > 0. */
function halfEven(n: number, d: number): number {
  const q = Math.floor(n / d),
    r = n - q * d;
  return 2 * r > d || (2 * r === d && q % 2 !== 0) ? q + 1 : q;
}
const refused = (error: string): Uint8Array => enc.encode(JSON.stringify({ error }));
export function handle(bytes: Uint8Array): Uint8Array {
  let cart: unknown;
  try {
    cart = JSON.parse(dec.decode(bytes));
  } catch {
    return refused('not JSON');
  }
  if (typeof cart !== 'object' || cart === null || Array.isArray(cart)) return refused('expected an object');
  const { lines, rate }: Record<string, unknown> = { ...cart };
  const r = units(rate, 5);
  if (r === null) return refused('rate: expected a number with at most 5 decimals');
  if (!Array.isArray(lines)) return refused('lines: expected an array');
  let subtotal = 0;
  const items: unknown[] = lines;
  for (const [i, line] of items.entries()) {
    const fields: Record<string, unknown> = typeof line === 'object' && line !== null ? { ...line } : {};
    const { price, qty } = fields;
    const p = units(price, 2);
    if (p === null) return refused(`lines[${i}].price: expected a number with at most 2 decimals`);
    if (typeof qty !== 'number' || !Number.isInteger(qty)) return refused(`lines[${i}].qty: expected an integer`);
    subtotal += p * qty;
  }
  // cents times a rate in units of 10^-5, back to cents: exact while the product is within 2^53
  const tax = halfEven(subtotal * r, 100000);
  return enc.encode(JSON.stringify({ subtotal: text(subtotal), tax: text(tax), total: text(subtotal + tax) }));
}
