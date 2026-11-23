// observability.ts: does the tape Worker's live observability (logs, traces, sampling) say what cloudflare.config.ts
// says? Observability is a setting of the script, not of a version: a versions upload and a ramp (ship.sh,
// deploy.sh) never apply it. Traces were turned on in the config (abd7729) and stayed off in prod until a full
// deploy (2026-11-23), with nothing failing. ship.sh runs this first and stops when they differ.
//   node scripts/observability.ts [--worker tape]
// Exit 0: every setting the config names is live as written. Exit 1: each one that differs, and what applies it.
// Needs CLOUDFLARE_ACCOUNT_ID; runs cf with the OAuth login.
import '../../node25.ts';
import { execFileSync } from 'node:child_process';
import config from '../cloudflare.config.ts';
import { field, observabilityDiff } from './obs/o11y.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--worker');
const worker = at < 0 ? 'tape' : (args[at + 1] ?? 'tape');
const env = { ...process.env };
delete env['CLOUDFLARE_API_TOKEN'];
const out = execFileSync('npx', ['cf', 'workers', 'get', worker], {
  cwd: new URL('../', import.meta.url).pathname,
  env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const live = field(JSON.parse(out.slice(out.indexOf('{'))), 'observability');
const differ = observabilityDiff(field(config, 'worker', 'observability'), live);
if (differ.length > 0) {
  console.error(`FAIL observability: ${worker}'s script settings are not what cloudflare.config.ts says:`);
  for (const d of differ) console.error(`  ${d}`);
  console.error(
    '  A version upload or a ramp does not apply them: apply them with a full deploy (cf deploy) or by editing the ' +
      "script's settings, then ship again.",
  );
  process.exit(1);
}
console.log(`observability ok: ${worker}'s script settings are as cloudflare.config.ts says`);
