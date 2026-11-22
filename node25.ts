// node25.ts: imported first by every Node entry point. The local tools need Node 25 (node:sqlite's
// StatementSync#columns, among others); on an older Node they would fail later with a confusing error.
const major = Number(process.versions.node.split('.')[0]);
if (!(major >= 25)) {
  console.error(
    `tape needs Node 25 or newer; this is Node ${process.versions.node} (${process.execPath}). Install Node 25, e.g. \`nvm install 25\`.`,
  );
  process.exit(1);
}
