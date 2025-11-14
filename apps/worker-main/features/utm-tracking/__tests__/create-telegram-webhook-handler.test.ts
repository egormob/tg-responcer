import { describe, expect, it, vi } from 'vitest';

import { createTelegramWebhookHandler } from '../create-telegram-webhook-handler';
import type { StoragePort } from '../../../ports';
import type { TelegramUpdate } from '../../../http/telegram-webhook';
import { describeTelegramIdForLogs } from '../../../http/telegram-ids';
import { createKnownUsersClearRoute } from '../../admin-diagnostics/known-users-route';

const createStorageMock = () => ({
  saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
  appendMessage: vi.fn(),
  getRecentMessages: vi.fn(),
}) as unknown as StoragePort;

const baseUpdate: TelegramUpdate = {
  update_id: 1,
  message: {
    message_id: '100',
    date: '1710000000',
    text: 'hello',
    from: {
      id: '55',
      first_name: 'Test',
    },
    chat: {
      id: '66',
      type: 'private',
    },
  },
};

const createStartUpdate = (payload: string | undefined): TelegramUpdate => {
  if (!baseUpdate.message) {
    throw new Error('Base update must include message');
  }

  return {
    ...baseUpdate,
    message: {
      ...baseUpdate.message,
      text: payload ? `/start ${payload}` : '/start',
      entities: [{ type: 'bot_command', offset: 0, length: '/start'.length }],
    },
  };
};

describe('createTelegramWebhookHandler', () => {
  it('stores utmSource on first /start payload', async () => {
    const storage = createStorageMock();
    const handler = createTelegramWebhookHandler({
      storage,
      now: () => new Date('2024-02-01T00:00:00.000Z'),
    });

    const result = await handler(createStartUpdate('src_DEMO'));

    expect(result.kind).toBe('message');
    expect(storage.saveUser).toHaveBeenCalledTimes(1);
    expect(storage.saveUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '55',
        utmSource: 'src_DEMO',
        updatedAt: new Date('2024-02-01T00:00:00.000Z'),
      }),
    );
  });

  it('skips storage call when /start payload missing', async () => {
    const storage = createStorageMock();
    const handler = createTelegramWebhookHandler({ storage });

    await handler(createStartUpdate(undefined));

    expect(storage.saveUser).not.toHaveBeenCalled();
  });

  it('keeps string identifiers intact when caching utm data', async () => {
    const storage = createStorageMock();
    const handler = createTelegramWebhookHandler({
      storage,
      now: () => new Date('2024-02-01T00:00:00.000Z'),
    });

    const userId = '9223372036854775807';
    const chatId = '-100123456789012345';
    const threadId = '9223372036854775809';

    const startUpdate: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: '111',
        date: '1710000100',
        text: '/start src_BIG',
        message_thread_id: threadId,
        migrate_to_chat_id: '-100987654321098765',
        entities: [{ type: 'bot_command', offset: 0, length: '/start'.length }],
        from: {
          id: userId,
          first_name: 'String',
        },
        chat: {
          id: chatId,
          type: 'supergroup',
        },
      },
    };

    const waitUntil = vi.fn();
    const startResult = await handler(startUpdate, { waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(startResult.kind).toBe('message');
    expect(storage.saveUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        updatedAt: new Date('2024-02-01T00:00:00.000Z'),
      }),
    );
    const savePayload = storage.saveUser.mock.calls[0]?.[0] as { userId?: unknown } | undefined;
    expect(savePayload?.userId).toBe(userId);
    expect(typeof savePayload?.userId).toBe('string');

    const followUp: TelegramUpdate = {
      update_id: 3,
      message: {
        message_id: '112',
        date: '1710000200',
        text: 'ping',
        message_thread_id: threadId,
        migrate_to_chat_id: '-100987654321098765',
        from: {
          id: userId,
          first_name: 'String',
        },
        chat: {
          id: chatId,
          type: 'supergroup',
        },
      },
    };

    const followResult = await handler(followUp);

    expect(followResult.kind).toBe('message');
    if (followResult.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(followResult.message.user.userId).toBe(userId);
    expect(followResult.message.chat.id).toBe(chatId);
    expect(followResult.message.chat.threadId).toBe(threadId);
    expect(followResult.message.user.utmSource).toBe('src_BIG');
  });

  it('skips storage call for invalid payloads', async () => {
    const storage = createStorageMock();
    const handler = createTelegramWebhookHandler({ storage });

    await handler(createStartUpdate('ref=123'));

    expect(storage.saveUser).not.toHaveBeenCalled();
  });

  it('reuses stored utmSource for subsequent messages without payload', async () => {
    const storage = createStorageMock();
    const handler = createTelegramWebhookHandler({
      storage,
      now: () => new Date('2024-02-01T00:00:00.000Z'),
    });

    await handler(createStartUpdate('src_DEMO'));
    expect(storage.saveUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '55',
        utmSource: 'src_DEMO',
        updatedAt: new Date('2024-02-01T00:00:00.000Z'),
      }),
    );
    expect(handler.knownUsers.get('55')).toEqual({ utmSource: 'src_DEMO' });

    const followUp: TelegramUpdate = {
      ...baseUpdate,
      message: {
        ...baseUpdate.message!,
        text: 'follow up',
      },
    };

    const result = await handler(followUp);

    expect(storage.saveUser).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }
    expect(result.message.user.utmSource).toBe('src_DEMO');
  });

  it('exposes shared known users cache used by admin route clearing', async () => {
    const storage = createStorageMock();
    const handler = createTelegramWebhookHandler({
      storage,
      now: () => new Date('2024-02-01T00:00:00.000Z'),
    });

    await handler(createStartUpdate('src_DEMO'));

    const followUp: TelegramUpdate = {
      ...baseUpdate,
      message: {
        ...baseUpdate.message!,
        text: 'follow up after cache clear',
      },
    };

    const route = createKnownUsersClearRoute({ cache: handler.knownUsers });
    const response = await route(new Request('https://example.com/admin/known-users/clear'));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      cleared: number;
      size: number;
      userIdHashes: string[];
    };

    const expectedHash = describeTelegramIdForLogs('55')?.hash;
    if (!expectedHash) {
      throw new Error('Expected hash for Telegram user id 55');
    }

    expect(payload).toEqual({
      ok: true,
      cleared: 1,
      size: 1,
      userIdHashes: [expectedHash],
    });

    const result = await handler(followUp);

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.user.utmSource).toBeUndefined();
  });

  it('drops cached utm source when user id is corrupted to non-string', async () => {
    const storage = createStorageMock();
    let corruptNextMessage = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handler = createTelegramWebhookHandler({
      storage,
      features: {
        async handleMessage(message) {
          if (corruptNextMessage && message.text === 'ping') {
            corruptNextMessage = false;
            (message.user as { userId: unknown }).userId = 55 as unknown as string;
          }
        },
      },
    });

    try {
      await handler(createStartUpdate('src_CORRUPT'));

      const followUp: TelegramUpdate = {
        update_id: 10,
        message: {
          ...baseUpdate.message!,
          message_id: '113',
          date: '1710000300',
          text: 'ping',
          entities: undefined,
        },
      };

      const firstResult = await handler(followUp);
      expect(firstResult.kind).toBe('message');
      expect(consoleError).toHaveBeenCalledWith(
        '[utm-tracking] message with non-string user id',
        expect.objectContaining({
          userId: 55,
          userIdType: 'number',
        }),
      );

      consoleError.mockClear();

      const secondFollowUp: TelegramUpdate = {
        update_id: 11,
        message: {
          ...baseUpdate.message!,
          message_id: '114',
          date: '1710000400',
          text: 'ping',
          entities: undefined,
        },
      };

      const secondResult = await handler(secondFollowUp);
      expect(secondResult.kind).toBe('message');
      if (secondResult.kind !== 'message') {
        throw new Error('Expected message result');
      }

      expect(secondResult.message.user.utmSource).toBeUndefined();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('stores utmSource from mini app start payload', async () => {
    const storage = createStorageMock();
    const handler = createTelegramWebhookHandler({
      storage,
      now: () => new Date('2024-02-01T00:00:00.000Z'),
    });

    const miniAppUpdate: TelegramUpdate = {
      ...baseUpdate,
      startapp: 'src_MINI-Launch',
    };

    const result = await handler(miniAppUpdate);

    expect(result.kind).toBe('message');
    expect(storage.saveUser).toHaveBeenCalledTimes(1);
    expect(storage.saveUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '55',
        utmSource: 'src_MINI-Launch',
        updatedAt: new Date('2024-02-01T00:00:00.000Z'),
      }),
    );
  });

  it('returns message result even when saveUser fails', async () => {
    const storage = createStorageMock();
    const failure = new Error('storage offline');
    storage.saveUser = vi.fn().mockRejectedValue(failure);

    const waitUntil = vi.fn();
    const handler = createTelegramWebhookHandler({
      storage,
      now: () => new Date('2024-02-01T00:00:00.000Z'),
    });

    const result = await handler(createStartUpdate('src_FAIL'), { waitUntil });

    expect(result.kind).toBe('message');
    expect(storage.saveUser).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);

    const savePromise = waitUntil.mock.calls[0]?.[0];
    await expect(savePromise).resolves.toBeUndefined();
  });
});

describe('worker integration with cached router', () => {
  it('reuses stored utmSource across sequential webhook requests', async () => {
    vi.resetModules();

    const handleMessage = vi
      .fn()
      .mockResolvedValue({ status: 'replied', response: { text: 'ok', messageId: '42' } });
    const messaging = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };
    const storage = {
      saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
      appendMessage: vi.fn(),
      getRecentMessages: vi.fn(),
    };
    const ai = { reply: vi.fn().mockResolvedValue({ text: 'ok', metadata: {} }) };
    const rateLimit = { checkAndIncrement: vi.fn().mockResolvedValue('ok') };

    const composeWorkerMock = vi.fn(({ adapters }: { adapters?: Record<string, unknown> }) => ({
      dialogEngine: { handleMessage },
      ports: {
        messaging: (adapters?.messaging as typeof messaging | undefined) ?? messaging,
        storage: (adapters?.storage as typeof storage | undefined) ?? storage,
        ai: (adapters?.ai as typeof ai | undefined) ?? ai,
        rateLimit: (adapters?.rateLimit as typeof rateLimit | undefined) ?? rateLimit,
      },
      webhookSecret: 'secret',
    }));

    vi.doMock('../../../composition', () => ({ composeWorker: composeWorkerMock }));
    vi.doMock('../../../adapters', () => ({
      createTelegramMessagingAdapter: vi.fn(() => messaging),
      createOpenAIResponsesAdapter: vi.fn(() => ai),
      createD1StorageAdapter: vi.fn(() => storage),
      createKvRateLimitAdapter: vi.fn(() => rateLimit),
    }));

    const module = await import('../../../index');
    module.__internal.clearRouterCache();
    const worker = module.default;

    const env = {
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_BOT_USERNAME: 'demo_bot',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-test',
      ENV_VERSION: '1',
    } as Record<string, unknown>;

    const ctx = { waitUntil: vi.fn() } as { waitUntil(promise: Promise<unknown>): void };

    const startUpdate: TelegramUpdate = {
      ...baseUpdate,
      message: {
        ...baseUpdate.message!,
        text: '/start src_DEMO',
        entities: [{ type: 'bot_command', offset: 0, length: '/start'.length }],
      },
    };

    await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(startUpdate),
      }),
      env,
      ctx,
    );

    expect(composeWorkerMock).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0]?.[0]?.user.utmSource).toBe('src_DEMO');

    handleMessage.mockClear();

    const followUpUpdate: TelegramUpdate = {
      ...baseUpdate,
      message: {
        ...baseUpdate.message!,
        text: 'regular message',
      },
    };

    await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(followUpUpdate),
      }),
      env,
      ctx,
    );

    expect(composeWorkerMock).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0]?.[0]?.user.utmSource).toBe('src_DEMO');
    expect(storage.saveUser).toHaveBeenCalledTimes(1);

    vi.resetModules();
  });
});
