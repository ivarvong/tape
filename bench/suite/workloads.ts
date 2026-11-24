// bench/suite/workloads.ts: the six workloads by name, and the renderer and the blog (loaded on demand, so one
// can run without the others). The six are NAMES: each has a JS twin, and run.ts times them against it. The
// renderer and the blog have none, so the table does not run them; profile.ts and one.ts do.
import type { Workload } from './common.ts';

export const NAMES = ['crud', 'ledger', 'webhook', 'trace', 'csv', 'words'] as const;
const DOGFOOD = ['md', 'blog-put', 'blog-get', 'blog-index', 'blog-feed'] as const;
export async function load(name: string): Promise<Workload> {
  if (DOGFOOD.some(n => n === name)) {
    const found = (await import('./blog.ts')).workloads[name];
    if (found === undefined) throw new Error(`no workload ${name}`);
    return found;
  }
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
      throw new Error(`no workload ${name}; there are: ${[...NAMES, ...DOGFOOD].join(', ')}`);
  }
}
