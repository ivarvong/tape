// The retention checker (RUNTIME-SPEC R-RET-1..6): a KV op id is <t>_<id>; a shard runs it only while
// t >= now - W (else 410, nothing run), refuses t > now + S (400) and an untimed id (400), and keeps its record of
// the op until t < now - W - S, so a resend it accepts finds the first commit and answers it again.
//
// Each history entry is one attempt: { key, once, sent, got, status, version?, body? } with sent and got the
// client's clock when the request left and when the answer came (null status: no answer). The shard's clock is
// taken to be within `tolerance` ms of the client's, so an op the shard surely saw as expired (t < sent -
// tolerance - W) must be 410, and one it surely saw as fresh (t >= got + tolerance - W) must not be.
import type { Sender } from './client.ts';
import { at, messageOf } from './json.ts';
import type { Anomaly } from './traces.ts';

export const OP_ID = /^(\d{13})_[A-Za-z0-9_-]{1,50}$/;
const ok = (s: number | null | undefined): boolean => typeof s === 'number' && s >= 200 && s < 300;

/** One attempt: sent and got are the client's clock when the request left and when the answer came. */
export type Attempt = {
  key: string;
  once: string;
  sent: number;
  got: number;
  /** null: no answer */
  status: number | null | undefined;
  version?: unknown;
  body?: unknown;
  value?: string;
  error?: string;
};
export type Checked = { valid: boolean; anomalies: Anomaly[] };
type Bad = (type: string, detail: Readonly<Record<string, unknown>>) => void;
const collector = (): { anomalies: Anomaly[]; bad: Bad } => {
  const anomalies: Anomaly[] = [];
  return {
    anomalies,
    bad: (type, detail) => {
      anomalies.push({ type, ...detail });
    },
  };
};

export function check(
  history: readonly Attempt[],
  { window, skew, tolerance = 1000 }: { window: number; skew: number; tolerance?: number },
): Checked {
  const { anomalies, bad } = collector();
  const first = new Map<string, Attempt>();
  for (const h of history) {
    if (h.status === null || h.status === undefined || h.once === '') continue;
    const stamp = OP_ID.exec(h.once)?.[1];
    if (stamp === undefined) {
      if (h.status !== 400) bad('untimed-op-accepted', { op: h });
      continue;
    }
    const t = Number(stamp);
    if (t > h.got + tolerance + skew) {
      if (h.status !== 400) bad('future-op-accepted', { op: h });
      continue;
    }
    if (t < h.sent - tolerance - window && h.status !== 410) bad('expired-op-not-refused', { op: h, age: h.sent - t });
    if (h.status === 410) {
      if (t >= h.got + tolerance - window) bad('fresh-op-refused', { op: h, age: h.got - t });
      if (at(h.body, 'op_expired') !== true || at(h.body, 'window_ms') !== window)
        bad('expiry-answer-unclear', { op: h });
      continue;
    }
    if (!ok(h.status)) continue;
    // one op on one key is one write: every accepted attempt answers the version of the first
    const id = `${h.key}\u0000${h.once}`,
      prior = first.get(id);
    if (!prior) first.set(id, h);
    else if (prior.version !== h.version) bad('op-applied-twice', { op: h, first: prior });
  }
  return { valid: anomalies.length === 0, anomalies };
}

// Every write is unconditional and each op id names one write to one key, so a key's final version is at most the
// number of distinct op ids that may have run (an attempt with no answer, a 2xx or a 5xx; a 4xx ran nothing), and at
// least the number answered 2xx. final: { key: version } (0: absent).
export function checkFinal(history: readonly Attempt[], final: Readonly<Record<string, number>>): Checked {
  const { anomalies, bad } = collector();
  const refused = (h: Attempt): boolean => typeof h.status === 'number' && h.status >= 400 && h.status < 500;
  const by = Map.groupBy(
    history.filter(h => OP_ID.test(h.once)),
    h => h.key,
  );
  for (const [key, version] of Object.entries(final)) {
    const hs = by.get(key) ?? [],
      sent = new Set(hs.filter(h => !refused(h)).map(h => h.once)).size,
      applied = new Set(hs.filter(h => ok(h.status)).map(h => h.once)).size;
    if (version > sent) bad('versions-exceed-ops', { key, version, sent });
    else if (version < applied) bad('applied-op-lost', { key, version, applied });
  }
  return { valid: anomalies.length === 0, anomalies };
}

/** Whether an attempt's trace was found, and the newest record time its shard pruned (null: none). */
export type Traced = {
  op: Pick<Attempt, 'sent'> & Readonly<Record<string, unknown>>;
  found: boolean;
  pruned_before: number | null;
};
// A missing trace is allowed only for a request older than what its shard pruned (R-RET-6).
export function checkTraces(traces: readonly Traced[], { tolerance = 1000 }: { tolerance?: number } = {}): Checked {
  const { anomalies, bad } = collector();
  for (const t of traces) {
    if (t.found) continue;
    if (t.pruned_before === null || t.op.sent > t.pruned_before + tolerance)
      bad('trace-missing-not-pruned', { op: t.op, pruned_before: t.pruned_before });
  }
  return { valid: anomalies.length === 0, anomalies };
}

const pause = (ms: number): Promise<void> =>
  new Promise(done => {
    setTimeout(done, ms);
  });
export type Scenario = {
  send: Sender;
  base: string;
  window: number;
  skew: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  key?: string;
  tag?: string;
};
// The scenario that exercises the rules: send(method, path, body) answers { status, body }; base is the KV prefix
// (".../k/" is appended). It writes, resends inside the window (a replay), lets W + S pass, writes again (the
// prune), resends the first op (410), and sends an untimed and a future op id. Returns the history.
export async function scenario({
  send,
  base,
  window,
  skew,
  now = Date.now,
  sleep = pause,
  key = 'r',
  tag = 's',
}: Scenario): Promise<Attempt[]> {
  const history: Attempt[] = [];
  const attempt = async (once: string, value: string): Promise<void> => {
    const sent = now();
    try {
      const r = await send('PUT', `${base}/k/${key}?op=${once}`, value);
      history.push({
        key,
        once,
        sent,
        value,
        status: r.status,
        body: r.body,
        version: at(r.body, 'version'),
        got: now(),
      });
    } catch (e) {
      history.push({ key, once, sent, value, status: null, error: messageOf(e), got: now() });
    }
  };
  const x = `${now()}_${tag}-x`;
  await attempt(x, 'x');
  await attempt(`${now()}_${tag}-y`, 'y');
  await attempt(x, 'x'); // inside the window: the first answer again
  await sleep(window + skew + 300);
  await attempt(`${now()}_${tag}-z`, 'z'); // stores a new op, so the shard prunes what is past W + S
  await attempt(x, 'x'); // past the window: 410, nothing run
  await attempt(`${tag}-untimed`, 'u'); // 400
  await attempt(`${now() + skew + 60000}_${tag}-f`, 'f'); // 400
  return history;
}
