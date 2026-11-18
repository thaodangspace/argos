/**
 * Theme choice (spec FR16): dark by default, a persisted explicit choice wins, otherwise the OS
 * preference decides on first visit.
 */

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "argos:ui:theme";

/** `dark` unless the operator chose otherwise or the OS says light. */
export function preferredTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === "dark" || stored === "light") return stored;
  return prefersDark ? "dark" : "light";
}

/** Write the theme onto the document (`data-theme` drives the token file). */
export function applyTheme(theme: Theme, root?: HTMLElement | null): void {
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (target === null) return;
  target.dataset["theme"] = theme;
}

export class ThemeStore {
  theme = $state<Theme>("dark");

  init(): void {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    const prefersDark =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    this.theme = preferredTheme(stored, prefersDark);
    applyTheme(this.theme);
  }

  toggle(): Theme {
    this.theme = this.theme === "dark" ? "light" : "dark";
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, this.theme);
    }
    applyTheme(this.theme);
    return this.theme;
  }
}
