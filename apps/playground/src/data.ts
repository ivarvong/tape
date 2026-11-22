// apps/playground/src/data.ts: what the page is given besides its code: the examples with their texts, the
// highlighter and the trace renderer. In Node (test.ts) it is read from the tree here; build.ts replaces this
// module with the same object as a constant, so the page reads nothing at run time.
import { existsSync, readFileSync } from 'node:fs';
import { EXAMPLES, sectionProgram } from '../examples.ts';
import type { Example } from '../examples.ts';

export type ExampleData = Omit<Example, 'files'> & { files: { name: string; text: string; from: string }[] };
export type Data = { examples: ExampleData[]; highlight: string; trace: string | null };

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');

/** The data, from the tree as it is now. */
export function readData(): Data {
  const examples = EXAMPLES.map((ex): ExampleData => ({
    ...ex,
    files: ex.files.map(f => {
      if ('path' in f) return { name: f.name, text: read(f.path), from: f.path };
      const text = sectionProgram(read(f.doc), f.section);
      if (text === null) throw new Error(`${f.doc} has no tape block under "${f.section}"`);
      return { name: f.name, text, from: `${f.doc}, ${f.section.replace(/^#+ /, '')}` };
    }),
  }));
  const trace = existsSync(new URL('apps/trace/trace.tape', ROOT)) ? read('apps/trace/trace.tape') : null;
  return { examples, highlight: read('apps/highlight/highlight.tape'), trace };
}

export const DATA: Data = readData();
