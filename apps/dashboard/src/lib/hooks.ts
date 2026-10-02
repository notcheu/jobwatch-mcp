import { useEffect, useState } from 'react';

/** The value, but only after it stopped changing for `ms`: a search box that waits for the typist. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Only a web address that is safe to open from the dashboard: https, nothing else (no javascript: or data: links). */
export const safeHttpsUrl = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
};
