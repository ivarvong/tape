// What a test leaves in its meta for the json reporter: a transcript, or a run's summary.
import 'vitest';

declare module 'vitest' {
  interface TaskMeta {
    demo?: string;
    jepsen?: unknown;
    seams?: unknown;
    dump?: unknown[];
    u3?: unknown;
    machine?: unknown;
  }
}
