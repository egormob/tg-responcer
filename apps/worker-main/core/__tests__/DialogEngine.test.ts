import { describe, expect, it, vi } from 'vitest';

import { DialogEngine } from '../DialogEngine';
import type { AiPort, MessagingPort, RateLimitPort, StoragePort, StoredMessage } from '../../ports';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

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
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
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
      saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
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

  it('не передаёт в AI свежее пользовательское сообщение повторно', async () => {
    const messaging: MessagingPort = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };

    const ai: AiPort = {
      reply: vi.fn().mockResolvedValue({ text: 'Ответ' }),
    };

    const incomingMessage = createMessageOverrides();

    const storedMessages: StoredMessage[] = [
      {
        userId: incomingMessage.user.userId,
        chatId: incomingMessage.chat.id,
        role: 'assistant',
        text: 'Здравствуйте ещё раз!',
        timestamp: new Date('2024-01-01T09:59:00Z'),
      },
      {
        userId: incomingMessage.user.userId,
        chatId: incomingMessage.chat.id,
        role: 'user',
        text: incomingMessage.text,
        timestamp: incomingMessage.receivedAt,
        metadata: { messageId: incomingMessage.messageId },
      },
    ];

    const storage: StoragePort = {
      saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      getRecentMessages: vi.fn().mockResolvedValue(storedMessages),
    };

    const rateLimit: RateLimitPort = {
      checkAndIncrement: vi.fn().mockResolvedValue('ok'),
    };

    const engine = new DialogEngine({ messaging, ai, storage, rateLimit });

    await engine.handleMessage(incomingMessage);

    expect(ai.reply).toHaveBeenCalledWith({
      userId: incomingMessage.user.userId,
      text: incomingMessage.text,
      context: [
        {
          role: 'assistant',
          text: 'Здравствуйте ещё раз!',
        },
      ],
    });

    const context = (ai.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.context;
    const userMessagesInContext = context?.filter((item: { role: string }) => item.role === 'user') ?? [];
    expect(userMessagesInContext).toHaveLength(0);
  });

  it('останавливается при превышении лимита без обращений к остальным портам', async () => {
    const messaging: MessagingPort = {
      sendTyping: vi.fn(),
      sendText: vi.fn(),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };
    const ai: AiPort = {
      reply: vi.fn(),
    };
    const storage: StoragePort = {
      saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
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

  it('запускает typing до завершения операций хранения', async () => {
    let resolveTyping!: () => void;
    const typingInvoked = new Promise<void>((resolve) => {
      resolveTyping = resolve;
    });

    const messaging: MessagingPort = {
      sendTyping: vi.fn().mockImplementation(async () => {
        resolveTyping();
        return undefined;
      }),
      sendText: vi.fn().mockResolvedValue({ messageId: 'sent' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };

    const saveUserDeferred = createDeferred<{ utmDegraded: boolean }>();
    let saveUserResolved = false;
    const appendDeferred = createDeferred<void>();
    let appendResolved = false;
    const getRecentDeferred = createDeferred<StoredMessage[]>();
    let getRecentResolved = false;

    const storage: StoragePort = {
      saveUser: vi.fn().mockImplementation(async () => {
        const result = await saveUserDeferred.promise;
        saveUserResolved = true;
        return result;
      }),
      appendMessage: vi
        .fn()
        .mockImplementationOnce(async () => {
          await appendDeferred.promise;
          appendResolved = true;
        })
        .mockResolvedValue(undefined),
      getRecentMessages: vi.fn().mockImplementation(async () => {
        const result = await getRecentDeferred.promise;
        getRecentResolved = true;
        return result;
      }),
    };

    const ai: AiPort = {
      reply: vi.fn().mockResolvedValue({ text: 'Ответ', metadata: {} }),
    };

    const rateLimit: RateLimitPort = {
      checkAndIncrement: vi.fn().mockResolvedValue('ok'),
    };

    const nowValues = [new Date('2024-01-01T10:00:00Z'), new Date('2024-01-01T10:00:01Z')];
    const now = vi.fn(() => {
      const value = nowValues.shift();
      if (!value) {
        return new Date('2024-01-01T10:00:01Z');
      }
      return value;
    });

    const engine = new DialogEngine({ messaging, ai, storage, rateLimit, now });

    const handlePromise = engine.handleMessage(createMessageOverrides());

    await typingInvoked;

    expect(messaging.sendTyping).toHaveBeenCalledTimes(1);
    expect(storage.saveUser).toHaveBeenCalledTimes(1);
    expect(storage.appendMessage).toHaveBeenCalledTimes(1);
    expect(storage.getRecentMessages).toHaveBeenCalledTimes(1);

    const sendTypingOrder = (messaging.sendTyping as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const saveUserCallOrder = (storage.saveUser as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];
    const appendCallOrder = (storage.appendMessage as unknown as { mock: { invocationCallOrder: number[] } }).mock
      .invocationCallOrder[0];

    expect(sendTypingOrder).toBeLessThan(saveUserCallOrder);
    expect(sendTypingOrder).toBeLessThan(appendCallOrder);

    expect(saveUserResolved).toBe(false);
    expect(appendResolved).toBe(false);
    expect(getRecentResolved).toBe(false);

    saveUserDeferred.resolve({ utmDegraded: false });
    appendDeferred.resolve();

    await Promise.resolve();

    expect(storage.getRecentMessages).toHaveBeenCalledTimes(1);

    getRecentDeferred.resolve([]);

    const result = await handlePromise;

    expect(result).toEqual({
      status: 'replied',
      response: {
        text: 'Ответ',
        messageId: 'sent',
      },
    });

    expect(saveUserResolved).toBe(true);
    expect(appendResolved).toBe(true);
    expect(getRecentResolved).toBe(true);
  });
});
