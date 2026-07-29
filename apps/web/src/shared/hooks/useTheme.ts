import { useState } from 'react';

export type Theme = 'light' | 'dark';

/** Placeholder de tema. Alterna a classe `dark` na raiz (implementação completa virá depois). */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>('light');
  const toggle = () => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  return { theme, toggle };
}
