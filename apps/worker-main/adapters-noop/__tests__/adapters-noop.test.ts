import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createNoopAiPort,
  createNoopMessagingPort,
  createNoopPorts,
  createNoopRateLimitPort,
  createNoopStoragePort,
} from '../index';

describe('adapters-noop', () => {
  const originalWarn = console.warn;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    console.warn = originalWarn;
  });

  it('messaging adapter resolves without throwing and logs warning', async () => {
    const messaging = createNoopMessagingPort();

    await expect(
      messaging.sendTyping({ chatId: 'chat-1', threadId: 'thread-1' }),
    ).resolves.toBeUndefined();
    await expect(
      messaging.sendText({ chatId: 'chat-1', text: 'ignored' }),
    ).resolves.toEqual({ messageId: undefined });
    await expect(
      messaging.editMessageText({ chatId: 'chat-1', messageId: 'mid-1', text: 'ignored' }),
    ).resolves.toBeUndefined();
    await expect(
      messaging.deleteMessage({ chatId: 'chat-1', messageId: 'mid-1' }),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    const typingCall = warnSpy.mock.calls.find(([message]) =>
      typeof message === 'string' && message.includes('messaging.sendTyping'),
    );
    expect(typingCall).toBeDefined();

    const textCall = warnSpy.mock.calls.find(([message]) =>
      typeof message === 'string' && message.includes('messaging.sendText'),
    );
    expect(textCall).toBeDefined();

    const editCall = warnSpy.mock.calls.find(([message]) =>
      typeof message === 'string' && message.includes('messaging.editMessageText'),
    );
    expect(editCall).toBeDefined();

    const deleteCall = warnSpy.mock.calls.find(([message]) =>
      typeof message === 'string' && message.includes('messaging.deleteMessage'),
    );
    expect(deleteCall).toBeDefined();
  });

  it('ai adapter returns fallback response and logs warning', async () => {
    const ai = createNoopAiPort();

    const replyPromise = ai.reply({ userId: 'user-1', text: 'hi', context: [] });

    await expect(replyPromise).resolves.toEqual({
      text: 'Ассистент временно недоступен. Пожалуйста, попробуйте позже.',
      metadata: { selfTestNoop: true, usedOutputText: false },
    });

    const reply = await replyPromise;
    expect(reply.metadata.selfTestNoop).toBe(true);
    expect(reply.metadata.usedOutputText).toBe(false);

    expect(
      warnSpy.mock.calls.some(([message]) =>
        typeof message === 'string' && message.includes('ai.reply'),
      ),
    ).toBe(true);
  });

  it('storage adapter returns empty history and logs per method', async () => {
    const storage = createNoopStoragePort();

    await expect(
      storage.saveUser({ userId: 'user-2', updatedAt: new Date() }),
    ).resolves.toBeUndefined();

    await expect(
      storage.appendMessage({
        userId: 'user-2',
        chatId: 'chat',
        role: 'user',
        text: 'hello',
        timestamp: new Date(),
      }),
    ).resolves.toBeUndefined();

    await expect(
      storage.getRecentMessages({ userId: 'user-2', limit: 10 }),
    ).resolves.toEqual([]);

    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('rate limit adapter always returns ok and logs warning', async () => {
    const rateLimit = createNoopRateLimitPort();

    await expect(
      rateLimit.checkAndIncrement({ userId: 'user-3' }),
    ).resolves.toBe('ok');

    expect(
      warnSpy.mock.calls.some(([message]) =>
        typeof message === 'string' && message.includes('rateLimit.checkAndIncrement'),
      ),
    ).toBe(true);
  });

  it('createNoopPorts shares the same fallback text across adapters', async () => {
    const ports = createNoopPorts({ fallbackText: 'custom fallback' });

    const replyPromise = ports.ai.reply({ userId: 'user-4', text: 'test', context: [] });

    await expect(replyPromise).resolves.toEqual({
      text: 'custom fallback',
      metadata: { selfTestNoop: true, usedOutputText: false },
    });

    const reply = await replyPromise;
    expect(reply.metadata.selfTestNoop).toBe(true);
    expect(reply.metadata.usedOutputText).toBe(false);

    await ports.messaging.sendText({ chatId: 'chat-4', text: 'ignored' });

    const messagingCall = warnSpy.mock.calls.find(([, details]) =>
      typeof details === 'string' && details.includes('custom fallback'),
    );

    expect(messagingCall).toBeDefined();
  });
});
