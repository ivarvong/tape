// compiler/types.ts: the types and built-in functions the compiler knows by name.
export const BUILTIN_TYPES = new Set([
  'Int',
  'Float',
  'Dec',
  'Bool',
  'View',
  'Buf',
  'Sql',
  'Remote',
  'Remotes',
  'Clock',
  'Entropy',
  'Timer',
  'Rows',
  'Fn',
  'Fn2',
]);
export const CAPABILITIES = ['Sql', 'Remote', 'Remotes', 'Clock', 'Entropy', 'Timer'];

// An interface's name is a capability type, like Remote, for the build that declares it and no longer: compile()
// takes back what a build added, whether or not the build succeeded.
const added: string[] = [];
export function addCapability(name: string): void {
  BUILTIN_TYPES.add(name);
  CAPABILITIES.push(name);
  added.push(name);
}
export function forgetAddedCapabilities(): void {
  for (const name of added.splice(0)) {
    BUILTIN_TYPES.delete(name);
    CAPABILITIES.splice(CAPABILITIES.indexOf(name), 1);
  }
}
/** Each built-in: its parameters by name, or null for one whose arguments the compiler reads by label itself. */
export const INTRINSICS: ReadonlyMap<string, readonly string[] | null> = new Map<string, readonly string[] | null>(
  Object.entries({
    len: ['v'],
    slice: ['v', 'from', 'to'],
    buf: [],
    push: ['buf', 'byte'],
    append: ['buf', 'view'],
    freeze: ['buf'],
    rollback: ['out'],
    size: ['buf'],
    next: ['rows'],
    sql_exec: null,
    sql_first: null,
    sql_all: null,
    sql_move: null,
    remote: null,
    decode: null,
    call: null,
    ask: null,
    now: null,
    random: null,
    wake: null,
    write_json: ['out', 'value'],
    write_float: ['out', 'value'],
    wrapping_add: ['a', 'b'],
    wrapping_sub: ['a', 'b'],
    wrapping_mul: ['a', 'b'],
    // numbers (compiler/gen/float.ts)
    float: ['n'],
    trunc: ['x'],
    floor: ['x'],
    ceil: ['x'],
    sqrt: ['x'],
    abs: ['x'],
    min: ['a', 'b'],
    max: ['a', 'b'],
    // the math library (compiler/math)
    sin: ['x'],
    cos: ['x'],
    atan2: ['y', 'x'],
    exp: ['x'],
    log: ['x'],
    pow: ['x', 'y'],
    scan_plain: ['v', 'at'],
    parse_float: ['text'],
    // Dec (compiler/gen/dec.ts)
    rescale: ['x', 'to'],
    round: ['x', 'to', 'rounding'],
    mul: ['a', 'by', 'scale', 'rounding'],
    div: ['a', 'by', 'scale', 'rounding'],
    dec: ['n', 'scale'],
    to_int: ['x', 'rounding'],
    to_dec: ['x', 'scale', 'rounding'],
    parse_dec: ['text', 'scale'],
    write_dec: ['out', 'value'],
  }),
);
/** A type as the compiler holds it: a name applied to types. */
export type Type = { name: string; args: Type[] };
export const T = (n: string, ...args: Type[]): Type => ({ name: n, args });
export const INT = T('Int'),
  FLOAT = T('Float'),
  /** Dec[s]: the scale is the type's one argument, its digits as a name */
  decType = (s: number): Type => T('Dec', T(String(s))),
  BOOL = T('Bool'),
  VIEW = T('View'),
  BUF = T('Buf'),
  REMOTE = T('Remote');
export const key = (t: Type): string => t.name + (t.args.length > 0 ? `[${t.args.map(key).join(', ')}]` : '');
export const same = (a: Type, b: Type): boolean => key(a) === key(b);
/** The scale of a Dec[s], or null for any other type. */
export const scaleOf = (t: Type): number | null => (t.name === 'Dec' && t.args[0] ? Number(t.args[0].name) : null);
