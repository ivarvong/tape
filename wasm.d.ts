// wasm.d.ts: the parts of the WebAssembly JavaScript API this repo uses, as Node 25 provides them.
// TypeScript only declares them in its browser libraries, which would bring every DOM global along.
declare namespace WebAssembly {
  type ImportExportKind = 'function' | 'global' | 'memory' | 'table' | 'tag';
  type ExportValue = ((...args: (number | bigint)[]) => unknown) | Global | Memory | Table;
  type ImportValue = ((...args: never[]) => unknown) | Global | Memory | Table | number | bigint;
  type Imports = Record<string, Record<string, ImportValue>>;

  class Module {
    constructor(bytes: BufferSource);
    static imports(module: Module): { module: string; name: string; kind: ImportExportKind }[];
    static exports(module: Module): { name: string; kind: ImportExportKind }[];
    static customSections(module: Module, name: string): ArrayBuffer[];
  }
  class Instance {
    constructor(module: Module, imports?: Imports);
    readonly exports: Record<string, ExportValue>;
  }
  class Global {
    value: number | bigint;
  }
  class Memory {
    constructor(descriptor: { initial: number; maximum?: number });
    readonly buffer: ArrayBuffer;
    grow(pages: number): number;
  }
  class Table {
    readonly length: number;
  }
  class RuntimeError extends Error {}
  function validate(bytes: BufferSource): boolean;
}
