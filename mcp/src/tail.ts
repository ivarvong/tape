// tail.ts: what the tail of a program's Dynamic Worker (index.ts RunTail) logs about each of its invocations. The
// platform reports nothing of a Dynamic Worker to Workers Observability: no invocation, no CPU, no memory. Its tail
// gets each invocation's CPU and wall time, outcome and exceptions (workerd's TraceItem); this makes one line of
// each, joined to the hosted call's own line by the run id the runner logs first (loaded.ts). A pure function of
// the events, so test.ts checks it in Node.
type Fields = Record<string, unknown>;
/** The parts of a TraceItem this reads (the type is workerd's; Node has none). */
export type TailEvent = {
  readonly event: unknown;
  readonly logs: readonly { readonly message: unknown }[];
  readonly exceptions: readonly { readonly name: string; readonly message: string }[];
  readonly outcome: string;
  readonly cpuTime: number;
  readonly wallTime: number;
};

/** The run id in an invocation's logs: the first `{"tape-mcp.run_id": …}` it logged, or null. */
function runIdOf(logs: TailEvent['logs']): string | null {
  for (const l of logs)
    for (const part of Array.isArray(l.message) ? l.message : [l.message]) {
      if (typeof part !== 'string' || !part.startsWith('{"tape-mcp.run_id":')) continue;
      try {
        const parsed: unknown = JSON.parse(part);
        const id: unknown =
          typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'tape-mcp.run_id') : undefined;
        if (typeof id === 'string') return id;
      } catch {
        // not the runner's line
      }
    }
  return null;
}

/** One log line per invocation of a program's Dynamic Worker. */
export const tailLines = (events: readonly TailEvent[]): Fields[] =>
  events.map(e => {
    const method: unknown =
      typeof e.event === 'object' && e.event !== null ? Reflect.get(e.event, 'rpcMethod') : undefined;
    return {
      event: 'tape-mcp.run',
      run_id: runIdOf(e.logs),
      method: typeof method === 'string' ? method : null,
      outcome: e.outcome,
      cpu_ms: e.cpuTime,
      wall_ms: e.wallTime,
      exceptions: e.exceptions.map(x => `${x.name}: ${x.message}`.slice(0, 300)),
    };
  });
