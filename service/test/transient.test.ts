// RUNTIME-SPEC R-ANS-2: which storage failures are transient (503 at the edge; unreachable between programs)
import { it, expect } from 'vitest';
// program.ts is a Dynamic Worker module (it imports the loader's host.ts), so its patterns are read from its source
import source from '../src/program.ts?raw';
const pattern = (name: string): RegExp => {
  const [, body = '', flags = ''] = new RegExp(`export const ${name} =\\s*/(.+)/(\\w*);`).exec(source) ?? [];
  expect(body).not.toBe('');
  return new RegExp(body, flags);
};
const TRANSIENT = pattern('TRANSIENT'),
  FULL = pattern('FULL');
it('a busy, locked or reset store is transient at the edge; a full database is storage but not transient; a program error is neither', () => {
  const edge = (m: string): boolean => TRANSIENT.test(m) && !FULL.test(m),
    between = (m: string): boolean => TRANSIENT.test(m);
  const storage = [
    'SQLITE_BUSY: database is locked',
    'SQLITE_IOERR: disk I/O error',
    'Network connection lost.',
    'Durable Object reset because its code was updated.',
    'internal error',
  ];
  expect([storage.map(edge), storage.map(between)]).toEqual([
    [true, true, true, true, true],
    [true, true, true, true, true],
  ]);
  expect([edge('SQLITE_FULL: database or disk is full'), between('SQLITE_FULL: database or disk is full')]).toEqual([
    false,
    true,
  ]);
  expect(
    ['trap 4: division by zero or overflow', 'SQLITE_CONSTRAINT: UNIQUE constraint failed: t.x'].map(between),
  ).toEqual([false, false]);
});
