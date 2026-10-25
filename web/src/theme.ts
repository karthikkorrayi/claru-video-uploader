import { useLayoutEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('cvu.theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  });
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('cvu.theme', theme);
    } catch {
      /* Theme still works without storage. */
    }
  }, [theme]);
  return {
    theme,
    toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
  };
}
