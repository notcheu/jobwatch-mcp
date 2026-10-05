import { describe, expect, it } from 'vitest';
import { BackendError, type RuntimeSpec } from './backend';
import { AttachBackend } from './attachBackend';

const spec = { platform: 'linkedin', name: 'jw-linkedin' } as RuntimeSpec;
const answering = (ok: boolean): typeof fetch => (async () => ({ ok })) as unknown as typeof fetch;
const down: typeof fetch = async () => {
  throw new Error('ECONNREFUSED');
};

describe('AttachBackend', () => {
  it('hands out the address of the running Chrome', async () => {
    const backend = new AttachBackend('127.0.0.1:9222', answering(true));
    expect(await backend.start(spec)).toEqual({ name: 'jw-linkedin', platform: 'linkedin', address: '127.0.0.1:9222' });
  });

  it('explains how to start Chrome when nothing answers', async () => {
    const backend = new AttachBackend('127.0.0.1:9222', down);
    await expect(backend.start(spec)).rejects.toThrow(BackendError);
    await expect(backend.start(spec)).rejects.toThrow('--remote-debugging-port=9222');
  });

  it('reports the browser as running while DevTools answers, and never owns anything', async () => {
    const handle = { name: 'jw-linkedin', platform: 'linkedin', address: '127.0.0.1:9222' };
    expect((await new AttachBackend('127.0.0.1:9222', answering(true)).inspect()).running).toBe(true);
    expect((await new AttachBackend('127.0.0.1:9222', down).inspect()).running).toBe(false);
    const backend = new AttachBackend('127.0.0.1:9222', answering(true));
    await backend.stop();
    await backend.remove();
    expect(await backend.listManaged()).toEqual([]);
    expect(await backend.memoryBytes()).toBe(0);
    expect(handle.address).toBe('127.0.0.1:9222');
  });
});
