import type { BoardAddress } from '@jobwatch/sdk';

/** The Workday data centres (`wd5`) this adapter may reach: the host list of the adapter names each one. */
export const SHARDS = [
  'wd1',
  'wd2',
  'wd3',
  'wd4',
  'wd5',
  'wd6',
  'wd7',
  'wd8',
  'wd9',
  'wd10',
  'wd11',
  'wd12',
  'wd101',
  'wd102',
  'wd103',
  'wd104',
  'wd105',
  'wd501',
  'wd502',
  'wd503',
] as const;

const TENANT = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SHARD = /^wd[0-9]{1,3}$/;
const SITE = /^[A-Za-z0-9_-]{1,80}$/;
const LOCALE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;

/** What a Workday career site is: the company (`nvidia`), its data centre (`wd5`) and the site name (`NVIDIAExternalCareerSite`). */
export interface WorkdaySite {
  tenant: string;
  shard: string;
  site: string;
}

/** The label of a site in reports and budgets: `nvidia.wd5/NVIDIAExternalCareerSite`, which `resolveBoard` takes back. */
export const labelOf = (site: WorkdaySite): string => `${site.tenant}.${site.shard}/${site.site}`;

/** The address of the search of a site (a POST) and the base of its postings (a GET). */
export const apiBase = (site: WorkdaySite): string =>
  `https://${site.tenant}.${site.shard}.myworkdayjobs.com/wday/cxs/${site.tenant}/${site.site}`;

/** The site behind a label produced by `labelOf`. */
export function siteOf(label: string): WorkdaySite | null {
  const match = /^([a-z0-9-]+)\.(wd[0-9]{1,3})\/([A-Za-z0-9_-]+)$/.exec(label);
  return match === null ? null : { tenant: match[1] as string, shard: match[2] as string, site: match[3] as string };
}

/**
 * Where a company's jobs are, from `tenant.wdN/Site` (`nvidia.wd5/NVIDIAExternalCareerSite`) or a URL of its career site:
 * `https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite`, `https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/...`
 * or the `/wday/cxs/<tenant>/<site>/jobs` address. A Workday company is three values, not one handle, and a company can have several
 * sites. Only those values are taken from a URL: the requests always go to `<tenant>.<wdN>.myworkdayjobs.com/wday/cxs`. Returns null
 * for anything else.
 */
export function resolveBoard(input: string): BoardAddress | null {
  const text = input.trim();
  const make = (tenant: string, shard: string, site: string): BoardAddress | null => {
    if (!TENANT.test(tenant) || !SHARD.test(shard) || !SITE.test(site)) return null;
    const found = { tenant, shard, site };
    return { feedUrl: `${apiBase(found)}/jobs`, label: labelOf(found) };
  };
  const direct = siteOf(text);
  if (direct !== null) return make(direct.tenant, direct.shard, direct.site);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const labels = url.hostname.split('.');
  if (labels.length !== 4 || labels[2] !== 'myworkdayjobs' || labels[3] !== 'com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'wday' && parts[1] === 'cxs')
    return make(labels[0] as string, labels[1] as string, parts[3] ?? '') !== null && parts[2] === labels[0]
      ? make(labels[0] as string, labels[1] as string, parts[3] ?? '')
      : null;
  const site = parts[0] !== undefined && LOCALE.test(parts[0]) ? parts[1] : parts[0];
  return make(labels[0] as string, labels[1] as string, site ?? '');
}
