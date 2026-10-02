/** DevTools port inside the browser container, reached through the `socat` forward (docs/plans/05-browser-runtime.md, G2). */
export const DEVTOOLS_PORT = 9222;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/;

/**
 * The HTTP base URL of a browser's DevTools. `address` is a bare IPv4 address on the internal Docker network (DevTools
 * rejects any other Host header, so never a DNS name); `ip:port` exists for tests that publish the port.
 */
export function devtoolsBaseUrl(address: string): string {
  const match = IPV4.exec(address);
  if (match === null) throw new Error('the browser address must be an IP address');
  const octets = match.slice(1, 5).map(Number);
  const port = match[5] === undefined ? DEVTOOLS_PORT : Number(match[5]);
  if (octets.some((octet) => octet > 255) || port < 1 || port > 65_535) throw new Error('the browser address must be an IP address');
  return `http://${octets.join('.')}:${port}`;
}
