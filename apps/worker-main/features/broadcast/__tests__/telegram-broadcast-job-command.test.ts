import { describe, expect, it, vi } from 'vitest';

import type { TelegramAdminCommandContext } from '../../../http';
import type { AdminAccess } from '../../admin-access';
import type { BroadcastJob, BroadcastQueue } from '../broadcast-queue';
import { createTelegramBroadcastJobCommandHandler } from '../telegram-broadcast-job-command';

const createJob = (overrides: Partial<BroadcastJob> = {}): BroadcastJob => ({
  id: 'job-1',
  createdAt: new Date('2024-05-01T10:00:00Z'),
  updatedAt: new Date('2024-05-01T10:00:00Z'),
  requestedBy: 'ops',
  status: 'pending',
  attempts: 0,
  payload: {
    text: 'hello',
    metadata: {
      targetMessage: {
        chatId: 'dest-chat',
        messageId: '321',
        sentAt: '2024-05-01T10:00:00Z',
      },
    },
  },
  ...overrides,
});

const createContext = (
  overrides: Partial<TelegramAdminCommandContext> = {},
): TelegramAdminCommandContext => ({
  command: '/broadcast',
  rawCommand: '/broadcast',
  argument: 'edit job-1 Обновление',
  text: '/broadcast edit job-1 Обновление',
  chat: { id: 'admin-chat' },
  from: { userId: 'admin-1' },
  messageId: '555',
  update: {} as TelegramAdminCommandContext['update'],
  message: {} as TelegramAdminCommandContext['message'],
  incomingMessage: overrides.incomingMessage ?? ({} as TelegramAdminCommandContext['incomingMessage']),
  ...overrides,
});

describe('createTelegramBroadcastJobCommandHandler', () => {
  it('edits broadcast message when command is valid', async () => {
    const job = createJob();
    const queue: Pick<BroadcastQueue, 'getJob'> = {
      getJob: vi.fn().mockReturnValue(job),
    };
    const adminAccess: AdminAccess = {
      isAdmin: vi.fn().mockResolvedValue(true),
    } as AdminAccess;
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const handler = createTelegramBroadcastJobCommandHandler({
      adminAccess,
      queue,
      messaging: { editMessageText, deleteMessage: vi.fn() },
      now: () => new Date('2024-05-02T09:00:00Z'),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const response = await handler(createContext({ argument: 'edit job-1 Новый текст' }));

    expect(editMessageText).toHaveBeenCalledWith({
      chatId: 'dest-chat',
      threadId: undefined,
      messageId: '321',
      text: 'Новый текст',
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: 'edited', jobId: 'job-1', messageId: '321' });
  });

  it('supports /admin broadcast namespace for cancel command', async () => {
    const job = createJob();
    const queue: Pick<BroadcastQueue, 'getJob'> = {
      getJob: vi.fn().mockReturnValue(job),
    };
    const adminAccess: AdminAccess = {
      isAdmin: vi.fn().mockResolvedValue(true),
    } as AdminAccess;
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const handler = createTelegramBroadcastJobCommandHandler({
      adminAccess,
      queue,
      messaging: { editMessageText: vi.fn(), deleteMessage },
      now: () => new Date('2024-05-01T12:00:00Z'),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const context = createContext({
      command: '/admin',
      rawCommand: '/admin',
      argument: 'broadcast cancel job-1',
    });

    const response = await handler(context);

    expect(deleteMessage).toHaveBeenCalledWith({
      chatId: 'dest-chat',
      threadId: undefined,
      messageId: '321',
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: 'cancelled', jobId: 'job-1', messageId: '321' });
  });

  it('returns undefined for non-admin users', async () => {
    const queue: Pick<BroadcastQueue, 'getJob'> = {
      getJob: vi.fn(),
    };
    const adminAccess: AdminAccess = {
      isAdmin: vi.fn().mockResolvedValue(false),
    } as AdminAccess;
    const handler = createTelegramBroadcastJobCommandHandler({
      adminAccess,
      queue,
      messaging: { editMessageText: vi.fn(), deleteMessage: vi.fn() },
    });

    const result = await handler(createContext());

    expect(result).toBeUndefined();
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it('rejects commands when message is older than 48 hours', async () => {
    const job = createJob({
      payload: {
        text: 'hello',
        metadata: {
          targetMessage: {
            chatId: 'dest-chat',
            messageId: '321',
            sentAt: '2024-04-28T09:00:00Z',
          },
        },
      },
    });
    const warn = vi.fn();
    const handler = createTelegramBroadcastJobCommandHandler({
      adminAccess: { isAdmin: vi.fn().mockResolvedValue(true) } as AdminAccess,
      queue: { getJob: vi.fn().mockReturnValue(job) },
      messaging: { editMessageText: vi.fn(), deleteMessage: vi.fn() },
      now: () => new Date('2024-05-01T12:00:00Z'),
      logger: { warn },
    });

    const response = await handler(createContext({ argument: 'cancel job-1' }));

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: 'Нельзя удалить сообщение рассылки старше 48 часов.',
    });
    expect(warn).toHaveBeenCalledWith('broadcast job command rejected due to age limit', expect.any(Object));
  });

  it('returns error when metadata is missing', async () => {
    const job = createJob({
      payload: { text: 'hello', metadata: {} },
    });
    const handler = createTelegramBroadcastJobCommandHandler({
      adminAccess: { isAdmin: vi.fn().mockResolvedValue(true) } as AdminAccess,
      queue: { getJob: vi.fn().mockReturnValue(job) },
      messaging: { editMessageText: vi.fn(), deleteMessage: vi.fn() },
    });

    const response = await handler(createContext({ argument: 'edit job-1 Текст' }));

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: 'Для рассылки отсутствуют данные о сообщении.' });
  });
});
