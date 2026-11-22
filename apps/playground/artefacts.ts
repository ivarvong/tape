// apps/playground/artefacts.ts: what the homepage shows before its script runs, made at build time by the real
// compiler, host and simulator, in Node. Nothing here is typed by hand: the program is read from the tree, its two
// runs are run, the refusal is what the compiler says, and the waterfalls are drawn by apps/trace/trace.tape from
// the OTLP/JSON of real requests. Anything that does not come out as the page needs throws, and the build fails.
import '../../node25.ts';
import { compile } from '../../compiler.ts';
import { instantiate, responseOf } from '../../host.ts';
import { nodeSql } from '../../nodesql.ts';
import { std } from '../../std.ts';
import { readData } from './src/data.ts';
import type { Data } from './src/data.ts';
import { FULFILLMENT, HERO, armOf, requestFor, splitSvg, withoutRepeat } from './src/hero.ts';
import type { Refusal, Shown } from './src/hero.ts';
import { simulate } from './src/simulate.ts';
import { Workbench } from './src/workbench.ts';
import type { Exchange, Line } from './src/workbench.ts';

export type Run = Shown & { log: Line[]; trace: Line[]; spans: number };
export type Artefacts = {
  /** examples/hello.tape as it is, and as highlight.tape draws it */
  hello: { text: string; html: string; wasm: number };
  /** the same request sent twice, in order */
  runs: Run[];
  /** the second run's spans, drawn by trace.tape (its <style> taken out: see style) */
  helloSvg: string;
  /** what the compiler says to hello.tape without its `repeat: True,` line, and that text */
  refusal: Refusal;
  refused: string;
  /** a request through four programs, one of which fails */
  fulfillment: Run & {
    svg: string;
    services: string[];
    failed: string[];
    label: string;
    /** the root program's calls, in the order its spans start */
    calls: { name: string; failed: boolean }[];
    /** the `note` of the JSON it answered, if any */
    note: string | null;
  };
  /** the shop of LANGUAGE.md section 8 under tape sim, as it is and with the bug section 9 plants */
  sim: { clean: number; found: { run: number; choices: number; shrunkFrom: number; violation: string }; what: string };
  /** trace.tape's style, the same for every SVG it draws */
  traceCss: string;
  /** highlight.tape and trace.tape compiled, for the pages to run without compiling them */
  tools: { highlight: Uint8Array; trace: Uint8Array };
};

const enc = new TextEncoder(),
  dec = new TextDecoder();

/** A pure program compiled here and run by the host: bytes in, text out; and its Wasm. */
function tool(file: string, text: string): ((input: string) => string) & { wasm: Uint8Array } {
  const r = compile([...std, { name: file, text }]);
  if (!r.wasm)
    throw new Error(`${file} does not compile: ${r.errors.map(e => `${e.line}: ${e.code} ${e.message}`).join('; ')}`);
  const app = instantiate(new WebAssembly.Module(r.wasm), {});
  const wasm = r.wasm;
  return Object.assign(
    (input: string): string => {
      const raw = app.handle(enc.encode(input));
      const answer = dec.decode(raw);
      return /^\s*(<\?xml|<svg)/.test(answer) ? answer : dec.decode(responseOf(raw).body);
    },
    { wasm },
  );
}

const spansOf = (x: Exchange): number => x.otlp.resourceSpans.reduce((n, r) => n + r.scopeSpans[0].spans.length, 0);
const runOf = (x: Exchange): Run => ({
  n: x.n,
  line: x.request.split('\n')[0] ?? '',
  status: x.status,
  body: x.body,
  log: x.root.log,
  trace: x.root.trace,
  spans: spansOf(x),
  arm: armOf(x.root.trace),
});

export async function artefacts(data: Data = readData()): Promise<Artefacts> {
  const example = (id: string) => {
    const ex = data.examples.find(e => e.id === id);
    if (!ex) throw new Error(`no example ${id}`);
    return ex;
  };
  if (data.trace === null)
    throw new Error('apps/trace/trace.tape is not in the tree: the homepage draws its waterfalls');
  const highlight = tool('highlight.tape', data.highlight),
    draw = tool('trace.tape', data.trace);

  // the program, highlighted; its two runs
  const hello = example(HERO.example).files.find(f => f.name === HERO.program);
  if (!hello) throw new Error(`no ${HERO.program} in the ${HERO.example} example`);
  const bench = new Workbench(std, nodeSql);
  const problems = bench.load([{ name: hello.name, text: hello.text }]);
  if (problems.length > 0)
    throw new Error(`${hello.name}.tape: ${problems.map(p => `${p.line}: ${p.code} ${p.message}`).join('; ')}`);
  const first = await bench.send(hello.name, requestFor(HERO.name)),
    second = await bench.send(hello.name, requestFor(HERO.name));
  const runs = [runOf(first), runOf(second)];
  for (const r of runs) {
    if (r.status !== 200) throw new Error(`${r.line} answered ${r.status}: ${r.body}`);
    if (r.log.length === 0 || r.trace.length === 0) throw new Error(`${r.line} has no effect log or no trace`);
  }
  const helloDrawn = splitSvg(draw(JSON.stringify(second.otlp)));
  const wasm = bench.slots.get(hello.name)?.built?.wasm.length ?? 0;

  // the refusal
  const cut = withoutRepeat(hello.text);
  const refused = compile([...std, { name: `${hello.name}.tape`, text: cut }]);
  const [d] = refused.errors;
  if (refused.wasm || !d) throw new Error(`${hello.name}.tape without repeat: True compiles: the refusal is gone`);
  const refusal: Refusal = {
    file: d.file ?? `${hello.name}.tape`,
    line: d.line,
    code: d.code,
    message: d.message,
    hint: d.hint,
  };

  // four programs, one request, a failure
  const ful = example(FULFILLMENT.example);
  const preset = ful.presets.find(p => p.label === FULFILLMENT.preset);
  if (!preset) throw new Error(`no preset "${FULFILLMENT.preset}" in ${FULFILLMENT.example}`);
  const fb = new Workbench(std, nodeSql);
  const fp = fb.load(ful.files.map(f => ({ name: f.name, text: f.text })));
  if (fp.length > 0)
    throw new Error(`${FULFILLMENT.example}: ${fp.map(p => `${p.program}:${p.line}: ${p.code}`).join('; ')}`);
  fb.faults = { ...preset.faults };
  const fx = await fb.send(
    preset.to ?? ful.files[0]?.name ?? '',
    `${preset.method} ${preset.path}\n${preset.body ?? ''}`,
  );
  const fulDrawn = splitSvg(draw(JSON.stringify(fx.otlp)));
  if (fulDrawn.style !== helloDrawn.style) throw new Error('trace.tape drew two styles: the page serves one');
  const services = [
    ...new Set(
      fx.otlp.resourceSpans.map(rs => {
        const v = rs.resource.attributes.find(a => a.key === 'service.name')?.value;
        return v && 'stringValue' in v ? v.stringValue.replace(/^[^/]*\//, '') : '';
      }),
    ),
  ];
  const failed = fx.otlp.resourceSpans.flatMap(rs =>
    rs.scopeSpans[0].spans.filter(s => s.status?.code === 2).map(s => s.name),
  );
  if (services.length < 3 || failed.length === 0)
    throw new Error(
      `the fulfillment trace is not the one described: ${services.join(', ')}; failed ${failed.join(', ')}`,
    );

  const calls = (fx.otlp.resourceSpans[0]?.scopeSpans[0].spans ?? [])
    .slice(1)
    .toSorted((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)))
    .map(s => ({ name: s.name, failed: s.status?.code === 2 }));
  let note: string | null = null;
  try {
    const v: unknown = JSON.parse(fx.body);
    note =
      typeof v === 'object' && v !== null && 'note' in v && typeof v.note === 'string' && v.note !== '' ? v.note : null;
  } catch {
    note = null;
  }

  // the simulator on the shop, then with the planted bug
  const shop = example('shop');
  const plant = shop.plant;
  if (!plant) throw new Error('the shop has no plant');
  const files = shop.files.map(f => ({ name: f.name, text: f.text }));
  const clean = await simulate(files, { seeds: 300 });
  if (!clean.ok) throw new Error(`tape sim finds something wrong in the shop: ${clean.lines.join('\n')}`);
  const planted = files.map(f => (f.name === plant.file ? { ...f, text: f.text.replace(plant.from, plant.to) } : f));
  if (planted.every((f, i) => f.text === files[i]?.text)) throw new Error('the plant changes nothing in the shop');
  const bad = await simulate(planted, { seeds: 300 });
  if (bad.ok || !bad.failure) throw new Error('tape sim does not find the planted bug');

  return {
    hello: { text: hello.text, html: highlight(hello.text), wasm },
    runs,
    helloSvg: helloDrawn.svg,
    refusal,
    refused: cut,
    fulfillment: { ...runOf(fx), svg: fulDrawn.svg, services, failed, label: preset.label, calls, note },
    sim: {
      clean: clean.runs,
      found: {
        run: bad.runs,
        choices: bad.failure.choices,
        shrunkFrom: bad.failure.shrunkFrom,
        violation: bad.failure.violations[0] ?? '',
      },
      what: plant.what,
    },
    traceCss: helloDrawn.style,
    tools: { highlight: highlight.wasm, trace: draw.wasm },
  };
}
