import { describe, expect, it } from 'vitest';
import { isPublicAddress } from './addresses';

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '104.16.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4007:80f::200e',
  ])('accepts public %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '127.0.0.1',
    '127.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ])('refuses IPv4 %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '::',
    '::1',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd12:3456:789a::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.5',
    '::ffff:169.254.169.254',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::',
    '100::1',
  ])('refuses IPv6 %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('accepts IPv4-mapped IPv6 only when the IPv4 inside is public', () => {
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicAddress('::ffff:808:808')).toBe(true);
  });

  it.each(['', 'localhost', 'example.com', '1.2.3', '1.2.3.4.5', '256.1.1.1', '0x7f.0.0.1', '1e3.0.0.1', '::g', 'not an ip'])(
    'refuses %j',
    (value) => {
      expect(isPublicAddress(value)).toBe(false);
    },
  );
});
