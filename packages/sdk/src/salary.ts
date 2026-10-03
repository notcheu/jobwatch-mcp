/** A yearly salary found in a job text, as it is written and as numbers. */
export interface Salary {
  /** The text as written, a range or a fixed amount, with the variable part when there is one: `€72.000 - €115.000`. */
  text: string;
  /** The lower end of the range, or the fixed amount, in currency units per year. */
  min: number;
  /** The upper end of the range, or the fixed amount (equal to `min`). */
  max: number;
  /** ISO code: EUR, USD, GBP, CHF... */
  currency: string;
  /** The variable part per year when the text states one next to the fixed part, else null. */
  variable: number | null;
}

interface Amount {
  start: number;
  end: number;
  /** The amount in currency units (a `k` multiplies by 1000). */
  value: number;
  /** Written with a `k`: `65k€`. */
  thousands: boolean;
  currency: string | null;
  /** The amount as written, without the spaces around it. */
  raw: string;
}

const SYMBOLS: Record<string, string> = { '€': 'EUR', '£': 'GBP', $: 'USD', '¥': 'JPY', '₹': 'INR' };
const CODES = 'EUR|USD|GBP|CHF|CAD|AUD|NZD|SEK|NOK|DKK|PLN|CZK|HUF|RON|JPY|CNY|INR|AED|MAD|BRL|MXN|SGD|HKD|ZAR';
const CURRENCY = `(?:[€£$¥₹]|(?:${CODES})\\b|euros?\\b|dollars?\\b)`;
const NUMBER = new RegExp(
  `(?<pre>${CURRENCY}\\s?)?(?<num>\\d{1,3}(?:[.,\\u202f ]\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?)\\s?(?<k>[kK])?(?!\\w)\\s?(?<post>${CURRENCY})?`,
  'giu',
);
/** An amount that is a salary by its shape alone: 2 or 3 digits then `k` or a group of thousands, with a currency: `65k€`, `€65.000`, `$120,000`. */
const THOUSANDS = '\\d{2,3}(?:[kK]|[.,\\u202f ]?\\d{3})';
const SALARY_SHAPE = new RegExp(`^(?:${CURRENCY}\\s?${THOUSANDS}|${THOUSANDS}\\s?${CURRENCY})$`, 'iu');

const RANGE_SEPARATOR = /^\s*(?:-|–|—|to|à|a)\s*$/i;
const SALARY_WORDS =
  /salary|salaire|r[ée]mun[ée]ration|remuneraci[oó]n|compensation|salario|\bpay\s*(?:range|:)|gross|\bbrut|bruto|\bOTE\b|package|\bfix(?:e|ed|a)\b|per (?:year|annum)|annual|par an|\/ ?an\b|annuel|anual/i;
/** Lines whose amounts are something else: meal vouchers, funding, valuation, revenue. */
const NOT_A_SALARY_LINE =
  /ticket|repas|restaurant|voucher|swile|edenred|lunch|meal|titres|d[ée]jeuner|almuerzo|equity|valuation|series [a-e]|raised|lev[ée]e|funding|revenue|\bARR\b|chiffre d'affaires/i;
/** What right after an amount says it is not a yearly salary: millions, per day, per month. */
const NOT_YEARLY_AFTER =
  /^\s*(?:m\b|million|millions|mn\b|bn\b|billion|\/\s?(?:day|jour|dia|month|mois)|per (?:day|month)|par (?:jour|mois)|a (?:day|month))/i;

const MIN_YEARLY = 15_000;
/** A variable part can be small next to the fixed one. */
const MIN_VARIABLE = 1_000;
const MAX_YEARLY = 1_000_000;
/** What follows an amount that makes it the variable part: `10k€ variable`, `10k€ of bonus`. */
const AMOUNT_THEN_VARIABLE = /^\s*(?:of\s+|de\s+)?(?:variable|bonus|commission|primes?)\b/i;
const VARIABLE = /(?:variable|bonus|\bOTE\b|commission|primes?)s?\b[^\d€$£¥₹]{0,40}/i;

function parseValue(num: string, thousands: boolean): number {
  const compact = num.replace(/\s/g, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(compact)) return Number(compact.replace(/[.,]/g, ''));
  const value = Number(compact.replace(',', '.'));
  return thousands ? value * 1000 : value;
}

function currencyOf(text: string | undefined): string | null {
  if (text === undefined) return null;
  const word = text.trim();
  if (word === '') return null;
  const symbol = SYMBOLS[word];
  if (symbol !== undefined) return symbol;
  if (/^euros?$/i.test(word)) return 'EUR';
  if (/^dollars?$/i.test(word)) return 'USD';
  return word.toUpperCase();
}

function amountsIn(line: string): Amount[] {
  return [...line.matchAll(NUMBER)].map((match) => {
    const groups = match.groups ?? {};
    const lead = match[0].length - match[0].trimStart().length;
    const raw = match[0].trim();
    return {
      start: match.index + lead,
      end: match.index + lead + raw.length,
      value: parseValue(groups['num'] ?? '0', groups['k'] !== undefined),
      thousands: groups['k'] !== undefined,
      currency: currencyOf(groups['post']) ?? currencyOf(groups['pre']),
      raw,
    };
  });
}

interface YearlyAmount {
  start: number;
  end: number;
  text: string;
  min: number;
  max: number;
  currency: string;
  /** Its shape alone says it is a salary (see SALARY_SHAPE). */
  shaped: boolean;
}

/** The yearly amounts of a line; a range is one amount. */
function yearlyAmounts(line: string, minimum = MIN_YEARLY): YearlyAmount[] {
  const amounts = amountsIn(line);
  const found: YearlyAmount[] = [];
  for (let i = 0; i < amounts.length; i++) {
    const current = amounts[i];
    if (current === undefined) continue;
    const next = amounts[i + 1];
    const joined = next !== undefined && next.currency !== null && RANGE_SEPARATOR.test(line.slice(current.end, next.start));
    const upper = joined && next !== undefined ? next : current;
    if (upper.currency === null) continue;
    if (NOT_YEARLY_AFTER.test(line.slice(upper.end))) continue;
    if (upper.value < minimum || upper.value > MAX_YEARLY) continue;
    // "55-65k€": the lower end is written without its k
    const min = joined && upper.thousands && !current.thousands && current.value < 1000 ? current.value * 1000 : current.value;
    found.push({
      start: current.start,
      end: upper.end,
      text: line.slice(current.start, upper.end).replace(/\s+/g, ' ').trim(),
      min: joined ? min : upper.value,
      max: upper.value,
      currency: upper.currency,
      shaped: SALARY_SHAPE.test(upper.raw),
    });
    if (joined) i += 1;
  }
  return found;
}

/** The variable part of a salary: `Variable adicional: 12.500€` (label first) or `10k€ variable` (amount first). */
function variablePart(rest: string): YearlyAmount | undefined {
  const label = VARIABLE.exec(rest);
  const labelled =
    label === null ? undefined : yearlyAmounts(rest.slice(label.index + label[0].length).split('\n')[0] ?? '', MIN_VARIABLE)[0];
  if (labelled !== undefined) return labelled;
  const first = rest.split('\n')[0] ?? '';
  return yearlyAmounts(first, MIN_VARIABLE).find((amount) => AMOUNT_THEN_VARIABLE.test(first.slice(amount.end)));
}

/**
 * The yearly salary a job text states, or null. An amount is a candidate when its line or the line before names a salary (salary,
 * salaire, rémunération, compensation, per year...), or when it has the shape of a salary on its own (2 or 3 digits then `k` or a
 * group of thousands, with a currency of any kind: `65k€`, `€65.000`, `$120,000`, `CHF 95k`). A candidate that sits next to a salary
 * word is preferred to one that only has the right shape, wherever it is in the text ("our clients pay 120k€ for the platform" comes
 * after "salary is 78.000€ per year"); among equals the first wins. Whatever the candidate, its line must not be about meal vouchers,
 * funding or revenue, and the figure must not be a million, a daily or a monthly one. A variable part next to the fixed one is added
 * (`26.400€ + variable 12.500€`).
 */
export function findSalaryRange(text: string): Salary | null {
  const lines = text.split('\n');
  let shapedOnly: Salary | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (NOT_A_SALARY_LINE.test(line)) continue;
    const named = SALARY_WORDS.test(`${lines[index - 1] ?? ''}\n${line}`);
    if (!named && shapedOnly !== null) continue;
    const amounts = yearlyAmounts(line);
    const fixed = (named ? amounts : amounts.filter((amount) => amount.shaped))[0];
    if (fixed === undefined) continue;
    const variable = variablePart(`${line.slice(fixed.end)}\n${lines[index + 1] ?? ''}`);
    const salary: Salary = {
      text: (variable === undefined ? fixed.text : `${fixed.text} + variable ${variable.text}`).slice(0, 80),
      min: fixed.min,
      max: fixed.max,
      currency: fixed.currency,
      variable: variable?.max ?? null,
    };
    if (named) return salary;
    shapedOnly = salary;
  }
  return shapedOnly;
}

/** The salary as the text it was written in (what the hints return), or null. */
export const findSalary = (text: string): string | null => findSalaryRange(text)?.text ?? null;

/**
 * A salary for a table cell: one value when the range is a single amount, else `72 000 – 115 000 €`; `+ 12 500 € variable` follows when
 * the text states one. Amounts are written with a thin space, the currency symbol after, the code when there is no symbol.
 */
export function formatSalary(salary: Pick<Salary, 'min' | 'max' | 'currency' | 'variable'>, locale = 'fr-FR'): string {
  const symbols: Record<string, string> = { EUR: '€', GBP: '£', USD: '$', JPY: '¥', INR: '₹' };
  const suffix = symbols[salary.currency] ?? salary.currency;
  const number = (value: number): string => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  const fixed = salary.min === salary.max ? `${number(salary.max)} ${suffix}` : `${number(salary.min)} – ${number(salary.max)} ${suffix}`;
  return salary.variable === null ? fixed : `${fixed} + ${number(salary.variable)} ${suffix} variable`;
}
