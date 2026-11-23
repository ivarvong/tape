// apps/playground/src/lines.ts: an effect log and a trace as lines for the page, with each query in the program's
// own words (its `:name` placeholders). Pure functions of a build and a log: no Wasm is compiled or run here, so a
// Worker (mcp/, which cannot compile Wasm) uses them too. workbench.ts re-exports them.
import type { Built } from '../../../compiler.ts';
import { isCall, isHead, isNow, isRandom, isSql, isWake } from '../../../host.ts';
import type { Cell, Effect, TraceEvent } from '../../../host.ts';
import { lex } from '../../../compiler/lex.ts';
import { inNames, numbered } from '../../../compiler/sqltext.ts';

const dec = new TextDecoder();

/** One line of an effect log or of a trace, for the page: its kind, its text, and the source line it is about. */
export type Line = {
  kind: string;
  text: string;
  line?: number;
  program?: string;
  /** a query, as the program wrote it (its `:name` placeholders), the value bound to each name, and what came back */
  sql?: { query: string; binds: [string, string][]; result: string };
  /** a write its run's rollback(out) or trap undid: shown struck through */
  undone?: true;
};
/** What a write's line says it wrote; an undone one says so. */
const wrote = (r: number | undefined, undone: boolean): string => `${r} written${undone ? ', undone' : ''}`;

const cells = (rows: readonly Cell[][] | undefined): string =>
  JSON.stringify(rows, (_k, v: unknown) =>
    v instanceof Uint8Array ? `<${v.length} bytes>` : typeof v === 'bigint' ? Number(v) : v,
  );

/**
 * The names a program gave the values of its queries. The compiler numbers `:name` placeholders in the order they
 * first appear (compiler/sqltext.ts) and the build lists each statement in that numbered form, which is what the
 * host logs; the program's own text literals, read by the compiler's lexer, give the names back.
 */
export function queryNames(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let toks: ReturnType<typeof lex>;
  try {
    toks = lex('program.tape', text);
  } catch {
    return out;
  }
  // two literals that differ only in their names (`:id`, `:to`) are one statement, and a log entry cannot say which
  // ran: such a statement keeps its numbers
  const clash = new Set<string>();
  for (const t of toks) {
    if (t.t !== 'str') continue;
    const n = numbered(dec.decode(Uint8Array.from(t.v)));
    if (!n.names || n.names.length === 0 || n.mixed) continue;
    const had = out.get(n.sql);
    if (had && had.join(',') !== n.names.join(',')) clash.add(n.sql);
    out.set(n.sql, n.names);
  }
  for (const sql of clash) out.delete(sql);
  return out;
}

/** One entry of an effect log, as the page shows it: a query in the program's own words (its `:name`s). */
export function effectLine(built: Built | null, e: Effect, names: ReadonlyMap<string, string[]> = new Map()): Line {
  const ownNames = (numberedSql: string): string[] | null => {
    const exact = names.get(numberedSql);
    if (exact) return exact;
    // the build may have rewritten the text (a `*` the compiler expands to the row's columns): a literal matches when
    // it equals the statement with each `*` standing for some text, and its names are taken only when every literal
    // that matches gives the same names
    const found = new Map<string, string[]>();
    for (const [sql, ns] of names) {
      const re = new RegExp(
        `^${sql.replaceAll(/[.*+?^${}()|[\]\\]/g, c => (c === '*' ? '\u0000' : `\\${c}`)).replaceAll('\u0000', '.+?')}$`,
        's',
      );
      if (re.test(numberedSql)) found.set(JSON.stringify(ns), ns);
    }
    return found.size === 1 ? ([...found.values()][0] ?? null) : null;
  };
  if (isHead(e)) {
    const flags = Object.keys(e.flags).length > 0 ? `  flags ${JSON.stringify(e.flags)}` : '';
    const method = e.method ? `  method ${e.method}` : '';
    return {
      kind: 'head',
      text: `start   build ${e.build.slice(0, 12)}${flags}${method}${e.undone ? '  UNDONE' : ''}`,
    };
  }
  if (isCall(e)) {
    const once = 'once' in e;
    const send = typeof e.send === 'string' ? e.send : '(bytes)',
      reply = typeof e.reply === 'string' && e.reply !== '' ? ` ${e.reply}` : '';
    return {
      kind: e.status === 'ok' ? 'call' : 'bad',
      text: `${once ? 'call' : 'ask '}    ${e.call}.${e.method} ${send} within ${e.within} ms${once ? ` once ${JSON.stringify(e.once)}` : ''} -> ${e.status}${reply}`,
    };
  }
  if (isWake(e))
    return {
      kind: 'wake',
      text: `wake    ${e.wake} after ${e.after} ms (due ${new Date(e.due).toISOString()})${e.undone ? ', undone' : ''}`,
      ...(e.undone ? { undone: true as const } : {}),
    };
  if (isNow(e)) return { kind: 'now', text: `now     -> ${e.now} (${new Date(e.now).toISOString()})` };
  if (isRandom(e)) return { kind: 'now', text: `random  -> ${e.random}` };
  if (isSql(e)) {
    const numberedSql = built?.queries[e.q]?.sql ?? `query ${e.q}`,
      own = ownNames(numberedSql),
      query = inNames(numberedSql, own),
      result = e.rows ? cells(e.rows) : wrote(e.r, e.undone === true);
    const binds = e.p.map((v, i): [string, string] => [own?.[i] ? `:${own[i]}` : `?${i + 1}`, JSON.stringify(v)]);
    return {
      kind: 'sql',
      text: `sql     ${query}  ${JSON.stringify(e.p)} -> ${result}`,
      sql: { query, binds, result },
      ...(e.undone ? { undone: true as const } : {}),
    };
  }
  return { kind: 'mut', text: JSON.stringify(e) };
}

/** The trace of one run as lines: each function entered, and each arm or step tried in the program's own file. */
export function traceLines(
  traced: Built,
  file: string,
  lines: readonly string[],
  events: readonly TraceEvent[],
): Line[] {
  const matched = (site: number, i: number): boolean => {
    for (let j = i + 1; j < events.length; j++) {
      const n = events[j];
      if (n && 'site' in n && n.site === site) return n.what === 1;
    }
    return false;
  };
  const source = (line: number): string => (lines[line - 1] ?? '').trim().slice(0, 120);
  return events.flatMap((e, i): Line[] => {
    if ('sql' in e)
      return [
        {
          kind: 'sql',
          text: `sql ${JSON.stringify(e.p)} -> ${e.rows ? cells(e.rows) : wrote(e.r, e.undone === true)}`,
          ...(e.undone ? { undone: true as const } : {}),
        },
      ];
    if ('json' in e) return [{ kind: e.json === 'decoded' ? 'ok' : 'bad', text: `json: ${e.json}` }];
    if ('call' in e)
      return [
        {
          kind: e.status === 'ok' ? 'call' : 'bad',
          text: `call ${e.call}.${e.method} within ${e.within} ms -> ${e.status}`,
        },
      ];
    if (!('site' in e)) return [];
    const s = traced.sites[e.site];
    if (s?.file !== file) return [];
    if (e.what === 2) return [{ kind: 'fn', text: s.fn, line: s.line }];
    if (e.what === 0 && s.kind !== 'else' && !matched(e.site, i))
      return [{ kind: 'no', text: source(s.line), line: s.line }];
    return e.what === 1 ? [{ kind: 'ok', text: source(s.line), line: s.line }] : [];
  });
}
