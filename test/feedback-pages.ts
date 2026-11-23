// test/feedback-pages.ts: mcp/scripts/feedback.ts lists every report, page by page. `cf r2 objects list` prints the
// page of objects on stdout and its result_info, with the cursor of the next page, on stderr; reading the cursor from
// stdout alone stopped after the first page (20 reports a day at most were shown). Fake cf output, two pages.
import { keysWith } from '../mcp/scripts/feedback.ts';
import { finish, same } from './harness.ts';

const pages: Record<string, { stdout: string; stderr: string }> = {
  first: {
    stdout: JSON.stringify([{ key: '2026/11/22/a.json' }, { key: '2026/11/22/b.json' }], null, 2),
    stderr: `${JSON.stringify({ result_info: { cursor: 'c-2', is_truncated: true, per_page: 1000 } }, null, 2)}\n`,
  },
  'c-2': {
    stdout: JSON.stringify([{ key: '2026/11/22/c.json' }]),
    stderr: JSON.stringify({ result_info: { is_truncated: false, per_page: 1000 } }),
  },
};
const asked: string[][] = [];
const got = keysWith(args => {
  asked.push(args);
  const at = args.indexOf('--cursor');
  return pages[at < 0 ? 'first' : (args[at + 1] ?? '')] ?? { stdout: '[]', stderr: '' };
}, '2026/11/22/');
same('every page: three keys', got, ['2026/11/22/a.json', '2026/11/22/b.json', '2026/11/22/c.json']);
same(
  'two calls, the second with the cursor from stderr',
  asked.map(a => a.includes('--cursor')),
  [false, true],
);
same(
  'a page of 1000',
  asked.every(a => a[a.indexOf('--per-page') + 1] === '1000'),
  true,
);
finish();
