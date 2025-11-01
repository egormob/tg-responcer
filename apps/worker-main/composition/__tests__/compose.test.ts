import { describe, expect, it, vi } from 'vitest';

import type { AiPort, MessagingPort, RateLimitPort, StoragePort } from '../../ports';
import type { PortOverrides } from '../compose';
import { composeWorker } from '../compose';

const createMessagingPort = () => {
  const sendTyping = vi
    .fn<Parameters<MessagingPort['sendTyping']>, ReturnType<MessagingPort['sendTyping']>>()
    .mockResolvedValue(undefined);
  const sendText = vi
    .fn<Parameters<MessagingPort['sendText']>, ReturnType<MessagingPort['sendText']>>()
    .mockResolvedValue({ messageId: '42' });

  return {
    sendTyping,
    sendText,
  } satisfies MessagingPort & {
    sendTyping: typeof sendTyping;
    sendText: typeof sendText;
  };
};

const createAiPort = () => {
  const reply = vi
    .fn<Parameters<AiPort['reply']>, ReturnType<AiPort['reply']>>()
    .mockResolvedValue({ text: 'hi' });

  return {
    reply,
  } satisfies AiPort & {
    reply: typeof reply;
  };
};

const createStoragePort = () => {
  const saveUser = vi
    .fn<Parameters<StoragePort['saveUser']>, ReturnType<StoragePort['saveUser']>>()
    .mockResolvedValue(undefined);
  const appendMessage = vi
    .fn<Parameters<StoragePort['appendMessage']>, ReturnType<StoragePort['appendMessage']>>()
    .mockResolvedValue(undefined);
  const getRecentMessages = vi
    .fn<
      Parameters<StoragePort['getRecentMessages']>,
      ReturnType<StoragePort['getRecentMessages']>
    >()
    .mockResolvedValue([]);

  return {
    saveUser,
    appendMessage,
    getRecentMessages,
  } satisfies StoragePort & {
    saveUser: typeof saveUser;
    appendMessage: typeof appendMessage;
    getRecentMessages: typeof getRecentMessages;
  };
};

const createRateLimitPort = () => {
  const checkAndIncrement = vi
    .fn<
      Parameters<RateLimitPort['checkAndIncrement']>,
      ReturnType<RateLimitPort['checkAndIncrement']>
    >()
    .mockResolvedValue('ok');

  return {
    checkAndIncrement,
  } satisfies RateLimitPort & {
    checkAndIncrement: typeof checkAndIncrement;
  };
};

const createPortOverrides = () => {
  const messaging = createMessagingPort();
  const ai = createAiPort();
  const storage = createStoragePort();
  const rateLimit = createRateLimitPort();

  return {
    messaging,
    ai,
    storage,
    rateLimit,
  } satisfies PortOverrides & {
    messaging: ReturnType<typeof createMessagingPort>;
    ai: ReturnType<typeof createAiPort>;
    storage: ReturnType<typeof createStoragePort>;
    rateLimit: ReturnType<typeof createRateLimitPort>;
  };
};

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
});
