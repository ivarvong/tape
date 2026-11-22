// sql.js 1.10.3 (MIT), from https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/: SQLite 3.45.2 compiled to Wasm.
// build.ts serves sql-wasm.js as a module (it appends `export default initSqlJs`) and checks both files: sql-wasm.js
// against the SRI hash cdnjs publishes for it (api.cdnjs.com/libraries/sql.js/1.10.3?fields=sri), sql-wasm.wasm
// (which cdnjs lists no hash for) against the hash of the file cdnjs served on 22 November 2026.
import type { InitSqlJs } from '../../src/sqlite.ts';
declare const initSqlJs: InitSqlJs;
export default initSqlJs;
