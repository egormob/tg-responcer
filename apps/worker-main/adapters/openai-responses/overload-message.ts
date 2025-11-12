const DEFAULT_MESSAGE_EN =
  'The assistant is a bit overloaded right now. Please try again in a moment.';
const DEFAULT_MESSAGE_RU =
  'Ассистент перегружен. Попробуйте ещё раз через минуту.';

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
    return 'Асистент перевантажений. Спробуйте ще раз згодом.';
  }

  if (normalized.startsWith('be')) {
    return 'Памочнік перагружаны. Калі ласка, паспрабуйце пазней.';
  }

  return DEFAULT_MESSAGE_EN;
};
