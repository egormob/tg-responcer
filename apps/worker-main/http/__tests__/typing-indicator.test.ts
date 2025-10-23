import { describe, expect, it, vi } from 'vitest';

import type { MessagingPort } from '../../ports';
import { createTypingIndicator } from '../typing-indicator';

const createMessagingPort = () => ({
  sendTyping: vi.fn<Parameters<MessagingPort['sendTyping']>, ReturnType<MessagingPort['sendTyping']>>(),
});

describe('typing indicator', () => {
  it('calls sendTyping before executing the handler', async () => {
    const events: string[] = [];
    const messaging = createMessagingPort();
    messaging.sendTyping.mockImplementation(async () => {
      events.push('typing');
    });

    const indicator = createTypingIndicator({
      messaging: messaging,
    });

    await indicator.runWithTyping({ chatId: 'chat-1' }, async () => {
      events.push('handler');
    });

    expect(events).toEqual(['typing', 'handler']);
    expect(messaging.sendTyping).toHaveBeenCalledTimes(1);
  });

  it('does not start parallel typing for the same chat', async () => {
    const messaging = createMessagingPort();
    messaging.sendTyping.mockResolvedValue(undefined);

    const indicator = createTypingIndicator({ messaging });

    let releaseFirst: (() => void) | undefined;
    const firstRun = indicator.runWithTyping({ chatId: 'chat-2' }, async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });

    await vi.waitUntil(() => releaseFirst !== undefined);

    const secondHandler = vi.fn(async () => undefined);
    const secondRun = indicator.runWithTyping({ chatId: 'chat-2' }, secondHandler);

    expect(messaging.sendTyping).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await Promise.all([firstRun, secondRun]);
  });

  it('restarts typing indicator once previous handling is finished', async () => {
    const messaging = createMessagingPort();
    messaging.sendTyping.mockResolvedValue(undefined);

    const indicator = createTypingIndicator({ messaging });

    await indicator.runWithTyping({ chatId: 'chat-3' }, async () => undefined);
    await indicator.runWithTyping({ chatId: 'chat-3' }, async () => undefined);

    expect(messaging.sendTyping).toHaveBeenCalledTimes(2);
  });

  it('swallows errors from sendTyping and keeps processing', async () => {
    const messaging = createMessagingPort();
    messaging.sendTyping.mockRejectedValueOnce(new Error('network failure'));

    const indicator = createTypingIndicator({ messaging });

    await expect(
      indicator.runWithTyping({ chatId: 'chat-4' }, async () => 'ok'),
    ).resolves.toBe('ok');

    expect(messaging.sendTyping).toHaveBeenCalledTimes(1);

    await indicator.runWithTyping({ chatId: 'chat-4' }, async () => undefined);
    expect(messaging.sendTyping).toHaveBeenCalledTimes(2);
  });
});
