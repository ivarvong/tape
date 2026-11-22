// Deterministic CSV generator: gen(targetBytes, seed, crlf) -> Buffer.
import '../node25.ts';
export function gen(targetBytes: number, seed = 1, crlf = false): Buffer {
  let s = seed >>> 0 || 1;
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const int = (lo: number, hi: number): number => lo + ((rnd() * (hi - lo + 1)) | 0);
  const C = [
    'US',
    'DE',
    'FR',
    'GB',
    'JP',
    'BR',
    'IN',
    'CA',
    'AU',
    'MX',
    'NL',
    'SE',
    'NO',
    'ES',
    'IT',
    'KR',
    'SG',
    'ZA',
    'NG',
    'AR',
  ];
  const nl = crlf ? '\r\n' : '\n';
  const BAD: (() => string)[] = [
    () => `${int(1, 9e8)},u${int(1, 999)},${int(1, 9999)},us`,
    () => `${int(1, 9e8)},u${int(1, 999)},${int(1, 9999)}`,
    () => `${int(1, 9e8)},u${int(1, 999)},${int(1, 9999)},US,extra`,
    () => `${int(1, 9e8)},,${int(1, 9999)},DE`,
    () => `${int(1, 9e8)},u${int(1, 999)},12.5,FR`,
    () => `x${int(1, 9e8)},u${int(1, 999)},5,FR`,
    () => `${int(1, 9e8)},u${int(1, 999)},1234567890123,JP`,
  ];
  const bad = (): string => BAD[int(0, BAD.length - 1)]?.() ?? '';
  const lines = ['ts,user,amount,country'];
  let size = 24;
  while (size < targetBytes) {
    const line =
      rnd() < 0.03
        ? bad()
        : `${1700000000 + int(0, 9e7)},user${int(1, 5000)},${rnd() < 0.1 ? '-' : ''}${int(0, 250000)},${C[int(0, C.length - 1)]}`;
    lines.push(line);
    size += line.length + nl.length;
  }
  return Buffer.from(lines.join(nl) + nl, 'utf8');
}
