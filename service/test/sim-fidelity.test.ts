// The simulator's host against the real service: the same 104 requests to apps/tickets with pay.
// fixtures/sim-transcript.json is what host.ts over node:sqlite answered, one request at a time, every call
// delivered in-process (written by `node proof/sim-transcript.ts`, checked for staleness by proof/all.ts). Here
// the programs are uploaded to the service and asked the same in workerd: Durable Object SQLite, and pay reached
// by RPC between objects. Each status and each body must be the same, times masked. A difference means the model
// that `tape sim` checks programs against is not the thing they run on.
import { expect, it } from 'vitest';
import tickets from '../../apps/tickets/tickets.tape?raw';
import pay from '../../apps/tickets/pay.tape?raw';
import transcript from './fixtures/sim-transcript.json' with { type: 'json' };
import { at, call, got, num } from './help.ts';

const mask = (text: string): string => text.replaceAll(/\b\d{12,}\b/g, '<time>');

it("the service answers the simulator's transcript of apps/tickets as the simulator's host did", async () => {
  const up = new Map<string, number>();
  const programs: [string, string][] = [
    ['pay', pay],
    ['tickets', tickets],
  ];
  for (const [name, source] of programs) {
    const version = num(at(await got(`/fid/${name}`, { method: 'POST', body: source }), 'version'));
    expect(version, `uploading ${name}`).toBeGreaterThan(0);
    up.set(name, version);
  }
  expect(transcript.requests.length).toBeGreaterThan(80);
  const differ: string[] = [];
  for (const [i, q] of transcript.requests.entries()) {
    const r = await call(`/fid/tickets/v/${up.get('tickets')}${q.path}`, {
      method: q.method,
      ...(q.method === 'GET' ? {} : { body: q.body }),
    });
    const text = mask(await r.text());
    if (r.status !== q.status || text !== q.answer)
      differ.push(
        `#${i} ${q.method} ${q.path} ${q.body.slice(0, 80)}\n   simulator: ${q.status} ${q.answer.slice(0, 200)}\n   service:   ${r.status} ${text.slice(0, 200)}`,
      );
  }
  expect(differ.slice(0, 5).join('\n'), `${differ.length} of ${transcript.requests.length} answers differ`).toBe('');
}, 120000);
