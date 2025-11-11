import { describe, expect, it, beforeEach, vi } from 'vitest';

import { createD1StorageAdapter, type D1Database, UTM_COLUMN_RECHECK_INTERVAL } from '..';

interface StoredUserRow {
  userId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  utmSource: string | null;
  metadata: string | null;
  updatedAt: string;
}

interface StoredMessageRow {
  id: number;
  userId: string;
  chatId: string;
  threadId: string | null;
  role: string;
  text: string;
  timestamp: string;
  metadata: string | null;
}

interface TestDatabaseOptions {
  failOnRecentMessages?: boolean;
  hasUtmColumn?: boolean;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = unknown>(): Promise<T>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

class InMemoryStatement implements D1PreparedStatement {
  private params: unknown[] = [];

  constructor(private readonly query: string, private readonly db: InMemoryD1Database) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.params = values;
    return this;
  }

  async run<T = unknown>(): Promise<T> {
    return this.db.executeRun<T>(this.query, this.params);
  }

  async first<T = unknown>(): Promise<T | null> {
    const { results } = await this.all<T>();
    return results[0] ?? null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return this.db.executeAll<T>(this.query, this.params);
  }
}

class InMemoryD1Database implements D1Database {
  private readonly users = new Map<string, StoredUserRow>();
  private readonly messages: StoredMessageRow[] = [];
  private nextMessageId = 1;
  private readonly executedUserQueries: string[] = [];

  private hasUtmColumn: boolean;

  constructor(private readonly options: TestDatabaseOptions = {}) {
    this.hasUtmColumn = options.hasUtmColumn !== false;
  }

  prepare(query: string): D1PreparedStatement {
    return new InMemoryStatement(query.trim(), this);
  }

  executeRun<T>(query: string, params: unknown[]): Promise<T> {
    if (query.startsWith('INSERT INTO users')) {
      this.executedUserQueries.push(query);

      if (!this.hasUtmColumn && query.includes('utm_source')) {
        return Promise.reject(new Error('no such column: utm_source'));
      }

      if (query.includes('utm_source')) {
        this.upsertUserWithUtmColumn(params);
      } else {
        this.upsertUserWithoutUtmColumn(params);
      }

      return Promise.resolve({ success: true } as unknown as T);
    }

    if (query.startsWith('INSERT INTO messages')) {
      this.insertMessage(params);
      return Promise.resolve({ success: true } as unknown as T);
    }

    throw new Error(`Unsupported run query: ${query}`);
  }

  executeAll<T>(query: string, params: unknown[]): Promise<{ results: T[] }> {
    if (query.startsWith('SELECT id FROM messages')) {
      const [userId, metadata] = params as [string, string | null];
      const existing = this.messages.find(
        (message) => message.userId === userId && message.metadata === metadata,
      );

      if (!existing) {
        return Promise.resolve({ results: [] });
      }

      return Promise.resolve({ results: [{ id: existing.id } as unknown as T] });
    }

    if (query.startsWith('SELECT') && query.includes('FROM messages') && query.includes('ORDER BY timestamp DESC')) {
      if (this.options.failOnRecentMessages) {
        return Promise.reject(new Error('Simulated recent messages failure'));
      }

      const [userId, limitRaw] = params as [string, number];
      const limit = typeof limitRaw === 'number' ? limitRaw : Number(limitRaw);

      const results = this.messages
        .filter((message) => message.userId === userId)
        .sort((a, b) => {
          if (a.timestamp === b.timestamp) {
            return b.id - a.id;
          }

          return a.timestamp < b.timestamp ? 1 : -1;
        })
        .slice(0, limit)
        .map((message) => ({
          user_id: message.userId,
          chat_id: message.chatId,
          thread_id: message.threadId,
          role: message.role,
          text: message.text,
          timestamp: message.timestamp,
          metadata: message.metadata,
        })) as unknown as T[];

      return Promise.resolve({ results });
    }

    if (query.toUpperCase().startsWith('PRAGMA TABLE_INFO')) {
      const columns: Array<{ name: string }> = [
        { name: 'user_id' },
        { name: 'username' },
        { name: 'first_name' },
        { name: 'last_name' },
        { name: 'language_code' },
        { name: 'metadata' },
        { name: 'updated_at' },
      ];

      if (this.hasUtmColumn) {
        columns.splice(5, 0, { name: 'utm_source' });
      }

      return Promise.resolve({ results: columns as unknown as T[] });
    }

    throw new Error(`Unsupported all query: ${query}`);
  }

  setHasUtmColumn(hasColumn: boolean) {
    this.hasUtmColumn = hasColumn;
  }

  getUser(userId: string): StoredUserRow | undefined {
    return this.users.get(userId);
  }

  getMessages(): StoredMessageRow[] {
    return [...this.messages];
  }

  getExecutedUserQueries(): string[] {
    return [...this.executedUserQueries];
  }

  private upsertUserWithUtmColumn(params: unknown[]) {
    const [
      userId,
      username,
      firstName,
      lastName,
      languageCode,
      utmSource,
      metadata,
      updatedAt,
    ] = params as [
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
    ];

    const existing = this.users.get(userId);

    if (!existing) {
      this.users.set(userId, {
        userId,
        username,
        firstName,
        lastName,
        languageCode,
        utmSource,
        metadata,
        updatedAt,
      });
      return;
    }

    const nextUtmSource = utmSource ?? existing.utmSource ?? null;

    this.users.set(userId, {
      ...existing,
      username,
      firstName,
      lastName,
      languageCode,
      utmSource: nextUtmSource,
      metadata,
      updatedAt,
    });
  }

  private upsertUserWithoutUtmColumn(params: unknown[]) {
    const [
      userId,
      username,
      firstName,
      lastName,
      languageCode,
      metadata,
      updatedAt,
    ] = params as [
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
    ];

    const existing = this.users.get(userId);

    if (!existing) {
      this.users.set(userId, {
        userId,
        username,
        firstName,
        lastName,
        languageCode,
        utmSource: null,
        metadata,
        updatedAt,
      });
      return;
    }

    this.users.set(userId, {
      ...existing,
      username,
      firstName,
      lastName,
      languageCode,
      metadata,
      updatedAt,
    });
  }

  private insertMessage(params: unknown[]) {
    const [
      userId,
      chatId,
      threadId,
      role,
      text,
      timestamp,
      metadata,
    ] = params as [
      string,
      string,
      string | null,
      string,
      string,
      string,
      string | null,
    ];

    this.messages.push({
      id: this.nextMessageId++,
      userId,
      chatId,
      threadId,
      role,
      text,
      timestamp,
      metadata,
    });
  }
}

const createTestDatabase = (options: TestDatabaseOptions = {}) => {
  const db = new InMemoryD1Database(options);
  const adapter = createD1StorageAdapter({ db });

  return {
    db,
    adapter,
  };
};

describe('createD1StorageAdapter', () => {
  const baseDate = new Date('2024-01-01T00:00:00.000Z');

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('saves and updates user profiles with metadata', async () => {
    const { adapter, db } = createTestDatabase();

    await adapter.saveUser({
      userId: 'user-1',
      username: 'alice',
      firstName: 'Alice',
      lastName: 'Wonder',
      languageCode: 'en',
      utmSource: 'spring-campaign',
      metadata: { tier: 'beta' },
      updatedAt: baseDate,
    });

    await adapter.saveUser({
      userId: 'user-1',
      username: 'alice-updated',
      firstName: 'Alice',
      lastName: 'Wonderland',
      languageCode: 'en',
      utmSource: 'spring-campaign-2',
      metadata: { tier: 'gold', nested: { score: 3 } },
      updatedAt: new Date('2024-01-02T12:00:00.000Z'),
    });

    const stored = db.getUser('user-1');
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({
      userId: 'user-1',
      username: 'alice-updated',
      firstName: 'Alice',
      lastName: 'Wonderland',
      languageCode: 'en',
      utmSource: 'spring-campaign-2',
    });
    expect(stored?.metadata).toBe('{"nested":{"score":3},"tier":"gold"}');
  });

  it('stores utm source as nullable when missing', async () => {
    const { adapter, db } = createTestDatabase();

    await adapter.saveUser({
      userId: 'user-2',
      updatedAt: baseDate,
    });

    const stored = db.getUser('user-2');
    expect(stored).toBeDefined();
    expect(stored?.utmSource).toBeNull();
  });

  it('falls back to statements without utm_source when the column is missing', async () => {
    const warn = vi.fn();
    const db = new InMemoryD1Database({ hasUtmColumn: false });
    const adapter = createD1StorageAdapter({ db, logger: { warn } });

    const firstResult = await adapter.saveUser({
      userId: 'user-missing-column',
      utmSource: 'spring-campaign',
      updatedAt: baseDate,
    });

    expect(firstResult).toEqual({ utmDegraded: true });
    expect(warn).toHaveBeenCalledWith(
      '[d1-storage] utm_source column missing, disabling usage',
      expect.objectContaining({ error: 'no such column: utm_source' }),
    );

    const executedQueries = db.getExecutedUserQueries();
    expect(executedQueries).toHaveLength(2);
    expect(executedQueries[0]).toContain('utm_source');
    expect(executedQueries[1]).not.toContain('utm_source');

    const fallbackResult = await adapter.saveUser({
      userId: 'user-missing-column',
      username: 'fallback-user',
      updatedAt: new Date('2024-01-02T00:00:00.000Z'),
    });

    expect(fallbackResult).toEqual({ utmDegraded: true });
    expect(warn).toHaveBeenCalledTimes(1);

    const finalQueries = db.getExecutedUserQueries();
    expect(finalQueries).toHaveLength(3);
    expect(finalQueries[2]).not.toContain('utm_source');

    const stored = db.getUser('user-missing-column');
    expect(stored).toBeDefined();
    expect(stored?.utmSource).toBeNull();
    expect(stored?.username).toBe('fallback-user');
  });

  it('rechecks schema after fallback saves and restores utm usage when the column reappears', async () => {
    const warn = vi.fn();
    const db = new InMemoryD1Database({ hasUtmColumn: false });
    const adapter = createD1StorageAdapter({ db, logger: { warn } });

    await adapter.saveUser({
      userId: 'user-self-heal',
      utmSource: 'initial',
      updatedAt: baseDate,
    });

    db.setHasUtmColumn(true);

    for (let attempt = 0; attempt < UTM_COLUMN_RECHECK_INTERVAL - 1; attempt += 1) {
      const result = await adapter.saveUser({
        userId: 'user-self-heal',
        updatedAt: new Date(baseDate.getTime() + (attempt + 1) * 1_000),
      });

      if (attempt < UTM_COLUMN_RECHECK_INTERVAL - 2) {
        expect(result).toEqual({ utmDegraded: true });
      } else {
        expect(result).toEqual({ utmDegraded: false });
      }
    }

    const finalResult = await adapter.saveUser({
      userId: 'user-self-heal',
      utmSource: 'restored',
      updatedAt: new Date('2024-01-03T00:00:00.000Z'),
    });

    expect(finalResult).toEqual({ utmDegraded: false });

    const queries = db.getExecutedUserQueries();
    expect(queries.at(-1)).toContain('utm_source');

    expect(
      warn.mock.calls.some(
        ([message]) => message === '[d1-storage] utm_source column restored, re-enabling usage',
      ),
    ).toBe(true);
  });

  it('preserves existing utm source when subsequent updates omit the value', async () => {
    const { adapter, db } = createTestDatabase();

    await adapter.saveUser({
      userId: 'user-3',
      utmSource: 'spring-campaign',
      updatedAt: baseDate,
    });

    await adapter.saveUser({
      userId: 'user-3',
      username: 'charlie',
      updatedAt: new Date('2024-01-03T00:00:00.000Z'),
    });

    const stored = db.getUser('user-3');
    expect(stored).toBeDefined();
    expect(stored?.utmSource).toBe('spring-campaign');
    expect(stored?.username).toBe('charlie');
  });

  it('appends messages and avoids duplicates for the same metadata payload', async () => {
    const { adapter, db } = createTestDatabase();

    await adapter.appendMessage({
      userId: 'user-1',
      chatId: 'chat-1',
      role: 'user',
      text: 'Hello',
      timestamp: baseDate,
      metadata: { messageId: '42', order: ['a', 'b'] },
    });

    await adapter.appendMessage({
      userId: 'user-1',
      chatId: 'chat-1',
      role: 'user',
      text: 'Hello duplicate',
      timestamp: new Date('2024-01-01T00:00:01.000Z'),
      metadata: { order: ['a', 'b'], messageId: '42' },
    });

    await adapter.appendMessage({
      userId: 'user-1',
      chatId: 'chat-1',
      threadId: 'thread-7',
      role: 'assistant',
      text: 'Reply',
      timestamp: new Date('2024-01-01T00:00:02.000Z'),
      metadata: { messageId: '43' },
    });

    const messages = db.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      userId: 'user-1',
      chatId: 'chat-1',
      role: 'user',
      text: 'Hello',
      metadata: '{"messageId":"42","order":["a","b"]}',
    });
    expect(messages[1]).toMatchObject({
      threadId: 'thread-7',
      role: 'assistant',
      metadata: '{"messageId":"43"}',
    });
  });

  it('returns recent messages in chronological order limited by input', async () => {
    const { adapter } = createTestDatabase();

    const timestamps = [
      new Date('2024-01-01T10:00:00.000Z'),
      new Date('2024-01-01T11:00:00.000Z'),
      new Date('2024-01-01T12:00:00.000Z'),
    ];

    for (const [index, timestamp] of timestamps.entries()) {
      await adapter.appendMessage({
        userId: 'user-2',
        chatId: 'chat-2',
        role: index === 2 ? 'assistant' : 'user',
        text: `Message ${index + 1}`,
        timestamp,
      });
    }

    const recent = await adapter.getRecentMessages({ userId: 'user-2', limit: 2 });

    expect(recent).toHaveLength(2);
    expect(recent[0].text).toBe('Message 2');
    expect(recent[1].text).toBe('Message 3');
    expect(recent[0].timestamp.getTime()).toBeLessThan(recent[1].timestamp.getTime());
  });

  it('logs a warning and returns empty list when recent messages query fails', async () => {
    const warn = vi.fn();
    const db = new InMemoryD1Database({ failOnRecentMessages: true });
    const adapter = createD1StorageAdapter({ db, logger: { warn } });

    const result = await adapter.getRecentMessages({ userId: 'user-3', limit: 5 });

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[d1-storage] failed to load recent messages',
      expect.objectContaining({ userId: 'user-3', limit: 5 }),
    );
  });

  it('retries saveUser when the statement fails once', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValue({ success: true });

    const statement: Record<string, unknown> = {};
    const bind = vi.fn(() => statement);

    Object.assign(statement, {
      bind,
      run,
      first: vi.fn(),
      all: vi.fn(),
    });

    const prepare = vi.fn(() => statement);
    const warn = vi.fn();
    const adapter = createD1StorageAdapter({
      db: { prepare } as unknown as D1Database,
      logger: { warn },
    });

    try {
      const promise = adapter.saveUser({
        userId: 'user-retry',
        updatedAt: baseDate,
      });

      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toEqual({ utmDegraded: false });

      expect(run).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenLastCalledWith(
        '[d1-storage] saveUser failed, retrying',
        expect.objectContaining({ attempt: 1, maxAttempts: 6, nextDelayMs: 100 }),
      );
    } finally {
      vi.useRealTimers();
      randomSpy.mockRestore();
    }
  });

  it('logs success when saveUser eventually succeeds after multiple retries', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('locked-1'))
      .mockRejectedValueOnce(new Error('locked-2'))
      .mockResolvedValue({ success: true });

    const statement: Record<string, unknown> = {};
    const bind = vi.fn(() => statement);

    Object.assign(statement, {
      bind,
      run,
      first: vi.fn(),
      all: vi.fn(),
    });

    const prepare = vi.fn(() => statement);
    const warn = vi.fn();
    const adapter = createD1StorageAdapter({
      db: { prepare } as unknown as D1Database,
      logger: { warn },
    });

    try {
      const promise = adapter.saveUser({
        userId: 'user-retry-success',
        updatedAt: baseDate,
      });

      await vi.advanceTimersByTimeAsync(2000);
      await expect(promise).resolves.toEqual({ utmDegraded: false });

      expect(run).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenNthCalledWith(
        3,
        '[d1-storage] saveUser succeeded after retries',
        expect.objectContaining({ attempts: 3, maxAttempts: 6 }),
      );
    } finally {
      vi.useRealTimers();
      randomSpy.mockRestore();
    }
  });

  it('applies exponential backoff with jitter across long retry chains', async () => {
    vi.useFakeTimers();
    const randomSpy = vi
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.7)
      .mockReturnValueOnce(0.1)
      .mockReturnValue(0.5);

    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('locked-1'))
      .mockRejectedValueOnce(new Error('locked-2'))
      .mockRejectedValueOnce(new Error('locked-3'))
      .mockRejectedValueOnce(new Error('locked-4'))
      .mockResolvedValue({ success: true });

    const statement: Record<string, unknown> = {};
    const bind = vi.fn(() => statement);

    Object.assign(statement, {
      bind,
      run,
      first: vi.fn(),
      all: vi.fn(),
    });

    const prepare = vi.fn(() => statement);
    const warn = vi.fn();
    const adapter = createD1StorageAdapter({
      db: { prepare } as unknown as D1Database,
      logger: { warn },
    });

    try {
      const promise = adapter.saveUser({
        userId: 'user-backoff',
        updatedAt: baseDate,
      });

      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).resolves.toEqual({ utmDegraded: false });

      expect(run).toHaveBeenCalledTimes(5);
      expect(warn).toHaveBeenCalledTimes(5);
      expect(warn.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ nextDelayMs: 100 }));
      expect(warn.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ nextDelayMs: 140 }));
      expect(warn.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ nextDelayMs: 480 }));
      expect(warn.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ nextDelayMs: 480 }));
      expect(warn).toHaveBeenLastCalledWith(
        '[d1-storage] saveUser succeeded after retries',
        expect.objectContaining({ attempts: 5, maxAttempts: 6 }),
      );
    } finally {
      vi.useRealTimers();
      randomSpy.mockRestore();
    }
  });

  it('propagates errors when saveUser keeps failing after all retries', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const run = vi.fn().mockRejectedValue(new Error('permanent failure'));

    const statement: Record<string, unknown> = {};
    const bind = vi.fn(() => statement);

    Object.assign(statement, {
      bind,
      run,
      first: vi.fn(),
      all: vi.fn(),
    });

    const prepare = vi.fn(() => statement);
    const warn = vi.fn();
    const adapter = createD1StorageAdapter({
      db: { prepare } as unknown as D1Database,
      logger: { warn },
    });

    try {
      const promise = adapter.saveUser({
        userId: 'user-permanent-failure',
        updatedAt: baseDate,
      });
      const expectation = expect(promise).rejects.toThrow('permanent failure');

      await vi.runAllTimersAsync();

      await expectation;
      expect(run).toHaveBeenCalledTimes(6);
      expect(warn).toHaveBeenLastCalledWith(
        '[d1-storage] saveUser exhausted retries',
        expect.objectContaining({ attempt: 6, maxAttempts: 6, error: 'permanent failure' }),
      );
    } finally {
      vi.useRealTimers();
      randomSpy.mockRestore();
    }
  });

  it('propagates errors when appendMessage exhausts retries', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const run = vi.fn().mockRejectedValue(new Error('d1 down'));

    const statement: Record<string, unknown> = {};
    const bind = vi.fn(() => statement);

    Object.assign(statement, {
      bind,
      run,
      first: vi.fn(),
      all: vi.fn(),
    });

    const prepare = vi.fn(() => statement);
    const warn = vi.fn();
    const adapter = createD1StorageAdapter({
      db: { prepare } as unknown as D1Database,
      logger: { warn },
    });

    try {
      const promise = adapter.appendMessage({
        userId: 'user-retry',
        chatId: 'chat-1',
        role: 'user',
        text: 'hello',
        timestamp: baseDate,
      });
      const expectation = expect(promise).rejects.toThrow('d1 down');

      await vi.runAllTimersAsync();
      await expectation;

      expect(run).toHaveBeenCalledTimes(6);
      expect(warn).toHaveBeenCalledTimes(6);
      expect(warn).toHaveBeenLastCalledWith(
        '[d1-storage] appendMessage exhausted retries',
        expect.objectContaining({ attempt: 6, maxAttempts: 6, error: 'd1 down' }),
      );
    } finally {
      vi.useRealTimers();
      randomSpy.mockRestore();
    }
  });

  it('does not retry when encountering a non-retryable error', async () => {
    vi.useFakeTimers();

    const run = vi.fn().mockRejectedValue(new Error('SQLITE_CONSTRAINT: CHECK constraint failed: users'));

    const statement: Record<string, unknown> = {};
    const bind = vi.fn(() => statement);

    Object.assign(statement, {
      bind,
      run,
      first: vi.fn(),
      all: vi.fn(),
    });

    const prepare = vi.fn(() => statement);
    const warn = vi.fn();
    const adapter = createD1StorageAdapter({
      db: { prepare } as unknown as D1Database,
      logger: { warn },
    });

    try {
      const promise = adapter.saveUser({
        userId: 'user-non-retryable',
        updatedAt: baseDate,
      });

      await expect(promise).rejects.toThrow('SQLITE_CONSTRAINT: CHECK constraint failed: users');

      expect(run).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenLastCalledWith(
        '[d1-storage] saveUser failed with non-retryable error',
        expect.objectContaining({ attempt: 1, retryable: false }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
