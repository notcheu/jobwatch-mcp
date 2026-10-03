/** Compact number: 1234 -> 1.2k, 1_500_000 -> 1.5M. */
export function compact(value: number): string {
  if (Math.abs(value) < 1000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function duration(ms: number | null): string {
  if (ms === null) return '…';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** "3 min ago", "2 h ago", or the date for older. */
export function ago(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * A yearly salary for a cell, in the browser's own locale: one value for a fixed amount, `72 000 – 115 000 €` for a range, and
 * `+ 12 500 € variable` when the text states a variable part. The currency is written the way the locale writes it.
 */
export function formatSalary(salary: { min: number; max: number; currency: string; variable: number | null }, locale?: string): string {
  const money = (value: number): string => {
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency: salary.currency, maximumFractionDigits: 0 }).format(value);
    } catch {
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)} ${salary.currency}`;
    }
  };
  const fixed = salary.min === salary.max ? money(salary.max) : `${money(salary.min)} – ${money(salary.max)}`;
  return salary.variable === null ? fixed : `${fixed} + ${money(salary.variable)} variable`;
}
