// service/scripts/obs: the parsing trace.ts, cpu.ts and profile.ts rest on, on inputs built here (no network): a
// URL to its route, an invocation event and a call's log line to their rows, nearest-rank percentiles, a span tree
// from parent ids, and a pprof profile (written here field by field, as profile.proto lays it out) decoded, put in
// the hosted buckets, and its unnamed frames named from the source with every other byte kept.
import {
  callLogOf,
  grouped,
  invocationOf,
  observabilityDiff,
  pct,
  routeOf,
  spanOf,
  treeLines,
} from '../service/scripts/obs/o11y.ts';
import type { Invocation, Span } from '../service/scripts/obs/o11y.ts';
import { bucketOf, buckets, decode, encVarint, fields, nameAt, renamed } from '../service/scripts/obs/pprof.ts';
import type { Fn } from '../service/scripts/obs/pprof.ts';
import { finish, same } from './harness.ts';

const B = 'https://tape.ivar.workers.dev';
same(
  'routes',
  [
    '/',
    '/v1',
    '/mcp',
    '/v1/run',
    '/v1/compile',
    '/v1/nope',
    '/mcp/ivar',
    '/p/ivar/x',
    '/t/ivar',
    '/ivar/hello/a',
    '/playground/',
    '/x',
    'nonsense',
  ].map(p => routeOf(p === 'nonsense' ? p : B + p)),
  [
    '/',
    '/',
    '/mcp',
    '/v1/run',
    '/v1/compile',
    '/:account/:program…',
    '/mcp/:account',
    '/p/:account/…',
    '/t/:account/…',
    '/:account/:program…',
    '/playground',
    'other',
    'other',
  ],
);
same(
  'percentiles, nearest rank',
  [pct([5, 1, 4, 2, 3], 0.5), pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), pct([7], 0.99), pct([1, 100], 0.99)],
  [3, 9, 7, 100],
);
same('no values, no percentile', Number.isNaN(pct([], 0.5)), true);

const fetchEvent = {
  timestamp: 5,
  $workers: {
    scriptVersion: { id: 'dddd2c92-3fea-406b-a364-03c7d4b5eb4d' },
    executionModel: 'stateless',
    event: { request: { url: `${B}/v1/run`, method: 'POST' }, response: { status: 200 } },
    outcome: 'ok',
    cpuTimeMs: 313,
    wallTimeMs: 392,
  },
  $metadata: { type: 'cf-worker-event', requestId: 'r1', traceId: 't1', rayId: 'ray' },
};
const doEvent = {
  $workers: {
    scriptVersion: { id: 'v' },
    executionModel: 'durableObject',
    entrypoint: 'Name',
    eventType: 'jsrpc',
    event: { rpcMethods: ['isPublished'] },
    cpuTimeMs: 0,
    wallTimeMs: 11,
  },
  $metadata: { type: 'cf-worker-event' },
};
const inv = invocationOf(fetchEvent);
same('a fetch invocation', inv && [inv.route, inv.status, inv.cpu, inv.wall, inv.version.slice(0, 8), inv.requestId], [
  '/v1/run',
  200,
  313,
  392,
  'dddd2c92',
  'r1',
]);
same('a Durable Object invocation is its class and methods', invocationOf(doEvent)?.route, 'DO Name.isPublished');
same('a log line is not an invocation', invocationOf({ $metadata: { type: 'cf-worker' } }), null);
same(
  "a hosted call's log line",
  callLogOf({
    source: { event: 'tape-mcp.call', tool: 'run', via: 'mcp', requests: 2, source_bytes: 900 },
    $metadata: { type: 'cf-worker', requestId: 'r1' },
  }),
  { requestId: 'r1', tool: 'run', via: 'mcp', requests: 2, sourceBytes: 900 },
);
same('another log line is not one', callLogOf({ source: { msg: 'x' }, $metadata: { type: 'cf-worker' } }), null);
if (!inv) throw new Error('the fetch event did not read');
const rows = [3, 1, 2].map((cpu): Invocation => ({ ...inv, cpu }));
same(
  'grouped',
  grouped(rows, r => [r.route]).map(g => [g.key, g.n, g.cpu, g.cpuSum]),
  [[['/v1/run'], 3, [2, 3, 3], 6]],
);

const span = (id: string, parent: string | null, name: string, start: number): unknown => ({
  source: {
    name,
    startTime: start,
    durationMS: 1,
    'jsrpc.method': name === 'rpc' ? 'run' : undefined,
    faas: { name: 'tape' },
  },
  $metadata: { type: 'span', spanId: id, ...(parent ? { parentSpanId: parent } : {}) },
});
const spans = [
  span('c', 'a', 'rpc', 3),
  span('a', null, 'POST', 1),
  span('b', 'a', 'fetch', 2),
  span('d', 'zz', 'orphan', 4),
]
  .map(spanOf)
  .filter((s): s is Span => s !== null);
same(
  'a span tree: children under their parent in start order, a span whose parent is missing a root, infrastructure left out',
  treeLines(spans),
  ['POST  +0ms 1ms', '├─ fetch  +1ms 1ms', '└─ rpc  +2ms 1ms  jsrpc.method=run', 'orphan  +3ms 1ms'],
);

// ---- pprof: a profile written by hand
const enc = new TextEncoder();
const fld = (f: number, v: number | number[]): number[] =>
  typeof v === 'number'
    ? [...encVarint(f << 3), ...encVarint(v)]
    : [...encVarint((f << 3) | 2), ...encVarint(v.length), ...v];
const strings = [
  '',
  'cpu',
  'nanoseconds',
  'samples',
  'count',
  'runTool',
  '../mcp/src/tools.ts',
  'compiled',
  'lex',
  '../compiler/lex.ts',
  '',
  '(garbage collector)',
];
const fn = (id: number, name: number, file: number, line: number): number[] =>
  fld(5, [...fld(1, id), ...fld(2, name), ...fld(4, file), ...fld(5, line)]);
const loc = (id: number, f: number): number[] => fld(4, [...fld(1, id), ...fld(4, fld(1, f))]);
const sample = (locs: number[], ns: number): number[] =>
  fld(2, [
    ...fld(
      1,
      locs.flatMap(l => encVarint(l)),
    ),
    ...fld(2, [...encVarint(1), ...encVarint(ns)]),
  ]);
const raw = new Uint8Array([
  ...fld(1, [...fld(1, 3), ...fld(2, 4)]),
  ...fld(1, [...fld(1, 1), ...fld(2, 2)]),
  ...sample([3, 2, 1], 3_000_000), // leaf first: lex <- compiled <- runTool
  ...sample([4, 1], 1_000_000), // an unnamed frame of lex.ts, under runTool alone: the traced build
  ...sample([5], 500_000),
  ...loc(1, 1),
  ...loc(2, 2),
  ...loc(3, 3),
  ...loc(4, 4),
  ...loc(5, 5),
  ...fn(1, 5, 6, 634),
  ...fn(2, 7, 6, 356),
  ...fn(3, 8, 9, 300),
  ...fn(4, 10, 9, 2),
  ...fn(5, 11, 0, 0),
  ...strings.flatMap(s => fld(6, [...enc.encode(s)])),
]);
same('varints', [encVarint(0), encVarint(127), encVarint(300)], [[0], [127], [172, 2]]);
same(
  'fields read back what was written',
  fields(new Uint8Array(fld(3, 7))).map(f => [f.f, f.wt, Number(f.n)]),
  [[3, 0, 7]],
);
const p = decode(raw);
same(
  'decoded: sample types, functions, samples',
  [p.types, p.functions.size, p.samples.map(s => s.locs)],
  [
    [
      { type: 'samples', unit: 'count' },
      { type: 'cpu', unit: 'nanoseconds' },
    ],
    5,
    [[3, 2, 1], [4, 1], [5]],
  ],
);
same('buckets by the nanoseconds value', buckets(p).rows, [
  ['compile', 3_000_000],
  ['compile, traced build (line trace)', 1_000_000],
  ['gc', 500_000],
]);
const f = (name: string, file = ''): Fn => ({ id: 0, name, file, line: 0 });
same(
  'bucket rules',
  [
    [f('serve', '../mcp/src/serve.ts'), f('runTool'), f('lineTraceOf')],
    [
      f('serve', '../mcp/src/serve.ts'),
      f('runTool'),
      f('compiled', '../mcp/src/tools.ts'),
      f('build', '../compiler/build.ts'),
      f('sha256', '../compiler/sha256.ts'),
    ],
    [f('serve', '../mcp/src/serve.ts'), f('route')],
    [f('(root)'), f('(program)')],
  ].map(bucketOf),
  ['line trace rendering', 'compile: sha256', 'serve, other', 'runtime (program, idle)'],
);
const src = ['const lex = (a: string) => {', '  return xs.map(t => {', '    t.go();', '  });', '};'];
same(
  'names from the source',
  [nameAt(src, 1), nameAt(src, 2), nameAt(src, 3), nameAt(src, 99)],
  ['lex', 'lex.<anon>', 'lex.<anon>', null],
);
const r = renamed(raw, (file, line) => (file === '../compiler/lex.ts' && line === 2 ? 'lex.lex.<anon>' : null));
const q = decode(r.out);
same(
  'renamed: the unnamed frame only, the rest as it was',
  [r.n, q.functions.get(4)?.name, q.functions.get(3)?.name, q.functions.get(5)?.name, q.samples],
  [1, 'lex.lex.<anon>', 'lex', '(garbage collector)', p.samples],
);
same('nothing to name: the same bytes', [...renamed(raw, () => null).out], [...raw]);

// the live observability against the config's (scripts/observability.ts, ship.sh's preflight): the live shape is
// the one `cf workers get tape` gave on 2026-11-23 (traces off), and after the full deploy (on)
const liveOff = {
  enabled: true,
  head_sampling_rate: 1,
  logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true, persist: true },
  traces: { enabled: false, head_sampling_rate: 1, persist: true },
};
const liveOn = { ...liveOff, traces: { ...liveOff.traces, enabled: true } };
const wanted = { enabled: true, traces: { enabled: true, headSamplingRate: 1 } };
same('observability: traces on in the config, off live', observabilityDiff(wanted, liveOff), [
  'traces.enabled: cloudflare.config.ts true, live false',
]);
same('observability: as the config says (what it leaves out is not compared)', observabilityDiff(wanted, liveOn), []);
same(
  'observability: a sampling rate, a nested setting, and one live does not have',
  observabilityDiff({ headSamplingRate: 0.5, logs: { invocationLogs: false }, redactQueryString: true }, liveOn),
  [
    'head_sampling_rate: cloudflare.config.ts 0.5, live 1',
    'logs.invocation_logs: cloudflare.config.ts false, live true',
    'redact_query_string: cloudflare.config.ts true, live unset',
  ],
);
finish();
