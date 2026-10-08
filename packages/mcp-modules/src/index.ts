import type { AdapterModule, McpModule, UtilityModule } from '@jobwatch/sdk';
import budgetsFile from './budgets.json' with { type: 'json' };

/** Same shapes as `InstalledAdapters`, `InstalledUtilities` and `InstalledModules` in @jobwatch/core (structural typing; this package may not depend on core). */
export type InstalledAdapterMap = Readonly<Record<string, () => Promise<AdapterModule>>>;
export type InstalledUtilityMap = Readonly<Record<string, () => Promise<UtilityModule>>>;
export type InstalledModuleMap = Readonly<Record<string, () => Promise<McpModule>>>;

/**
 * THE INSTALLED ADAPTERS: the single place that lists adapter packages (`packages/adapter-*`, modules that fetch jobs). A line is
 * added by `npm run new:adapter -- <id>` and the lines between the markers are kept sorted; edit by hand only to remove an adapter.
 * Installed does not mean enabled: `jobwatch adapters enable <id>` decides which ones the router plugs in.
 * Loaders are lazy, so a disabled adapter is never imported.
 */
export const installedAdapters = {
  // <adapters:begin>
  apec: () => import('@jobwatch/adapter-apec').then((m) => m.default),
  ashby: () => import('@jobwatch/adapter-ashby').then((m) => m.default),
  ats: () => import('@jobwatch/adapter-ats').then((m) => m.default),
  bamboohr: () => import('@jobwatch/adapter-bamboohr').then((m) => m.default),
  breezy: () => import('@jobwatch/adapter-breezy').then((m) => m.default),
  greenhouse: () => import('@jobwatch/adapter-greenhouse').then((m) => m.default),
  hibob: () => import('@jobwatch/adapter-hibob').then((m) => m.default),
  lever: () => import('@jobwatch/adapter-lever').then((m) => m.default),
  linkedin: () => import('@jobwatch/adapter-linkedin').then((m) => m.default),
  personio: () => import('@jobwatch/adapter-personio').then((m) => m.default),
  recruitee: () => import('@jobwatch/adapter-recruitee').then((m) => m.default),
  smartrecruiters: () => import('@jobwatch/adapter-smartrecruiters').then((m) => m.default),
  teamtailor: () => import('@jobwatch/adapter-teamtailor').then((m) => m.default),
  workable: () => import('@jobwatch/adapter-workable').then((m) => m.default),
  workday: () => import('@jobwatch/adapter-workday').then((m) => m.default),
  wttj: () => import('@jobwatch/adapter-wttj').then((m) => m.default),
  // <adapters:end>
} satisfies InstalledAdapterMap;

/**
 * THE INSTALLED UTILITIES: the single place that lists utility packages (`packages/utility-*`, helper modules that fetch no jobs).
 * A line is added by `npm run new:utility -- <id>`, sorted between the markers. Enabled with `jobwatch utilities enable <id>`.
 */
export const installedUtilities = {
  // <utilities:begin>
  'ats-discovery': () => import('@jobwatch/utility-ats-discovery').then((m) => m.default),
  'linkedin-geo': () => import('@jobwatch/utility-linkedin-geo').then((m) => m.default),
  // <utilities:end>
} satisfies InstalledUtilityMap;

/** Both, for the code that handles every module the same way (the registry, the dashboard). Ids are unique across the two. */
export const installedModules: InstalledModuleMap = { ...installedAdapters, ...installedUtilities };

export { describeInstalledAdapters, describeInstalledModules, describeInstalledUtilities } from './summary';
export type { AdapterEntry, ModuleEntry, UtilityEntry } from './summary';

const sortedIds = (map: Readonly<Record<string, unknown>>): string[] => Object.keys(map).sort();

/** Ids of all installed adapters, sorted. */
export const installedAdapterIds = (map: InstalledAdapterMap = installedAdapters): string[] => sortedIds(map);
/** Ids of all installed utilities, sorted. */
export const installedUtilityIds = (map: InstalledUtilityMap = installedUtilities): string[] => sortedIds(map);

/**
 * THE DEFAULT BUDGETS: requests per hour and per day of each installed module (`budgets.json`, next to this file; edit it by hand).
 * They apply until someone saves another budget from the dashboard, and an environment variable
 * (`LINKEDIN_BUDGET_HOURLY`, `LINKEDIN_BUDGET_DAILY`) wins over both. A module with no entry gets the engine default of its kind.
 */
export const budgetDefaults: Readonly<Record<string, { readonly hourly: number; readonly daily: number }>> = budgetsFile;

/**
 * THE GATEWAYS: modules the engine switches on by itself, each with the modules it reads through (`delegates.to` of the gateway).
 * `ats` is on while any ATS adapter is, and cannot be enabled or disabled by hand. Kept here because core must know it before loading
 * anything; a test checks it against the gateways' own declarations.
 */
export const managedModules: Readonly<Record<string, readonly string[]>> = {
  ats: [
    'ashby',
    'bamboohr',
    'breezy',
    'greenhouse',
    'hibob',
    'lever',
    'personio',
    'recruitee',
    'smartrecruiters',
    'teamtailor',
    'workable',
    'workday',
  ],
};
