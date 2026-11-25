// What `node tape.ts` with no arguments, or with arguments it cannot use, prints.
export const USAGE = `usage:
  node tape.ts program.tape 'METHOD /path' ['POST /path\\n{json}' ...]   run requests, print responses, logs and traces
  node tape.ts fmt [--check] [--with f] files...                         rewrite files in the canonical layout, uses clauses too (--check: only report; --with: another file of the program)
  node tape.ts test [files...]                                           run the examples in comments (default: std and examples)
  node tape.ts sim files... [--seeds n] [--steps n] [--faults n]         simulate the programs together: requests, lost and cut calls, timers
                    [--random] [--exhaust depth] [--no-rules] [--quiet]     and the clock, checking their invariants (sim.ts)
                    [--replay 'json' --seed n]                             one script again
                    [--secret name=value] [--http table.json]              what every program's secret() reads and fetch is answered
  node tape.ts program.tape … [--secret name=value] [--http table.json] the same, for one run`;
