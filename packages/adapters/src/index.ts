import type { AdapterModule } from '@jobwatch/sdk';

/** Same shape as `InstalledAdapters` in @jobwatch/core (structural typing; this package may not depend on core). */
export type InstalledMap = Readonly<Record<string, () => Promise<AdapterModule>>>;

/**
 * THE INSTALLED ADAPTERS: the single place that lists adapter packages. A line is added by `npm run new:adapter -- <id>`
 * and the lines between the markers are kept sorted; edit by hand only to remove an adapter.
 * Installed does not mean enabled: `jobwatch adapters enable <id>` decides which ones the router plugs in.
 * Loaders are lazy, so a disabled adapter is never imported.
 */
export const installed = {
  // <installed:begin>
  linkedin: () => import('@jobwatch/adapter-linkedin').then((m) => m.default),
  // <installed:end>
} satisfies InstalledMap;

export { describeInstalled } from './summary';
export type { InstalledEntry } from './summary';

/** Ids of all installed adapters, sorted. */
export function installedIds(map: InstalledMap = installed): string[] {
  return Object.keys(map).sort();
}
