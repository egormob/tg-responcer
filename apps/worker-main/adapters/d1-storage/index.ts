import type { StoragePort, StoredMessage, UserProfile } from '../../ports';

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = D1Result>(): Promise<T>;
  first<T = unknown>(mode?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1Result {
  success: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface D1StorageAdapterOptions {
  db: D1Database;
  logger?: {
    warn(message: string, details?: Record<string, unknown>): void;
  };
}

const NOOP_LOGGER = {
  warn: (message: string, details?: Record<string, unknown>) => {
    console.warn(message, details);
  },
};

const UPSERT_USER_SQL = `
  INSERT INTO users (
    user_id,
    username,
    first_name,
    last_name,
    language_code,
    metadata,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    username = excluded.username,
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    language_code = excluded.language_code,
    metadata = excluded.metadata,
    updated_at = excluded.updated_at;
`;

const CHECK_MESSAGE_DUPLICATE_SQL = `
  SELECT id FROM messages
  WHERE user_id = ? AND metadata = ?
  LIMIT 1;
`;

const INSERT_MESSAGE_SQL = `
  INSERT INTO messages (
    user_id,
    chat_id,
    thread_id,
    role,
    text,
    timestamp,
    metadata
  ) VALUES (?, ?, ?, ?, ?, ?, ?);
`;

interface MessageRow {
  user_id: string;
  chat_id: string;
  thread_id: string | null;
  role: string;
  text: string;
  timestamp: string;
  metadata: string | null;
}

const SELECT_RECENT_MESSAGES_SQL = `
  SELECT
    user_id,
    chat_id,
    thread_id,
    role,
    text,
    timestamp,
    metadata
  FROM messages
  WHERE user_id = ?
  ORDER BY timestamp DESC, id DESC
  LIMIT ?;
`;

const toNullableString = (value: string | undefined | null): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const sanitizeBigInt = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === '[object Object]';

const sortJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(sortJsonValue) as JsonValue;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, JsonValue>>((acc, key) => {
        if (value[key] === undefined) {
          return acc;
        }

        const sortedChild = sortJsonValue(value[key]);
        acc[key] = sortedChild;
        return acc;
      }, {}) as JsonValue;
  }

  return String(value);
};

const serializeMetadata = (metadata?: Record<string, unknown>): string | null => {
  if (!metadata) {
    return null;
  }

  const sorted = sortJsonValue(metadata);

  try {
    return JSON.stringify(sorted, sanitizeBigInt);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[d1-storage] failed to serialize metadata', { error });
    return null;
  }
};

const parseMetadata = (raw: unknown): Record<string, unknown> | undefined => {
  if (typeof raw !== 'string') {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[d1-storage] failed to parse metadata', { error });
  }

  return undefined;
};

const toIsoString = (date: Date): string => {
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return new Date().toISOString();
  }
  return new Date(time).toISOString();
};

const toTimestampDate = (value: string): Date => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return new Date();
  }

  return date;
};

const mapRowToStoredMessage = (row: MessageRow): StoredMessage => ({
  userId: row.user_id,
  chatId: row.chat_id,
  threadId: row.thread_id ?? undefined,
  role: row.role as StoredMessage['role'],
  text: row.text,
  timestamp: toTimestampDate(row.timestamp),
  metadata: parseMetadata(row.metadata),
});

export const createD1StorageAdapter = (options: D1StorageAdapterOptions): StoragePort => {
  const logger = options.logger ?? NOOP_LOGGER;

  return {
    async saveUser(input: UserProfile & { updatedAt: Date }) {
      const metadataText = serializeMetadata(input.metadata);

      await options.db
        .prepare(UPSERT_USER_SQL)
        .bind(
          input.userId,
          toNullableString(input.username),
          toNullableString(input.firstName),
          toNullableString(input.lastName),
          toNullableString(input.languageCode),
          metadataText,
          toIsoString(input.updatedAt),
        )
        .run();
    },

    async appendMessage(message) {
      const metadataText = serializeMetadata(message.metadata);

      if (metadataText) {
        const existing = await options.db
          .prepare(CHECK_MESSAGE_DUPLICATE_SQL)
          .bind(message.userId, metadataText)
          .first<{ id: number }>();

        if (existing) {
          return;
        }
      }

      await options.db
        .prepare(INSERT_MESSAGE_SQL)
        .bind(
          message.userId,
          message.chatId,
          toNullableString(message.threadId),
          message.role,
          message.text,
          toIsoString(message.timestamp),
          metadataText,
        )
        .run();
    },

    async getRecentMessages({ userId, limit }) {
      try {
        const { results } = await options.db
          .prepare(SELECT_RECENT_MESSAGES_SQL)
          .bind(userId, limit)
          .all<MessageRow>();

        return results.map(mapRowToStoredMessage).reverse();
      } catch (error) {
        logger.warn('[d1-storage] failed to load recent messages', {
          userId,
          limit,
          error: error instanceof Error ? error.message : String(error),
        });

        return [];
      }
    },
  };
};
