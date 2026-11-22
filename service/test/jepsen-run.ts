// The workflow Jepsen run in workerd (sender, jepsen): used by jepsen.test.ts, seams.test.ts and dump.test.ts.
import tickets from '../../examples/tickets.tape?raw';
import payments from '../../examples/payments.tape?raw';
import inventory from '../../examples/inventory.tape?raw';
import shipping from '../../examples/shipping.tape?raw';
import fulfillment from '../../examples/fulfillment.tape?raw';
import type { Sender } from '../jepsen/client.ts';
import { setup, load, heal, check, collectTraces, checkTraces, CONFIG } from '../jepsen/harness.ts';
import type { Final } from '../jepsen/harness.ts';
import { senderVia } from './help.ts';

const sources = { tickets, payments, inventory, shipping, fulfillment };
/** A sender for one account: the workload's paths are the account's own. */
export const sender = (account: string): Sender =>
  senderVia(path => (path === '/~faults' ? `/_faults/${account}` : `/${account}${path}`));
/** A run's settings, and for U3 another heal or a sender whose reads fail (test/u3.test.ts). */
export type Options = Partial<typeof CONFIG> & {
  tag?: string;
  heal?: (send: Sender) => Promise<Final>;
  healSend?: (send: Sender) => Sender;
};
export async function jepsen(seed: number, options?: Options) {
  const send = sender(`jepsen-l${seed}${options?.tag ?? ''}`);
  const config = { ...CONFIG, ...options };
  await setup(send, sources, { seed, plan: config.plan, tail: config.tail, router: config.router });
  const history = await load(send, { seed, clients: config.clients, ops: config.ops });
  // options.heal and options.healSend: a replay of another heal, or of a heal whose reads fail (U3, test/u3.test.ts)
  const final = await (options?.heal ?? heal)(options?.healSend?.(send) ?? send),
    traces = checkTraces(history, final, await collectTraces(send, history));
  return { seed, history, final, ...check(history, final), traces };
}
