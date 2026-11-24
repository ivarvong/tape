// A storage failure as the runtime reports it: a code on the error, or the code as the token before the first colon
// of its message. The rest of the service switches on the kind. A full database is storage and is not retried at the
// client edge: it stays full until rows are removed.
export type StorageKind =
  'busy' | 'locked' | 'io' | 'full' | 'nomem' | 'cantopen' | 'protocol' | 'network' | 'reset' | 'internal';

const CODES: Readonly<Record<string, StorageKind>> = {
  SQLITE_BUSY: 'busy',
  SQLITE_LOCKED: 'locked',
  SQLITE_IOERR: 'io',
  SQLITE_FULL: 'full',
  SQLITE_NOMEM: 'nomem',
  SQLITE_CANTOPEN: 'cantopen',
  SQLITE_PROTOCOL: 'protocol',
};

const isKind = (v: unknown): v is StorageKind =>
  v === 'busy' ||
  v === 'locked' ||
  v === 'io' ||
  v === 'full' ||
  v === 'nomem' ||
  v === 'cantopen' ||
  v === 'protocol' ||
  v === 'network' ||
  v === 'reset' ||
  v === 'internal';

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : typeof err === 'string' ? err : '');

/** The storage kind of an error, or null when it is the program's own failure. */
export function storageKind(err: unknown): StorageKind | null {
  if (typeof err === 'object' && err !== null) {
    if ('kind' in err && isKind(err.kind)) return err.kind;
    if ('code' in err && typeof err.code === 'string') {
      const named = CODES[err.code];
      if (named !== undefined) return named;
    }
  }
  const message = messageOf(err);
  const token = message.split(':')[0]?.trim() ?? '';
  const named = CODES[token];
  if (named !== undefined) return named;
  if (message.startsWith('Network connection lost')) return 'network';
  if (message.includes('Durable Object') && (message.includes('storage') || message.includes('reset'))) return 'reset';
  if (message.toLowerCase().includes('internal error')) return 'internal';
  return null;
}

/** At the client edge a full database is not retried. Between programs every storage kind is transient. */
export const transientAtEdge = (err: unknown): boolean => {
  const kind = storageKind(err);
  return kind !== null && kind !== 'full';
};
export const transientBetween = (err: unknown): boolean => storageKind(err) !== null;
