// The customer walkthrough (demo/demo.ts) in workerd. Each line it prints is checked as it is written; the
// transcript is in the json reporter's output (meta.demo) and, from a run against this code, in DEMO.md.
import { exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import hello from '../../examples/hello.tape?raw';
import payments from '../../examples/payments.tape?raw';
import inventory from '../../examples/inventory.tape?raw';
import shipping from '../../examples/shipping.tape?raw';
import fulfillment from '../../examples/fulfillment.tape?raw';
import price from '../../examples/tools/price.tape?raw';
import notes from '../../examples/tools/notes.tape?raw';
import fx from '../../examples/tools/fx.tape?raw';
import { demo } from '../demo/demo.ts';

it('demo: upload and trace, a workflow that resumes and compensates, tools for agents', async ({ task }) => {
  const text = await demo({
    fetch: (url: string, init?: RequestInit) => exports.default.fetch(url, init),
    base: 'http://tape',
    token: 'test-token',
    sources: { hello, payments, inventory, shipping, fulfillment, price, notes, fx },
  });
  task.meta.demo = text;
  for (const part of ['A. Upload', 'did not run again', 'the stock went back', 'MCP tools/list'])
    expect(text).toContain(part);
}, 60000);
