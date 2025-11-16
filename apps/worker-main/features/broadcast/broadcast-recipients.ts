import type { BroadcastRecipient } from './minimal-broadcast-service';

export interface BroadcastRecipientsParserLogger {
  warn?(message: string, details?: Record<string, unknown>): void;
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeUsername = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim().replace(/^@+/, '');
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed.toLowerCase();
};

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    const text = String(value);
    return text.length > 0 ? text : undefined;
  }

  return undefined;
};

const parseDelimitedList = (value: string): string[] =>
  value
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const parseStringToken = (token: string): BroadcastRecipient | undefined => {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  for (const separator of ['=', ':']) {
    const index = trimmed.indexOf(separator);
    if (index > 0 && index < trimmed.length - 1) {
      const usernamePart = trimmed.slice(0, index);
      const chatIdPart = trimmed.slice(index + 1);
      const chatId = toNonEmptyString(chatIdPart);
      if (!chatId) {
        return undefined;
      }

      return {
        chatId,
        username: normalizeUsername(usernamePart),
      } satisfies BroadcastRecipient;
    }
  }

  return {
    chatId: trimmed,
  } satisfies BroadcastRecipient;
};

const toEntriesArray = (
  value: unknown,
  warn: (message: string, details?: Record<string, unknown>) => void,
): unknown[] => {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed;
      }

      if (isObjectRecord(parsed) || typeof parsed === 'string') {
        return [parsed];
      }

      if (typeof parsed === 'number' || typeof parsed === 'bigint') {
        return [String(parsed)];
      }

      warn('[broadcast] BROADCAST_RECIPIENTS JSON must be an array, string, or object', {
        value: trimmed,
      });
      return [];
    } catch (error) {
      warn('[broadcast] BROADCAST_RECIPIENTS is not valid JSON, falling back to delimited list', {
        error: error instanceof Error ? error.message : String(error),
      });

      return parseDelimitedList(trimmed);
    }
  }

  if (isObjectRecord(value)) {
    return [value];
  }

  const stringValue = toNonEmptyString(value);
  if (stringValue) {
    return [stringValue];
  }

  warn('[broadcast] BROADCAST_RECIPIENTS must be an array, string, or object', {
    valueType: typeof value,
  });

  return [];
};

const toRecipientFromRecord = (record: Record<string, unknown>): BroadcastRecipient | undefined => {
  const chatId = toNonEmptyString(record.chatId);
  if (!chatId) {
    return undefined;
  }

  const threadId = toNonEmptyString(record.threadId);
  const username = normalizeUsername(toNonEmptyString(record.username));

  return {
    chatId,
    threadId,
    username,
  } satisfies BroadcastRecipient;
};

export const parseBroadcastRecipients = (
  value: unknown,
  logger?: BroadcastRecipientsParserLogger,
): BroadcastRecipient[] => {
  const warn = logger?.warn?.bind(logger) ?? (() => {});
  const entries = toEntriesArray(value, warn);
  const recipients: BroadcastRecipient[] = [];
  const seen = new Map<string, number>();

  for (const entry of entries) {
    let recipient: BroadcastRecipient | undefined;

    if (typeof entry === 'string') {
      recipient = parseStringToken(entry);
    } else if (isObjectRecord(entry)) {
      recipient = toRecipientFromRecord(entry);
    } else if (typeof entry === 'number' || typeof entry === 'bigint') {
      recipient = parseStringToken(String(entry));
    }

    if (!recipient) {
      warn('[broadcast] skipping invalid broadcast recipient entry', {
        entry,
      });
      continue;
    }

    const key = `${recipient.chatId}:${recipient.threadId ?? ''}`;
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      const existing = recipients[existingIndex];
      if (!existing.username && recipient.username) {
        recipients[existingIndex] = {
          ...existing,
          username: recipient.username,
        } satisfies BroadcastRecipient;
      }
      continue;
    }

    seen.set(key, recipients.length);
    recipients.push(recipient);
  }

  return recipients;
};
