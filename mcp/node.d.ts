// mcp/node.d.ts: for the check of the Node side (tsconfig.node.json). tools.ts imports service/src/view.ts, which
// reaches service/src/spans.ts, written for a Worker, where `scheduler` is a global; nothing here calls it (only the
// service's router does), so it is declared and nothing more (as apps/playground/env.d.ts does).
declare const scheduler: { wait(ms: number): Promise<void> };
