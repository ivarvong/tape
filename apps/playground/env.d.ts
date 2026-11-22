// apps/playground/env.d.ts: for the playground's own check (`tsc -p apps/playground`, with the DOM). workbench.ts
// imports service/src/view.ts, which reaches service/src/spans.ts, written for a Worker, where `scheduler` is a
// global; the page never calls it (only the service's router does), so it is declared here and nothing more.
declare const scheduler: { wait(ms: number): Promise<void> };
