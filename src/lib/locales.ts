/**
 * Single source of truth for the supported UI-language catalog.
 *
 * Unlike the color theme (a pure client-side CSS attribute), locale
 * drives which `messages/<locale>.json` dictionary `next-intl` loads
 * server-side (see `src/i18n/request.ts`) — so the chosen locale is
 * carried in a cookie (readable on both server and client) rather
 * than localStorage, avoiding a server/client render mismatch.
 *
 * Adding a language is a two-step change:
 *   1. Add `messages/<locale>.json` with the same key structure as
 *      `messages/en.json`.
 *   2. Add an entry below. The order here drives the picker grid.
 */

export const LOCALES = ["en", "pt"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Cookie name the locale is persisted under — read by src/i18n/request.ts. */
export const LOCALE_COOKIE = "wacrm.locale";

export interface LocaleMeta {
  id: Locale;
  name: string;
  /** Shown alongside `name` in the picker (the language's own name for itself). */
  nativeName: string;
}

export const LOCALE_META: ReadonlyArray<LocaleMeta> = [
  { id: "en", name: "English", nativeName: "English" },
  { id: "pt", name: "Portuguese", nativeName: "Português" },
];

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as ReadonlyArray<string>).includes(value)
  );
}
