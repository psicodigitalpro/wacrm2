import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from '@/lib/locales';

export default getRequestConfig(async () => {
  // The user's picked language (Settings → Language) is stored in a
  // cookie rather than localStorage — this runs server-side, and a
  // cookie is the only per-user choice readable at this point. Falls
  // back to the env var (whole-deployment default) then 'en'.
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieLocale)
    ? cookieLocale
    : process.env.NEXT_PUBLIC_APP_LOCALE || DEFAULT_LOCALE;

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch (error) {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages
  };
});
