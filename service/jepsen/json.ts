// json.ts: reading what came over HTTP. A response body is JSON of some shape, or text; these read it without
// assuming the shape: a field that is not there reads as undefined, a number that is not one as 0.
export type Fields = Readonly<Record<string, unknown>>;
export const fields = (v: unknown): Fields =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : {};
export const list = (v: unknown): unknown[] => {
  const all: unknown[] = Array.isArray(v) ? v : [];
  return all;
};
export const text = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
export const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
export const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** The value at a path of field names and indexes; undefined when any step is not there. */
export const at = (v: unknown, ...path: readonly (string | number)[]): unknown => {
  let here = v;
  for (const step of path) here = typeof step === 'number' ? list(here)[step] : fields(here)[step];
  return here;
};
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
