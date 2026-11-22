// The host, under the name the Loader gives it to program.ts (index.ts loads host.ts of the repository root as
// `host.js` beside it). This file is what the type checker reads for that import; it is never bundled.
export * from '../../host.ts';
