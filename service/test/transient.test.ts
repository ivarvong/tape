// RUNTIME-SPEC R-ANS-2: which storage failures are transient (503 at the edge; unreachable between programs)
import { it, expect } from 'vitest';
import { transientAtEdge, transientBetween } from '../../host/failure.ts';

it('a busy, locked or reset store is transient at the edge; a full database is storage but not transient; a program error is neither', () => {
  const storage = [
    'SQLITE_BUSY: database is locked',
    'SQLITE_IOERR: disk I/O error',
    'Network connection lost.',
    'Durable Object reset because its code was updated.',
    'internal error',
  ];
  expect([storage.map(transientAtEdge), storage.map(transientBetween)]).toEqual([
    [true, true, true, true, true],
    [true, true, true, true, true],
  ]);
  expect([
    transientAtEdge('SQLITE_FULL: database or disk is full'),
    transientBetween('SQLITE_FULL: database or disk is full'),
  ]).toEqual([false, true]);
  expect(
    ['trap 4: division by zero', 'SQLITE_CONSTRAINT: UNIQUE constraint failed: t.x'].map(transientBetween),
  ).toEqual([false, false]);
  // a code on the error is the same kind as the token in a message
  expect(transientAtEdge({ code: 'SQLITE_BUSY' })).toBe(true);
  expect(transientAtEdge({ kind: 'full' })).toBe(false);
});
