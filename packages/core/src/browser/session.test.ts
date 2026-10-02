import { describe, expect, it } from 'vitest';
import { persistentCopies, SESSION_COOKIE_TTL_S } from './session';

const cookie = (domain: string, expires: number, name = 'c') => ({
  name,
  value: 'v',
  domain,
  path: '/',
  expires,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax' as const,
});

describe('persistentCopies', () => {
  const hosts = ['www.welcometothejungle.com'];

  it('gives a session cookie of the host or its parent domain an expiry, keeping everything else', () => {
    const [copy] = persistentCopies([cookie('.welcometothejungle.com', -1, 'a')], hosts, 1000);
    expect(copy).toEqual({ ...cookie('.welcometothejungle.com', -1, 'a'), expires: 1000 + SESSION_COOKIE_TTL_S });
    expect(persistentCopies([cookie('www.welcometothejungle.com', -1)], hosts, 1000)).toHaveLength(1);
  });

  it('leaves persistent cookies and other sites alone', () => {
    const cookies = [
      cookie('.welcometothejungle.com', 2_000_000_000),
      cookie('.google.com', -1),
      cookie('.evil-welcometothejungle.com', -1),
    ];
    expect(persistentCopies(cookies, hosts, 1000)).toEqual([]);
  });

  it('does not match a sibling subdomain', () => {
    expect(persistentCopies([cookie('api.welcometothejungle.com', -1)], hosts, 1000)).toEqual([]);
  });
});
