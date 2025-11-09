import { describe, expect, it, vi } from 'vitest';

import { createTelegramWebhookHandler } from '../create-telegram-webhook-handler';
import type { StoragePort } from '../../../ports';
import type { TelegramUpdate } from '../../../http/telegram-webhook';

const createStorageMock = () => ({
  saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
  appendMessage: vi.fn(),
  getRecentMessages: vi.fn(),
}) as unknown as StoragePort;

const baseUpdate: TelegramUpdate = {
  update_id: 1,
  message: {
    message_id: 100,
    date: 1_710_000_000,
    text: 'hello',
    from: {
      id: 55,
      first_name: 'Test',
    },
    chat: {
      id: 66,
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
