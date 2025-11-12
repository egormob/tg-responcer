const DEFAULT_MESSAGE_EN =
  "We're swamped with requests 😔 Please give us a few seconds and try again.";
const DEFAULT_MESSAGE_RU =
  'Перегружены запросами 😔 Дай нам пару секунд и попробуй ещё раз.';

const normalizeLanguageCode = (languageCode?: string): string | undefined => {
  if (typeof languageCode !== 'string') {
    return undefined;
  }

  const trimmed = languageCode.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const getFriendlyOverloadMessage = (languageCode?: string): string => {
  const normalized = normalizeLanguageCode(languageCode);

  if (!normalized) {
    return DEFAULT_MESSAGE_EN;
  }

  if (normalized.startsWith('ru')) {
    return DEFAULT_MESSAGE_RU;
  }

  if (normalized.startsWith('uk')) {
    return 'Перевантажені запитами 😔 Дайте нам кілька секунд і спробуйте ще раз.';
  }

  if (normalized.startsWith('be')) {
    return 'Перагружаны запытамі 😔 Дайце нам некалькі секунд і паспрабуйце яшчэ раз.';
  }

  return DEFAULT_MESSAGE_EN;
};
