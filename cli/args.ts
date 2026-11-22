// --name value among a command's arguments, or the fallback
export const option = <T>(args: readonly string[], name: string, fallback: T): string | T => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : (args[i + 1] ?? fallback);
};

// "1 path", "3 paths"
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
