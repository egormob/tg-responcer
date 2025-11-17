import type { BroadcastAudienceFilter } from './broadcast-payload';
import type { BroadcastRecipient } from './minimal-broadcast-service';

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface BroadcastRecipientRecord {
  chatId: string;
  username?: string;
  languageCode?: string;
  createdAt: Date;
  activeFlag: boolean;
}

export interface BroadcastRecipientUpsertInput {
  chatId: string;
  username?: string;
  languageCode?: string;
}

export interface BroadcastRecipientsStoreSampleOptions {
  usernames?: readonly string[];
  userIds?: readonly string[];
  limit?: number;
}

export interface BroadcastRecipientsStore {
  listActiveRecipients(filter?: BroadcastAudienceFilter): Promise<BroadcastRecipient[]>;
  listActiveRecords(): Promise<BroadcastRecipientRecord[]>;
  listSample(options?: BroadcastRecipientsStoreSampleOptions): Promise<{
    items: BroadcastRecipient[];
    count: number;
  }>;
  upsertRecipient(input: BroadcastRecipientUpsertInput): Promise<void>;
  deactivateRecipient(chatId: string): Promise<void>;
}

export interface CreateBroadcastRecipientsStoreOptions {
  db: D1Database;
  cache?: KVNamespace;
  cacheKey?: string;
  cacheTtlMs?: number;
  logger?: Logger;
  now?: () => Date;
}

interface BroadcastRecipientRow {
  chatId: string | number;
  username: string | null;
  languageCode: string | null;
  createdAt: number | string | null;
  isBot: number | null;
}

const CACHE_VERSION = 1;
const DEFAULT_CACHE_KEY = 'broadcast:recipients:active';

interface CachePayload {
  version: number;
  recipients: BroadcastRecipient[];
  refreshedAt: string;
}

const normalizeChatId = (value: string): string => value.trim();

const normalizeUsername = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().replace(/^@+/, '');
  return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
};

const normalizeLanguageCode = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeList = (values: readonly string[] | undefined): string[] | undefined => {
  if (!values) {
    return undefined;
  }

  const normalized = values
    .map((value) => value.trim())
    .map((value) => (value.startsWith('@') ? value.slice(1) : value))
    .map((value) => value.toLowerCase())
    .filter((value) => value.length > 0);

  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
};

const toDate = (value: number | string | null | undefined, fallback: Date): Date => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000);
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return fallback;
};

const mapRowToRecord = (row: BroadcastRecipientRow, now: Date): BroadcastRecipientRecord => ({
  chatId: normalizeChatId(String(row.chatId)),
  username: normalizeUsername(row.username ?? undefined),
  languageCode: normalizeLanguageCode(row.languageCode ?? undefined),
  createdAt: toDate(row.createdAt, now),
  activeFlag: true,
});

const toRecipient = (record: BroadcastRecipientRecord): BroadcastRecipient => ({
  chatId: record.chatId,
  username: record.username,
  languageCode: record.languageCode,
});

const serializeCachePayload = (payload: CachePayload): string => JSON.stringify(payload);

const parseCachePayload = (raw: string | null): CachePayload | undefined => {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as CachePayload;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.recipients)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
};

const deduplicateRecipients = (recipients: BroadcastRecipient[]): BroadcastRecipient[] => {
  const seen = new Map<string, number>();
  const result: BroadcastRecipient[] = [];

  for (const recipient of recipients) {
    const key = `${recipient.chatId}`;
    const existingIndex = seen.get(key);

    if (existingIndex !== undefined) {
      const existing = result[existingIndex];
      if (!existing.username && recipient.username) {
        result[existingIndex] = { ...existing, username: recipient.username };
      }

      if (!existing.languageCode && recipient.languageCode) {
        result[existingIndex] = { ...existing, languageCode: recipient.languageCode };
      }

      continue;
    }

    seen.set(key, result.length);
    result.push(recipient);
  }

  return result;
};

const buildRecipientsWhereClause = (filters?: BroadcastRecipientsStoreSampleOptions) => {
  const usernames = normalizeList(filters?.usernames);
  const userIds = normalizeList(filters?.userIds);

  const clauses = [
    'm.chat_id IS NOT NULL',
    "TRIM(m.chat_id) != ''",
    'COALESCE(json_extract(u.metadata, "$.isBot"), 0) = 0',
  ];
  const bindings: unknown[] = [];

  if (usernames?.length) {
    clauses.push(`LOWER(u.username) IN (${usernames.map(() => '?').join(', ')})`);
    bindings.push(...usernames);
  }

  if (userIds?.length) {
    clauses.push(`u.user_id IN (${userIds.map(() => '?').join(', ')})`);
    bindings.push(...userIds);
  }

  const whereClause = clauses.map((clause, index) => `${index === 0 ? 'WHERE' : '  AND'} ${clause}`).join('\n');

  return { whereClause, bindings };
};

const mapRowsToRecords = (
  rows: BroadcastRecipientRow[],
  now: Date,
): BroadcastRecipientRecord[] => rows.map((row) => mapRowToRecord(row, now));

export const createBroadcastRecipientsStore = (
  options: CreateBroadcastRecipientsStoreOptions,
): BroadcastRecipientsStore => {
  const cacheKey = options.cacheKey ?? DEFAULT_CACHE_KEY;
  const cacheTtlSeconds = options.cacheTtlMs ? Math.max(1, Math.floor(options.cacheTtlMs / 1000)) : undefined;
  const now = options.now ?? (() => new Date());

  const queryRecipients = async (
    filters?: BroadcastRecipientsStoreSampleOptions,
    limit?: number,
  ): Promise<{ records: BroadcastRecipientRecord[]; count: number }> => {
    const { whereClause, bindings } = buildRecipientsWhereClause(filters);
    const limitClause = limit && Number.isFinite(limit) && limit > 0 ? 'LIMIT ?' : '';

    const selectSql = `
      SELECT
        m.chat_id AS chatId,
        MIN(m.timestamp) AS createdAt,
        LOWER(NULLIF(u.username, '')) AS username,
        LOWER(NULLIF(u.language_code, '')) AS languageCode,
        MAX(COALESCE(json_extract(u.metadata, "$.isBot"), 0)) AS isBot
      FROM messages m
      LEFT JOIN users u ON u.user_id = m.user_id
      ${whereClause}
      GROUP BY m.chat_id
      ORDER BY MIN(m.timestamp) ASC
      ${limitClause};
    `;

    const countSql = `
      SELECT COUNT(DISTINCT m.chat_id) AS total
      FROM messages m
      LEFT JOIN users u ON u.user_id = m.user_id
      ${whereClause};
    `;

    const selectStatement = options.db.prepare(selectSql);
    const countStatement = options.db.prepare(countSql);

    const selectBindings = limitClause ? [...bindings, limit] : bindings;

    try {
      const { results } = await selectStatement.bind(...selectBindings).all<BroadcastRecipientRow>();
      const countResult = await countStatement.bind(...bindings).all<{ total: number | string | null }>();
      const total = countResult.results[0]?.total ?? 0;
      const currentTime = now();

      const records = mapRowsToRecords(results, currentTime).filter((record) => record.chatId.length > 0);
      return { records, count: typeof total === 'string' ? Number(total) : Number(total) };
    } catch (error) {
      options.logger?.error?.('failed to read broadcast recipients from d1', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const readActiveRecipients = async (): Promise<BroadcastRecipient[]> => {
    if (options.cache) {
      const cached = parseCachePayload(await options.cache.get(cacheKey));
      if (cached) {
        return deduplicateRecipients(cached.recipients);
      }
    }

    const { records } = await queryRecipients();
    const recipients = records.map(toRecipient);

    if (options.cache) {
      const payload: CachePayload = {
        version: CACHE_VERSION,
        recipients,
        refreshedAt: now().toISOString(),
      };

      try {
        await options.cache.put(cacheKey, serializeCachePayload(payload), {
          expirationTtl: cacheTtlSeconds,
        });
      } catch (error) {
        options.logger?.warn?.('failed to update broadcast recipients cache', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return deduplicateRecipients(recipients);
  };

  const invalidateCache = async () => {
    if (!options.cache) {
      return;
    }

    try {
      await options.cache.delete(cacheKey);
    } catch (error) {
      options.logger?.warn?.('failed to invalidate broadcast recipients cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    async listActiveRecipients(filter) {
      const recipients = await readActiveRecipients();

      if (!filter || (!filter.chatIds && !filter.userIds)) {
        return recipients;
      }

      const chatIds = filter.chatIds ? new Set(filter.chatIds.map((id) => id.trim())) : undefined;
      const userIds = filter.userIds ? new Set(filter.userIds.map((id) => id.trim())) : undefined;

      return recipients.filter((recipient) => {
        if (chatIds && !chatIds.has(recipient.chatId)) {
          return false;
        }

        if (userIds && !userIds.has(recipient.chatId)) {
          return false;
        }

        return true;
      });
    },
    async listActiveRecords() {
      const { records } = await queryRecipients();
      return records;
    },
    async listSample(options) {
      const { records, count } = await queryRecipients({
        usernames: options?.usernames,
        userIds: options?.userIds,
        limit: options?.limit,
      }, options?.limit);

      return { items: records.map(toRecipient), count };
    },
    async upsertRecipient(input) {
      options.logger?.warn?.('upsert recipient ignored for derived registry', {
        chatId: normalizeChatId(input.chatId),
      });
      await invalidateCache();
    },
    async deactivateRecipient(chatIdInput) {
      options.logger?.warn?.('deactivate recipient ignored for derived registry', {
        chatId: normalizeChatId(chatIdInput),
      });
      await invalidateCache();
    },
  } satisfies BroadcastRecipientsStore;
};

export type { D1Database };
