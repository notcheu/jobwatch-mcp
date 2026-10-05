import { z } from 'zod';
import { JobwatchError } from './errors';
import { findSalaryRange } from './salary';

/** The salary floor of a search, the same on every platform that reads job text. There is no built-in amount or currency. */
export const salaryFilterFields = {
  min_salary: z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .default(0)
    .describe(
      'Yearly salary floor in whole currency units (e.g. 70000), 0 for none. A job whose stated salary is in salary_currency and whose upper end is below it is dropped after its text is read (stored, not returned). A job that states no salary, or one in another currency, is kept.',
    ),
  salary_currency: z
    .string()
    .trim()
    .length(3)
    .optional()
    .describe('ISO 4217 code of min_salary, e.g. "EUR", "USD", "GBP". Required when min_salary is above 0.'),
};

/**
 * Returns the stated salary (as written) when it is below the floor, else null. Null as well for a text with no salary or a salary in
 * another currency, so such jobs are kept. The function itself is null when there is no floor.
 */
export function salaryFloor(args: { min_salary: number; salary_currency?: string | undefined }): ((text: string) => string | null) | null {
  if (args.min_salary <= 0) return null;
  if (args.salary_currency === undefined)
    throw new JobwatchError('invalid_arguments', 'salary_currency is required with min_salary (an ISO code such as "EUR" or "USD").');
  const currency = args.salary_currency.toUpperCase();
  return (text) => {
    const salary = findSalaryRange(text);
    return salary !== null && salary.currency === currency && salary.max < args.min_salary ? salary.text : null;
  };
}
