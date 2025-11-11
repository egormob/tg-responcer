import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DialogEngine } from '../../core/DialogEngine';
import type { MessagingPort, StoragePort } from '../../ports';
import { createTelegramWebhookHandler } from '../../features';
import { createTelegramBroadcastCommandHandler } from '../../features/broadcast';
import { createBindingsDiagnosticsRoute } from '../../features/admin-diagnostics/bindings-route';
import { createSelfTestRoute } from '../../features/admin-diagnostics/self-test-route';
import { createRouter, parseIncomingMessage, RATE_LIMIT_FALLBACK_TEXT } from '../router';
import * as telegramPayload from '../telegram-payload';
import { resetLastTelegramUpdateSnapshot } from '../telegram-webhook';

describe('http router', () => {
  beforeEach(() => {
    resetLastTelegramUpdateSnapshot();
  });

  const createDialogEngineMock = () => ({
    handleMessage: vi.fn(),
  }) as unknown as DialogEngine;

  const createMessagingMock = () => ({
    sendTyping: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({}),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  }) as unknown as MessagingPort;

  const createStorageMock = () => ({
    saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
  }) as unknown as StoragePort;

  const createDeferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { promise, resolve, reject };
  };

  const createTypingIndicatorMock = (messaging: ReturnType<typeof createMessagingMock>) => ({
    runWithTyping: vi.fn(async ({ chatId, threadId }, run) => {
      await messaging.sendTyping({ chatId, threadId });
      return run();
    }),
  });

  it('responds with ok for healthz route', async () => {
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
    });

    const response = await router.handle(new Request('https://example.com/healthz'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('returns 403 when webhook secret does not match', async () => {
    const dialogEngine = createDialogEngineMock();
    const router = createRouter({
      dialogEngine,
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/other', { method: 'POST', body: '{}' }),
    );

    expect(response.status).toBe(403);
    expect(dialogEngine.handleMessage).not.toHaveBeenCalled();
  });

  it('returns 500 when webhook secret is missing', async () => {
    const dialogEngine = createDialogEngineMock();
    const router = createRouter({ dialogEngine, messaging: createMessagingMock() });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', { method: 'POST', body: '{}' }),
    );

    expect(response.status).toBe(500);
  });

  it('passes parsed message to dialog engine for valid webhook request', async () => {
    const handleMessage = vi.fn().mockResolvedValue({
      status: 'replied',
      response: { text: 'ok', messageId: '123' },
    });
    const dialogEngine = { handleMessage } as unknown as DialogEngine;
    const router = createRouter({
      dialogEngine,
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
    });

    const payload = {
      user: { userId: 'user-1', username: 'demo' },
      chat: { id: 'chat-1', threadId: 'thread-9' },
      text: 'hello',
      messageId: 'mid-1',
      receivedAt: '2024-03-01T00:00:00.000Z',
    };

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: '123' });

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const message = handleMessage.mock.calls[0][0];
    expect(message.user.userId).toBe('user-1');
    expect(message.chat.threadId).toBe('thread-9');
    expect(message.receivedAt).toBeInstanceOf(Date);
  });

  it('sends fallback message when dialog engine signals rate limit without notifier', async () => {
    const handleMessage = vi.fn().mockResolvedValue({ status: 'rate_limited' });
    const messaging = createMessagingMock();
    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({
          user: { userId: 'user-2' },
          chat: { id: 'chat-2' },
          text: 'hello',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'rate_limited' });
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-2',
      threadId: undefined,
      text: RATE_LIMIT_FALLBACK_TEXT,
    });
  });

  it('preserves large identifiers when sending rate limit fallback', async () => {
    const handleMessage = vi.fn().mockResolvedValue({ status: 'rate_limited' });
    const messaging = createMessagingMock();
    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload: createTelegramWebhookHandler({
        storage: createStorageMock(),
      }),
    });

    const chatId = '-100123456789012345';
    const threadId = '9223372036854775808';
    const migrateToChatId = '-100987654321098765';
    const rawUpdate = JSON.stringify({
      update_id: '1',
      message: {
        message_id: '100',
        date: 1_710_000_000,
        text: 'hello',
        message_thread_id: threadId,
        migrate_to_chat_id: migrateToChatId,
        chat: {
          id: chatId,
          type: 'supergroup',
        },
        from: {
          id: '9223372036854775809',
          first_name: 'Thread',
        },
      },
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: rawUpdate,
      }),
    );

    expect(response.status).toBe(200);
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId,
      threadId,
      text: RATE_LIMIT_FALLBACK_TEXT,
    });

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const passedMessage = handleMessage.mock.calls[0]?.[0];
    expect(passedMessage).toBeDefined();
    if (!passedMessage) {
      throw new Error('Expected message to be passed to dialog engine');
    }
    expect(passedMessage.chat.id).toBe(chatId);
    expect(typeof passedMessage.chat.id).toBe('string');
    expect(passedMessage.chat.threadId).toBe(threadId);
    expect(passedMessage.user.userId).toBe('9223372036854775809');
    expect(passedMessage.messageId).toBe('100');
  });

  it('keeps large identifiers when invoking typing indicator for telegram updates', async () => {
    const messaging = createMessagingMock();
    messaging.sendTyping = vi.fn().mockResolvedValue(undefined);
    const typingIndicator = createTypingIndicatorMock(messaging);

    const handleMessage = vi.fn().mockResolvedValue({
      status: 'replied',
      response: { text: 'ok', messageId: '500' },
    });

    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload: createTelegramWebhookHandler({
        storage: createStorageMock(),
      }),
      typingIndicator,
    });

    const chatId = '-1002003004005006007';
    const threadId = '9223372036854775807';
    const rawUpdate = JSON.stringify({
      update_id: '42',
      message: {
        message_id: '600',
        date: 1_710_000_000,
        text: 'ping',
        message_thread_id: threadId,
        chat: {
          id: chatId,
          type: 'supergroup',
        },
        from: {
          id: '9223372036854775809',
          first_name: 'Stringer',
        },
      },
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: rawUpdate,
      }),
    );

    expect(response.status).toBe(200);
    expect(typingIndicator.runWithTyping).toHaveBeenCalledWith(
      { chatId, threadId },
      expect.any(Function),
    );
    expect(messaging.sendTyping).toHaveBeenCalledWith({ chatId, threadId });

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const message = handleMessage.mock.calls[0]?.[0];
    expect(message).toBeDefined();
    if (!message) {
      throw new Error('Expected message to be passed to dialog engine');
    }
    expect(message.chat.id).toBe(chatId);
    expect(message.chat.threadId).toBe(threadId);
    expect(message.user.userId).toBe('9223372036854775809');
  });

  it('returns bad request when transform detects unsafe telegram identifiers', async () => {
    const handleMessage = vi.fn().mockResolvedValue({ status: 'replied', response: { text: 'ok' } });
    const messaging = createMessagingMock();
    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload: createTelegramWebhookHandler({
        storage: createStorageMock(),
      }),
    });

    const unsafeUpdate = {
      update_id: 1,
      message: {
        message_id: '100',
        date: '1710000000',
        text: 'hello',
        chat: {
          id: Number.MAX_SAFE_INTEGER + 5,
          type: 'supergroup',
        },
        from: {
          id: '123',
          first_name: 'Unsafe',
        },
      },
    };

    const parseSpy = vi
      .spyOn(telegramPayload, 'parseTelegramUpdateBody')
      .mockReturnValueOnce(unsafeUpdate as unknown);

    try {
      const response = await router.handle(
        new Request('https://example.com/webhook/secret', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toContain('UNSAFE_TELEGRAM_ID');
      expect(messaging.sendText).not.toHaveBeenCalled();
      expect(handleMessage).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('uses notifier result to skip fallback when handled', async () => {
    const handleMessage = vi.fn().mockResolvedValue({ status: 'rate_limited' });
    const messaging = createMessagingMock();
    const notify = vi.fn(async ({ chatId, threadId }) => {
      await messaging.sendText({
        chatId,
        threadId,
        text: 'custom rate limit',
      });

      return { handled: true };
    });

    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
      rateLimitNotifier: { notify },
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({
          user: { userId: 'user-2' },
          chat: { id: 'chat-2' },
          text: 'hello',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'rate_limited' });

    expect(notify).toHaveBeenCalledWith({
      userId: 'user-2',
      chatId: 'chat-2',
      threadId: undefined,
    });

    expect(messaging.sendText).toHaveBeenCalledTimes(1);
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-2',
      threadId: undefined,
      text: 'custom rate limit',
    });
  });

  it('sends fallback when notifier does not handle notification', async () => {
    const handleMessage = vi.fn().mockResolvedValue({ status: 'rate_limited' });
    const messaging = createMessagingMock();
    const notify = vi.fn().mockResolvedValue({ handled: false });

    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
      rateLimitNotifier: { notify },
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({
          user: { userId: 'user-2' },
          chat: { id: 'chat-2' },
          text: 'hello',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'rate_limited' });
    expect(notify).toHaveBeenCalledWith({
      userId: 'user-2',
      chatId: 'chat-2',
      threadId: undefined,
    });
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-2',
      threadId: undefined,
      text: RATE_LIMIT_FALLBACK_TEXT,
    });
  });

  it('logs warning when notifier throws but still returns ok response', async () => {
    const handleMessage = vi.fn().mockResolvedValue({ status: 'rate_limited' });
    const notify = vi.fn().mockRejectedValue(new Error('notify failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messaging = createMessagingMock();

    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
      rateLimitNotifier: { notify },
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({
          user: { userId: 'user-3' },
          chat: { id: 'chat-3' },
          text: 'hello',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith('[router] rate limit notifier failed', expect.any(Error));
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-3',
      threadId: undefined,
      text: RATE_LIMIT_FALLBACK_TEXT,
    });

    warnSpy.mockRestore();
  });

  it('returns 400 for invalid payload', async () => {
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({ invalid: true }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(400);
  });

  it('sends reminder for voice-only webhook results and skips dialog', async () => {
    const messaging = createMessagingMock();
    const handleMessage = vi.fn();
    const transformPayload = vi
      .fn()
      .mockResolvedValue({
        kind: 'non_text',
        chat: { id: 'chat-voice', threadId: 'thread-1' },
        reply: 'voice',
      });

    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload,
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(transformPayload).toHaveBeenCalledTimes(1);
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-voice',
      threadId: 'thread-1',
      text: '🔇  👉📝',
    });
    expect(handleMessage).not.toHaveBeenCalled();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ignored' });
  });

  it('sends reminder for media-only webhook results and skips dialog', async () => {
    const messaging = createMessagingMock();
    const handleMessage = vi.fn();
    const transformPayload = vi
      .fn()
      .mockResolvedValue({
        kind: 'non_text',
        chat: { id: 'chat-media' },
        reply: 'media',
      });

    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload,
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(transformPayload).toHaveBeenCalledTimes(1);
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-media',
      threadId: undefined,
      text: '🖼️❌  👉📝',
    });
    expect(handleMessage).not.toHaveBeenCalled();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ignored' });
  });

  it('routes admin broadcast requests when handler is provided', async () => {
    const broadcast = vi.fn().mockResolvedValue(new Response('queued', { status: 202 }));
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'admin-token',
        broadcastToken: 'broadcast-token',
        broadcast,
      },
    });

    const response = await router.handle(
      new Request('https://example.com/admin/broadcast', {
        method: 'POST',
        headers: { 'x-admin-token': 'broadcast-token', 'x-admin-actor': 'ops' },
      }),
    );

    expect(response.status).toBe(202);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const passedRequest = broadcast.mock.calls[0][0];
    expect(passedRequest.headers.get('x-admin-token')).toBe('broadcast-token');
    expect(passedRequest.headers.get('x-admin-actor')).toBe('ops');
  });

  it('injects broadcast token from query string while preserving actor header', async () => {
    const broadcast = vi.fn().mockResolvedValue(new Response('queued', { status: 202 }));
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'admin-token',
        broadcastToken: 'broadcast-token',
        broadcast,
      },
    });

    const response = await router.handle(
      new Request('https://example.com/admin/broadcast?token=broadcast-token', {
        method: 'POST',
        headers: { 'x-admin-actor': 'ops' },
      }),
    );

    expect(response.status).toBe(202);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const passedRequest = broadcast.mock.calls[0][0];
    expect(passedRequest.headers.get('x-admin-token')).toBe('broadcast-token');
    expect(passedRequest.headers.get('x-admin-actor')).toBe('ops');
  });

  it('returns 404 for broadcast route when handler is missing', async () => {
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'admin-token',
      },
    });

    const response = await router.handle(
      new Request('https://example.com/admin/broadcast', {
        method: 'POST',
        headers: { 'x-admin-token': 'admin-token', 'x-admin-actor': 'ops' },
      }),
    );

    expect(response.status).toBe(404);
  });

  it('sends broadcast via telegram command and confirms delivery', async () => {
    const messaging = createMessagingMock();
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(true) };
    const deferred = createDeferred<{ delivered: number; failed: number; deliveries: unknown[] }>();
    const sendBroadcast = vi.fn().mockReturnValue(deferred.promise);

    const handler = createTelegramBroadcastCommandHandler({
      adminAccess,
      messaging,
      sendBroadcast,
      logger: console,
      now: () => new Date('2024-01-01T00:00:00Z'),
    });

    const transformPayload = createTelegramWebhookHandler({
      storage: createStorageMock(),
      features: {
        handleAdminCommand: (context) => handler.handleCommand(context),
        handleMessage: (message, featureContext) => handler.handleMessage(message, featureContext),
      },
    });

    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging,
      webhookSecret: 'secret',
      transformPayload,
    });

    const commandUpdate = {
      update_id: 2001,
      message: {
        message_id: '700',
        date: '1704067200',
        chat: { id: '4242', type: 'private' },
        from: { id: '1010', first_name: 'Admin' },
        text: '/broadcast',
        entities: [
          { type: 'bot_command', offset: 0, length: '/broadcast'.length },
        ],
      },
    };

    const textUpdate = {
      update_id: 2002,
      message: {
        message_id: '701',
        date: '1704067205',
        chat: { id: '4242', type: 'private' },
        from: { id: '1010', first_name: 'Admin' },
        text: 'привет всем',
      },
    };

    const commandResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(commandUpdate),
      }),
    );

    expect(commandResponse.status).toBe(200);
    await expect(commandResponse.json()).resolves.toEqual({ status: 'awaiting_text' });
    expect(adminAccess.isAdmin).toHaveBeenCalledWith('1010');
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: '4242',
      threadId: undefined,
      text: [
        'Введите текст рассылки (до 4096 символов).',
        'Следующее сообщение уйдёт всем получателям минимальной модели.',
      ].join('\n'),
    });

    const waitUntil = vi.fn();
    const textResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(textUpdate),
      }),
      { waitUntil },
    );

    expect(textResponse.status).toBe(200);
    await expect(textResponse.json()).resolves.toEqual({ status: 'ok' });

    expect(sendBroadcast).toHaveBeenCalledWith({
      text: 'привет всем',
      requestedBy: '1010',
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const backgroundTask = waitUntil.mock.calls[0]?.[0];
    expect(typeof backgroundTask?.then).toBe('function');

    expect(messaging.sendText).toHaveBeenNthCalledWith(2, {
      chatId: '4242',
      threadId: undefined,
      text: '📣 Рассылка запущена. Ожидайте отчёт о доставке.',
    });

    expect(messaging.sendText).toHaveBeenCalledTimes(2);

    deferred.resolve({ delivered: 2, failed: 0, deliveries: [] });
    await backgroundTask;

    expect(messaging.sendText).toHaveBeenCalledTimes(3);
    expect(messaging.sendText).toHaveBeenLastCalledWith({
      chatId: '4242',
      threadId: undefined,
      text: ['📣 Рассылка отправлена.', 'Получателей: 2.'].join('\n'),
    });
  });

  it('exposes parseIncomingMessage for custom transformations', () => {
    const result = parseIncomingMessage({
      user: { userId: 'user-1' },
      chat: { id: 'chat-1' },
      text: 'ping',
    });

    expect(result.user.userId).toBe('user-1');
    expect(result.chat.id).toBe('chat-1');
    expect(result.receivedAt).toBeInstanceOf(Date);
  });

  it('allows transformPayload to short-circuit handling', async () => {
    const handleMessage = vi.fn();
    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      transformPayload: async () => ({
        kind: 'handled',
        response: new Response('handled', { status: 202 }),
      }),
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('handled');
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('wraps dialog engine call with typing indicator when provided', async () => {
    const handleMessage = vi
      .fn<Parameters<DialogEngine['handleMessage']>, ReturnType<DialogEngine['handleMessage']>>()
      .mockResolvedValue({ status: 'replied', response: { text: 'ok' } });
    const typingIndicator = {
      runWithTyping: vi.fn(async (_context, run: () => Promise<unknown>) => run()),
    };

    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      typingIndicator: typingIndicator,
    });

    const payload = {
      user: { userId: 'user-typing' },
      chat: { id: 'chat-typing', threadId: 'thread-typing' },
      text: 'typing test',
    };

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    expect(typingIndicator.runWithTyping).toHaveBeenCalledTimes(1);
    expect(typingIndicator.runWithTyping).toHaveBeenCalledWith(
      { chatId: 'chat-typing', threadId: 'thread-typing' },
      expect.any(Function),
    );
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for admin export when handler is not configured', async () => {
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
    });

    const response = await router.handle(new Request('https://example.com/admin/export'));

    expect(response.status).toBe(404);
  });

  it('delegates admin export requests to provided handler', async () => {
    const exportHandler = vi.fn().mockResolvedValue(new Response('csv', { status: 200 }));
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'secret',
        export: exportHandler,
      },
    });

    const request = new Request('https://example.com/admin/export?limit=10', {
      headers: { 'x-admin-token': 'secret' },
    });

    await router.handle(request);

    expect(exportHandler).toHaveBeenCalledTimes(1);
    expect(exportHandler).toHaveBeenCalledWith(request);
  });

  it('authorizes admin handlers using query token', async () => {
    const exportHandler = vi.fn().mockResolvedValue(new Response('csv', { status: 200 }));
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'secret',
        export: exportHandler,
      },
    });

    const response = await router.handle(
      new Request('https://example.com/admin/export?token=secret', {
        headers: { 'x-admin-token': '' },
      }),
    );

    expect(response.status).toBe(200);
    expect(exportHandler).toHaveBeenCalledTimes(1);
    const passedRequest = exportHandler.mock.calls[0][0];
    expect(passedRequest.headers.get('x-admin-token')).toBe('secret');
  });

  it('accepts dedicated admin export token when different from global token', async () => {
    const exportHandler = vi.fn().mockResolvedValue(new Response('csv', { status: 200 }));
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'global-secret',
        exportToken: 'export-secret',
        export: exportHandler,
      },
    });

    const response = await router.handle(
      new Request('https://example.com/admin/export', {
        headers: { 'x-admin-token': 'export-secret' },
      }),
    );

    expect(response.status).toBe(200);
    expect(exportHandler).toHaveBeenCalledTimes(1);
    const passedRequest = exportHandler.mock.calls[0][0];
    expect(passedRequest.headers.get('x-admin-token')).toBe('export-secret');
  });

  it('enforces admin token for selftest route', async () => {
    const selfTest = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'secret',
        selfTest,
      },
    });

    const unauthorized = await router.handle(new Request('https://example.com/admin/selftest'));
    expect(unauthorized.status).toBe(401);

    const forbidden = await router.handle(
      new Request('https://example.com/admin/selftest', {
        headers: { 'x-admin-token': 'nope' },
      }),
    );
    expect(forbidden.status).toBe(403);

    const okResponse = await router.handle(
      new Request('https://example.com/admin/selftest?token=secret'),
    );
    expect(okResponse.status).toBe(200);
    expect(selfTest).toHaveBeenCalledTimes(1);
  });

  it('dispatches admin envz route with valid token', async () => {
    const envz = vi.fn().mockResolvedValue(new Response('env', { status: 200 }));
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'secret',
        envz,
      },
    });

    const response = await router.handle(
      new Request('https://example.com/admin/envz', {
        headers: { 'x-admin-token': 'secret' },
      }),
    );

    expect(response.status).toBe(200);
    expect(envz).toHaveBeenCalledTimes(1);
  });

  it('requires admin token for known users clear route', async () => {
    const knownUsersClear = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, cleared: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }));
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'secret',
        knownUsersClear,
      },
    });

    const unauthorized = await router.handle(
      new Request('https://example.com/admin/known-users/clear'),
    );
    expect(unauthorized.status).toBe(401);
    expect(knownUsersClear).not.toHaveBeenCalled();

    const response = await router.handle(
      new Request('https://example.com/admin/known-users/clear', {
        headers: { 'x-admin-token': 'secret' },
      }),
    );

    expect(response.status).toBe(200);
    expect(knownUsersClear).toHaveBeenCalledTimes(1);
  });

  it('delegates admin diag route when configured', async () => {
    const diag = vi.fn().mockResolvedValue(new Response('diag', { status: 200 }));
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'secret',
        diag,
      },
    });

    const response = await router.handle(
      new Request('https://example.com/admin/diag?q=bindings', {
        headers: { 'x-admin-token': 'secret' },
      }),
    );

    expect(response.status).toBe(200);
    expect(diag).toHaveBeenCalledTimes(1);
    const passedRequest = diag.mock.calls[0][0];
    expect(passedRequest.url).toContain('/admin/diag?q=bindings');
  });

  it('exposes snapshot fields on admin diagnostics routes even after sendTyping failures', async () => {
    const messaging = createMessagingMock();
    messaging.sendTyping = vi.fn().mockRejectedValue(new Error('typing unavailable'));
    messaging.sendText = vi.fn().mockResolvedValue({ messageId: 'abc' });

    const ai = {
      reply: vi.fn().mockResolvedValue({ text: 'pong', metadata: { usedOutputText: true } }),
    };

    const storage: StoragePort = {
      saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      getRecentMessages: vi.fn().mockResolvedValue([]),
    };

    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging,
      webhookSecret: 'secret',
      admin: {
        token: 'secret',
        selfTest: createSelfTestRoute({ ai, messaging, now: () => 0 }),
        diag: createBindingsDiagnosticsRoute({
          storage,
          env: { TELEGRAM_BOT_TOKEN: '123456:ABCDEF', OPENAI_API_KEY: 'sk-test' },
        }),
      },
    });

    const selfTestResponse = await router.handle(
      new Request('https://example.com/admin/selftest?chatId=999&token=secret'),
    );

    expect(selfTestResponse.status).toBe(200);
    const selfTestPayload = await selfTestResponse.json();

    expect(selfTestPayload.lastWebhookSnapshot).toEqual(
      expect.objectContaining({
        route: 'admin',
        sendTyping: expect.objectContaining({ ok: false }),
        failSoft: false,
      }),
    );
    expect(selfTestPayload.lastWebhookSnapshot.sendText).toBeUndefined();
    expect(selfTestPayload.telegramReason).toBe('send_failed');

    const diagResponse = await router.handle(
      new Request('https://example.com/admin/diag?q=bindings&token=secret'),
    );

    expect(diagResponse.status).toBe(200);
    const diagPayload = await diagResponse.json();
    expect(diagPayload.lastWebhookSnapshot).toEqual(
      expect.objectContaining({
        route: 'admin',
        sendTyping: expect.objectContaining({ ok: false }),
      }),
    );
  });
});
