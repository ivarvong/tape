// tape program.tape 'METHOD /path' …: compile one program with std, check its SQL against its schema, run the
// requests against it on one in-memory SQLite, and print each response, its effect log, and the trace made
// afterwards from that log. Remotes are not provided here.
import { readFileSync } from 'node:fs';
import { checkQueries } from '../check.ts';
import { compile } from '../compiler.ts';
import type { Built } from '../compiler.ts';
import { instantiate, isCall, isHead, isNow, isRandom, isWake, traceOf } from '../host.ts';
import type { Cell, Effect, TraceEvent } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const answer = (e: { rows?: Cell[][] | undefined; r?: number | undefined }): string =>
  e.rows ? JSON.stringify(e.rows) : `${e.r} written`;

/** One entry of the effect log, as a line. */
function effectLine(plain: Built, e: Effect): string {
  if (isHead(e)) return `start   build ${e.build}  flags ${JSON.stringify(e.flags)}  ${e.bytes} bytes of memory`;
  if (isCall(e)) return `call    ${e.call}.${e.method} within ${e.within} ms -> ${e.status}`;
  if (isWake(e)) return `wake    ${e.wake} after ${e.after} ms (due ${new Date(e.due).toISOString()})`;
  if (isNow(e)) return `now     -> ${e.now}`;
  if (isRandom(e)) return `random  -> ${e.random}`;
  return `sql     ${plain.queries[e.q]?.sql ?? e.q}  ${JSON.stringify(e.p)} -> ${answer(e)}`;
}

/** What the host did between two sites of a trace; null for what the trace does not show. */
function hostLine(e: TraceEvent): string | null {
  if ('sql' in e) return `        sql ${JSON.stringify(e.p)} -> ${answer(e)}`;
  if ('json' in e) return `        json: ${e.json}`;
  return 'call' in e ? `        call ${e.call}.${e.method} -> ${e.status}` : null;
}

/** The trace of one request as lines: each function entered, and each arm or step tried in this file. */
function traceLines(traced: Built, file: string, lines: readonly string[], events: readonly TraceEvent[]): string[] {
  // an arm tried and matched is shown once, as matched
  const matched = (site: number, i: number): boolean => {
    const next = events.slice(i + 1).find(e => 'site' in e && e.site === site);
    return next !== undefined && 'what' in next && next.what === 1;
  };
  const source = (line: number): string =>
    `${String(line).padStart(3)}  ${(lines[line - 1] ?? '').trim().slice(0, 100)}`;
  return events.flatMap((e, i) => {
    if (!('site' in e)) return hostLine(e) ?? [];
    const s = traced.sites[e.site];
    if (s?.file !== file) return [];
    if (e.what === 2) return [`  ${s.fn}`];
    if (e.what === 0 && s.kind !== 'else' && !matched(e.site, i)) return [`    ✗ ${source(s.line)}`];
    return e.what === 1 ? [`    ✓ ${source(s.line)}`] : [];
  });
}

/** The program compiled plain and traced, or the process ends with what is wrong with it. */
function compiled(file: string, text: string): { plain: Built; traced: Built } {
  const sources = [...std, { name: file, text }];
  const plain = compile(sources);
  const traced = compile(sources, { trace: true });
  if (plain.wasm === null || traced.wasm === null) {
    for (const e of plain.errors)
      console.error(`${file}:${e.line}: ${e.code} ${e.message}${e.hint ? `\n  ${e.hint}` : ''}`);
    process.exit(1);
  }
  const bad = checkQueries(plain);
  for (const b of bad) console.error(`${file}: SQL: ${b}`);
  if (bad.length > 0) process.exit(1);
  return { plain, traced };
}

export async function runRequests(file: string, requests: readonly string[]): Promise<void> {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const { plain, traced } = compiled(file, text);
  const tmod = new WebAssembly.Module(traced.wasm);
  const app = instantiate(new WebAssembly.Module(plain.wasm), { sql: nodeSql(), name: 'cli' });
  console.log(`${file}: ${plain.wasm.length} bytes of Wasm, ${plain.functions.length} functions`);
  for (const r of requests.length > 0 ? requests : ['']) {
    const req = enc.encode(r.replaceAll(String.raw`\n`, '\n').replace(/^([A-Z]+ \S+)$/, '$1\n'));
    const ran = await app.runLogged(req);
    console.log(`\n→ ${r}\n← ${dec.decode(ran.out).replaceAll('\n', ' ⏎ ')}\n\n  effect log`);
    for (const e of ran.effects) console.log(`    ${effectLine(plain, e)}`);
    const t = traceOf(tmod, req, ran.effects);
    const out = [...traceLines(traced, file, lines, t.events), ...(t.error === null ? [] : [`  ${t.error}`])];
    console.log(`\n  trace, from that log\n${out.join('\n')}`);
  }
}
