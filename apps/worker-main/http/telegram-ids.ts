import { createHash } from 'node:crypto';

const TELEGRAM_ID_HASH_PREFIX_LENGTH = 12;

export const toTelegramIdString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'bigint') {
    return value.toString(10);
  }

  if (typeof value === 'number') {
    throw new Error('UNSAFE_TELEGRAM_ID');
  }

  return undefined;
};

const hashTelegramId = (id: string): string =>
  createHash('sha256').update(id).digest('hex').slice(0, TELEGRAM_ID_HASH_PREFIX_LENGTH);

export const describeTelegramIdForLogs = (
  value: unknown,
): { value: string; length: number; hash: string } | undefined => {
  const asString = toTelegramIdString(value);
  if (!asString) {
    return undefined;
  }

  return {
    value: asString,
    length: asString.length,
    hash: hashTelegramId(asString),
  };
};

export const applyTelegramIdLogFields = <T extends Record<string, unknown>>(
  target: T,
  field: string,
  value: unknown,
): T => {
  const described = describeTelegramIdForLogs(value);
  if (!described) {
    return target;
  }

  target[field] = described.value;
  target[`${field}Length`] = described.length;
  target[`${field}Hash`] = described.hash;
  return target;
};
