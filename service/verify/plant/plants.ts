// Planted bugs: each re-introduces one defect the service once had (or a new one) into a copy of
// the tree, as an exact text edit, and names the run that must fail with it present. plant.ts applies and runs them.
//   detect: { kv: 'a-b' }   the KV Jepsen seeds (test/kv-jepsen.test.ts, kv.js CONFIG)
//           { wf: 'a-b' }   the workflow Jepsen seeds (test/jepsen.test.ts, harness.ts CONFIG)
//           { seams: 'KV' | 'workflow' }   the fault-point enumeration (test/seams.test.ts)
//           { cmd: [...], cwd: 'service' | '.' }   any other command that must exit non-zero
export type Edit = { file: string; find: string; replace: string; all?: boolean };
export type Detect =
  { kv: string } | { wf: string } | { seams: string } | { cmd: [string, ...string[]]; cwd: 'service' | '.' };
export type Plant = { id: string; what: string; edits: Edit[]; detect: Detect };

/** A rule's problems dropped where every rule reports them: the compiler lets through what the rule refuses. */
const without = (...codes: string[]): Edit => ({
  file: 'rules/driver.ts',
  find: '      problems.push({',
  replace: `      if (!${JSON.stringify(codes)}.includes(code)) problems.push({`,
});
// examples/kv.tape: the unconditional write without its op-id guard
const R7: Edit = {
  file: 'examples/kv.tape',
  find: ' WHERE live IN (0, 1) AND NOT EXISTS (SELECT 1 FROM key_ops WHERE op = :once AND key = :key) RETURNING *", key, value, once)',
  replace: ' WHERE live IN (0, 1) RETURNING *", key, value)',
};
// program.ts: a callee whose commit failed answers `rejected`
const S2: Edit = {
  file: 'service/src/program.ts',
  find: "const status = transient ? 'unreachable' : 'skew';",
  replace: "const status = transient ? 'skew' : 'skew';",
};

export const PLANTS: readonly Plant[] = [
  {
    id: 'J1',
    what: 'a transport exception taken as a refusal (the callee may have run)',
    edits: [
      {
        file: 'host/call.ts',
        find: "return entry('timeout', err instanceof Late || err instanceof TimedOut ? NONE : enc.encode(messageOf(err)));",
        replace:
          "return err instanceof Late || err instanceof TimedOut ? entry('timeout', NONE) : entry('rejected', enc.encode(messageOf(err)));",
      },
    ],
    detect: { wf: '1-6' },
  },
  {
    id: 'J2',
    what: 'the decline path releases seats without the compare-and-set on pending',
    edits: [
      {
        file: 'examples/tickets.tape',
        find: "\"UPDATE sales SET state = 'declined' WHERE id = :id AND state = 'pending' RETURNING *\"",
        replace: '"UPDATE sales SET state = \'declined\' WHERE id = :id RETURNING *"',
      },
    ],
    // the compiler refuses the unguarded write at upload, so every seed's setup fails
    detect: { wf: '1-2' },
  },
  {
    // Removing the guard on the write alone is not R7 at run time: a resend is answered from key_ops before it
    // writes, and the guard only covers a resend racing its original. Here the op id is ignored throughout: no
    // stored reply is read, the write is unguarded, and the reply is stored again.
    id: 'R7-runtime',
    what: 'R7: the op id ignored (no stored reply read, the write unguarded), C54 and C55 disabled',
    edits: [
      R7,
      {
        file: 'examples/kv.tape',
        find: 'query: "SELECT * FROM key_ops WHERE op = :once AND key = :key", once, key: key_of(op)',
        replace: 'query: "SELECT * FROM key_ops WHERE op = :once AND key = :key AND 0", once, key: key_of(op)',
      },
      {
        file: 'examples/kv.tape',
        find: 'INSERT INTO key_ops(op, key, status, version, at) VALUES (:once, :key, :status, :version, :t) RETURNING *',
        replace:
          'INSERT OR REPLACE INTO key_ops(op, key, status, version, at) VALUES (:once, :key, :status, :version, :t) RETURNING *',
      },
      without('C54', 'C55'),
    ],
    detect: { kv: '1-12' },
  },
  {
    id: 'J4',
    what: 'a transition another request won is taken to mean the order is absent (the phantom 404)',
    edits: [
      {
        file: 'examples/fulfillment.tape',
        find: '    Raced(now) -> Some(now)\n    NoRow -> None\n',
        replace: '    Raced(now) -> None\n    NoRow -> None\n',
      },
    ],
    detect: { wf: '1-6' },
  },
  {
    id: 'R7',
    what: 'a resent unconditional write applied twice (the op id ignored on the write)',
    edits: [R7],
    // the compiler's retry rule (C54) refuses this write at build: kv.tape does not build, so no cluster is made
    detect: { kv: '1-2' },
  },
  {
    id: 'R11',
    what: 'a reused op id answered by the hash: key_ops read by op id alone',
    edits: [
      {
        file: 'examples/kv.tape',
        find: 'query: "SELECT * FROM key_ops WHERE op = :once AND key = :key", once, key: key_of(op)',
        replace: 'query: "SELECT * FROM key_ops WHERE op = :once AND :key = :key", once, key: key_of(op)',
      },
    ],
    // Jepsen op ids are unique per client and op (c<client>-<n>), so only the targeted test can show it
    detect: {
      cmd: ['npx', 'vitest', 'run', 'test/kv.test.ts', '-t', 'an op id names one write to one key'],
      cwd: 'service',
    },
  },
  {
    id: 'S1',
    what: 'a failed cluster lookup answers "a shard stopped", outcome unknown, with no trace headers',
    edits: [
      {
        file: 'service/src/kv.ts',
        find: '  try {\n    return await shardsFor(k.ctx, k.account, k.cluster, k.rt, fault);\n  } catch (e) {',
        replace:
          "  if (k.account !== '') return shardsFor(k.ctx, k.account, k.cluster, k.rt, fault);\n  try {\n    throw new Error('never');\n  } catch (e) {",
      },
    ],
    detect: { seams: 'KV, 1' },
  },
  {
    id: 'S2',
    what: 'a callee whose commit fails answers a final outcome (skew; rejected until a refusal had to be a value of the error type): the caller gives up a call its key would have made',
    edits: [S2],
    detect: {
      cmd: ['npx', 'vitest', 'run', 'test/service.test.ts', '-t', 'a callee whose commit fails'],
      cwd: 'service',
    },
  },
  {
    id: 'S2-seeds',
    what: 'S2 again, judged by the workflow seeds alone (21 to 25: four of them failed before the fix)',
    edits: [S2],
    detect: { wf: '21-25' },
  },
  {
    id: 'K1',
    what: 'the phantom-404 rule takes the last completion of an order, which excuses a 404 between two answers',
    edits: [
      {
        file: 'service/jepsen/harness.ts',
        find: 'if (isOrder(h.value) && !((created.get(h.value.id) ?? Infinity) <= h.t)) created.set(h.value.id, h.t);',
        replace: 'if (isOrder(h.value)) created.set(h.value.id, h.t);',
      },
    ],
    detect: { cmd: ['node', 'jepsen/selftest.ts'], cwd: 'service' },
  },
  {
    id: 'X1',
    what: '(new, generic) a write that skips a version: version + 2',
    edits: [
      {
        file: 'examples/kv.tape',
        find: 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1, live = 1 WHERE live IN (0, 1) AND NOT EXISTS',
        replace:
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 2, live = 1 WHERE live IN (0, 1) AND NOT EXISTS',
      },
    ],
    detect: { kv: '1-4' },
  },
];
