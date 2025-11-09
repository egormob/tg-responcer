import { describe, expect, it, vi } from 'vitest';

import { createTelegramBroadcastCommandHandler } from '../telegram-broadcast-command';
import type { TelegramAdminCommandContext } from '../../../http';
import type { MessagingPort } from '../../../ports';
import type { IncomingMessage } from '../../../core';
import type { SendBroadcast } from '../minimal-broadcast-service';
import type { AdminCommandErrorRecorder } from '../../admin-access/admin-messaging-errors';

const createContext = ({
  command = '/broadcast',
  argument,
}: {
  command?: '/broadcast' | '/admin';
  argument?: string;
} = {}): TelegramAdminCommandContext => {
  const trimmedArgument = argument?.trim();
  const contextArgument = trimmedArgument && trimmedArgument.length > 0 ? trimmedArgument : undefined;
  const text = [command, contextArgument].filter(Boolean).join(' ').trim();

  return {
    command,
    rawCommand: command,
    argument: contextArgument,
    text,
    chat: { id: 'chat-1', threadId: 'thread-1', type: 'private' },
    from: { userId: 'admin-1' },
    messageId: 'message-1',
    update: { update_id: 1 },
    message: {
      message_id: 1,
      chat: { id: 1 },
    } as unknown as TelegramAdminCommandContext['message'],
    incomingMessage: {
      chat: { id: 'chat-1', threadId: 'thread-1' },
      messageId: 'message-1',
      receivedAt: new Date('2024-01-01T00:00:00Z'),
      text,
      user: { userId: 'admin-1' },
    },
  };
};

const createIncomingMessage = (text: string): IncomingMessage => ({
  user: { userId: 'admin-1' },
  chat: { id: 'chat-1', threadId: 'thread-1' },
  text,
  messageId: 'incoming-1',
  receivedAt: new Date('2024-01-01T00:01:00Z'),
});

describe('createTelegramBroadcastCommandHandler', () => {
  const createHandler = ({
    isAdmin = true,
    sendTextMock = vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
    sendBroadcastMock = vi.fn().mockResolvedValue({ delivered: 2, failed: 0, deliveries: [] }),
    adminErrorRecorder,
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }: {
    isAdmin?: boolean;
    sendTextMock?: ReturnType<typeof vi.fn>;
    sendBroadcastMock?: SendBroadcast;
    adminErrorRecorder?: AdminCommandErrorRecorder;
    logger?: { info?: (...args: unknown[]) => unknown; warn?: (...args: unknown[]) => unknown; error?: (...args: unknown[]) => unknown };
  } = {}) => {
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(isAdmin) };
    const messaging: Pick<MessagingPort, 'sendText'> = {
      sendText: sendTextMock as unknown as MessagingPort['sendText'],
    };

    const handler = createTelegramBroadcastCommandHandler({
      adminAccess,
      messaging,
      sendBroadcast: sendBroadcastMock,
      now: () => new Date('2024-01-01T00:00:00Z'),
      logger,
      adminErrorRecorder,
    });

    return { handler, adminAccess, sendTextMock, sendBroadcastMock, logger };
  };

  it('prompts admin for broadcast text after /broadcast command', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, adminAccess } = createHandler({ sendTextMock });

    const response = await handler.handleCommand(createContext());

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('admin-1');
    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: [
        'Введите текст рассылки (до 4096 символов).',
        'Следующее сообщение уйдёт всем получателям минимальной модели.',
      ].join('\n'),
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: 'awaiting_text' });
  });

  it('ignores command when user is not an admin', async () => {
    const sendTextMock = vi.fn();
    const { handler, adminAccess } = createHandler({ isAdmin: false, sendTextMock });

    const response = await handler.handleCommand(createContext());

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('admin-1');
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(response).toBeUndefined();
  });

  it('sends broadcast when admin provides valid text', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({ delivered: 3, failed: 0, deliveries: [] });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await handler.handleCommand(createContext());
    const result = await handler.handleMessage(createIncomingMessage('hello everyone'));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).toHaveBeenCalledWith({
      text: 'hello everyone',
      requestedBy: 'admin-1',
    });

    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: ['📣 Рассылка отправлена.', 'Получателей: 3.'].join('\n'),
    });
  });

  it('ignores incoming message from a different thread', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({ delivered: 3, failed: 0, deliveries: [] });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await handler.handleCommand(createContext());

    const result = await handler.handleMessage({
      ...createIncomingMessage('hello everyone'),
      chat: { id: 'chat-1', threadId: 'thread-2' },
    });

    expect(result).toBeUndefined();
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledTimes(1);
  });

  it('rejects empty broadcast text and asks to restart', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

    await handler.handleCommand(createContext());
    const result = await handler.handleMessage(createIncomingMessage('   '));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: 'Текст рассылки не может быть пустым. Запустите /broadcast заново и введите сообщение.',
    });
  });

  it('rejects text that exceeds telegram limit', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

    await handler.handleCommand(createContext());
    const longText = 'a'.repeat(5000);
    const result = await handler.handleMessage(createIncomingMessage(longText));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: 'Текст рассылки превышает лимит 4096 символов. Отправьте более короткое сообщение.',
    });
  });

  it('records diagnostics when prompt delivery fails', async () => {
    const error = Object.assign(new Error('blocked'), { status: 403 });
    const sendTextMock = vi.fn().mockRejectedValue(error);
    const record = vi.fn().mockResolvedValue(undefined);
    const adminErrorRecorder: AdminCommandErrorRecorder = {
      record,
      source: 'primary',
      namespace: undefined,
    };

    const { handler, adminAccess } = createHandler({ sendTextMock, adminErrorRecorder });

    const response = await handler.handleCommand(createContext());

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('admin-1');
    expect(record).toHaveBeenCalledWith({
      userId: 'admin-1',
      command: 'broadcast_prompt',
      error,
      details: { status: 403 },
    });
    expect(response?.status).toBe(502);
  });

  it('notifies admin when broadcast sending fails', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockRejectedValue(new Error('network error'));
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await handler.handleCommand(createContext());
    const result = await handler.handleMessage(createIncomingMessage('hello everyone'));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: 'Не удалось отправить рассылку. Попробуйте ещё раз позже или обратитесь к оператору.',
    });
  });

  it('supports /admin broadcast alias', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler } = createHandler({ sendTextMock });

    const response = await handler.handleCommand(createContext({ command: '/admin', argument: 'broadcast' }));

    expect(sendTextMock).toHaveBeenCalled();
    expect(response?.status).toBe(200);
  });

  it('clears pending broadcast when admin runs another command', async () => {
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn() };
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock, logger });

    await handler.handleCommand(createContext());

    const statusResult = await handler.handleCommand(createContext({ command: '/admin', argument: 'status' }));

    expect(statusResult).toBeUndefined();
    expect(info).toHaveBeenCalledWith('broadcast pending cleared before non-broadcast command', {
      userId: 'admin-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      command: '/admin',
      argument: 'status',
    });

    const messageResult = await handler.handleMessage(createIncomingMessage('не рассылка'));

    expect(messageResult).toBeUndefined();
    expect(sendBroadcastMock).not.toHaveBeenCalled();
  });

  it('ignores incoming messages when there is no active broadcast session', async () => {
    const { handler, sendBroadcastMock } = createHandler();

    const result = await handler.handleMessage(createIncomingMessage('ignored text'));

    expect(result).toBeUndefined();
    expect(sendBroadcastMock).not.toHaveBeenCalled();
  });
});

describe('worker integration for broadcast command', () => {
  it('preserves pending broadcast session between webhook requests', async () => {
    vi.resetModules();

    const handleMessage = vi.fn();
    const messaging = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };
    const storage = {
      saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
      appendMessage: vi.fn(),
      getRecentMessages: vi.fn(),
    };
    const ai = { reply: vi.fn().mockResolvedValue({ text: 'ok', metadata: {} }) };
    const rateLimit = { checkAndIncrement: vi.fn().mockResolvedValue('ok') };

    const composeWorkerMock = vi.fn(({ adapters }: { adapters?: Record<string, unknown> }) => ({
      dialogEngine: { handleMessage },
      ports: {
        messaging: (adapters?.messaging as typeof messaging | undefined) ?? messaging,
        storage: (adapters?.storage as typeof storage | undefined) ?? storage,
        ai: (adapters?.ai as typeof ai | undefined) ?? ai,
        rateLimit: (adapters?.rateLimit as typeof rateLimit | undefined) ?? rateLimit,
      },
      webhookSecret: 'secret',
    }));

    vi.doMock('../../../composition', () => ({ composeWorker: composeWorkerMock }));
    vi.doMock('../../../adapters', () => ({
      createTelegramMessagingAdapter: vi.fn(() => messaging),
      createOpenAIResponsesAdapter: vi.fn(() => ai),
      createD1StorageAdapter: vi.fn(() => storage),
      createKvRateLimitAdapter: vi.fn(() => rateLimit),
    }));

    const module = await import('../../../index');
    module.__internal.clearRouterCache();
    const worker = module.default;

    const adminKv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ whitelist: ['admin-1'] })),
      put: vi.fn(),
      list: vi.fn().mockResolvedValue({ keys: [] }),
      delete: vi.fn(),
    };

    const env = {
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_BOT_USERNAME: 'demo_bot',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-test',
      BROADCAST_ENABLED: 'true',
      BROADCAST_RECIPIENTS: JSON.stringify([{ chatId: 'subscriber-1' }]),
      ADMIN_TG_IDS: adminKv,
      ENV_VERSION: '1',
    } as Record<string, unknown>;

    const ctx = { waitUntil: vi.fn() } as { waitUntil(promise: Promise<unknown>): void };

    const commandUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        date: 1_710_000_000,
        text: '/broadcast',
        entities: [{ type: 'bot_command', offset: 0, length: '/broadcast'.length }],
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
        message_thread_id: 77,
      },
    };

    const commandResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(commandUpdate),
      }),
      env,
      ctx,
    );

    expect(commandResponse.status).toBe(200);
    await expect(commandResponse.json()).resolves.toEqual({ status: 'awaiting_text' });
    expect(composeWorkerMock).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: [
        'Введите текст рассылки (до 4096 символов).',
        'Следующее сообщение уйдёт всем получателям минимальной модели.',
      ].join('\n'),
    });

    messaging.sendText.mockClear();

    const broadcastTextUpdate = {
      update_id: 2,
      message: {
        message_id: 101,
        date: 1_710_000_010,
        text: 'Всем привет',
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
        message_thread_id: 77,
      },
    };

    const broadcastResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(broadcastTextUpdate),
      }),
      env,
      ctx,
    );

    expect(broadcastResponse.status).toBe(200);
    await expect(broadcastResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(composeWorkerMock).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: [
        '📣 Рассылка отправлена.',
        'Получателей: 1.',
      ].join('\n'),
    });
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'subscriber-1',
      threadId: undefined,
      text: 'Всем привет',
    });

    expect(adminKv.get).toHaveBeenCalledWith('whitelist', 'text');

    vi.resetModules();
  });
});
