// Imported for its effect by the test files that print their own FAIL lines: a printed FAIL (or "n FAILED") makes
// the process exit non-zero, so a failure cannot be passed over by whatever runs the file.
const say = console.log;
console.log = (...a: unknown[]): void => {
  if (/^FAIL|\d+ FAILED$/.test(String(a[0]))) process.exitCode = 1;
  say(...a);
};
