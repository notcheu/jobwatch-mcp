import { AdapterBroken, htmlToText, type BoardPosting } from '@jobwatch/sdk';
import { child, childText, parseXml, type XmlElement } from './xml';

const isoOrNull = (value: string | null): string | null => {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** The pay range Personio publishes, as one line the salary filter can read; null when there is none. */
const payLine = (position: XmlElement): string | null => {
  const pay = child(position, 'salaryInformation');
  if (pay === undefined) return null;
  const min = childText(pay, 'min');
  const max = childText(pay, 'max');
  if (min === null && max === null) return null;
  const range = min !== null && max !== null && min !== max ? `${min}-${max}` : (min ?? max);
  return `Salary: ${range} ${childText(pay, 'currencyCode') ?? ''} ${childText(pay, 'type') ?? ''}`.replace(/\s+/g, ' ').trim();
};

/** `GET <handle>.jobs.personio.de/xml`: every open position, with its text in named HTML sections. A changed shape is `adapter_broken`. */
export function parseFeed(xml: string, handle: string): { name: string | null; postings: Omit<BoardPosting, 'board'>[] } {
  const root = parseXml(xml);
  if (root.name !== 'workzag-jobs') throw new AdapterBroken('The answer is not a Personio feed.');
  const positions = root.children.filter((entry) => entry.name === 'position');
  let company: string | null = null;
  const postings = positions.map((position) => {
    const id = childText(position, 'id');
    const title = childText(position, 'name');
    if (id === null || title === null) throw new AdapterBroken('A Personio position has no id or no name.');
    company ??= childText(position, 'subcompany');
    const offices = [
      childText(position, 'office'),
      ...(child(position, 'additionalOffices')?.children ?? []).map((office) => office.text.trim() || null),
    ];
    const sections = (child(position, 'jobDescriptions')?.children ?? []).map((section) => {
      const text = htmlToText(childText(section, 'value') ?? '');
      return text === '' ? '' : `${childText(section, 'name') ?? ''}\n${text}`.trim();
    });
    return {
      id,
      title,
      company: childText(position, 'subcompany'),
      locations: offices.filter((office, index, list): office is string => office !== null && list.indexOf(office) === index),
      url: `https://${handle}.jobs.personio.de/job/${id}`,
      postedAt: isoOrNull(childText(position, 'createdAt')),
      description: [...sections, payLine(position)].filter((part): part is string => part !== null && part !== '').join('\n\n'),
    };
  });
  return { name: company, postings };
}
