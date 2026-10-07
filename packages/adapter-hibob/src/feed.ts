import { htmlToText, z, type BoardPosting } from '@jobwatch/sdk';

/** `GET <handle>.careers.hibob.com/api/job-ad` (header `companyidentifier: <handle>`): every job ad, with its text in four HTML parts. */
const schema = z.object({
  jobAdDetails: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      site: z.string().nullish(),
      country: z.string().nullish(),
      workspaceType: z.string().nullish(),
      workspaceTypeId: z.string().nullish(),
      publishedAt: z.string().nullish(),
      description: z.string().nullish(),
      requirements: z.string().nullish(),
      responsibilities: z.string().nullish(),
      benefits: z.string().nullish(),
      sectionLabels: z.record(z.string(), z.string()).nullish(),
      payTransparencyMinSalary: z.number().nullish(),
      payTransparencyMaxSalary: z.number().nullish(),
      payTransparencySalaryCurrency: z.string().nullish(),
      payTransparencySalaryPayPeriod: z.string().nullish(),
    }),
  ),
});

const isoOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** The pay range HiBob publishes under pay transparency, as one line the salary filter can read; null when there is none. */
const payLine = (ad: {
  payTransparencyMinSalary?: number | null;
  payTransparencyMaxSalary?: number | null;
  payTransparencySalaryCurrency?: string | null;
  payTransparencySalaryPayPeriod?: string | null;
}): string | null => {
  const { payTransparencyMinSalary: min, payTransparencyMaxSalary: max } = ad;
  if (min === null || min === undefined || max === null || max === undefined) return null;
  const period = ad.payTransparencySalaryPayPeriod?.toLowerCase();
  return `Salary: ${min}-${max} ${ad.payTransparencySalaryCurrency ?? ''}${period ? ` per ${period}` : ''}`.trim();
};

export function parseBoard(
  handle: string,
  parse: <T>(schema: z.ZodType<T>) => T,
): { name: string | null; postings: Omit<BoardPosting, 'board'>[] } {
  const postings = parse(schema).jobAdDetails.map((ad) => {
    const places = [[ad.site, ad.country].filter(Boolean).join(', ')].map((place) => place.trim()).filter((place) => place !== '');
    // HiBob states remote work in a field of its own, not in the site: say it where location filters can see it.
    if ((ad.workspaceTypeId ?? ad.workspaceType ?? '').toLowerCase() === 'remote' && !places.some((place) => /remote/i.test(place)))
      places.push('Remote');
    const labels = ad.sectionLabels ?? {};
    const section = (label: string | undefined, html: string | null | undefined): string | null => {
      const text = htmlToText(html ?? '');
      return text.trim() === '' ? null : `${label ?? ''}\n${text}`.trim();
    };
    return {
      id: ad.id,
      title: ad.title.trim(),
      // HiBob job ads carry no company name: the board is named after the handle.
      company: null,
      locations: places,
      url: `https://${handle}.careers.hibob.com/jobs/${ad.id}`,
      postedAt: isoOrNull(ad.publishedAt),
      description: [
        section(undefined, ad.description),
        section(labels['requirements'], ad.requirements),
        section(labels['responsibilities'], ad.responsibilities),
        section(labels['benefits'], ad.benefits),
        payLine(ad),
      ]
        .filter((part): part is string => part !== null)
        .join('\n\n'),
    };
  });
  return { name: null, postings };
}
