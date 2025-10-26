import { describe, expect, it, vi } from 'vitest';

import type { MessagingPort } from '../../../ports';
import { createRateLimitNotifier } from '../rate-limit-notifier';

const createMessagingPort = () => ({
  sendTyping: vi.fn(),
  sendText: vi.fn().mockResolvedValue({ messageId: 'mid-1' }),
}) satisfies MessagingPort;

describe('rate limit notifier', () => {
  it('sends notification with formatted ttl and logs info', async () => {
    const messaging = createMessagingPort();
    const logger = { info: vi.fn(), error: vi.fn() };
    const notifier = createRateLimitNotifier({
      messaging,
      limit: 5,
      windowMs: 60 * 60 * 1000,
      now: () => 30 * 60 * 1000, // половина часа
      logger,
    });

    await notifier.notify({ userId: 'user-1', chatId: 'chat-1' });

    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: undefined,
      text: expect.stringContaining('30 мин'),
    });
    expect(logger.info).toHaveBeenCalledWith('rate limit notification sent', {
      userId: 'user-1',
      chatId: 'chat-1',
      threadId: undefined,
      limit: 5,
      ttlMs: 30 * 60 * 1000,
    });
  });

  it('logs error when messaging send fails', async () => {
    const messaging: MessagingPort = {
      sendTyping: vi.fn(),
      sendText: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const logger = { info: vi.fn(), error: vi.fn() };

    const notifier = createRateLimitNotifier({
      messaging,
      limit: 10,
      now: () => 0,
      logger,
    });

    await notifier.notify({ userId: 'user-err', chatId: 'chat-err', threadId: 'thread' });

    expect(logger.error).toHaveBeenCalledWith('failed to send rate limit notification', {
      userId: 'user-err',
      chatId: 'chat-err',
      threadId: 'thread',
      limit: 10,
      ttlMs: 24 * 60 * 60 * 1000,
      error: { name: 'Error', message: 'network error' },
    });
  });

  it('supports custom message builder', async () => {
    const messaging = createMessagingPort();
    const formatMessage = vi.fn().mockReturnValue('custom message');

    const notifier = createRateLimitNotifier({
      messaging,
      limit: 3,
      now: () => 0,
      formatMessage,
    });

    await notifier.notify({ userId: 'user-x', chatId: 'chat-x', threadId: 'thread-x' });

    expect(formatMessage).toHaveBeenCalledWith({
      userId: 'user-x',
      chatId: 'chat-x',
      threadId: 'thread-x',
      limit: 3,
      ttlMs: 24 * 60 * 60 * 1000,
    });
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-x',
      threadId: 'thread-x',
      text: 'custom message',
    });
  });
});

