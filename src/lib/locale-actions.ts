'use server';

import { cookies } from 'next/headers';
import { LOCALE_COOKIE, isLocale } from '@/lib/locales';

/**
 * Persists the user's language choice as a cookie so the next request
 * (and every request after) resolves `next-intl`'s server-side
 * `getRequestConfig` (src/i18n/request.ts) to the new locale. The
 * caller (language-panel.tsx) follows this with `router.refresh()` to
 * re-render the current page's Server Components immediately.
 */
export async function setLocaleCookie(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
}
