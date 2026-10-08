/** The ATS this gateway reads through: each is a module with a tool named `<id>_jobs`. */
export const ATS_IDS = [
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
] as const;
export type AtsId = (typeof ATS_IDS)[number];

/** The ATS that `ats_find` can recognise; the others are routed from a URL or from the operator's mapping only. */
export const DISCOVERABLE: readonly AtsId[] = ['ashby', 'greenhouse', 'lever', 'teamtailor'];

export const toolOf = (ats: AtsId): string => `${ats}_jobs`;

/** Host suffixes that name an ATS. A board address on one of them is routed with no lookup. */
const HOSTS: readonly (readonly [string, AtsId])[] = [
  ['jobs.ashbyhq.com', 'ashby'],
  ['bamboohr.com', 'bamboohr'],
  ['breezy.hr', 'breezy'],
  ['greenhouse.io', 'greenhouse'],
  ['careers.hibob.com', 'hibob'],
  ['jobs.lever.co', 'lever'],
  ['jobs.personio.de', 'personio'],
  ['recruitee.com', 'recruitee'],
  ['smartrecruiters.com', 'smartrecruiters'],
  ['teamtailor.com', 'teamtailor'],
  ['apply.workable.com', 'workable'],
  ['myworkdayjobs.com', 'workday'],
];

/** The ATS an address belongs to, or null when the text is not the https address of a known ATS. */
export function atsOfUrl(text: string): AtsId | null {
  if (!/^https:\/\//i.test(text)) return null;
  let host: string;
  try {
    host = new URL(text).hostname.toLowerCase();
  } catch {
    return null;
  }
  return HOSTS.find(([suffix]) => host === suffix || host.endsWith(`.${suffix}`))?.[1] ?? null;
}
