export interface AdminAccessKvNamespace {
  get(key: string, type?: 'text'): Promise<string | null>;
}

export interface CreateAdminAccessOptions {
  kv: AdminAccessKvNamespace;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface AdminAccess {
  isAdmin(userId: string | number | bigint): Promise<boolean>;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const ADMIN_ACCESS_KEY = 'whitelist';

interface CachedWhitelist {
  ids: Set<string>;
  expiresAt: number;
}

const toCacheExpiry = (ttl: number, now: number) => (ttl === 0 ? now : now + ttl);

const normalizeUserId = (userId: string | number | bigint | undefined): string | undefined => {
  if (typeof userId === 'string') {
    const trimmed = userId.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof userId === 'number') {
    if (!Number.isFinite(userId) || !Number.isInteger(userId)) {
      return undefined;
    }

    return userId.toString();
  }

  if (typeof userId === 'bigint') {
    return userId.toString();
  }

  return undefined;
};

const parseWhitelist = (raw: string | null): string[] => {
  if (typeof raw !== 'string') {
    return [];
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    const data = JSON.parse(trimmed);
    const whitelist = (data as { whitelist?: unknown })?.whitelist;

    if (!Array.isArray(whitelist)) {
      return [];
    }

    const normalized = whitelist
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    return Array.from(new Set(normalized));
  } catch (error) {
    console.warn('[admin-access] failed to parse whitelist from KV', {
      error: error instanceof Error ? { name: error.name, message: error.message } : undefined,
    });
    return [];
  }
};

export const createAdminAccess = (options: CreateAdminAccessOptions): AdminAccess => {
  let cachedWhitelist: CachedWhitelist | undefined;
  const ttl = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  const now = options.now ?? (() => Date.now());

  const readWhitelist = async () => {
    const currentTime = now();
    if (cachedWhitelist && ttl > 0 && currentTime < cachedWhitelist.expiresAt) {
      return cachedWhitelist.ids;
    }

    try {
      const raw = await options.kv.get(ADMIN_ACCESS_KEY, 'text');
      const ids = new Set(parseWhitelist(raw));
      cachedWhitelist = {
        ids,
        expiresAt: toCacheExpiry(ttl, currentTime),
      };
      return ids;
    } catch (error) {
      console.warn('[admin-access] failed to read whitelist from KV', {
        error: error instanceof Error ? { name: error.name, message: error.message } : undefined,
      });
      cachedWhitelist = {
        ids: new Set(),
        expiresAt: toCacheExpiry(ttl, currentTime),
      };
      return cachedWhitelist.ids;
    }
  };

  return {
    async isAdmin(userId) {
      const normalizedUserId = normalizeUserId(userId);
      if (!normalizedUserId) {
        return false;
      }

      const whitelist = await readWhitelist();
      return whitelist.has(normalizedUserId);
    },
  };
};
