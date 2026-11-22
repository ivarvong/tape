// node service/verify/plant/machine.ts [--out <jsonl>]: plant M (machine.e2e.ts) in two copies of the tree, one with
// rule C59 disabled and one with it in place; prints and appends to --out each copy's result.
import { appendFileSync, copyFileSync } from 'node:fs';
import { at, list, text } from '../../jepsen/json.ts';
import type { Edit } from './plants.ts';
import { apply, copyTree, flag, reportAt, sh } from './tree.ts';

const out = flag('out') ?? '/tmp/plant.jsonl';
// the decline path moves the sale to a state its machine does not declare
const BAD: Edit = {
  file: 'examples/tickets.tape',
  find: "\"UPDATE sales SET state = 'declined' WHERE id = :id AND state = 'pending' RETURNING *\"",
  replace: "\"UPDATE sales SET state = 'void' WHERE id = :id AND state = 'pending' RETURNING *\"",
};
// C59 dropped where the machine rules report
const NO_C59: Edit = {
  file: 'rules/machines/check.ts',
  find: "  r.problems.push({ code, file: at.file ?? '', line: at.line ?? 0, message, hint });",
  replace: "  if (code !== 'C59') r.problems.push({ code, file: at.file ?? '', line: at.line ?? 0, message, hint });",
};
for (const mode of ['checker-off', 'checker-on']) {
  const id = `M-${mode}`,
    dir = copyTree(id);
  // the mode reaches the Worker as a binding: the plugin's config is edited in the copy only
  const binding: Edit = {
    file: 'service/vitest.config.ts',
    find: "TOKEN: 'test-token',",
    replace: `TOKEN: 'test-token', MACHINE_PLANT: '${mode}',`,
  };
  apply(dir, id, [BAD, binding, ...(mode === 'checker-off' ? [NO_C59] : [])]);
  copyFileSync(`${import.meta.dirname}/machine.e2e.ts`, `${dir}/service/test/machine-plant.test.ts`);
  const report = `${dir}/report.json`;
  const { code } = await sh(
    'npx',
    ['vitest', 'run', 'test/machine-plant.test.ts', '--reporter=json', `--outputFile=${report}`],
    `${dir}/service`,
  );
  const file = at(reportAt(report), 'testResults', 0),
    test = at(file, 'assertionResults', 0);
  const line = {
    id,
    what:
      mode === 'checker-off'
        ? 'C59 disabled; a decline writes the undeclared state void: the triggers must refuse it at run time'
        : 'the same write with C59 in place: refused at upload',
    passed: code === 0,
    exit: code,
    status: at(test, 'status'),
    failure: list(at(test, 'failureMessages')).map(String).join('').slice(0, 800),
    machine: at(test, 'meta', 'machine') ?? null,
    message: text(at(file, 'message')).slice(0, 800),
  };
  appendFileSync(out, `${JSON.stringify(line)}\n`);
  console.log(JSON.stringify(line, null, 1));
}
