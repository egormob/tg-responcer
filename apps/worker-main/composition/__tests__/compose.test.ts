import { describe, expect, it, vi } from 'vitest';

import type { AiPort, MessagingPort, RateLimitPort, StoragePort } from '../../ports';
import type { PortOverrides } from '../compose';
import { composeWorker } from '../compose';

const createMessagingPort = (): MessagingPort => ({
  sendTyping: vi
    .fn<Parameters<MessagingPort['sendTyping']>, ReturnType<MessagingPort['sendTyping']>>()
    .mockResolvedValue(undefined),
  sendText: vi
    .fn<Parameters<MessagingPort['sendText']>, ReturnType<MessagingPort['sendText']>>()
    .mockResolvedValue({ messageId: '42' }),
  editMessageText: vi
    .fn<Parameters<MessagingPort['editMessageText']>, ReturnType<MessagingPort['editMessageText']>>()
    .mockResolvedValue(undefined),
  deleteMessage: vi
    .fn<Parameters<MessagingPort['deleteMessage']>, ReturnType<MessagingPort['deleteMessage']>>()
    .mockResolvedValue(undefined),
});

const createAiPort = (): AiPort => ({
  reply: vi
    .fn<Parameters<AiPort['reply']>, ReturnType<AiPort['reply']>>()
    .mockResolvedValue({ text: 'hi' }),
});

const createStoragePort = (): StoragePort => ({
  saveUser: vi
    .fn<Parameters<StoragePort['saveUser']>, ReturnType<StoragePort['saveUser']>>()
    .mockResolvedValue({ utmDegraded: false }),
  appendMessage: vi
    .fn<Parameters<StoragePort['appendMessage']>, ReturnType<StoragePort['appendMessage']>>()
    .mockResolvedValue(undefined),
  getRecentMessages: vi
    .fn<Parameters<StoragePort['getRecentMessages']>, ReturnType<StoragePort['getRecentMessages']>>()
    .mockResolvedValue([]),
});

const createRateLimitPort = (): RateLimitPort => ({
  checkAndIncrement: vi
    .fn<
      Parameters<RateLimitPort['checkAndIncrement']>,
      ReturnType<RateLimitPort['checkAndIncrement']>
    >()
    .mockResolvedValue('ok'),
});

const createPortOverrides = (): PortOverrides => ({
  messaging: createMessagingPort(),
  ai: createAiPort(),
  storage: createStoragePort(),
  rateLimit: createRateLimitPort(),
});

describe('composeWorker', () => {
  it('returns noop ports when overrides are not provided', async () => {
    const composition = composeWorker({
      env: {},
    });

    expect(composition.webhookSecret).toBeUndefined();

    const result = await composition.dialogEngine.handleMessage({
      user: { userId: 'user-1' },
      chat: { id: 'chat-1' },
      text: 'hello',
      receivedAt: new Date(),
    });

    expect(result.status).toBe('replied');
    expect(composition.ports.ai).toBeDefined();
    expect(composition.ports.messaging).toBeDefined();
  });

  it('uses default dialog history limit', async () => {
    const adapters = createPortOverrides();

    const composition = composeWorker({
      env: {},
      adapters,
    });

    await composition.dialogEngine.handleMessage({
      user: { userId: 'user-history' },
      chat: { id: 'chat-history' },
      text: 'hello',
      receivedAt: new Date(),
    });

    expect(adapters.storage.getRecentMessages).toHaveBeenCalledWith({
      userId: 'user-history',
      limit: 40,
    });
  });

  it('prefers provided adapters over noop defaults', async () => {
    const adapters = createPortOverrides();

    const composition = composeWorker({
      env: { TELEGRAM_WEBHOOK_SECRET: 'secret-value' },
      adapters,
    });

    await composition.dialogEngine.handleMessage({
      user: { userId: 'user-2' },
      chat: { id: 'chat-2' },
      text: 'ping',
      receivedAt: new Date(),
    });

    expect(adapters.rateLimit.checkAndIncrement).toHaveBeenCalled();
    expect(adapters.storage.saveUser).toHaveBeenCalled();
    expect(adapters.ai.reply).toHaveBeenCalled();
    expect(adapters.messaging.sendText).toHaveBeenCalled();
    expect(composition.webhookSecret).toBe('secret-value');
  });

  it('passes dialog options to the engine', async () => {
    const adapters = createPortOverrides();
    adapters.storage.getRecentMessages.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({
        userId: 'user',
        chatId: 'chat',
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `msg-${index}`,
        timestamp: new Date(),
      })),
    );

    const composition = composeWorker({
      env: {},
      adapters,
      dialogOptions: { recentMessagesLimit: 2 },
    });

    await composition.dialogEngine.handleMessage({
      user: { userId: 'user-3' },
      chat: { id: 'chat-3' },
      text: 'hello',
      receivedAt: new Date(),
    });

    expect(adapters.storage.getRecentMessages).toHaveBeenCalledWith({
      userId: 'user-3',
      limit: 2,
    });
  });

  it('disables rate limiting when kv flag is off', async () => {
    const adapters = createPortOverrides();
    adapters.rateLimit.checkAndIncrement.mockResolvedValue('limit');

    const kv = {
      get: vi.fn().mockResolvedValue('false'),
    };

    const composition = composeWorker({
      env: { TELEGRAM_WEBHOOK_SECRET: 'secret', RATE_LIMIT_KV: kv },
      adapters,
    });

    const result = await composition.dialogEngine.handleMessage({
      user: { userId: 'user-4' },
      chat: { id: 'chat-4' },
      text: 'hello',
      receivedAt: new Date(),
    });

    expect(result.status).toBe('replied');
    expect(kv.get).toHaveBeenCalledWith('LIMITS_ENABLED');
    expect(adapters.rateLimit.checkAndIncrement).not.toHaveBeenCalled();
  });

  it('keeps raw rate limit enabled for admin ports when limits flag disables user limiter', async () => {
    const adapters = createPortOverrides();
    adapters.rateLimit.checkAndIncrement.mockResolvedValue('limit');

    const kv = {
      get: vi.fn().mockResolvedValue('0'),
    };

    const composition = composeWorker({
      env: { RATE_LIMIT_KV: kv },
      adapters,
    });

    const userResult = await composition.ports.rateLimit.checkAndIncrement({ userId: 'user-5' });
    expect(userResult).toBe('ok');
    expect(adapters.rateLimit.checkAndIncrement).not.toHaveBeenCalled();

    const adminResult = await composition.ports.rawRateLimit.checkAndIncrement({ userId: 'admin-1' });
    expect(adminResult).toBe('limit');
    expect(adapters.rateLimit.checkAndIncrement).toHaveBeenCalledTimes(1);
  });
});
