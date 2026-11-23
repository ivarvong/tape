// feedback.ts: read the feedback agents sent through tape-mcp's feedback tool (src/feedback.ts), from the private
// R2 bucket tape-feedback, with cf (the OAuth login: CLOUDFLARE_API_TOKEN is unset for it).
//   node mcp/scripts/feedback.ts                  the last 7 days' reports, newest first, one line each
//   node mcp/scripts/feedback.ts --days 30        further back
//   node mcp/scripts/feedback.ts --smoke          the deploys' smoke reports (smoke/) instead
//   node mcp/scripts/feedback.ts --show <id>      one report in full, as JSON (add --smoke for a smoke report)
//   node mcp/scripts/feedback.ts --delete-smoke   delete every smoke report
// The hash of a client's address is left out unless --ip is given. Needs CLOUDFLARE_ACCOUNT_ID.
import '../../node25.ts';
import { spawnSync } from 'node:child_process';

const BUCKET = 'tape-feedback';
const env = { ...process.env };
delete env['CLOUDFLARE_API_TOKEN'];
const cfBoth = (a: string[]): Ran => {
  const r = spawnSync('npx', ['cf', ...a], {
    env,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    cwd: new URL('..', import.meta.url).pathname,
  });
  if (r.status !== 0) throw new Error(`cf ${a.join(' ')}: exit ${r.status ?? r.signal}: ${r.stderr.slice(0, 300)}`);
  return { stdout: r.stdout, stderr: r.stderr };
};
const cf = (...a: string[]): string => cfBoth(a).stdout;

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const F = (v: unknown): Fields => (isFields(v) ? v : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ''));

/** What one call of cf gives: its two streams. */
export type Ran = { stdout: string; stderr: string };
/**
 * Every key under a prefix (cf r2 objects list, 1000 a page). cf prints the page of objects on stdout and its
 * result_info, with the next page's cursor, on stderr: the cursor is read from both (from stdout alone, paging
 * stopped after the first page, so at most 20 reports a day were listed).
 */
export function keysWith(run: (args: string[]) => Ran, prefix: string): string[] {
  const out: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const { stdout, stderr } = run([
      'r2',
      'objects',
      'list',
      '--bucket-name',
      BUCKET,
      '--prefix',
      prefix,
      '--per-page',
      '1000',
      ...(cursor ? ['--cursor', cursor] : []),
    ]);
    const at = stdout.indexOf('[');
    const parsed: unknown = at < 0 ? [] : JSON.parse(stdout.slice(at, stdout.lastIndexOf(']') + 1));
    const list = Array.isArray(parsed) ? parsed : [];
    for (const o of list) if (typeof F(o)['key'] === 'string') out.push(String(F(o)['key']));
    const next = /"cursor":\s*"([^"]+)"/.exec(`${stderr}\n${stdout}`)?.[1] ?? null;
    if (next === null || next === cursor || list.length === 0) return out;
    cursor = next;
  }
}
const get = (key: string): Fields => F(JSON.parse(cf('r2', 'objects', 'get', key, '--bucket-name', BUCKET, '--text')));

if (import.meta.url === `file://${process.argv[1] ?? ''}`) main();

function main(): void {
  const args = process.argv.slice(2);
  const has = (f: string): boolean => args.includes(`--${f}`);
  const opt = (f: string): string | null => {
    const i = args.indexOf(`--${f}`);
    return i < 0 ? null : (args[i + 1] ?? null);
  };
  const days = Number(opt('days') ?? '7'),
    smoke = has('smoke'),
    ip = has('ip'),
    show = opt('show');
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > 366 ||
    (show !== null && !/^\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{12}$/.test(show))
  ) {
    console.error('usage: node mcp/scripts/feedback.ts [--days N] [--smoke] [--show <id>] [--ip] [--delete-smoke]');
    process.exit(2);
  }

  const keys = (prefix: string): string[] => keysWith(cfBoth, prefix);
  /** A report as it is shown: without the address's hash unless --ip. */
  const shown = (r: Fields): Fields => {
    const server = { ...F(r['server']) };
    if (!ip) delete server['ip_hash'];
    return { ...r, server };
  };
  const keyOf = (id: string): string =>
    `${smoke ? 'smoke/' : ''}${id.slice(0, 4)}/${id.slice(4, 6)}/${id.slice(6, 8)}/${id}.json`;
  if (has('delete-smoke')) {
    const all = keys('smoke/');
    for (const k of all) cf('r2', 'objects', 'delete', k, '--bucket-name', BUCKET, '--force');
    console.log(`deleted ${all.length} smoke reports`);
  } else if (show !== null) {
    console.log(JSON.stringify(shown(get(keyOf(show))), null, 2));
  } else {
    const prefixes = smoke
      ? ['smoke/']
      : Array.from(
          { length: days },
          (_, i) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '/') + '/',
        );
    const all = prefixes.flatMap(keys).toSorted().toReversed();
    console.log(`${all.length} reports${smoke ? ' (smoke)' : ` in the last ${days} days`}`);
    for (const k of all) {
      const r = get(k),
        rep = F(r['reproduced']),
        codes = Array.isArray(rep['diagnostic_codes']) ? rep['diagnostic_codes'].map(str).join(',') : '';
      const text = str(r['text']).replaceAll(/\s+/g, ' ');
      console.log(
        [
          str(r['received_at']).slice(0, 19),
          (str(r['kind'] ?? '') || '-').padEnd(9),
          str(r['id']),
          `files ${Array.isArray(r['files']) ? r['files'].length : 0}`,
          rep['ok'] === undefined ? 'no program' : `compiles ${str(rep['ok'])}${codes ? ` ${codes}` : ''}`,
          text.length > 90 ? `${text.slice(0, 89)}…` : text,
        ].join('  '),
      );
    }
  }
}
