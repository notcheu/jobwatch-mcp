import { describe, expect, it } from 'vitest';
import { devtoolsBaseUrl } from './address';

describe('devtoolsBaseUrl', () => {
  it('adds the DevTools port to a bare IPv4 address', () => {
    expect(devtoolsBaseUrl('172.18.0.5')).toBe('http://172.18.0.5:9222');
  });

  it('keeps an explicit port (a test that publishes the port)', () => {
    expect(devtoolsBaseUrl('127.0.0.1:19222')).toBe('http://127.0.0.1:19222');
  });

  it('refuses DNS names: DevTools rejects any Host header that is not an IP (G2)', () => {
    for (const name of ['jw-linkedin', 'localhost', 'browser.internal', 'example.com:9222', '']) {
      expect(() => devtoolsBaseUrl(name), name).toThrow('must be an IP address');
    }
  });

  it('refuses injection through the address', () => {
    for (const bad of [
      '1.2.3.4/../x',
      '1.2.3.4@evil.com',
      '1.2.3.4 evil',
      'http://1.2.3.4',
      '1.2.3.4:99999999',
      '1.2.3.4:70000',
      '1.2.3.4:0',
      '999.1.1.1',
      '1.2.3',
    ]) {
      expect(() => devtoolsBaseUrl(bad), bad).toThrow();
    }
  });
});
