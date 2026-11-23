#!/usr/bin/env node
// CodeGraph telemetry off, before any CodeGraph code can load.
process.env.CODEGRAPH_TELEMETRY = '0';
process.env.DO_NOT_TRACK = '1';

const { main } = await import('../dist/server/cli.js');
process.exitCode = await main(process.argv.slice(2), {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
