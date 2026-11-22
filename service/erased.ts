// erased.ts: a Vite plugin. `import text from './file.ts?erased'` gives the file as JavaScript text: its types
// replaced by spaces (the toolchain is erasable TypeScript, so that is all it takes) and each relative './x.ts'
// it imports read as './x.js'. For source handed to the Worker Loader, which runs JavaScript modules by name.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type { Plugin } from 'vite';

const MARK = '\0erased:';
export const erased = (): Plugin => ({
  name: 'erased',
  enforce: 'pre',
  async resolveId(id, importer) {
    if (!id.endsWith('?erased')) return null;
    const file = await this.resolve(id.slice(0, -'?erased'.length), importer);
    return file ? MARK + file.id : null;
  },
  load(id) {
    if (!id.startsWith(MARK)) return null;
    const file = id.slice(MARK.length);
    this.addWatchFile(file);
    const text = stripTypeScriptTypes(readFileSync(file, 'utf8')).replaceAll(
      /(from\s+['"]\.[^'"]*)\.ts(['"])/g,
      '$1.js$2',
    );
    return `export default ${JSON.stringify(text)};`;
  },
});
