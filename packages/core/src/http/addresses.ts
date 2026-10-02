import { isIP } from 'node:net';

/** Parse a dotted IPv4 address into four numbers, or null. */
function ipv4(address: string): [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((n) => !(n >= 0 && n <= 255))) return null;
  return numbers as [number, number, number, number];
}

function publicIpv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // "this network", private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, including the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, documentation
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expand an IPv6 address to eight 16-bit groups, or null. Handles `::` and an embedded dotted IPv4 tail. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const tail = text.lastIndexOf(':');
  const dotted = ipv4(text.slice(tail + 1));
  if (dotted !== null) {
    const high = ((dotted[0] << 8) | dotted[1]).toString(16);
    const low = ((dotted[2] << 8) | dotted[3]).toString(16);
    text = `${text.slice(0, tail + 1)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));
    return groups.some(Number.isNaN) ? null : groups;
  };
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || rest === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...rest];
}

function publicIpv6(address: string): boolean {
  const g = ipv6Groups(address);
  if (g === null) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((group) => group === 0)) return false; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return false; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form: judge the embedded IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return publicIpv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
  }
  if (g0 === 0x64 && g1 === 0xff9b) return publicIpv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]); // NAT64: judge the IPv4 inside
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return publicIpv4([g1 >> 8, g1 & 255, g2 >> 8, g2 & 255]); // 6to4: judge the IPv4 inside
  if ((g0 & 0xe000) !== 0x2000) return false; // only global unicast 2000::/3 is public
  return true;
}

/**
 * True only for an address that belongs on the public internet. Refuses loopback, private, link-local (cloud metadata),
 * carrier-grade NAT, documentation, multicast and reserved ranges, for IPv4 and IPv6, including IPv4 hidden in IPv6 forms.
 * Anything that is not a valid IP literal is refused.
 */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const parsed = ipv4(address);
    return parsed !== null && publicIpv4(parsed);
  }
  if (kind === 6) return publicIpv6(address);
  return false;
}
