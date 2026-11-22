// The live versions' builds, under the name program.ts imports them by. The supervisor writes the real module for
// each name when it loads the name's worker (index.ts, Name.data): every live version's two modules, its trace
// sites and its source. This file is what the type checker reads for that import; it is never bundled.
import type { Built } from '../../compiler.ts';

export type VersionBuild = {
  plain: WebAssembly.Module;
  traced: WebAssembly.Module;
  sites: Built['sites'];
  source: string;
};
const versions: Readonly<Record<string, VersionBuild>> = {};
export default versions;
