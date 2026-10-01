import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAdapterLogger, createLogger, sanitizeFields } from './logging';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[]; raw: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      buffer += String(chunk);
      done();
    },
  });
  return {
    stream,
    raw: () => buffer,
    lines: () =>
      buffer
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('sanitizeFields', () => {
  it('redacts sensitive keys whatever their case or position in the name', () => {
    const out = sanitizeFields({
      Cookie: 'li_at=abc',
      accessToken: 't',
      client_secret: 's',
      password: 'p',
      Authorization: 'Bearer x',
      sessionId: '1',
      apiKey: 'k',
      note: 'visible',
    });
    expect(out).toEqual({
      Cookie: '[redacted]',
      accessToken: '[redacted]',
      client_secret: '[redacted]',
      password: '[redacted]',
      Authorization: '[redacted]',
      sessionId: '[redacted]',
      apiKey: '[redacted]',
      note: 'visible',
    });
  });

  it('strips query strings, userinfo and fragments from URL values', () => {
    expect(sanitizeFields({ url: 'https://user:pw@www.linkedin.com/jobs/view/1/?trk=abc&JSESSIONID=SECRET#x' })).toEqual({
      url: 'https://www.linkedin.com/jobs/view/1/',
    });
  });

  it('keeps scalars and omits nested objects (which could hide secrets)', () => {
    expect(sanitizeFields({ n: 3, ok: true, none: null, nested: { cookie: 'x' }, list: [1] })).toEqual({
      n: 3,
      ok: true,
      none: null,
      nested: '[object omitted]',
      list: '[object omitted]',
    });
  });

  it('handles missing fields', () => {
    expect(sanitizeFields(undefined)).toEqual({});
  });
});

describe('createAdapterLogger', () => {
  it('tags lines with the adapter id and never writes a secret', () => {
    const sink = capture();
    const log = createAdapterLogger(createLogger({ level: 'debug', destination: sink.stream }), 'linkedin');
    log.info('opened search', {
      url: 'https://www.linkedin.com/jobs/search/?keywords=x&li_at=TOPSECRET',
      cookie: 'li_at=TOPSECRET',
      count: 25,
    });
    log.warn('slow', { ms: 9000 });
    expect(sink.raw()).not.toContain('TOPSECRET');
    expect(sink.lines()).toEqual([
      expect.objectContaining({
        level: 'info',
        adapter: 'linkedin',
        msg: 'opened search',
        url: 'https://www.linkedin.com/jobs/search/',
        cookie: '[redacted]',
        count: 25,
      }),
      expect.objectContaining({ level: 'warn', adapter: 'linkedin', msg: 'slow', ms: 9000 }),
    ]);
  });

  it('respects the configured level', () => {
    const sink = capture();
    const log = createAdapterLogger(createLogger({ level: 'warn', destination: sink.stream }), 'x');
    log.debug('hidden');
    log.info('hidden');
    log.error('shown');
    expect(sink.lines().map((line) => line['msg'])).toEqual(['shown']);
  });
});

describe('createLogger redaction for engine objects', () => {
  it('censors request headers and common secret fields', () => {
    const sink = capture();
    const log = createLogger({ level: 'info', destination: sink.stream });
    log.info(
      {
        req: { headers: { authorization: 'Bearer TOPSECRET', cookie: 'a=TOPSECRET', accept: 'json' } },
        token: 'TOPSECRET',
        ctx: { password: 'TOPSECRET' },
      },
      'request',
    );
    expect(sink.raw()).not.toContain('TOPSECRET');
    expect(sink.lines()[0]).toMatchObject({ level: 'info', msg: 'request' });
  });

  it('writes ISO timestamps and named levels', () => {
    const sink = capture();
    createLogger({ level: 'info', destination: sink.stream }).info('hello');
    const [line] = sink.lines();
    expect(line?.['level']).toBe('info');
    expect(String(line?.['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
