import { useSyncExternalStore } from "react";

// Apariencia: Claro (Mina Blue), Oscuro (Blue Neon) o Sistema. La preferencia se guarda en localStorage y se aplica a
// <html data-theme>. El script de index.html la aplica antes del primer pintado (sin parpadeo); este módulo mantiene
// el estado, reacciona al cambio de preferencia del dispositivo cuando se eligió Sistema y no recarga ni toca la sesión.
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "upmina:theme";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

function readStored(): ThemePreference {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* almacenamiento no disponible */
  }
  return "system";
}

function systemTheme(): ResolvedTheme {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

function apply(pref: ThemePreference) {
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", resolved === "dark");
}

let preference: ThemePreference = typeof window === "undefined" ? "system" : readStored();
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  apply(preference);
  if (typeof window.matchMedia === "function") {
    window
      .matchMedia("(prefers-color-scheme: light)")
      .addEventListener?.("change", () => {
        if (preference === "system") apply(preference);
        listeners.forEach((l) => l());
      });
  }
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* sin persistencia */
  }
  apply(next);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const pref = useSyncExternalStore(
    subscribe,
    () => preference,
    () => "system" as const,
  );
  return [pref, setThemePreference];
}
