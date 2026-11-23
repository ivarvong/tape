// bench/suite/workloads.ts: the six workloads by name (loaded on demand, so one can run without the others).
import type { Workload } from './common.ts';

export const NAMES = ['crud', 'ledger', 'webhook', 'trace', 'csv', 'words'] as const;
export async function load(name: string): Promise<Workload> {
  switch (name) {
    case 'crud':
      return (await import('./crud-js.ts')).workload;
    case 'ledger':
      return (await import('./ledger-js.ts')).workload;
    case 'webhook':
      return (await import('./webhook-js.ts')).workload;
    case 'trace':
      return (await import('./trace.ts')).workload;
    case 'csv':
      return (await import('./pure.ts')).csv;
    case 'words':
      return (await import('./pure.ts')).words;
    default:
      throw new Error(`no workload ${name}; there are: ${NAMES.join(', ')}`);
  }
}
