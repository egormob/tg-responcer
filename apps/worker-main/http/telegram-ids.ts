export const toTelegramIdString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error('UNSAFE_TELEGRAM_ID');
    }

    return value.toString(10);
  }

  if (typeof value === 'bigint') {
    return value.toString(10);
  }

  return undefined;
};
