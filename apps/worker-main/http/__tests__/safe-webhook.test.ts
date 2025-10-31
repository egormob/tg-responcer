import { describe, expect, it, vi } from 'vitest';

import type { MessagingPort } from '../../ports';
import { safeWebhookHandler } from '../safe-webhook';

describe('safeWebhookHandler', () => {
  const createMessagingMock = () => ({
    sendTyping: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({}),
  }) as unknown as MessagingPort;

  it('returns success response when run completes without errors', async () => {
    const messaging = createMessagingMock();

    const response = await safeWebhookHandler({
      chat: { id: 'chat-1', threadId: 'thread-1' },
      messaging,
      run: async () => ({ status: 'ok' }),
      mapResult: async () => ({ body: { ok: true } }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(messaging.sendText).not.toHaveBeenCalled();
  });

  it('sends fallback message and still returns 200 when run throws', async () => {
    const messaging = createMessagingMock();

    const response = await safeWebhookHandler({
      chat: { id: 'chat-2' },
      messaging,
      run: async () => {
        throw new Error('boom');
      },
      mapResult: async () => ({ body: { ok: false } }),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ok');
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-2',
      threadId: undefined,
      text: expect.stringContaining('Повторите'),
    });
  });
});
