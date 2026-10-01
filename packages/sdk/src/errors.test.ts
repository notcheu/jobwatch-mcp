import { describe, expect, it } from 'vitest';
import { AdapterBroken, Checkpoint, ERROR_CODES, HostNotAllowedError, JobwatchError, SessionInvalid, UpstreamError } from './errors';

describe('errors', () => {
  it('maps adapter-signalled errors to the documented codes', () => {
    expect(new SessionInvalid().code).toBe('needs_login');
    expect(new Checkpoint().code).toBe('checkpoint');
    expect(new AdapterBroken('selector drift').code).toBe('adapter_broken');
    expect(new UpstreamError('HTTP 503').code).toBe('upstream_error');
    expect(new HostNotAllowedError('evil.example').code).toBe('internal');
  });

  it('only uses codes from the documented list', () => {
    expect(ERROR_CODES).toHaveLength(11);
    for (const error of [
      new SessionInvalid(),
      new Checkpoint(),
      new AdapterBroken('x'),
      new UpstreamError('x'),
      new HostNotAllowedError('h'),
    ]) {
      expect(ERROR_CODES).toContain(error.code);
    }
  });

  it('serialises to the client-facing body without a stack or cause', () => {
    const error = new JobwatchError('rate_limited', 'Slow down.', {
      retryAfterS: 30,
      details: { platform: 'linkedin' },
      cause: new Error('secret internals'),
    });
    expect(error.toBody()).toEqual({ code: 'rate_limited', message: 'Slow down.', retry_after_s: 30, details: { platform: 'linkedin' } });
    expect(JSON.stringify(error.toBody())).not.toContain('secret internals');
  });

  it('defaults retry_after_s to null and details to {}', () => {
    expect(new JobwatchError('internal', 'boom').toBody()).toEqual({ code: 'internal', message: 'boom', retry_after_s: null, details: {} });
  });

  it('is an Error with the subclass name', () => {
    const error = new Checkpoint();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(JobwatchError);
    expect(error.name).toBe('Checkpoint');
  });
});
