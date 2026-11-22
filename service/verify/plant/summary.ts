// node service/verify/plant/summary.ts <plants.jsonl>: the last result of each plant, one line each
import { readFileSync } from 'node:fs';
import { at, fields, list, text } from '../../jepsen/json.ts';
import type { Fields } from '../../jepsen/json.ts';

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error('usage: summary.ts <plants.jsonl>');
const last = new Map(
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line): [string, Fields] => {
      const stored: unknown = JSON.parse(line);
      return [text(at(stored, 'id')), fields(stored)];
    }),
);
/** What the plant's run showed: its anomaly types, the machine plant's statuses, or the last line of its log. */
const shown = (r: Fields): string => {
  if (r['types'] !== undefined) return JSON.stringify(r['types']);
  if (r['machine'] === undefined || r['machine'] === null) return text(list(r['log']).at(-1));
  const upload = list(at(r['machine'], 'upload')).slice(0, 2),
    buy = at(r['machine'], 'buy', 0);
  return `upload ${upload.map(Number).join(',')} buy ${typeof buy === 'number' ? buy : '-'}`;
};
for (const [id, r] of last)
  console.log(`${(r['caught'] ?? r['passed']) === true ? 'caught' : 'MISSED'}\t${id}\t${shown(r)}`);
