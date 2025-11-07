import { describe, expect, it, beforeEach, vi } from 'vitest';

import { createD1StorageAdapter, type D1Database } from '..';

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

  constructor(private readonly options: TestDatabaseOptions = {}) {}

  prepare(query: string): D1PreparedStatement {
    return new InMemoryStatement(query.trim(), this);
  }

  executeRun<T>(query: string, params: unknown[]): Promise<T> {
    if (query.startsWith('INSERT INTO users')) {
      this.upsertUser(params);
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

    throw new Error(`Unsupported all query: ${query}`);
  }

  getUser(userId: string): StoredUserRow | undefined {
    return this.users.get(userId);
  }

  getMessages(): StoredMessageRow[] {
    return [...this.messages];
  }

  private upsertUser(params: unknown[]) {
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

    this.users.set(userId, {
      ...existing,
      username,
      firstName,
      lastName,
      languageCode,
      utmSource,
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

    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValue({ success: true });

    const statement: any = {};
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
      await expect(promise).resolves.toBeUndefined();

      expect(run).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenLastCalledWith(
        '[d1-storage] saveUser failed, retrying',
        expect.objectContaining({ attempt: 1, maxAttempts: 3 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a warning without throwing when appendMessage exhausts retries', async () => {
    vi.useFakeTimers();

    const run = vi.fn().mockRejectedValue(new Error('d1 down'));

    const statement: any = {};
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

      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toBeUndefined();

      expect(run).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenLastCalledWith(
        '[d1-storage] appendMessage exhausted retries',
        expect.objectContaining({ attempt: 3, maxAttempts: 3, error: 'd1 down' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
