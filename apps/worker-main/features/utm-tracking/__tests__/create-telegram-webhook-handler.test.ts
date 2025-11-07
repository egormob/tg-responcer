import { describe, expect, it, vi } from 'vitest';

import { createTelegramWebhookHandler } from '../create-telegram-webhook-handler';
import type { StoragePort } from '../../../ports';
import type { TelegramUpdate } from '../../../http/telegram-webhook';

const createStorageMock = () => ({
  saveUser: vi.fn().mockResolvedValue(undefined),
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
        utmSource: 'src_demo',
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
    expect(result.message.user.utmSource).toBe('src_demo');
  });
});
