import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { controlSocketPath, sendControl, startControlServer } from './control';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jw-ctl-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('control socket', () => {
  it('answers a command, is readable by its owner only, and is gone after close', async () => {
    const path = controlSocketPath(dir);
    const control = await startControlServer(path, { ping: async () => ({ pong: 1 }) });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await sendControl(path, { command: 'ping' })).toEqual({ ok: true, pong: 1 });
    await control.close();
    expect(await sendControl(path, { command: 'ping' })).toBeUndefined();
  });

  it('refuses an unknown command and a handler that throws, with a short message', async () => {
    const path = controlSocketPath(dir);
    const control = await startControlServer(path, {
      boom: async () => {
        throw new Error('it broke');
      },
    });
    expect(await sendControl(path, { command: 'nope' })).toEqual({ ok: false, error: 'unknown command: nope' });
    expect(await sendControl(path, { command: 'boom' })).toEqual({ ok: false, error: 'it broke' });
    await control.close();
  });

  it('reports no router when there is no socket', async () => {
    expect(await sendControl(join(dir, 'missing.sock'), { command: 'ping' })).toBeUndefined();
  });

  it('replaces a stale socket file left by a crash', async () => {
    const path = controlSocketPath(dir);
    await writeFile(path, 'stale');
    const control = await startControlServer(path, { ping: async () => ({}) });
    expect(await sendControl(path, { command: 'ping' })).toEqual({ ok: true });
    await control.close();
  });
});
