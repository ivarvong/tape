// sql-wasm.js beside loaded.ts in the Dynamic Worker: sql.js's script with `export default initSqlJs` added
// (index.ts, MODULES). Its init takes the instantiateWasm hook runner.ts gives it.
import type { SqlJsInit } from './runner.ts';
declare const initSqlJs: SqlJsInit;
export default initSqlJs;
