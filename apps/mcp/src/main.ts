import pkg from '../package.json' with { type: 'json' };
import { reportStartupError, start } from './server';

try {
  const running = await start({ env: process.env, version: pkg.version });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`${signal} received, shutting down\n`);
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} catch (error) {
  if (!reportStartupError(error, (text) => process.stderr.write(text))) {
    process.stderr.write(`Startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
  process.exit(1);
}
