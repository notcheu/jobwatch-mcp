/** One amount found in a line: `€72.000`, `26.400€`, `65k€`, or the lower end of `55 - 65k€`. */
interface Amount {
  start: number;
  end: number;
  /** The amount in currency units (a `k` multiplies by 1000). */
  value: number;
  hasCurrency: boolean;
}

const NUMBER =
  /(?<pre>[€£$])?\s?(?<num>\d{1,3}(?:[.,\u202f ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s?(?<k>[kK])?(?!\w)\s?(?<post>€|EUR\b|euros?\b|£|GBP\b|\$|USD\b)?/gu;
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

function parseValue(num: string, thousands: boolean): number {
  const compact = num.replace(/\s/g, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(compact)) return Number(compact.replace(/[.,]/g, ''));
  const value = Number(compact.replace(',', '.'));
  return thousands ? value * 1000 : value;
}

function amountsIn(line: string): Amount[] {
  return [...line.matchAll(NUMBER)].map((match) => {
    const groups = match.groups ?? {};
    const start = match.index + (match[0].length - match[0].trimStart().length);
    return {
      start,
      end: match.index + match[0].trimEnd().length,
      value: parseValue(groups['num'] ?? '0', groups['k'] !== undefined),
      hasCurrency: groups['pre'] !== undefined || groups['post'] !== undefined,
    };
  });
}

/** The yearly amounts of a line, each as the text to show (a range is one amount) and its upper value. */
function yearlyAmounts(line: string, minimum = MIN_YEARLY): { start: number; end: number; text: string; value: number }[] {
  const amounts = amountsIn(line);
  const found: { start: number; end: number; text: string; value: number }[] = [];
  for (let i = 0; i < amounts.length; i++) {
    const current = amounts[i];
    if (current === undefined) continue;
    const next = amounts[i + 1];
    const joined = next !== undefined && next.hasCurrency && RANGE_SEPARATOR.test(line.slice(current.end, next.start));
    const upper = joined && next !== undefined ? next : current;
    if (!current.hasCurrency && !joined) continue;
    if (NOT_YEARLY_AFTER.test(line.slice(upper.end))) continue;
    if (upper.value < minimum || upper.value > MAX_YEARLY) continue;
    found.push({
      start: current.start,
      end: upper.end,
      text: line.slice(current.start, upper.end).replace(/\s+/g, ' ').trim(),
      value: upper.value,
    });
    if (joined) i += 1;
  }
  return found;
}

const VARIABLE = /(?:variable|bonus|\bOTE\b|commission|primes?)s?\b[^\d€$£]{0,40}/i;

/**
 * The yearly salary a job text states, as it is written (`€72.000 - €115.000`), or null. An amount counts only when its line or the
 * line before names a salary (salary, salaire, rémunération, compensation, per year...), the line is not about meal vouchers, funding or
 * revenue, and it is not a million, a daily or a monthly figure. A variable part that follows the fixed one is added
 * (`26.400€ + variable 12.500€`).
 */
export function findSalary(text: string): string | null {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const context = `${lines[index - 1] ?? ''}\n${line}`;
    if (!SALARY_WORDS.test(context) || NOT_A_SALARY_LINE.test(line)) continue;
    const [fixed] = yearlyAmounts(line);
    if (fixed === undefined) continue;
    const rest = `${line.slice(fixed.end)}\n${lines[index + 1] ?? ''}`;
    const label = VARIABLE.exec(rest);
    const variable =
      label === null ? undefined : yearlyAmounts(rest.slice(label.index + label[0].length).split('\n')[0] ?? '', MIN_VARIABLE)[0];
    return (variable === undefined ? fixed.text : `${fixed.text} + variable ${variable.text}`).slice(0, 80);
  }
  return null;
}
