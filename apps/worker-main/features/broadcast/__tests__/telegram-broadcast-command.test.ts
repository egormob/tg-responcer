import { describe, expect, it, vi } from 'vitest';

import { createTelegramBroadcastCommandHandler } from '../telegram-broadcast-command';
import type { BroadcastJob, BroadcastMessagePayload } from '../broadcast-queue';
import type { TelegramAdminCommandContext } from '../../../http';
import type { MessagingPort } from '../../../ports';

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
    chat: { id: 'chat-1', threadId: 'thread-1', type: 'supergroup' },
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

describe('createTelegramBroadcastCommandHandler', () => {
  const createHandler = ({
    isAdmin = true,
    sendTextMock = vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
    enqueueMock,
  }: {
    isAdmin?: boolean;
    sendTextMock?: ReturnType<typeof vi.fn>;
    enqueueMock?: ReturnType<typeof vi.fn>;
  } = {}) => {
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(isAdmin) };
    const messaging: Pick<MessagingPort, 'sendText'> = {
      sendText: sendTextMock as unknown as MessagingPort['sendText'],
    };

    const enqueue = enqueueMock
      ?? vi.fn().mockImplementation(
        ({
          payload,
          requestedBy,
        }: {
          payload: BroadcastMessagePayload;
          requestedBy?: string;
        }) =>
          ({
            id: 'job-1',
            createdAt: new Date('2024-01-01T00:00:00.000Z'),
            updatedAt: new Date('2024-01-01T00:00:00.000Z'),
            requestedBy,
            status: 'pending',
            attempts: 0,
            payload,
          }) satisfies BroadcastJob,
      );

    const queue = { enqueue };

    const handler = createTelegramBroadcastCommandHandler({
      adminAccess,
      messaging,
      queue,
    });

    return { handler, adminAccess, sendTextMock, queue };
  };

  it('sends help message for /broadcast help', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, adminAccess } = createHandler({ sendTextMock });

    const response = await handler(createContext({ argument: 'help' }));

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('admin-1');
    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: [
        'Команды рассылок:',
        '- /broadcast help — показать эту подсказку.',
        '- /broadcast preview <текст> — отправить пробное сообщение только вам.',
        '- /broadcast send [--chat=<id>] [--user=<id>] [--lang=<code>] <текст> — поставить рассылку в очередь. Для сложных сценариев используйте HTTP POST /admin/broadcast.',
      ].join('\n'),
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ help: 'sent' });
  });

  it('ignores non-admin users', async () => {
    const sendTextMock = vi.fn();
    const { handler, adminAccess } = createHandler({ isAdmin: false, sendTextMock });

    const response = await handler(createContext({ argument: 'help' }));

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('admin-1');
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(response).toBeUndefined();
  });

  it('returns 400 when preview text is missing', async () => {
    const { handler } = createHandler();

    const response = await handler(createContext({ argument: 'preview' }));

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: 'Broadcast text must not be empty' });
  });

  it('sends preview message when text is provided', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({ messageId: 'preview-1' });
    const { handler } = createHandler({ sendTextMock });

    const response = await handler(createContext({ argument: 'preview hello world' }));

    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: 'hello world',
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ preview: 'sent', messageId: 'preview-1' });
  });

  it('validates filters for send intent', async () => {
    const { handler } = createHandler();

    const response = await handler(createContext({ argument: 'send hello world' }));

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: 'Укажите хотя бы один фильтр (--chat, --user или --lang), чтобы ограничить аудиторию.',
    });
  });

  it('enqueues job and notifies admin for send intent', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, queue } = createHandler({ sendTextMock });

    const response = await handler(
      createContext({ argument: 'send --chat=123,456 --lang=en hello world' }),
    );

    expect(queue.enqueue).toHaveBeenCalledWith({
      payload: {
        text: 'hello world',
        filters: { chatIds: ['123', '456'], languageCodes: ['en'] },
      },
      requestedBy: 'admin-1',
    });

    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: ['📣 Рассылка поставлена в очередь.', 'ID задачи: job-1', 'Проверить статус: /broadcast status'].join('\n'),
    });

    expect(response?.status).toBe(202);
    await expect(response?.json()).resolves.toEqual({
      status: 'queued',
      jobId: 'job-1',
      enqueuedAt: '2024-01-01T00:00:00.000Z',
      requestedBy: 'admin-1',
      filters: {
        chatIds: ['123', '456'],
        languageCodes: ['en'],
      },
    });
  });

  it('supports /admin broadcast namespace', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler } = createHandler({ sendTextMock });

    const response = await handler(
      createContext({ command: '/admin', argument: 'broadcast help' }),
    );

    expect(sendTextMock).toHaveBeenCalled();
    expect(response?.status).toBe(200);
  });
});
