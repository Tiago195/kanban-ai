import { useCallback, useEffect, useMemo, useState } from "react";

export const THEME_KEY = "kanban-ai-theme";
const THEME_CLASSES = ["dark", "high-contrast"] as const;

export type Theme = "light" | "dark" | "high-contrast";

const THEME_ORDER: Theme[] = ["light", "dark", "high-contrast"];

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "high-contrast";
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_KEY);
  if (isTheme(stored)) return stored;
  if (stored === "dark") return "dark";
  if (stored === "light") return "light";
  return "light";
}

function applyThemeClass(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove(...THEME_CLASSES);
  if (theme === "dark") root.classList.add("dark");
  if (theme === "high-contrast") root.classList.add("high-contrast");
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    applyThemeClass(theme);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_KEY, theme);
    }
  }, [theme]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_KEY) return;
      const next = isTheme(event.newValue) ? event.newValue : "light";
      setTheme(next);
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const cycleTheme = useCallback(() => {
    setTheme((prev) => {
      const index = THEME_ORDER.indexOf(prev);
      return THEME_ORDER[(index + 1) % THEME_ORDER.length];
    });
  }, []);

  const label = useMemo(() => {
    if (theme === "dark") return "Escuro";
    if (theme === "high-contrast") return "Alto contraste";
    return "Claro";
  }, [theme]);

  return { theme, setTheme, cycleTheme, label };
}
