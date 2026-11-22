// node runtime-types.ts: writes runtime.d.ts, the types of the Workers runtime at this service's compatibility
// date, made by the local workerd. Run it again when the compatibility date in cloudflare.config.ts changes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { generateRuntimeTypes } from '@cloudflare/runtime-types';

const out = new URL('./runtime.d.ts', import.meta.url).pathname;
const config = readFileSync(new URL('./cloudflare.config.ts', import.meta.url).pathname, 'utf8');
const compatibilityDate = /compatibilityDate: ['"](\d{4}-\d{2}-\d{2})['"]/.exec(config)?.[1];
if (compatibilityDate === undefined) throw new Error('cloudflare.config.ts names no compatibilityDate');
const { runtimeHeader, runtimeTypes, isCached } = await generateRuntimeTypes({
  compatibilityDate,
  compatibilityFlags: [],
  ...(existsSync(out) ? { existingContent: readFileSync(out, 'utf8') } : {}),
});
if (!isCached) writeFileSync(out, `${runtimeHeader}\n${runtimeTypes}\n`);
console.log(isCached ? 'runtime.d.ts is current' : `wrote runtime.d.ts for ${compatibilityDate}`);
