import { chmod, mkdir, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';

/** The Unix socket the running router listens on for commands from the host (`jobwatch ...` in the same container). */
export const controlSocketPath = (dataDir: string): string => join(dataDir, 'control.sock');

export type ControlRequest = { command: string; [key: string]: unknown };
export type ControlResponse = { ok: true; [key: string]: unknown } | { ok: false; error: string };
export type ControlHandler = (request: ControlRequest) => Promise<Record<string, unknown>>;

const MAX_LINE = 64 * 1024;

/**
 * A line-oriented JSON control channel on a Unix socket in the data directory (mode 0600: only the router's user can open it).
 * One request per connection, one response, then close. No network port is added: reaching it needs a shell on the host, which
 * is the point (docs/plans/17-dashboard.md, section 2). Unknown commands are refused.
 */
export async function startControlServer(
  path: string,
  handlers: Readonly<Record<string, ControlHandler>>,
  onError: (error: unknown) => void = () => undefined,
): Promise<{ server: Server; close: () => Promise<void> }> {
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true }); // a stale socket from a crash
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('error', onError);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) return void socket.destroy();
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      const line = buffer.slice(0, end);
      buffer = '';
      void (async () => {
        let response: ControlResponse;
        try {
          const request = JSON.parse(line) as unknown;
          if (typeof request !== 'object' || request === null || typeof (request as ControlRequest).command !== 'string')
            throw new Error('a request is {"command": "..."}');
          const handler = handlers[(request as ControlRequest).command];
          if (handler === undefined) throw new Error(`unknown command: ${String((request as ControlRequest).command).slice(0, 40)}`);
          response = { ok: true, ...(await handler(request as ControlRequest)) };
        } catch (error) {
          response = { ok: false, error: error instanceof Error ? error.message : 'failed' };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  return {
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(path, { force: true });
    },
  };
}

/** Send one command to the running router. Resolves `undefined` when no router is listening (no socket, or nobody behind it). */
export function sendControl(path: string, request: ControlRequest, timeoutMs = 30_000): Promise<ControlResponse | undefined> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the router did not answer in time'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => (buffer += chunk));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(undefined);
      else reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.trim()) as ControlResponse);
      } catch {
        reject(new Error('the router sent an unreadable answer'));
      }
    });
  });
}
