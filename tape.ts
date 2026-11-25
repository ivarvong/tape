// tape.ts: the command line.
//   node tape.ts hello.tape 'GET /hello/ada' ['POST /x⏎{"a":1}' ...]     run requests (\n in an argument is a line feed)
//   node tape.ts fmt [--check] [--with f] files…                          the canonical layout, `uses` clauses too
//   node tape.ts test [files…]                                            the examples in comments
//   node tape.ts sim a.tape b.tape                                        simulate them together
// Each command is a file of cli/.
import './node25.ts';
import { USAGE } from './cli/usage.ts';

const [command, ...rest] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') {
  console.error(USAGE);
  process.exit(command ? 0 : 2);
}
if (command === 'fmt') (await import('./cli/fmt.ts')).formatFiles(rest);
else if (command === 'test') (await import('./cli/test.ts')).testFiles(rest);
else if (command === 'sim') await (await import('./cli/sim.ts')).simulate(rest);
else await (await import('./cli/run.ts')).runRequests(command, rest);
