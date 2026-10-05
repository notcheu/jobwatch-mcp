import { spawnDocker } from '@jobwatch/core';
import { installedAdapters, installedUtilities } from '@jobwatch/mcp-modules';
import pkg from '../package.json' with { type: 'json' };
import { run } from './cli';

const code = await run(process.argv.slice(2), {
  io: { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
  env: process.env,
  adapters: installedAdapters,
  utilities: installedUtilities,
  docker: spawnDocker,
  version: pkg.version,
});
process.exitCode = code;
