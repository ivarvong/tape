// apps/playground/examples.ts: the programs the playground offers, and the requests each one's buttons send. The
// texts are not copied here: build.ts reads each file from the tree (and the shop from LANGUAGE.md section 8) at
// build time, so the page always shows the programs as they are. Programs that call each other are offered
// together, each in its own tab, with its own database; a Remote parameter named like another program reaches it.
// A Remote that no program here serves is stood in for, with a reply made from its reply type (as `tape sim` does).

/** What happens to a call to one program, or to a stand-in: the simulator's words. */
export type Fault = 'deliver' | 'reject' | 'lose' | 'drop';
export type Preset = {
  label: string;
  method: string;
  path: string;
  body?: string;
  /** the program to send it to (the example's first by default) */
  to?: string;
  /** calls to these programs or stand-ins fail this way for this request */
  faults?: Record<string, Fault>;
  /** flag values, by program, set before this request */
  flags?: Record<string, Record<string, number | boolean>>;
  /** what to look at */
  note?: string;
};
/** Where a program's text comes from: a file of the tree, or the first tape block of a section of LANGUAGE.md. */
export type FileRef = { name: string; path: string } | { name: string; doc: string; section: string };
export type Example = {
  id: string;
  title: string;
  blurb: string;
  files: FileRef[];
  presets: Preset[];
  /** a one-line edit that plants a bug the simulator finds (LANGUAGE.md section 9) */
  plant?: { file: string; from: string; to: string; what: string };
};

const json = (v: unknown): string => JSON.stringify(v);

export const EXAMPLES: Example[] = [
  {
    id: 'hello',
    title: 'Hello',
    blurb: 'Text with holes, "Hello again, \\(name) #\\(n)!", and a write that says it repeats (repeat: True).',
    files: [{ name: 'hello', path: 'examples/hello.tape' }],
    presets: [
      {
        label: 'Hello, Ada',
        method: 'GET',
        path: '/hello/Ada',
        note: 'send it twice: the count is in the second answer',
      },
      { label: 'Hello, Grace', method: 'GET', path: '/hello/Grace' },
      { label: 'No name', method: 'GET', path: '/hello/' },
    ],
  },
  {
    id: 'orders',
    title: 'Orders + stock',
    blurb: 'Two programs: orders reserves stock in another object with a call, a time budget and a key.',
    files: [
      { name: 'orders', path: 'examples/orders.tape' },
      { name: 'stock', path: 'examples/stock.tape' },
    ],
    presets: [
      { label: 'Order a lamp', method: 'POST', path: '/orders', body: json({ key: 'o-1', item: 'lamp' }) },
      {
        label: 'Same key again',
        method: 'POST',
        path: '/orders',
        body: json({ key: 'o-1', item: 'lamp' }),
        note: 'the same order: nothing is reserved twice',
      },
      { label: 'Order a desk', method: 'POST', path: '/orders', body: json({ key: 'o-2', item: 'desk' }) },
      {
        label: 'Stock lost',
        method: 'POST',
        path: '/orders',
        body: json({ key: 'o-3', item: 'desk' }),
        faults: { stock: 'lose' },
        flags: { orders: { stock_budget_ms: 300 } },
        note: 'the call never arrives; after 300 ms the order stays pending',
      },
      { label: 'Retry order 3', method: 'POST', path: '/retry/3', note: 'the same once key: stock runs it now' },
      {
        label: 'Gold bar',
        method: 'POST',
        path: '/orders',
        body: json({ key: 'o-4', item: 'gold bar' }),
        note: 'stock has none: Rejected',
      },
      { label: 'List', method: 'GET', path: '/orders' },
      { label: 'Bad body', method: 'POST', path: '/orders', body: json({ key: 'o-5', item: 7 }) },
    ],
  },
  {
    id: 'fulfillment',
    title: 'Fulfillment (4 programs)',
    blurb:
      'A durable workflow over three other programs: reserve stock, charge the card, buy a label; undo on failure.',
    files: [
      { name: 'fulfillment', path: 'examples/fulfillment.tape' },
      { name: 'inventory', path: 'examples/inventory.tape' },
      { name: 'payments', path: 'examples/payments.tape' },
      { name: 'shipping', path: 'examples/shipping.tape' },
    ],
    presets: [
      {
        label: 'Ship a lamp',
        method: 'POST',
        path: '/orders',
        body: json({ key: 'f-1', sku: 'lamp', qty: 1, card: 'ann-4242', address: '1 Main St' }),
      },
      {
        label: 'Card declined',
        method: 'POST',
        path: '/orders',
        body: json({ key: 'f-2', sku: 'lamp', qty: 2, card: 'bob-0001', address: '1 Main St' }),
        note: 'the stock is given back',
      },
      {
        label: 'No carrier',
        method: 'POST',
        path: '/orders',
        body: json({ key: 'f-3', sku: 'desk', qty: 1, card: 'ann-4242', address: 'Atlantis' }),
        note: 'refund, then release: the longest trace',
      },
      { label: 'Order 1', method: 'GET', path: '/orders/1' },
      { label: 'Cards', method: 'GET', path: '/cards', to: 'payments' },
    ],
  },
  {
    id: 'shop',
    title: 'The shop (LANGUAGE.md)',
    blurb: 'The whole program of LANGUAGE.md section 8: a state machine, invariants, a timer and a call to payments.',
    files: [{ name: 'shop', doc: 'LANGUAGE.md', section: '## 8. A whole program' }],
    presets: [
      { label: 'Pay 40', method: 'POST', path: '/orders', body: json({ key: 's-1', amount: 40 }) },
      { label: 'Same key again', method: 'POST', path: '/orders', body: json({ key: 's-1', amount: 40 }) },
      {
        label: 'Declined',
        method: 'POST',
        path: '/orders',
        body: json({ key: 's-2', amount: 900 }),
        faults: { payments: 'reject' },
      },
      {
        label: 'Payments lost',
        method: 'POST',
        path: '/orders',
        body: json({ key: 's-3', amount: 15 }),
        faults: { payments: 'lose' },
        note: 'the call times out after 2 s; the order stays paying and a timer is set to try again',
      },
      { label: 'Order 3', method: 'GET', path: '/orders/3' },
      { label: 'List', method: 'GET', path: '/orders' },
      { label: 'Amount 0', method: 'POST', path: '/orders', body: json({ key: 's-4', amount: 0 }) },
    ],
    plant: {
      file: 'shop',
      from: "UPDATE orders SET state = 'failed', note = :reason",
      to: "UPDATE orders SET state = 'paid', note = :reason",
      what: 'a refusal marks the order paid (LANGUAGE.md section 9)',
    },
  },
  {
    id: 'counter',
    title: 'Counter (flags)',
    blurb: 'A count per name, once per op id; the step is a flag the host can change between requests.',
    files: [{ name: 'counter', path: 'examples/counter.tape' }],
    presets: [
      { label: 'Add (op 1)', method: 'POST', path: '/visits?op=1' },
      { label: 'Op 1 again', method: 'POST', path: '/visits?op=1', note: 'the same addition: the count stands' },
      { label: 'Add (op 2)', method: 'POST', path: '/visits?op=2' },
      { label: 'Step 10 (op 3)', method: 'POST', path: '/visits?op=3', flags: { counter: { step: 10 } } },
      { label: 'Read', method: 'GET', path: '/visits' },
      { label: 'No op id', method: 'POST', path: '/visits' },
    ],
  },
  {
    id: 'todo',
    title: 'Todo API',
    blurb: 'A REST API where every value is parsed where it enters, and a retried create is the same todo.',
    files: [{ name: 'todo', path: 'examples/todo.tape' }],
    presets: [
      { label: 'Create', method: 'POST', path: '/todos', body: json({ key: 't-1', title: 'buy milk' }) },
      { label: 'List', method: 'GET', path: '/todos' },
      { label: 'Get 1', method: 'GET', path: '/todos/1' },
      { label: 'Done 1', method: 'PATCH', path: '/todos/1', body: json({ done: true }) },
      { label: 'Only done', method: 'GET', path: '/todos?done=true' },
      { label: 'Delete 1', method: 'DELETE', path: '/todos/1' },
      { label: 'Bad body', method: 'POST', path: '/todos', body: json({ key: 't-2', title: '', extra: 1 }) },
    ],
  },
  {
    id: 'ledger',
    title: 'Ledger',
    blurb: 'Move money between accounts; a refined amount, a debit only when the balance covers it, and rollback.',
    files: [{ name: 'ledger', path: 'examples/ledger.tape' }],
    presets: [
      {
        label: 'Alice pays Bob 30',
        method: 'POST',
        path: '/transfers',
        body: json({ key: 'x-1', from: 'alice', to: 'bob', amount: 30 }),
      },
      {
        label: 'Same key again',
        method: 'POST',
        path: '/transfers',
        body: json({ key: 'x-1', from: 'alice', to: 'bob', amount: 30 }),
      },
      {
        label: 'Overdraw',
        method: 'POST',
        path: '/transfers',
        body: json({ key: 'x-2', from: 'bob', to: 'alice', amount: 500 }),
      },
      {
        label: 'To no one',
        method: 'POST',
        path: '/transfers',
        body: json({ key: 'x-3', from: 'alice', to: 'zed', amount: 5 }),
      },
      { label: 'Accounts', method: 'GET', path: '/accounts' },
    ],
  },
  {
    id: 'tickets',
    title: 'Tickets + payments',
    blurb:
      'A box office: seats held in SQL, the card charged by payments, a ticket code from Entropy, the time from the Clock.',
    files: [
      { name: 'tickets', path: 'examples/tickets.tape' },
      { name: 'payments', path: 'examples/payments.tape' },
    ],
    presets: [
      {
        label: 'Buy 2 floor',
        method: 'POST',
        path: '/buy',
        body: json({ key: 'b-1', section: 'floor', qty: 2, card: 'ann-4242' }),
      },
      {
        label: 'Same key again',
        method: 'POST',
        path: '/buy',
        body: json({ key: 'b-1', section: 'floor', qty: 2, card: 'ann-4242' }),
      },
      {
        label: 'Declined',
        method: 'POST',
        path: '/buy',
        body: json({ key: 'b-2', section: 'floor', qty: 4, card: 'bob-0001' }),
      },
      { label: 'Sections', method: 'GET', path: '/sections' },
      { label: 'Sales', method: 'GET', path: '/sales' },
      { label: 'Cards', method: 'GET', path: '/cards', to: 'payments' },
    ],
  },
  {
    id: 'shortener',
    title: 'Link shortener',
    blurb:
      'The id comes from Entropy and the time from the Clock; both are in the log, so a replay makes the same link.',
    files: [{ name: 'shortener', path: 'examples/shortener.tape' }],
    presets: [
      {
        label: 'Shorten',
        method: 'POST',
        path: '/links',
        body: json({ key: 'l-1', url: 'https://example.com/a/long/path' }),
      },
      {
        label: 'Same key again',
        method: 'POST',
        path: '/links',
        body: json({ key: 'l-1', url: 'https://example.com/a/long/path' }),
      },
      { label: 'Too short', method: 'POST', path: '/links', body: json({ key: 'l-2', url: 'x' }) },
    ],
  },
  {
    id: 'ratelimit',
    title: 'Rate limit',
    blurb: 'At most `limit` requests per caller in each ten-second window; the window is in the log.',
    files: [{ name: 'ratelimit', path: 'examples/ratelimit.tape' }],
    presets: [
      { label: 'Ann', method: 'POST', path: '/check/ann', note: 'the fourth in ten seconds is refused' },
      { label: 'Bob', method: 'POST', path: '/check/bob' },
      { label: 'Limit 1', method: 'POST', path: '/check/cy', flags: { ratelimit: { limit: 1 } } },
    ],
  },
  {
    id: 'kv',
    title: 'Sharded KV (largest)',
    blurb: 'A key-value store with placement and shards: the largest program here (755 lines).',
    files: [{ name: 'kv', path: 'examples/kv.tape' }],
    presets: [
      {
        label: 'Place shard 0 of 1',
        method: 'PUT',
        path: '/placement/0?shards=1',
        note: 'a shard serves nothing until it is placed',
      },
      { label: 'Put a (if version 0)', method: 'PUT', path: '/k/a?if=0', body: 'first value' },
      { label: 'Get a', method: 'GET', path: '/k/a' },
      { label: 'Set a if version 1', method: 'PUT', path: '/k/a?if=1', body: 'second value' },
      {
        label: 'Stale write',
        method: 'PUT',
        path: '/k/a?if=1',
        body: 'lost update',
        note: 'a is at version 2 now: 409',
      },
      { label: 'No op id', method: 'PUT', path: '/k/b', body: 'x' },
      { label: 'Stats', method: 'GET', path: '/stats' },
    ],
  },
  {
    id: 'trap',
    title: 'Trap',
    blurb: 'Writes a row, then divides by zero: the trap ends the request and its write is undone.',
    files: [{ name: 'trap', path: 'examples/trap.tape' }],
    presets: [{ label: 'Run it', method: 'GET', path: '/' }],
  },
];

/** The text of a section's first ```tape block: what follows its heading, up to the closing fence. */
export function sectionProgram(doc: string, heading: string): string | null {
  const after = doc.split(`\n${heading}\n`)[1];
  const block = after?.split('\n```tape\n')[1]?.split('\n```\n')[0];
  return block === undefined ? null : `${block}\n`;
}
