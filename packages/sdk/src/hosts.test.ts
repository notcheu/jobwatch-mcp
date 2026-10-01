import { describe, expect, it } from 'vitest';
import { HostNotAllowedError } from './errors';
import { assertUrlAllowed, isBareHostname, isUrlAllowed, redactUrl } from './hosts';

const allowed = ['www.apec.fr', 'api.example.com'];

describe('isBareHostname', () => {
  it('accepts plain lowercase DNS names', () => {
    for (const host of ['www.apec.fr', 'api.example.com', 'a.b.c.example.org', 'xn--bcher-kva.example'])
      expect(isBareHostname(host)).toBe(true);
  });

  it('rejects anything that is not a bare hostname', () => {
    for (const host of [
      '',
      'localhost',
      'WWW.APEC.FR',
      'https://www.apec.fr',
      'www.apec.fr/path',
      'www.apec.fr:443',
      '*.apec.fr',
      '127.0.0.1',
      '[::1]',
      'apec',
      'a..b.fr',
      '-a.example.com',
      'www.apec.fr.',
      'user@www.apec.fr',
    ]) {
      expect(isBareHostname(host), host).toBe(false);
    }
  });
});

describe('isUrlAllowed', () => {
  it('allows https URLs on exactly the listed hosts', () => {
    expect(isUrlAllowed('https://www.apec.fr/cms/webservices/rechercheOffre', allowed)).toBe(true);
    expect(isUrlAllowed('https://API.EXAMPLE.COM/x?y=1#z', allowed)).toBe(true);
    expect(isUrlAllowed('https://www.apec.fr:443/x', allowed)).toBe(true); // default port is normalised away
  });

  it('blocks look-alike and parent/sub domains', () => {
    for (const url of [
      'https://apec.fr/',
      'https://evil.www.apec.fr/',
      'https://www.apec.fr.evil.com/',
      'https://wwwapec.fr/',
      'https://xwww.apec.fr/',
      'https://www.apec.fr.:443/',
    ]) {
      expect(isUrlAllowed(url, allowed), url).toBe(false);
    }
  });

  it('blocks userinfo tricks', () => {
    expect(isUrlAllowed('https://www.apec.fr@evil.com/', allowed)).toBe(false);
    expect(isUrlAllowed('https://evil.com@www.apec.fr/', allowed)).toBe(false);
    expect(isUrlAllowed('https://user:pass@www.apec.fr/', allowed)).toBe(false);
  });

  it('blocks other schemes and non-default ports', () => {
    for (const url of [
      'http://www.apec.fr/',
      'ftp://www.apec.fr/',
      'file:///etc/passwd',
      'data:text/html,hi',
      'javascript:alert(1)',
      'about:blank',
      'chrome://settings',
      'https://www.apec.fr:8443/',
    ]) {
      expect(isUrlAllowed(url, allowed), url).toBe(false);
    }
  });

  it('blocks IP literals, relative URLs and garbage', () => {
    for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://192.168.1.10/', '/relative/path', '', 'not a url']) {
      expect(isUrlAllowed(url, allowed), url).toBe(false);
    }
  });

  it('blocks everything when no host is allowed', () => {
    expect(isUrlAllowed('https://www.apec.fr/', [])).toBe(false);
  });
});

describe('assertUrlAllowed', () => {
  it('returns the parsed URL when allowed', () => {
    expect(assertUrlAllowed('https://www.apec.fr/a?b=1', allowed).pathname).toBe('/a');
  });

  it('throws HostNotAllowedError without leaking the query string', () => {
    try {
      assertUrlAllowed('https://evil.example/path?token=SECRET', allowed);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HostNotAllowedError);
      expect((error as Error).message).toContain('evil.example');
      expect((error as Error).message).not.toContain('SECRET');
    }
  });
});

describe('redactUrl', () => {
  it('keeps scheme, host and path only', () => {
    expect(redactUrl('https://user:pw@www.linkedin.com/jobs/view/123/?trk=abc&li_at=SECRET#frag')).toBe(
      'https://www.linkedin.com/jobs/view/123/',
    );
  });

  it('does not throw on garbage', () => {
    expect(redactUrl('???')).toBe('[invalid url]');
  });
});
