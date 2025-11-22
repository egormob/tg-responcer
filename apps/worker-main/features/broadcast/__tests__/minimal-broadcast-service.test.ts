import { describe, expect, it, vi } from 'vitest';

import {
  BroadcastAbortedError,
  createImmediateBroadcastSender,
  createRegistryBroadcastSender,
  loadBroadcastCheckpoint,
  listBroadcastCheckpoints,
  type BroadcastRecipient,
} from '../minimal-broadcast-service';

const createRecipients = (count: number): BroadcastRecipient[] =>
  Array.from({ length: count }, (_, index) => ({ chatId: `chat-${index}` }));

class MemoryKv implements KVNamespace {
  constructor(private readonly now: () => number = () => Date.now()) {}

  readonly store = new Map<string, { value: string; expiration?: number }>();

  async get(key: string, type: 'text'): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiration && entry.expiration * 1000 <= this.now()) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiration = options?.expirationTtl
      ? Math.floor(this.now() / 1000) + options.expirationTtl
      : undefined;
    this.store.set(key, { value, expiration });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
    cursor: string;
  }> {
    const filteredKeys = Array.from(this.store.entries())
      .filter(([name]) => (options?.prefix ? name.startsWith(options.prefix) : true))
      .map(([name, entry]) => ({ name, expiration: entry.expiration }));

    const limited = typeof options?.limit === 'number' ? filteredKeys.slice(0, options.limit) : filteredKeys;

    return { keys: limited, list_complete: true, cursor: '' };
  }
}

describe('createImmediateBroadcastSender', () => {
  it('throttles large batches, retries 429 responses, and records telemetry', async () => {
    const recipients = createRecipients(50);
    const attempts = new Map<string, number>();
    const waitCalls: number[] = [];

    const sendText = vi.fn(async ({ chatId }: { chatId: string }) => {
      const attempt = attempts.get(chatId) ?? 0;
      attempts.set(chatId, attempt + 1);

      if ((chatId.endsWith('0') || chatId.endsWith('5')) && attempt === 0) {
        const error = new Error('Too many requests');
        (error as Error & { status?: number; retryAfterMs?: number }).status = 429;
        (error as Error & { status?: number; retryAfterMs?: number }).retryAfterMs = 25;
        throw error;
      }

      return { messageId: `${chatId}-${attempt}` };
    });

    const wait = vi.fn(async (ms: number) => {
      waitCalls.push(ms);
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const telemetry = { record: vi.fn(), snapshot: vi.fn() };

    const sendBroadcast = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger,
      pool: {
        concurrency: 5,
        maxAttempts: 3,
        baseDelayMs: 1,
        jitterRatio: 0,
        wait,
        random: () => 0,
      },
      telemetry,
      emergencyStop: { retryAfterMs: 500 },
    });

    const result = await sendBroadcast({ text: 'hello', requestedBy: 'ops' });

    expect(result.delivered).toBe(recipients.length);
    expect(result.failed).toBe(0);
    expect(sendText).toHaveBeenCalledTimes(recipients.length + 10);
    const throttledLogs = logger.warn.mock.calls.filter(([event]) => event === 'broadcast throttled');
    expect(throttledLogs.length).toBeGreaterThan(0);
    expect(throttledLogs[0]?.[1]).toMatchObject({ retryAfterMs: expect.any(Number) });
    expect(waitCalls.some((delay) => delay >= 25)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      'broadcast_summary',
      expect.objectContaining({ delivered: recipients.length, throttled429: expect.any(Number) }),
    );
    expect(telemetry.record).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: 'ops',
        delivered: recipients.length,
        status: 'ok',
        throttled429: expect.any(Number),
      }),
    );
  });

  it('caps global send rate at 28 rps and respects retry_after windows', async () => {
    const recipients = createRecipients(30);
    const attempts = new Map<string, number>();
    const waitCalls: number[] = [];
    const timeline = { now: 0 };
    const sentAt: number[] = [];

    const wait = vi.fn(async (ms: number) => {
      waitCalls.push(ms);
      timeline.now += ms;
    });

    const sendText = vi.fn(async ({ chatId }: { chatId: string }) => {
      const attempt = attempts.get(chatId) ?? 0;
      attempts.set(chatId, attempt + 1);
      sentAt.push(timeline.now);

      if (chatId === 'chat-0' && attempt === 0) {
        const error = new Error('Too many requests');
        (error as Error & { status?: number; parameters?: { retry_after?: number } }).status = 429;
        (error as Error & { status?: number; parameters?: { retry_after?: number } }).parameters = {
          retry_after: 1,
        };
        throw error;
      }

      return { messageId: `${chatId}-${attempt}` };
    });

    const sendBroadcast = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pool: {
        concurrency: 10,
        maxRps: 28,
        rateJitterRatio: 0,
        baseDelayMs: 10,
        jitterRatio: 0,
        wait,
        random: () => 0,
        now: () => timeline.now,
      },
    });

    const result = await sendBroadcast({ text: 'hello', requestedBy: 'ops' });

    expect(result.delivered).toBe(recipients.length);
    expect(result.failed).toBe(0);
    expect(sendText).toHaveBeenCalledTimes(recipients.length + 1);
    expect(Math.max(...sentAt)).toBeGreaterThanOrEqual(1000);
    expect(waitCalls.some((delay) => delay >= 1000)).toBe(true);
  });

  it('aborts broadcast when sendText reports fatal error', async () => {
    const recipients = createRecipients(5);
    const sendText = vi.fn(async () => {
      const error = new Error('unauthorized');
      (error as Error & { status?: number }).status = 401;
      throw error;
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const telemetry = { record: vi.fn(), snapshot: vi.fn() };

    const sendBroadcast = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger,
      telemetry,
      emergencyStop: { retryAfterMs: 500 },
    });

    await expect(sendBroadcast({ text: 'stop', requestedBy: 'ops' })).rejects.toBeInstanceOf(
      BroadcastAbortedError,
    );
    expect(logger.error).toHaveBeenCalledWith(
      'broadcast pool aborted',
      expect.objectContaining({ reason: 'send_text_failed' }),
    );
    expect(telemetry.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'aborted', abortReason: 'send_text_failed' }),
    );
  });

  it('ignores segmentation filters and delivers to all recipients from D1 source', async () => {
    const recipients = [
      { chatId: 'chat-1', languageCode: 'en' },
      { chatId: 'chat-2', languageCode: 'ru' },
    ];

    const sendText = vi
      .fn(async ({ chatId }: { chatId: string }) => ({ messageId: `sent-${chatId}` }))
      .mockResolvedValue({ messageId: 'sent-chat-1' });

    const sendBroadcast = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await sendBroadcast({
      text: 'hello',
      requestedBy: 'ops',
      filters: { languageCodes: ['ru'] },
    });

    expect(sendText).toHaveBeenCalledTimes(recipients.length);
    expect(result.delivered).toBe(recipients.length);
    expect(result.failed).toBe(0);
  });

  it('rejects text exceeding max length before sending', async () => {
    const recipients = createRecipients(2);
    const sendText = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const sendBroadcast = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger,
    });

    await expect(
      sendBroadcast({ text: 'a'.repeat(3980), requestedBy: 'ops' }),
    ).rejects.toBeInstanceOf(BroadcastAbortedError);

    expect(sendText).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'broadcast text exceeds limit',
      expect.objectContaining({ length: 3980, limit: 3970 }),
    );
  });

  it('delivers broadcast when text respects the configured limit', async () => {
    const recipients = createRecipients(3);
    const sendText = vi.fn().mockResolvedValue({ messageId: 'ok' });

    const sendBroadcast = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      maxTextLength: 5000,
    });

    const result = await sendBroadcast({ text: 'a'.repeat(4500), requestedBy: 'ops' });

    expect(sendText).toHaveBeenCalledTimes(recipients.length);
    expect(result.delivered).toBe(recipients.length);
    expect(result.failed).toBe(0);
  });

  it('limits batch size by text budget and resumes from checkpoint', async () => {
    const recipients = createRecipients(6);
    const controller = new AbortController();
    const kv = new MemoryKv();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const sendText = vi.fn(async ({ chatId }: { chatId: string }) => {
      if (sendText.mock.calls.length >= 3 && !controller.signal.aborted) {
        controller.abort();
      }

      return { messageId: `id-${chatId}` };
    });

    const sender = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger,
      progressKv: kv,
      batchSize: 5,
      maxBatchTextBytes: 10,
      jobIdGenerator: () => 'job-batch-limit',
    });

    await expect(
      sender({ text: 'long', requestedBy: 'ops', abortSignal: controller.signal }),
    ).rejects.toBeInstanceOf(BroadcastAbortedError);

    const checkpoint = await loadBroadcastCheckpoint(kv, 'job-batch-limit');
    expect(checkpoint?.batchSize).toBe(2);
    expect(checkpoint?.maxBatchTextBytes).toBe(10);
    expect(checkpoint?.offset).toBeGreaterThan(0);

    const result = await sender({ text: 'long', requestedBy: 'ops', resumeFrom: checkpoint });

    expect(result.delivered + result.failed).toBe(recipients.length);
    expect(sendText.mock.calls.filter(([payload]) => payload.chatId === 'chat-0').length).toBe(1);
  });

  it('persists degraded pool after throttling and reuses it on resume', async () => {
    const recipients = createRecipients(12);
    const controller = new AbortController();
    const kv = new MemoryKv();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const attempts = new Map<string, number>();

    const sendText = vi.fn(async ({ chatId }: { chatId: string }) => {
      const attempt = attempts.get(chatId) ?? 0;
      attempts.set(chatId, attempt + 1);

      if (attempt === 0 && Number(chatId.split('-')[1]) < 6) {
        const error = new Error('429');
        (error as Error & { status?: number; retryAfterMs?: number }).status = 429;
        (error as Error & { status?: number; retryAfterMs?: number }).retryAfterMs = 5;
        throw error;
      }

      if (attempts.size >= 8 && !controller.signal.aborted) {
        controller.abort();
      }

      return { messageId: `${chatId}-${attempt}` };
    });

    const sender = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger,
      pool: {
        concurrency: 4,
        maxRps: 28,
        wait: async () => {},
        random: () => 0,
        baseDelayMs: 1,
        jitterRatio: 0,
        rateJitterRatio: 0,
      },
      progressKv: kv,
      jobIdGenerator: () => 'job-degrade',
    });

    await expect(
      sender({ text: 'hello', requestedBy: 'ops', abortSignal: controller.signal }),
    ).rejects.toBeInstanceOf(BroadcastAbortedError);

    const checkpoint = await loadBroadcastCheckpoint(kv, 'job-degrade');
    expect(checkpoint?.pool).toBeDefined();
    expect(checkpoint?.pool?.concurrency).toBeGreaterThanOrEqual(1);
    expect(checkpoint?.pool?.concurrency).toBeLessThan(4);
    expect(checkpoint?.pool?.maxRps).toBeGreaterThanOrEqual(1);
    expect(checkpoint?.pool?.maxRps).toBeLessThan(28);

    const resumed = await sender({ text: 'hello', requestedBy: 'ops', resumeFrom: checkpoint });

    const poolInitCalls = logger.info.mock.calls.filter(
      ([event]) => event === 'broadcast pool initialized',
    );
    expect(poolInitCalls.at(-1)?.[1]).toMatchObject({
      poolSize: checkpoint?.pool?.concurrency,
      maxRps: checkpoint?.pool?.maxRps,
    });

    expect(resumed.delivered + resumed.failed).toBe(recipients.length);
    expect(await loadBroadcastCheckpoint(kv, 'job-degrade')).toBeUndefined();
  });

  it('processes 100k recipients with pause/resume without duplicates', async () => {
    const recipients = createRecipients(100_000);
    const kv = new MemoryKv();
    const controller = new AbortController();
    const sent = new Set<string>();

    const sendText = vi.fn(async ({ chatId }: { chatId: string }) => {
      sent.add(chatId);
      if (sent.size === 10_000 && !controller.signal.aborted) {
        controller.abort();
      }

      if (sent.size % 20000 === 0) {
        await Promise.resolve();
      }

      return { messageId: chatId };
    });

    const sender = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pool: {
        concurrency: 32,
        maxRps: 10_000,
        wait: async () => {},
        random: () => 0,
        baseDelayMs: 1,
        jitterRatio: 0,
        rateJitterRatio: 0,
      },
      progressKv: kv,
      jobIdGenerator: () => 'job-large',
    });

    await expect(
      sender({ text: 'bulk-message', requestedBy: 'ops', abortSignal: controller.signal }),
    ).rejects.toBeInstanceOf(BroadcastAbortedError);

    const checkpoint = await loadBroadcastCheckpoint(kv, 'job-large');
    expect(checkpoint?.offset).toBeGreaterThanOrEqual(10_000);

    const result = await sender({
      text: 'bulk-message',
      requestedBy: 'ops',
      resumeFrom: checkpoint,
    });

    expect(result.delivered + result.failed).toBe(recipients.length);
    expect(sendText).toHaveBeenCalledTimes(recipients.length);
    expect(sent.size).toBe(recipients.length);
  });
});

describe('createRegistryBroadcastSender', () => {
  it('rejects text exceeding max length before sending', async () => {
    const recipients = createRecipients(2);
    const sendText = vi.fn();
    const registry = { listActiveRecipients: vi.fn().mockResolvedValue(recipients) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const sendBroadcast = createRegistryBroadcastSender({
      messaging: { sendText },
      registry,
      logger,
    });

    await expect(
      sendBroadcast({ text: 'b'.repeat(5000), requestedBy: 'ops' }),
    ).rejects.toBeInstanceOf(BroadcastAbortedError);

    expect(registry.listActiveRecipients).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'broadcast text exceeds limit',
      expect.objectContaining({ length: 5000 }),
    );
  });

  it('delivers broadcast when text is within limit', async () => {
    const recipients = createRecipients(3);
    const sendText = vi.fn().mockResolvedValue({ messageId: 'ok' });
    const registry = { listActiveRecipients: vi.fn().mockResolvedValue(recipients) };

    const sendBroadcast = createRegistryBroadcastSender({
      messaging: { sendText },
      registry,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      maxTextLength: 5000,
    });

    const result = await sendBroadcast({ text: 'a'.repeat(4000), requestedBy: 'ops' });

    expect(sendText).toHaveBeenCalledTimes(recipients.length);
    expect(result.delivered).toBe(recipients.length);
    expect(result.failed).toBe(0);
  });

  it('pauses on long retry_after and resumes without duplicates', async () => {
    const recipients = createRecipients(3);
    const timeline = { now: 0 };
    const kv = new MemoryKv(() => timeline.now);
    let resumed = false;

    const sendText = vi.fn(async ({ chatId }: { chatId: string }) => {
      if (chatId === 'chat-1' && !resumed) {
        const error = new Error('Too Many Requests');
        (error as Error & { status?: number; retryAfterMs?: number }).status = 429;
        (error as Error & { status?: number; retryAfterMs?: number }).retryAfterMs = 5000;
        throw error;
      }

      return { messageId: `${chatId}-${resumed ? 'resume' : 'initial'}` };
    });

    const wait = vi.fn(async (ms: number) => {
      timeline.now += ms;
    });

    const sender = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pool: {
        concurrency: 1,
        baseDelayMs: 1,
        jitterRatio: 0,
        wait,
        random: () => 0,
        rateJitterRatio: 0,
        maxAttempts: 2,
        maxRps: 28,
      },
      emergencyStop: { retryAfterMs: 4000 },
      progressKv: kv,
      progressTtlSeconds: 300,
      jobIdGenerator: () => 'job-resume',
    });

    await expect(
      sender({ text: 'hello', requestedBy: 'ops' }),
    ).rejects.toBeInstanceOf(BroadcastAbortedError);

    const checkpoint = await loadBroadcastCheckpoint(kv, 'job-resume');
    expect(checkpoint).toMatchObject({
      status: 'paused',
      delivered: 1,
      offset: 1,
      ttlSeconds: 300,
    });

    resumed = true;
    const result = await sender({ text: 'hello', requestedBy: 'ops', resumeFrom: checkpoint });

    expect(result.delivered).toBe(recipients.length);
    expect(sendText.mock.calls.filter(([payload]) => payload.chatId === 'chat-0').length).toBe(1);
    expect(sendText.mock.calls.filter(([payload]) => payload.chatId === 'chat-1').length).toBe(2);
    expect(await loadBroadcastCheckpoint(kv, 'job-resume')).toBeUndefined();
  });

  it('sends admin notification and leaves diagnostic checkpoint on fatal stop', async () => {
    const kv = new MemoryKv();
    const sendText = vi.fn(async () => {
      const error = new Error('Unauthorized');
      (error as Error & { status?: number }).status = 401;
      throw error;
    });

    const onAdminNotification = vi.fn();
    const sender = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients: createRecipients(2),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      emergencyStop: { retryAfterMs: 1000 },
      progressKv: kv,
      progressTtlSeconds: 180,
      jobIdGenerator: () => 'job-fatal',
      onAdminNotification,
    });

    await expect(
      sender({ text: 'oops', requestedBy: 'ops', adminChat: { chatId: 'admin-chat' } }),
    ).rejects.toBeInstanceOf(BroadcastAbortedError);

    expect(onAdminNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-fatal',
        status: 'aborted',
        reason: 'send_text_failed',
        checkpoint: expect.objectContaining({ reason: 'send_text_failed', ttlSeconds: 180 }),
      }),
    );

    const checkpoint = await loadBroadcastCheckpoint(kv, 'job-fatal');
    expect(checkpoint?.reason).toBe('send_text_failed');
    expect(checkpoint?.ttlSeconds).toBe(180);
    expect(checkpoint?.expiresAt).toBeDefined();
  });
});
