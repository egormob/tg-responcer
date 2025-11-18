import { describe, expect, it, vi } from 'vitest';

import {
  BROADCAST_AUDIENCE_PROMPT,
  buildBroadcastPromptMessage,
  createTelegramBroadcastCommandHandler,
} from '../telegram-broadcast-command';
import type { BroadcastPendingKvNamespace } from '../telegram-broadcast-command';
import type { TelegramAdminCommandContext } from '../../../http';
import type { MessagingPort } from '../../../ports';
import type { IncomingMessage } from '../../../core';
import type { BroadcastSendResult, SendBroadcast } from '../minimal-broadcast-service';
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
      message_id: '1',
      chat: { id: '1' },
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

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

const createPendingKv = () => {
  const store = new Map<string, { value: string; expiration?: number }>();

  const kv: BroadcastPendingKvNamespace = {
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async put(key, value, options) {
      const expiration = Math.floor(Date.now() / 1000) + (options.expirationTtl ?? 0);
      store.set(key, { value, expiration });
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return {
        keys: Array.from(store.entries()).map(([name, entry]) => ({
          name,
          expiration: entry.expiration,
        })),
        list_complete: true,
        cursor: '',
      };
    },
  };

  return { kv, store };
};

describe('createTelegramBroadcastCommandHandler', () => {
  const createHandler = ({
    isAdmin = true,
    sendTextMock = vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
    sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 2,
      failed: 0,
      deliveries: [],
      recipients: 2,
      durationMs: 50,
      source: 'D1',
      sample: [],
      throttled429: 0,
    }),
    adminErrorRecorder,
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    recipients = [
      { chatId: 'subscriber-1', username: 'alice' },
      { chatId: 'subscriber-2', username: 'bob' },
      { chatId: 'subscriber-3', username: 'charlie' },
    ],
  }: {
    isAdmin?: boolean;
    sendTextMock?: ReturnType<typeof vi.fn>;
    sendBroadcastMock?: SendBroadcast;
    adminErrorRecorder?: AdminCommandErrorRecorder;
    logger?: { info?: (...args: unknown[]) => unknown; warn?: (...args: unknown[]) => unknown; error?: (...args: unknown[]) => unknown };
    recipients?: Array<{ chatId: string; username?: string }>;
  } = {}) => {
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(isAdmin) };
    const messaging: Pick<MessagingPort, 'sendText'> = {
      sendText: sendTextMock as unknown as MessagingPort['sendText'],
    };

    const recipientsRegistry = {
      listActiveRecipients: vi.fn().mockResolvedValue(recipients),
    };

    const exportLogKv = { put: vi.fn() };

    const handler = createTelegramBroadcastCommandHandler({
      adminAccess,
      messaging,
      sendBroadcast: sendBroadcastMock,
      now: () => new Date('2024-01-01T00:00:00Z'),
      logger,
      adminErrorRecorder,
      recipientsRegistry,
      exportLogKv,
    });

    return { handler, adminAccess, sendTextMock, sendBroadcastMock, logger, exportLogKv };
  };

  const startBroadcastFlow = async (
    handler: ReturnType<typeof createTelegramBroadcastCommandHandler>,
    selection = '/everybody',
  ) => {
    await handler.handleCommand(createContext());
    const selectionResult = await handler.handleMessage(createIncomingMessage(selection));
    expect(selectionResult).toBe('handled');
  };

  it('prompts admin for audience selection after /broadcast command', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, adminAccess } = createHandler({ sendTextMock });

    const response = await handler.handleCommand(createContext());

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('admin-1');
    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: BROADCAST_AUDIENCE_PROMPT,
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: 'awaiting_audience' });
  });

  it('ignores command when user is not an admin', async () => {
    const sendTextMock = vi.fn();
    const { handler, adminAccess } = createHandler({ isAdmin: false, sendTextMock });

    const response = await handler.handleCommand(createContext());

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('admin-1');
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(response).toBeUndefined();
  });

  it('sends broadcast when admin selects /everybody and provides valid text', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const deferred = createDeferred<BroadcastSendResult>();
    const sendBroadcastMock = vi
      .fn<Parameters<SendBroadcast>, ReturnType<SendBroadcast>>()
      .mockReturnValue(deferred.promise);

    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await startBroadcastFlow(handler);

    const waitUntil = vi.fn();
    const resultPromise = handler.handleMessage(
      createIncomingMessage('hello everyone'),
      { waitUntil },
    );

    await expect(resultPromise).resolves.toBe('handled');
    expect(sendTextMock).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildBroadcastPromptMessage(3),
    });
    expect(sendBroadcastMock).toHaveBeenCalledWith({
      text: 'hello everyone',
      requestedBy: 'admin-1',
      filters: undefined,
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const scheduled = waitUntil.mock.calls[0]?.[0];
    expect(typeof scheduled?.then).toBe('function');

    deferred.resolve({
      delivered: 3,
      failed: 0,
      deliveries: [],
      recipients: 3,
      durationMs: 120,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    await scheduled;

    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: '✅ Рассылка отправлена!',
    });
  });

  it('writes broadcast log with d1 source and mode', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, exportLogKv } = createHandler({
      sendTextMock,
      sendBroadcastMock: vi.fn().mockResolvedValue({
        delivered: 1,
        failed: 0,
        deliveries: [],
        recipients: 1,
        durationMs: 15,
        source: 'D1',
        sample: [{ chatId: 'subscriber-1', threadId: null, username: null, languageCode: null }],
        throttled429: 0,
      }) as unknown as SendBroadcast,
    });

    await startBroadcastFlow(handler);

    const waitUntil = vi.fn();
    await handler.handleMessage(createIncomingMessage('/send hello!'), { waitUntil });
    const scheduled = waitUntil.mock.calls[0]?.[0];
    expect(typeof scheduled?.then).toBe('function');
    await scheduled;

    expect(exportLogKv.put).toHaveBeenCalledWith(
      'broadcast:last',
      expect.any(String),
      { expirationTtl: 7 * 24 * 60 * 60 },
    );

    const payload = JSON.parse(exportLogKv.put.mock.calls[0]?.[1] ?? '{}');
    expect(payload).toMatchObject({
      mode: 'all',
      source: 'D1',
      not_found: [],
      delivered: 1,
      recipients: 1,
    });
    expect(payload.duration_ms).toBeGreaterThan(0);
  });

  it('deduplicates provided chat ids and usernames', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 1,
      failed: 0,
      deliveries: [],
      recipients: 1,
      durationMs: 25,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await handler.handleCommand(createContext());
    const selectionResult = await handler.handleMessage(
      createIncomingMessage('subscriber-2 @alice subscriber-2'),
    );
    expect(selectionResult).toBe('handled');

    expect(sendTextMock).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildBroadcastPromptMessage(2),
    });

    const result = await handler.handleMessage(createIncomingMessage('Segmented message'));
    expect(result).toBe('handled');

    expect(sendBroadcastMock).toHaveBeenCalledWith({
      text: 'Segmented message',
      requestedBy: 'admin-1',
      filters: { chatIds: ['subscriber-2', 'subscriber-1'] },
    });
  });

  it('reports unknown audience entries and keeps them in prompt', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 1,
      failed: 0,
      deliveries: [],
      recipients: 1,
      durationMs: 25,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await handler.handleCommand(createContext());
    const selectionResult = await handler.handleMessage(createIncomingMessage('missing-one subscriber-3'));
    expect(selectionResult).toBe('handled');

    expect(sendTextMock).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildBroadcastPromptMessage(1, ['missing-one']),
    });

    const result = await handler.handleMessage(createIncomingMessage('Check not found'));
    expect(result).toBe('handled');

    expect(sendBroadcastMock).toHaveBeenCalledWith({
      text: 'Check not found',
      requestedBy: 'admin-1',
      filters: { chatIds: ['subscriber-3'] },
    });
  });

  it('handles empty audience selection', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 0,
      failed: 0,
      deliveries: [],
      recipients: 0,
      durationMs: 10,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await handler.handleCommand(createContext());
    const selectionResult = await handler.handleMessage(createIncomingMessage('   '));
    expect(selectionResult).toBe('handled');

    expect(sendTextMock).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: BROADCAST_AUDIENCE_PROMPT,
    });
  });

  it('ignores incoming message from a different thread', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 3,
      failed: 0,
      deliveries: [],
      recipients: 3,
      durationMs: 30,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await startBroadcastFlow(handler);

    const result = await handler.handleMessage({
      ...createIncomingMessage('hello everyone'),
      chat: { id: 'chat-1', threadId: 'thread-2' },
    });

    expect(result).toBeUndefined();
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledTimes(2);
  });

  it('rejects empty broadcast text and asks to restart', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

    await startBroadcastFlow(handler);
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

    await startBroadcastFlow(handler);
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

    await startBroadcastFlow(handler);
    const result = await handler.handleMessage(createIncomingMessage('hello everyone'));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: 'Не удалось отправить рассылку. Попробуйте ещё раз позже или обратитесь к оператору.',
    });
  });

  it('warns admin about unsupported /admin broadcast usage', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

    const response = await handler.handleCommand(createContext({ command: '/admin', argument: 'broadcast status' }));

    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: 'Мгновенная рассылка доступна только через команду /broadcast без аргументов.',
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: 'unsupported_broadcast_subcommand' });

    const result = await handler.handleMessage(createIncomingMessage('продолжить диалог'));

    expect(result).toBeUndefined();
    expect(sendBroadcastMock).not.toHaveBeenCalled();

    const baseAliasResponse = await handler.handleCommand(createContext({ command: '/admin', argument: 'broadcast' }));

    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: 'Мгновенная рассылка доступна только через команду /broadcast без аргументов.',
    });
    await expect(baseAliasResponse?.json()).resolves.toEqual({ status: 'unsupported_broadcast_subcommand' });
  });

  it('cancels broadcast when admin sends /cancel', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

    await handler.handleCommand(createContext());
    const result = await handler.handleMessage(createIncomingMessage('/cancel'));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: '❌ Рассылка отменена. Чтобы отправить новое сообщение, снова выполните /broadcast.',
    });
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
  it('enables broadcast command by default even without BROADCAST_ENABLED flag', async () => {
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
      createQueuedMessagingPort: vi.fn((port) => port),
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

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            {
              chatId: 'subscriber-1',
              username: null,
              languageCode: null,
              createdAt: 1710000000,
              isBot: 0,
            },
          ],
        }),
      })),
    };

    const env = {
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_BOT_USERNAME: 'demo_bot',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-test',
      DB: db,
      ADMIN_EXPORT_LOG: { put: vi.fn() },
      ADMIN_TG_IDS: adminKv,
      ENV_VERSION: '1',
    } as Record<string, unknown>;

    const ctx = { waitUntil: vi.fn() } as { waitUntil(promise: Promise<unknown>): void };

    const commandUpdate = {
      update_id: 1,
      message: {
        message_id: '100',
        date: '1710000000',
        text: '/broadcast',
        entities: [{ type: 'bot_command', offset: 0, length: '/broadcast'.length }],
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
        message_thread_id: '77',
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
    await expect(commandResponse.json()).resolves.toEqual({ status: 'awaiting_audience' });
    expect(handleMessage).not.toHaveBeenCalled();
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: BROADCAST_AUDIENCE_PROMPT,
    });

    const audienceResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          update_id: 2,
          message: {
            message_id: '101',
            date: '1710000005',
            text: '/everybody',
            from: { id: 'admin-1', first_name: 'Admin' },
            chat: { id: 'chat-1', type: 'private' },
            message_thread_id: '77',
          },
        }),
      }),
      env,
      ctx,
    );

    expect(audienceResponse.status).toBe(200);
    await expect(audienceResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(messaging.sendText).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: buildBroadcastPromptMessage(1),
    });

    vi.resetModules();
  });

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
      createQueuedMessagingPort: vi.fn((port) => port),
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

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            {
              chatId: 'subscriber-1',
              username: null,
              languageCode: null,
              createdAt: 1710000000,
              isBot: 0,
            },
          ],
        }),
      })),
    };

    const env = {
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_BOT_USERNAME: 'demo_bot',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-test',
      BROADCAST_ENABLED: 'true',
      DB: db,
      ADMIN_EXPORT_LOG: { put: vi.fn() },
      ADMIN_TG_IDS: adminKv,
      ENV_VERSION: '1',
    } as Record<string, unknown>;

    const ctx = { waitUntil: vi.fn() } as { waitUntil(promise: Promise<unknown>): void };

    const commandUpdate = {
      update_id: 1,
      message: {
        message_id: '100',
        date: '1710000000',
        text: '/broadcast',
        entities: [{ type: 'bot_command', offset: 0, length: '/broadcast'.length }],
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
        message_thread_id: '77',
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
    await expect(commandResponse.json()).resolves.toEqual({ status: 'awaiting_audience' });
    expect(composeWorkerMock).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: BROADCAST_AUDIENCE_PROMPT,
    });

    const audienceResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          update_id: 2,
          message: {
            message_id: '101',
            date: '1710000005',
            text: '/everybody',
            from: { id: 'admin-1', first_name: 'Admin' },
            chat: { id: 'chat-1', type: 'private' },
            message_thread_id: '77',
          },
        }),
      }),
      env,
      ctx,
    );

    expect(audienceResponse.status).toBe(200);
    await expect(audienceResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(messaging.sendText).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: buildBroadcastPromptMessage(1),
    });

    messaging.sendText.mockClear();

    const recipientDeferred = createDeferred<{ messageId?: string } | void>();
    messaging.sendText.mockImplementation(({ chatId, threadId, text: messageText }) => {
      if (chatId === 'subscriber-1') {
        return recipientDeferred.promise;
      }

      return Promise.resolve({
        messageId: `sent-${chatId}-${threadId ?? 'null'}-${messageText.slice(0, 4)}`,
      });
    });

    const broadcastTextUpdate = {
      update_id: 3,
      message: {
        message_id: '102',
        date: '1710000010',
        text: 'Всем привет',
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
        message_thread_id: '77',
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
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);

    const backgroundTask = ctx.waitUntil.mock.calls[0]?.[0];
    expect(typeof backgroundTask?.then).toBe('function');

    expect(messaging.sendText).toHaveBeenNthCalledWith(1, {
      chatId: 'subscriber-1',
      threadId: undefined,
      text: 'Всем привет',
    });

    recipientDeferred.resolve({ messageId: 'delivered-1' });
    await backgroundTask;

    expect(messaging.sendText).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: '✅ Рассылка отправлена!',
    });

    expect(adminKv.get).toHaveBeenCalledWith('whitelist', 'text');

    vi.resetModules();
  });

  it('keeps pending broadcast after router cache reset and worker restart', async () => {
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
      createQueuedMessagingPort: vi.fn((port) => port),
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

    const pendingKv = createPendingKv();

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            {
              chatId: 'subscriber-1',
              username: null,
              languageCode: null,
              createdAt: 1710000000,
              isBot: 0,
            },
          ],
        }),
      })),
    };

    const env = {
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_BOT_USERNAME: 'demo_bot',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-test',
      DB: db,
      ADMIN_EXPORT_LOG: { put: vi.fn() },
      ADMIN_TG_IDS: adminKv,
      ENV_VERSION: '1',
      BROADCAST_PENDING_KV: pendingKv.kv,
    } as Record<string, unknown>;

    const ctx = { waitUntil: vi.fn() } as { waitUntil(promise: Promise<unknown>): void };

    const commandUpdate = {
      update_id: 1,
      message: {
        message_id: '100',
        date: '1710000000',
        text: '/broadcast',
        entities: [{ type: 'bot_command', offset: 0, length: '/broadcast'.length }],
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
      },
    };

    const audienceUpdate = {
      update_id: 2,
      message: {
        message_id: '101',
        date: '1710000005',
        text: '/everybody',
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
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
    await expect(commandResponse.json()).resolves.toEqual({ status: 'awaiting_audience' });
    expect(handleMessage).not.toHaveBeenCalled();

    module.__internal.clearRouterCache(env as never);
    module.__internal.clearBroadcastSessionStore(env as never);

    const audienceResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(audienceUpdate),
      }),
      env,
      ctx,
    );

    expect(audienceResponse.status).toBe(200);
    await expect(audienceResponse.json()).resolves.toEqual({ status: 'ok' });

    messaging.sendText.mockReset();
    const recipientDeferred = createDeferred<{ messageId?: string }>();
    messaging.sendText.mockImplementation(({ chatId, text }) => {
      if (chatId === 'subscriber-1') {
        return recipientDeferred.promise;
      }

      return Promise.resolve({ messageId: `sent-${chatId}-${text.slice(0, 4)}` });
    });

    const broadcastTextUpdate = {
      update_id: 3,
      message: {
        message_id: '102',
        date: '1710000010',
        text: 'Всем привет',
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
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
    expect(handleMessage).not.toHaveBeenCalled();
    expect(ctx.waitUntil).toHaveBeenCalled();

    const backgroundTask = ctx.waitUntil.mock.calls.at(-1)?.[0];
    expect(typeof backgroundTask?.then).toBe('function');

    recipientDeferred.resolve({ messageId: 'delivered-late' });
    await backgroundTask;

    expect(messaging.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'subscriber-1', text: 'Всем привет' }),
    );

    expect(messaging.sendText).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: undefined,
      text: '✅ Рассылка отправлена!',
    });

    vi.resetModules();
  });
});
