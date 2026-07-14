"use client";

import { useTransition } from "react";
import { Check, Globe, Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { LOCALE_META, type Locale } from "@/lib/locales";
import { setLocaleCookie } from "@/lib/locale-actions";
import { cn } from "@/lib/utils";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Language panel — picks the UI locale.
 *
 * Unlike Appearance (a pure client-side CSS attribute), the chosen
 * locale has to reach the server: `next-intl` resolves `messages/*.json`
 * inside `getRequestConfig` (src/i18n/request.ts), which runs before
 * any Client Component mounts. So picking a language here calls a
 * Server Action that sets a cookie, then `router.refresh()` re-runs
 * the current page's Server Components (including the root layout)
 * against the new locale — no full navigation needed.
 */
export function LanguagePanel() {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("Settings.language");
  const [isPending, startTransition] = useTransition();

  function pick(next: Locale) {
    if (next === locale) return;
    startTransition(async () => {
      await setLocaleCookie(next);
      router.refresh();
    });
  }

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Globe className="size-4 text-muted-foreground" />
          {t("language")}
        </h3>

        <div
          role="radiogroup"
          aria-label={t("language")}
          className="grid max-w-md grid-cols-1 gap-3 sm:grid-cols-2"
        >
          {LOCALE_META.map((l) => (
            <LanguageCard
              key={l.id}
              name={l.name}
              nativeName={l.nativeName}
              isActive={l.id === locale}
              disabled={isPending}
              onPick={() => pick(l.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function LanguageCard({
  name,
  nativeName,
  isActive,
  disabled,
  onPick,
}: {
  name: string;
  nativeName: string;
  isActive: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const t = useTranslations("Settings.language");
  return (
    <button
      type="button"
      role="radio"
      onClick={onPick}
      disabled={disabled}
      aria-checked={isActive}
      aria-label={t("useLanguage", { name })}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors disabled:opacity-60",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
      >
        <Languages className="h-4 w-4" />
      </span>
      <span className="flex-1">
        <span className="block text-sm font-semibold text-foreground">
          {nativeName}
        </span>
        {nativeName !== name && (
          <span className="block text-xs text-muted-foreground">{name}</span>
        )}
      </span>
      {isActive && (
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
          <Check className="h-3 w-3" />
          {t("active")}
        </span>
      )}
    </button>
  );
}
