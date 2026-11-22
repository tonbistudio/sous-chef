import { useSyncExternalStore } from "react";
import { local } from "./storage";

export type Theme = "dark" | "light";
const KEY = "sous.theme";
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return local.get(KEY) === "light" ? "light" : "dark";
}

/** Puts the theme on the page. Called before the first render so there is no flash of the other one. */
export function applyTheme(t: Theme = getTheme()): void {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", t);
}

export function setTheme(t: Theme): void {
  local.set(KEY, t);
  applyTheme(t);
  for (const fn of listeners) fn();
}

export function useTheme(): [Theme, () => void] {
  const t = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, getTheme);
  return [t, () => setTheme(t === "dark" ? "light" : "dark")];
}
