import { describe, expect, it, vi } from 'vitest';

import { createTelegramBroadcastCommandHandler } from '../telegram-broadcast-command';
import type { TelegramAdminCommandContext } from '../../../http';
import type { MessagingPort } from '../../../ports';
import type { IncomingMessage } from '../../../core';
import type { SendBroadcast } from '../minimal-broadcast-service';

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
  }: {
    isAdmin?: boolean;
    sendTextMock?: ReturnType<typeof vi.fn>;
    sendBroadcastMock?: SendBroadcast;
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
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    return { handler, adminAccess, sendTextMock, sendBroadcastMock };
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

  it('ignores incoming messages when there is no active broadcast session', async () => {
    const { handler, sendBroadcastMock } = createHandler();

    const result = await handler.handleMessage(createIncomingMessage('ignored text'));

    expect(result).toBeUndefined();
    expect(sendBroadcastMock).not.toHaveBeenCalled();
  });
});
