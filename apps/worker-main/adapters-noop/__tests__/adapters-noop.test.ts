import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  createNoopAiPort,
  createNoopMessagingPort,
  createNoopPorts,
  createNoopRateLimitPort,
  createNoopStoragePort,
} from '../index';

describe('adapters-noop', () => {
  const originalWarn = console.warn;
  let warnSpy: MockInstance<
    Parameters<typeof console.warn>,
    ReturnType<typeof console.warn>
  >;

  beforeEach(() => {
    warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined as ReturnType<typeof console.warn>);
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

    expect(warnSpy).toHaveBeenCalled();
    const typingCall = warnSpy.mock.calls.find(([message]) =>
      typeof message === 'string' && message.includes('messaging.sendTyping'),
    );
    expect(typingCall).toBeDefined();

    const textCall = warnSpy.mock.calls.find(([message]) =>
      typeof message === 'string' && message.includes('messaging.sendText'),
    );
    expect(textCall).toBeDefined();
  });

  it('ai adapter returns fallback response and logs warning', async () => {
    const ai = createNoopAiPort();

    await expect(
      ai.reply({ userId: 'user-1', text: 'hi', context: [] }),
    ).resolves.toEqual({
      text: 'Ассистент временно недоступен. Пожалуйста, попробуйте позже.',
    });

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

    await expect(
      ports.ai.reply({ userId: 'user-4', text: 'test', context: [] }),
    ).resolves.toEqual({ text: 'custom fallback' });

    await ports.messaging.sendText({ chatId: 'chat-4', text: 'ignored' });

    const messagingCall = warnSpy.mock.calls.find(([, details]) =>
      typeof details === 'string' && details.includes('custom fallback'),
    );

    expect(messagingCall).toBeDefined();
  });
});
