export type Locale = 'en' | 'de' | 'fr' | 'zh-CN' | 'zh-TW' | 'uk' | 'es' | 'pt-BR' | 'ko' | 'pl' | 'ja';

export const LOCALES = ['en', 'de', 'fr', 'zh-CN', 'zh-TW', 'uk', 'es', 'pt-BR', 'ko', 'pl', 'ja'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'zh-CN';

export const LOCALE_LABEL_KEYS: Record<Locale, 'common.language.english' | 'common.language.french' | 'common.language.simplifiedChinese' | 'common.language.traditionalChinese' | 'common.language.ukrainian' | 'common.language.spanish' | 'common.language.brazilianPortuguese' | 'common.language.korean' | 'common.language.polish' | 'common.language.german' | 'common.language.japanese'> = {
  en: 'common.language.english',
  fr: 'common.language.french',
  'zh-CN': 'common.language.simplifiedChinese',
  'zh-TW': 'common.language.traditionalChinese',
  uk: 'common.language.ukrainian',
  es: 'common.language.spanish',
  'pt-BR': 'common.language.brazilianPortuguese',
  ko: 'common.language.korean',
  pl: 'common.language.polish',
  de: 'common.language.german',
  ja: 'common.language.japanese',
};

export const LOCALE_STORAGE_KEY = 'grok-code.i18n.v1';
const LEGACY_LOCALE_STORAGE_KEY = 'openchamber.i18n.v1';

type StoredLocale = {
  locale?: unknown;
};

export function normalizeLocale(value: string | undefined | null): Locale {
  if (!value) {
    return DEFAULT_LOCALE;
  }

  const normalized = value.toLowerCase().replace(/_/g, '-');
  if (normalized === 'zh-cn' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) {
    return 'zh-CN';
  }
  if (normalized === 'zh-tw' || normalized === 'zh-hant' || normalized.startsWith('zh-hant-')) {
    return 'zh-TW';
  }
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalized.startsWith('en')) {
    return 'en';
  }
  if (normalized === 'fr' || normalized.startsWith('fr-')) {
    return 'fr';
  }
  if (normalized === 'uk' || normalized.startsWith('uk-') || normalized === 'ua' || normalized.startsWith('ua-')) {
    return 'uk';
  }
  if (normalized === 'es' || normalized.startsWith('es-')) {
    return 'es';
  }
  if (normalized === 'pt' || normalized === 'pt-br' || normalized.startsWith('pt-br-')) {
    return 'pt-BR';
  }
  if (normalized === 'ko' || normalized.startsWith('ko-')) {
    return 'ko';
  }
  if (normalized === 'ja' || normalized.startsWith('ja-')) {
    return 'ja';
  }
  if (normalized === 'de' || normalized.startsWith('de-')) {
    return 'de';
  }
  if (normalized === 'pl' || normalized.startsWith('pl-')) {
    return 'pl';
  }
  return DEFAULT_LOCALE;
}

function readStoredLocale(): Locale | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredLocale;
      return typeof parsed.locale === 'string' ? normalizeLocale(parsed.locale) : undefined;
    }

    // The upstream app wrote English on first launch even when the user never
    // selected it. Preserve an explicit non-English legacy choice, but let the
    // Grok Code fork start in Simplified Chinese by default.
    const legacyRaw = window.localStorage.getItem(LEGACY_LOCALE_STORAGE_KEY);
    if (!legacyRaw) {
      return undefined;
    }
    const legacy = JSON.parse(legacyRaw) as StoredLocale;
    if (typeof legacy.locale !== 'string') {
      return undefined;
    }
    const locale = normalizeLocale(legacy.locale);
    return locale === 'en' ? undefined : locale;
  } catch {
    return undefined;
  }
}

export function writeStoredLocale(locale: Locale): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify({ locale }));
  } catch {
    return;
  }
}

export function detectInitialLocale(): Locale {
  const stored = readStoredLocale();
  if (stored) {
    return stored;
  }

  return DEFAULT_LOCALE;
}
