// Idiomatic JavaScript: the reference semantics and the JS baseline of examples/cart.tape. handle(bytes) -> Uint8Array.
const dec = new TextDecoder(),
  enc = new TextEncoder();
type Line = { sku: string; qty: number; cents: number };
const REFUSED = enc.encode('{"error":"not a cart"}');
/** An object; a key the type does not name is left unread, as decode leaves it. */
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const whole = (v: unknown, least: number, most: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= least && v <= most;
const line = (v: unknown): Line | null => {
  if (!record(v)) return null;
  const { sku, qty, cents } = v;
  if (typeof sku !== 'string' || sku === '' || enc.encode(sku).length > 32) return null;
  return whole(qty, 1, 1000) && whole(cents, 0, 100_000_000) ? { sku, qty, cents } : null;
};
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const off = (coupon: unknown, subtotal: number): number =>
  coupon === 'TEN' ? Math.trunc(subtotal / 10) : coupon === 'FIVE' && subtotal >= 5000 ? 500 : 0;
export function handle(bytes: Uint8Array): Uint8Array {
  const cart = parsed(dec.decode(bytes));
  if (!record(cart)) return REFUSED;
  const { customer, coupon } = cart;
  if (typeof customer !== 'string' || !Array.isArray(cart.lines)) return REFUSED;
  // a coupon is a string, or is not there; null is no coupon (decode reads null for an Option as None)
  if (coupon !== undefined && coupon !== null && typeof coupon !== 'string') return REFUSED;
  const lines: Line[] = [];
  for (const v of cart.lines) {
    const l = line(v);
    if (l === null) return REFUSED;
    lines.push(l);
  }
  const subtotal = lines.reduce((sum, l) => sum + l.qty * l.cents, 0);
  const discount = off(coupon, subtotal);
  return enc.encode(
    JSON.stringify({
      customer,
      lines: lines.length,
      items: lines.reduce((sum, l) => sum + l.qty, 0),
      subtotal,
      discount,
      total: subtotal - discount,
    }),
  );
}
