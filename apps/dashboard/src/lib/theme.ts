import { useEffect, useState } from 'react';

/** The dark theme is the default; the choice is kept in this browser and applied as a class on <html>. */
export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => localStorage.getItem('jw-theme') !== 'light');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('jw-theme', dark ? 'dark' : 'light');
  }, [dark]);
  return [dark, () => setDark((value) => !value)];
}
