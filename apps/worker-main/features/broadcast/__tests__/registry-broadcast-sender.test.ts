import { describe, expect, it, vi } from 'vitest';

import { createRegistryBroadcastSender } from '../minimal-broadcast-service';
import type { BroadcastRecipient } from '../minimal-broadcast-service';

const createMessagingMock = () => ({
  sendText: vi.fn().mockResolvedValue({ messageId: 'sent' }),
});

describe('createRegistryBroadcastSender', () => {
  it('fetches recipients from registry and respects filters', async () => {
    const messaging = createMessagingMock();
    const registryRecipients: BroadcastRecipient[] = [
      { chatId: '100', username: 'alice', languageCode: 'ru' },
      { chatId: '200', username: 'bob', languageCode: 'en' },
    ];
    const registry = {
      listActiveRecipients: vi.fn().mockResolvedValue(registryRecipients),
    };

    const sender = createRegistryBroadcastSender({
      messaging,
      registry,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await sender({
      text: 'Segmented hello',
      requestedBy: 'admin-1',
      filters: { languageCodes: ['ru'] },
    });

    expect(registry.listActiveRecipients).toHaveBeenCalledWith({ languageCodes: ['ru'] });
    expect(messaging.sendText).toHaveBeenCalledTimes(1);
    expect(messaging.sendText).toHaveBeenCalledWith({ chatId: '100', threadId: undefined, text: 'Segmented hello' });
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('falls back to environment recipients when registry fails and deduplicates', async () => {
    const messaging = createMessagingMock();
    const registry = {
      listActiveRecipients: vi.fn().mockRejectedValue(new Error('d1 unavailable')),
    };

    const fallbackRecipients: BroadcastRecipient[] = [
      { chatId: '100', username: 'alice' },
      { chatId: '100', username: 'alice2' },
      { chatId: '300', username: 'carol' },
    ];

    const sender = createRegistryBroadcastSender({
      messaging,
      registry,
      fallbackRecipients,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await sender({ text: 'Hello fallback', requestedBy: 'admin-1' });

    expect(registry.listActiveRecipients).toHaveBeenCalled();
    expect(messaging.sendText).toHaveBeenCalledTimes(2);
    expect(messaging.sendText).toHaveBeenCalledWith({ chatId: '100', threadId: undefined, text: 'Hello fallback' });
    expect(messaging.sendText).toHaveBeenCalledWith({ chatId: '300', threadId: undefined, text: 'Hello fallback' });
    expect(result.delivered).toBe(2);
    expect(result.failed).toBe(0);
  });
});
