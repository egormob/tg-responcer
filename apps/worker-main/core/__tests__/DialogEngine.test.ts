import { describe, expect, it, vi } from 'vitest';

import { DialogEngine } from '../DialogEngine';
import type { AiPort, MessagingPort, RateLimitPort, StoragePort, StoredMessage } from '../../ports';

function createMessageOverrides(overrides: Partial<Parameters<DialogEngine['handleMessage']>[0]> = {}) {
  return {
    user: {
      userId: 'user-1',
      username: 'demo',
    },
    chat: {
      id: 'chat-1',
    },
    text: 'Привет!',
    messageId: 'incoming-1',
    receivedAt: new Date('2024-01-01T10:00:00Z'),
    ...overrides,
  };
}

describe('DialogEngine', () => {
  it('проходит полный контур диалога и возвращает ответ', async () => {
    const messaging: MessagingPort = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: 'outgoing-1' }),
    };
    const ai: AiPort = {
      reply: vi.fn().mockResolvedValue({ text: 'Здравствуйте!', metadata: { tokens: 123 } }),
    };

    const previousMessages: StoredMessage[] = [
      {
        userId: 'user-1',
        chatId: 'chat-1',
        role: 'user',
        text: 'Как дела?',
        timestamp: new Date('2024-01-01T09:59:30Z'),
      },
    ];

    const storage: StoragePort = {
      saveUser: vi.fn().mockResolvedValue(undefined),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      getRecentMessages: vi.fn().mockResolvedValue(previousMessages),
    };

    const rateLimit: RateLimitPort = {
      checkAndIncrement: vi.fn().mockResolvedValue('ok'),
    };

    const nowValues = [new Date('2024-01-01T10:00:05Z'), new Date('2024-01-01T10:00:06Z')];
    const now = vi.fn(() => {
      const value = nowValues.shift();
      if (!value) {
        throw new Error('now() called more times than expected');
      }
      return value;
    });

    const engine = new DialogEngine({ messaging, ai, storage, rateLimit, now });

    const result = await engine.handleMessage(createMessageOverrides());

    expect(result).toEqual({
      status: 'replied',
      response: {
        text: 'Здравствуйте!',
        messageId: 'outgoing-1',
      },
    });

    expect(rateLimit.checkAndIncrement).toHaveBeenCalledWith({
      userId: 'user-1',
      context: { chatId: 'chat-1', threadId: undefined },
    });

    expect(storage.saveUser).toHaveBeenCalledWith({
      userId: 'user-1',
      username: 'demo',
      updatedAt: new Date('2024-01-01T10:00:05Z'),
    });

    expect(storage.appendMessage).toHaveBeenCalledTimes(2);
    expect(storage.appendMessage).toHaveBeenNthCalledWith(1, {
      userId: 'user-1',
      chatId: 'chat-1',
      threadId: undefined,
      role: 'user',
      text: 'Привет!',
      timestamp: new Date('2024-01-01T10:00:00Z'),
      metadata: { messageId: 'incoming-1' },
    });

    expect(storage.appendMessage).toHaveBeenNthCalledWith(2, {
      userId: 'user-1',
      chatId: 'chat-1',
      threadId: undefined,
      role: 'assistant',
      text: 'Здравствуйте!',
      timestamp: new Date('2024-01-01T10:00:06Z'),
      metadata: { tokens: 123 },
    });

    expect(storage.getRecentMessages).toHaveBeenCalledWith({
      userId: 'user-1',
      limit: 15,
    });

    expect(messaging.sendTyping).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: undefined,
    });

    expect(ai.reply).toHaveBeenCalledWith({
      userId: 'user-1',
      text: 'Привет!',
      context: previousMessages.map(({ role, text }) => ({ role, text })),
    });

    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: undefined,
      text: 'Здравствуйте!',
    });

    const appendMessageCallOrder = (storage.appendMessage as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder;
    const getRecentOrder = (storage.getRecentMessages as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder;

    expect(appendMessageCallOrder[0]).toBeLessThan(getRecentOrder[0]);
    expect(getRecentOrder[0]).toBeLessThan(appendMessageCallOrder[1]);
  });

  it('останавливается при превышении лимита без обращений к остальным портам', async () => {
    const messaging: MessagingPort = {
      sendTyping: vi.fn(),
      sendText: vi.fn(),
    };
    const ai: AiPort = {
      reply: vi.fn(),
    };
    const storage: StoragePort = {
      saveUser: vi.fn(),
      appendMessage: vi.fn(),
      getRecentMessages: vi.fn(),
    };
    const rateLimit: RateLimitPort = {
      checkAndIncrement: vi.fn().mockResolvedValue('limit'),
    };

    const engine = new DialogEngine({ messaging, ai, storage, rateLimit });
    const result = await engine.handleMessage(createMessageOverrides());

    expect(result).toEqual({ status: 'rate_limited' });
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledTimes(1);
    expect(storage.saveUser).not.toHaveBeenCalled();
    expect(storage.appendMessage).not.toHaveBeenCalled();
    expect(storage.getRecentMessages).not.toHaveBeenCalled();
    expect(messaging.sendTyping).not.toHaveBeenCalled();
    expect(ai.reply).not.toHaveBeenCalled();
    expect(messaging.sendText).not.toHaveBeenCalled();
  });
});
