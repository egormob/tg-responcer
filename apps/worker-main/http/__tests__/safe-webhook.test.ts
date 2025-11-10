import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessagingPort } from '../../ports';
import { resetLastTelegramUpdateSnapshot } from '../telegram-webhook';
import { safeWebhookHandler } from '../safe-webhook';

describe('safeWebhookHandler', () => {
  beforeEach(() => {
    resetLastTelegramUpdateSnapshot();
  });

  const createMessagingMock = () => ({
    sendTyping: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({}),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
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
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await safeWebhookHandler({
      chat: { id: 'chat-2' },
      messaging,
      run: async () => {
        throw new Error('boom');
      },
      mapResult: async () => ({ body: { ok: false } }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-2',
      threadId: undefined,
      text: '⚠️ → 🔁💬',
    });

    expect(errorSpy).toHaveBeenCalledWith('[safe][error]', { err: 'Error: boom' });
    errorSpy.mockRestore();
  });

  it('awaits fallback delivery before resolving the handler', async () => {
    const messaging = createMessagingMock();
    let resolveSend: (() => void) | undefined;
    const sendTextMock = vi.fn(
      () =>
        new Promise<{ messageId?: string }>((resolve) => {
          resolveSend = () => resolve({});
        }),
    );

    messaging.sendText = sendTextMock as unknown as MessagingPort['sendText'];

    const handlerPromise = safeWebhookHandler({
      chat: { id: 'chat-3', threadId: 'thread-3' },
      messaging,
      run: async () => {
        throw new Error('unexpected');
      },
      mapResult: async () => ({ body: { ok: false } }),
    });

    let isResolved = false;
    const trackedPromise = handlerPromise.then((response) => {
      isResolved = true;
      return response;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(isResolved).toBe(false);
    expect(sendTextMock).toHaveBeenCalledTimes(1);
    expect(typeof resolveSend).toBe('function');

    resolveSend?.();

    const response = await trackedPromise;

    expect(isResolved).toBe(true);
    expect(response.status).toBe(200);
  });
});
