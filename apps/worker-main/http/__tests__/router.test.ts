import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DialogEngine } from '../../core/DialogEngine';
import type { MessagingPort, StoragePort } from '../../ports';
import { createQueuedMessagingPort, type MessagingQuotaSharedState } from '../../adapters';
import { createTelegramWebhookHandler } from '../../features';
import {
  createTelegramBroadcastCommandHandler,
  BROADCAST_AUDIENCE_PROMPT,
  buildBroadcastPromptMessage,
  createImmediateBroadcastSender,
} from '../../features/broadcast';
import { createBindingsDiagnosticsRoute } from '../../features/admin-diagnostics/bindings-route';
import { createSelfTestRoute } from '../../features/admin-diagnostics/self-test-route';
import {
  AI_GUARD_WAIT_TEXT,
  createRouter,
  parseIncomingMessage,
  RATE_LIMIT_FALLBACK_TEXT,
} from '../router';
import { createSystemCommandRegistry } from '../system-commands';
import * as telegramPayload from '../telegram-payload';
import { resetLastTelegramUpdateSnapshot } from '../telegram-webhook';

describe('http router', () => {
  beforeEach(() => {
    resetLastTelegramUpdateSnapshot();
  }, 10000);

  const createDialogEngineMock = () => ({
    handleMessage: vi.fn(),
  }) as unknown as DialogEngine;

  const createMessagingMock = (overrides?: Partial<MessagingPort>) => ({
    sendTyping: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({}),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
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

  it('routes broadcast recipients admin endpoints', async () => {
    const list = vi.fn().mockResolvedValue(new Response('list-ok'));
    const upsert = vi.fn().mockResolvedValue(new Response('upsert-ok'));
    const deactivate = vi.fn().mockResolvedValue(new Response('delete-ok'));
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'admin-token',
        broadcastRecipients: { list, upsert, deactivate },
      },
    });

    const listResponse = await router.handle(
      new Request('https://example.com/admin/broadcast/recipients?token=admin-token'),
    );
    expect(list).toHaveBeenCalled();
    expect(listResponse.status).toBe(200);

    const upsertResponse = await router.handle(
      new Request('https://example.com/admin/broadcast/recipients', {
        method: 'POST',
        headers: { 'x-admin-token': 'admin-token' },
        body: JSON.stringify({ chatId: '100' }),
      }),
    );
    expect(upsert).toHaveBeenCalled();
    expect(upsertResponse.status).toBe(200);

    const deleteResponse = await router.handle(
      new Request('https://example.com/admin/broadcast/recipients/500?token=admin-token', {
        method: 'DELETE',
      }),
    );
    expect(deactivate).toHaveBeenCalledWith(expect.any(Request), '500');
    expect(deleteResponse.status).toBe(200);
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

  it('greets user locally on /start without invoking dialog engine', async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 'start-1' });
    const messaging = createMessagingMock({ sendText });
    const handleMessage = vi.fn();
    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
    });

    const payload = {
      user: { userId: 'user-1', firstName: 'Егор' },
      chat: { id: 'chat-1' },
      text: '/start src_TEST',
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
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: 'start-1' });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: undefined,
      text: 'Привет, Егор!',
    });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('falls back to generic greeting when first name missing', async () => {
    const sendText = vi.fn().mockResolvedValue({});
    const messaging = createMessagingMock({ sendText });
    const dialogEngine = createDialogEngineMock();
    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
    });

    const payload = {
      user: { userId: 'user-2' },
      chat: { id: 'chat-2', threadId: 'th-1' },
      text: '/start',
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
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: null });
    expect(sendText).toHaveBeenCalledWith({
      chatId: 'chat-2',
      threadId: 'th-1',
      text: 'Привет!',
    });
    expect(dialogEngine.handleMessage).not.toHaveBeenCalled();
  });

  it('skips duplicate /start when update_id processed already', async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 'start-dup' });
    const messaging = createMessagingMock({ sendText });
    const dialogEngine = createDialogEngineMock();
    const dedupKeys = new Set<string>();
    const startDedupeKv = {
      get: vi.fn(async (key: string) => (dedupKeys.has(key) ? '1' : null)),
      put: vi.fn(async (key: string) => {
        dedupKeys.add(key);
      }),
    };
    const storage = createStorageMock();
    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
      startDedupeKv,
      transformPayload: createTelegramWebhookHandler({
        storage,
      }),
    });

    const rawUpdate = {
      update_id: 123,
      message: {
        message_id: '200',
        date: 1_712_000_000,
        text: '/start src_DUP',
        chat: { id: 'chat-dup', type: 'private' },
        from: { id: 'user-dup', first_name: 'Дуплик' },
      },
    };

    const createStartRequest = () =>
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rawUpdate),
      });

    const firstResponse = await router.handle(createStartRequest());
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toEqual({ status: 'ok', messageId: 'start-dup' });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(startDedupeKv.put).toHaveBeenCalledWith(
      'dedup:start:123',
      '1',
      { expirationTtl: 60 },
    );

    const secondResponse = await router.handle(createStartRequest());
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toEqual({ status: 'ok', messageId: null });
    expect(startDedupeKv.get).toHaveBeenCalledTimes(1);
    expect(startDedupeKv.put).toHaveBeenCalledTimes(1);
  });

  it('skips dialog engine when transform marks message as system command', async () => {
    const handleMessage = vi.fn();
    const dialogEngine = { handleMessage } as unknown as DialogEngine;
    const messaging = createMessagingMock();
    const systemMessage = {
      user: { userId: 'user-3' },
      chat: { id: 'chat-3' },
      text: '/export',
      messageId: 'm-3',
      receivedAt: new Date('2024-03-02T00:00:00.000Z'),
    };
    const systemCommands = createSystemCommandRegistry();
    systemCommands.register('/export', 'user-3');
    const transformPayload = Object.assign(
      vi.fn().mockResolvedValue({ kind: 'message', message: systemMessage }),
      { systemCommands },
    );

    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload,
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({ any: 'payload' }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: null });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('treats unknown slash-prefixed text as regular message when not registered as system command', async () => {
    const handleMessage = vi.fn().mockResolvedValue({
      status: 'replied',
      response: { text: 'ok', messageId: '42' },
    });
    const dialogEngine = { handleMessage } as unknown as DialogEngine;
    const messaging = createMessagingMock();
    const systemCommands = createSystemCommandRegistry();
    const transformPayload = Object.assign(
      vi.fn().mockResolvedValue({
        kind: 'message',
        message: {
          user: { userId: 'user-4' },
          chat: { id: 'chat-4' },
          text: '/fff unknown',
          messageId: 'm-4',
          receivedAt: new Date('2024-03-02T01:00:00.000Z'),
        },
      }),
      { systemCommands },
    );

    const router = createRouter({
      dialogEngine,
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: '42' });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0]?.[0]?.text).toBe('/fff unknown');
  });

  it('handles /admin status locally when scoped role is confirmed', async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 'admin-ok-1' });
    const messaging = createMessagingMock({ sendText });
    const dialogEngine = createDialogEngineMock();
    const systemCommands = createSystemCommandRegistry();
    const transformPayload = Object.assign(
      vi.fn().mockResolvedValue({
        kind: 'message',
        message: {
          user: { userId: 'admin-1', firstName: 'Ирина' },
          chat: { id: 'chat-admin' },
          text: '/admin status',
          messageId: 'm-100',
          receivedAt: new Date('2024-05-01T00:00:00.000Z'),
        },
      }),
      { systemCommands },
    );

    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload,
      systemCommands,
      determineCommandRole: () => 'scoped',
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(sendText).toHaveBeenCalledWith({
      chatId: 'chat-admin',
      threadId: undefined,
      text: 'admin-ok',
    });
    expect(dialogEngine.handleMessage).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: 'admin-ok-1' });
    expect(systemCommands.isAllowed('/admin status', 'admin-1')).toBe(true);
  });

  it('rescues scoped commands via determineCommandRole when registry has no entry', async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 'admin-ok-2' });
    const messaging = createMessagingMock({ sendText });
    const dialogEngine = createDialogEngineMock();
    const systemCommands = createSystemCommandRegistry();
    const transformPayload = Object.assign(
      vi.fn().mockResolvedValue({
        kind: 'message',
        message: {
          user: { userId: 'admin-auto', firstName: 'AutoAdmin' },
          chat: { id: 'chat-auto' },
          text: '/admin status',
          messageId: 'm-150',
          receivedAt: new Date('2024-05-01T01:00:00.000Z'),
        },
      }),
      { systemCommands },
    );

    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload,
      systemCommands,
      determineCommandRole: () => 'scoped',
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: 'admin-ok-2' });
    expect(sendText).toHaveBeenCalledWith({
      chatId: 'chat-auto',
      threadId: undefined,
      text: 'admin-ok',
    });
    expect(systemCommands.isAllowed('/admin status', 'admin-auto')).toBe(true);
  });

  it('registers scoped system commands once and skips redundant role checks', async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 'admin-ok-5' });
    const messaging = createMessagingMock({ sendText });
    const dialogEngine = createDialogEngineMock();
    const systemCommands = createSystemCommandRegistry();
    const determineCommandRole = vi.fn().mockResolvedValue('scoped' as const);
    const transformPayload = Object.assign(
      vi.fn().mockResolvedValue({
        kind: 'message',
        message: {
          user: { userId: 'admin-once' },
          chat: { id: 'chat-once' },
          text: '/admin status',
          messageId: 'm-250',
          receivedAt: new Date('2024-05-04T00:00:00.000Z'),
        },
      }),
      { systemCommands },
    );

    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload,
      systemCommands,
      determineCommandRole,
    });

    const request = () =>
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

    const firstResponse = await router.handle(request());
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toEqual({ status: 'ok', messageId: 'admin-ok-5' });
    expect(determineCommandRole).toHaveBeenCalledTimes(1);
    expect(systemCommands.isAllowed('/admin status', 'admin-once')).toBe(true);

    const secondResponse = await router.handle(request());
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toEqual({ status: 'ok', messageId: 'admin-ok-5' });
    expect(determineCommandRole).toHaveBeenCalledTimes(1);
  });

  it('sends unauthorized hint when scoped command lacks role access', async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 'denied-1' });
    const messaging = createMessagingMock({ sendText });
    const dialogEngine = createDialogEngineMock();
    const systemCommands = createSystemCommandRegistry();
    const transformPayload = Object.assign(
      vi.fn().mockResolvedValue({
        kind: 'message',
        message: {
          user: { userId: 'admin-2' },
          chat: { id: 'chat-denied' },
          text: '/admin status',
          messageId: 'm-200',
          receivedAt: new Date('2024-05-02T00:00:00.000Z'),
        },
      }),
      { systemCommands },
    );

    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload,
      systemCommands,
      determineCommandRole: () => undefined,
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(sendText).toHaveBeenCalledTimes(1);
    const unauthorizedText = sendText.mock.calls[0]?.[0]?.text;
    expect(unauthorizedText).toBe('Эта команда доступна только администратору');
    expect(dialogEngine.handleMessage).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: null });
  });

  it('returns admin usage hints for bare /admin command', async () => {
    const sendText = vi.fn().mockResolvedValue({});
    const messaging = createMessagingMock({ sendText });
    const dialogEngine = createDialogEngineMock();
    const systemCommands = createSystemCommandRegistry();
    systemCommands.register('/admin', 'admin-3');
    const transformPayload = Object.assign(
      vi.fn().mockResolvedValue({
        kind: 'message',
        message: {
          user: { userId: 'admin-3' },
          chat: { id: 'chat-admin-3' },
          text: '/admin',
          messageId: 'm-300',
          receivedAt: new Date('2024-05-03T00:00:00.000Z'),
        },
      }),
      { systemCommands },
    );

    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload,
      systemCommands,
      determineCommandRole: () => 'scoped',
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(sendText).toHaveBeenCalledTimes(1);
    const hintText = sendText.mock.calls[0]?.[0]?.text;
    expect(hintText).toContain('Ой… 🧐 …');
    expect(hintText).toContain('Примеры');
    expect(hintText).toContain('/admin status');
    expect(dialogEngine.handleMessage).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: null });
  });

  it('sends short denial for non-admin /admin commands', async () => {
    const handleMessage = vi.fn().mockResolvedValue({
      status: 'replied',
      response: { text: 'ok', messageId: 'adm-1' },
    });
    const dialogEngine = { handleMessage } as unknown as DialogEngine;
    const messaging = createMessagingMock();
    const handleAdminCommand = vi.fn().mockResolvedValue(undefined);
    const transformPayload = createTelegramWebhookHandler({
      storage: createStorageMock(),
      features: { handleAdminCommand },
    });

    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload,
    });

    const update = {
      update_id: 3001,
      message: {
        message_id: '801',
        date: '1705000000',
        chat: { id: 'chat-5', type: 'private' },
        from: { id: 'user-5' },
        text: '/admin status',
        entities: [{ type: 'bot_command', offset: 0, length: '/admin'.length }],
      },
    };

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update),
      }),
    );

    expect(handleAdminCommand).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(messaging.sendTyping).toHaveBeenCalledWith({ chatId: 'chat-5', threadId: undefined });
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-5',
      threadId: undefined,
      text: 'Эта команда доступна только администратору',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: null });
  });

  it('sends typing and denial for /export when user is not admin', async () => {
    const handleMessage = vi.fn();
    const dialogEngine = { handleMessage } as unknown as DialogEngine;
    const messaging = createMessagingMock();

    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
    });

    const payload = {
      user: { userId: 'user-10' },
      chat: { id: 'chat-export' },
      text: '/export 2024-01-01',
      messageId: 'exp-1',
      receivedAt: '2024-05-01T00:00:00.000Z',
    };

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

    expect(handleMessage).not.toHaveBeenCalled();
    expect(messaging.sendTyping).toHaveBeenCalledWith({ chatId: 'chat-export', threadId: undefined });
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-export',
      threadId: undefined,
      text: 'Эта команда доступна только администратору',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: null });
  });

  it('routes неподдерживаемые команды в диалог', async () => {
    const handleMessage = vi.fn().mockResolvedValue({
      status: 'replied',
      response: { text: 'ok', messageId: 'cmd-2' },
    });
    const dialogEngine = { handleMessage } as unknown as DialogEngine;
    const messaging = createMessagingMock();
    const handleAdminCommand = vi
      .fn()
      .mockImplementation(async (context) => (context.argument === 'supported' ? new Response('ok') : undefined));
    const transformPayload = createTelegramWebhookHandler({
      storage: createStorageMock(),
      features: { handleAdminCommand },
    });

    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload,
    });

    const update = {
      update_id: 3002,
      message: {
        message_id: '802',
        date: '1705000100',
        chat: { id: 'chat-6', type: 'private' },
        from: { id: 'user-6' },
        text: '/admin unsupported',
        entities: [{ type: 'bot_command', offset: 0, length: '/admin'.length }],
      },
    };

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update),
      }),
    );

    expect(handleAdminCommand).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(messaging.sendTyping).toHaveBeenCalledWith({ chatId: 'chat-6', threadId: undefined });
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-6',
      threadId: undefined,
      text: 'Эта команда доступна только администратору',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: null });
  });

  it('sends unconfirmed admin commands from other users into dialog after admin success', async () => {
    const handleMessage = vi.fn().mockResolvedValue({
      status: 'replied',
      response: { text: 'ok', messageId: 'cmd-3' },
    });
    const dialogEngine = { handleMessage } as unknown as DialogEngine;
    const messaging = createMessagingMock();
    const handleAdminCommand = vi.fn(async (context) =>
      context.from.userId === 'admin-7' ? new Response('ok') : undefined,
    );
    const transformPayload = createTelegramWebhookHandler({
      storage: createStorageMock(),
      features: { handleAdminCommand },
    });

    const router = createRouter({
      dialogEngine,
      messaging,
      webhookSecret: 'secret',
      transformPayload,
    });

    const adminUpdate = {
      update_id: 4001,
      message: {
        message_id: '901',
        date: '1705000200',
        chat: { id: 'chat-7', type: 'private' },
        from: { id: 'admin-7' },
        text: '/admin status',
        entities: [{ type: 'bot_command', offset: 0, length: '/admin'.length }],
      },
    };

    const adminResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(adminUpdate),
      }),
    );

    expect(adminResponse.status).toBe(200);
    await expect(adminResponse.text()).resolves.toBe('ok');
    expect(handleAdminCommand).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();

    const outsiderUpdate = {
      ...adminUpdate,
      update_id: 4002,
      message: {
        ...adminUpdate.message,
        message_id: '902',
        from: { id: 'user-7' },
      },
    };

    const outsiderResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(outsiderUpdate),
      }),
    );

    expect(outsiderResponse.status).toBe(200);
    await expect(outsiderResponse.json()).resolves.toEqual({ status: 'ok', messageId: null });
    expect(handleAdminCommand).toHaveBeenCalledTimes(2);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(messaging.sendTyping).toHaveBeenCalledWith({ chatId: 'chat-7', threadId: undefined });
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-7',
      threadId: undefined,
      text: 'Эта команда доступна только администратору',
    });
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

  it('sends guard wait message when ai guard blocks the dialog', async () => {
    const handleMessage = vi.fn();
    const messaging = createMessagingMock();
    const aiGuard = {
      enter: vi.fn().mockResolvedValue({ status: 'blocked', reason: 'over_limit' }),
      release: vi.fn(),
      getStats: vi.fn(),
    };
    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
      aiGuard,
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({
          user: { userId: 'user-guard' },
          chat: { id: 'chat-guard' },
          text: 'hello',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'queued' });
    expect(aiGuard.enter).toHaveBeenCalledTimes(1);
    expect(aiGuard.release).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-guard',
      threadId: undefined,
      text: AI_GUARD_WAIT_TEXT,
    });
  });

  it('returns queued status when message is buffered by ai guard', async () => {
    const handleMessage = vi.fn();
    const messaging = createMessagingMock();
    const aiGuard = {
      enter: vi.fn().mockResolvedValue({
        status: 'buffered',
        ticket: { chatKey: 'chat-guard::', ticketId: 1, kvCounted: false },
      }),
      release: vi.fn(),
      getStats: vi.fn(),
    };
    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
      aiGuard,
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({
          user: { userId: 'user-guard' },
          chat: { id: 'chat-guard' },
          text: 'hello 2',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'queued', buffered: true });
    expect(aiGuard.enter).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(aiGuard.release).not.toHaveBeenCalled();
    expect(messaging.sendText).not.toHaveBeenCalled();
  });

  it('promotes buffered message after processing the active one', async () => {
    const handleMessage = vi
      .fn()
      .mockResolvedValue({ status: 'replied', response: { text: 'ok', messageId: 'm1' } });
    const messaging = createMessagingMock();
    const aiGuard = {
      enter: vi
        .fn()
        .mockResolvedValue({ status: 'proceed', ticket: { chatKey: 'chat-guard::', ticketId: 1, kvCounted: false } }),
      release: vi
        .fn()
        .mockResolvedValueOnce({
          ticket: { chatKey: 'chat-guard::', ticketId: 2, kvCounted: false },
          message: {
            user: { userId: 'user-guard' },
            chat: { id: 'chat-guard' },
            text: 'followup',
            receivedAt: new Date(),
          },
        })
        .mockResolvedValueOnce(null),
      getStats: vi.fn(),
    };

    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging,
      webhookSecret: 'secret',
      aiGuard,
    });

    const response = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        body: JSON.stringify({
          user: { userId: 'user-guard' },
          chat: { id: 'chat-guard' },
          text: 'hello',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', messageId: 'm1' });

    // handleMessage should be called for the initial message and for the promoted buffer.
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(aiGuard.release).toHaveBeenCalledTimes(2);
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

  it('sends broadcast via telegram command and confirms delivery', async () => {
    const messaging = createMessagingMock();
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(true) };
    const deferred = createDeferred<{ delivered: number; failed: number; deliveries: unknown[] }>();
    const sendBroadcast = vi.fn().mockReturnValue(deferred.promise);
    const pendingKvStore = new Map<string, string>();
    const pendingKv = {
      get: vi.fn(async (key: string) => pendingKvStore.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        pendingKvStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        pendingKvStore.delete(key);
      }),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    };
    const exportLogKv = { put: vi.fn().mockResolvedValue(undefined) };
    const recipientsRegistry = { listActiveRecipients: vi.fn().mockResolvedValue([{ chatId: 'r-1' }]) };

    const handler = createTelegramBroadcastCommandHandler({
      adminAccess,
      messaging,
      sendBroadcast,
      logger: console,
      now: () => new Date('2024-01-01T00:00:00Z'),
      recipientsRegistry,
      pendingKv,
      exportLogKv,
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

    const audienceUpdate = {
      update_id: 2002,
      message: {
        message_id: '701',
        date: '1704067205',
        chat: { id: '4242', type: 'private' },
        from: { id: '1010', first_name: 'Admin' },
        text: '/everybody',
      },
    };

    const textUpdate = {
      update_id: 2003,
      message: {
        message_id: '702',
        date: '1704067210',
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
    await expect(commandResponse.json()).resolves.toEqual({ status: 'awaiting_audience' });
    expect(adminAccess.isAdmin).toHaveBeenCalledWith('1010');
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: '4242',
      threadId: undefined,
      text: BROADCAST_AUDIENCE_PROMPT,
    });

    const audienceResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(audienceUpdate),
      }),
    );

    expect(audienceResponse.status).toBe(200);
    await expect(audienceResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: '4242',
      threadId: undefined,
      text: buildBroadcastPromptMessage(1),
    });

    const sendUpdate = {
      update_id: 2004,
      message: {
        message_id: '703',
        date: '1704067212',
        chat: { id: '4242', type: 'private' },
        from: { id: '1010', first_name: 'Admin' },
        text: '/send',
        entities: [{ type: 'bot_command', offset: 0, length: '/send'.length }],
      },
    };

    const textWaitUntil = vi.fn();
    const textResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(textUpdate),
      }),
      { waitUntil: textWaitUntil },
    );

    expect(textResponse.status).toBe(200);
    await expect(textResponse.json()).resolves.toEqual({ status: 'ok' });

    const textBackgroundTask = textWaitUntil.mock.calls.at(-1)?.[0];
    expect(typeof textBackgroundTask?.then).toBe('function');
    if (textBackgroundTask) {
      await textBackgroundTask;
    }

    expect(messaging.sendText.mock.calls.length).toBe(3);
    expect(messaging.sendText).toHaveBeenLastCalledWith({
      chatId: '4242',
      threadId: undefined,
      text: expect.stringContaining('/send'),
    });

    const sendWaitUntil = vi.fn();
    const sendResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sendUpdate),
      }),
      { waitUntil: sendWaitUntil },
    );

    expect(sendWaitUntil).toHaveBeenCalledTimes(1);
    const backgroundTask = sendWaitUntil.mock.calls[0]?.[0];
    expect(typeof backgroundTask?.then).toBe('function');

    expect(sendResponse.status).toBe(200);
    await expect(sendResponse.json()).resolves.toEqual({ status: 'ok' });

    deferred.resolve({ delivered: 2, failed: 0, deliveries: [] });
    await backgroundTask;

    expect(messaging.sendText.mock.calls.length).toBe(4);
    expect(messaging.sendText).toHaveBeenLastCalledWith({
      chatId: '4242',
      threadId: undefined,
      text: expect.stringContaining('✅ Рассылка отправлена:'),
    });
  });

  it('keeps dialog responses snappy while broadcast queue is busy', async () => {
    const sharedState: MessagingQuotaSharedState = {
      queue: { high: [], normal: [] },
      active: 0,
      recentStarts: [],
      observedMaxQueue: 0,
    };

    const pendingBroadcastSends: Array<ReturnType<typeof createDeferred<{ messageId?: string }>>> = [];

    const sendText = vi.fn((input: Parameters<MessagingPort['sendText']>[0]) => {
      if (input.chatId === 'admin-chat') {
        return Promise.resolve({ messageId: 'admin-reply' });
      }

      if (input.chatId === 'dialog-chat') {
        return Promise.resolve({ messageId: 'dialog-reply' });
      }

      const deferred = createDeferred<{ messageId?: string }>();
      pendingBroadcastSends.push(deferred);
      return deferred.promise;
    });

    const messagingAdapter = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText,
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as MessagingPort;

    const broadcastMessaging = createQueuedMessagingPort(messagingAdapter, {
      maxParallel: 2,
      maxRps: 10,
      logger: console,
      sharedState,
    });

    const dialogMessaging = createQueuedMessagingPort(messagingAdapter, {
      maxParallel: 2,
      maxRps: 10,
      logger: console,
      sharedState,
      priority: 'high',
    });

    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(true) };
    const sendBroadcast = createImmediateBroadcastSender({
      messaging: dialogMessaging,
      messagingBroadcast: broadcastMessaging,
      recipients: [{ chatId: 'broadcast-1' }],
      logger: console,
      pool: { concurrency: 1 },
    });
    const pendingKvStore = new Map<string, string>();
    const pendingKv = {
      get: vi.fn(async (key: string) => pendingKvStore.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        pendingKvStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        pendingKvStore.delete(key);
      }),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    };

    const handler = createTelegramBroadcastCommandHandler({
      adminAccess,
      messaging: dialogMessaging,
      sendBroadcast,
      logger: console,
      now: () => new Date('2024-01-01T00:00:00Z'),
      recipientsRegistry: { listActiveRecipients: vi.fn().mockResolvedValue([{ chatId: 'broadcast-1' }]) },
      pendingKv,
    });

    const transformPayload = createTelegramWebhookHandler({
      storage: createStorageMock(),
      features: {
        handleAdminCommand: (context) => handler.handleCommand(context),
        handleMessage: (message, featureContext) => handler.handleMessage(message, featureContext),
      },
    });

    const dialogEngine = {
      handleMessage: vi.fn(async (message: Parameters<DialogEngine['handleMessage']>[0]) => {
        await dialogMessaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: 'dialog-ok',
        });

        return {
          status: 'replied',
          response: { text: 'dialog-ok', messageId: 'dialog-1' },
        };
      }),
    } as unknown as DialogEngine;

    const router = createRouter({
      dialogEngine,
      messaging: dialogMessaging,
      webhookSecret: 'secret',
      transformPayload,
      systemCommands: transformPayload.systemCommands,
      typingIndicator: createTypingIndicatorMock(dialogMessaging),
    });

    const commandUpdate = {
      update_id: 3001,
      message: {
        message_id: '900',
        date: '1704067200',
        chat: { id: 'admin-chat', type: 'private' },
        from: { id: '2020', first_name: 'Admin' },
        text: '/broadcast',
        entities: [
          { type: 'bot_command', offset: 0, length: '/broadcast'.length },
        ],
      },
    };

    const audienceUpdate = {
      update_id: 3002,
      message: {
        message_id: '901',
        date: '1704067205',
        chat: { id: 'admin-chat', type: 'private' },
        from: { id: '2020', first_name: 'Admin' },
        text: '/everybody',
      },
    };

    const textUpdate = {
      update_id: 3003,
      message: {
        message_id: '902',
        date: '1704067210',
        chat: { id: 'admin-chat', type: 'private' },
        from: { id: '2020', first_name: 'Admin' },
        text: 'announcement',
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
    await expect(commandResponse.json()).resolves.toEqual({ status: 'awaiting_audience' });
    expect(sendText).toHaveBeenCalledWith({
      chatId: 'admin-chat',
      threadId: undefined,
      text: BROADCAST_AUDIENCE_PROMPT,
    });

    const audienceResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(audienceUpdate),
      }),
    );

    expect(audienceResponse.status).toBe(200);
    await expect(audienceResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(sendText).toHaveBeenCalledWith({
      chatId: 'admin-chat',
      threadId: undefined,
      text: buildBroadcastPromptMessage(1),
    });

    const sendUpdate = {
      update_id: 3004,
      message: {
        message_id: '903',
        date: '1704067212',
        chat: { id: 'admin-chat', type: 'private' },
        from: { id: '2020', first_name: 'Admin' },
        text: '/send',
        entities: [{ type: 'bot_command', offset: 0, length: '/send'.length }],
      },
    };

    const textWaitUntil = vi.fn();
    const textResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(textUpdate),
      }),
      { waitUntil: textWaitUntil },
    );

    expect(textResponse.status).toBe(200);
    await expect(textResponse.json()).resolves.toEqual({ status: 'ok' });

    const textBackgroundTask = textWaitUntil.mock.calls.at(-1)?.[0];
    expect(typeof textBackgroundTask?.then).toBe('function');
    if (textBackgroundTask) {
      await textBackgroundTask;
    }

    const sendWaitUntil = vi.fn();
    const sendResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sendUpdate),
      }),
      { waitUntil: sendWaitUntil },
    );

    expect(sendResponse.status).toBe(200);
    await expect(sendResponse.json()).resolves.toEqual({ status: 'ok' });

    expect(sendWaitUntil).toHaveBeenCalledTimes(1);
    const backgroundTask = sendWaitUntil.mock.calls[0]?.[0];
    expect(typeof backgroundTask?.then).toBe('function');

    const userResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          update_id: 3005,
          message: {
            message_id: '904',
            date: '1704067216',
            chat: { id: 'dialog-chat', type: 'private' },
            from: { id: '3030', first_name: 'User' },
            text: 'ping',
          },
        }),
      }),
    );

    expect(userResponse.status).toBe(200);
    await expect(userResponse.json()).resolves.toEqual({ status: 'ok', messageId: 'dialog-1' });
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'dialog-chat', text: 'dialog-ok' }),
    );

    if (backgroundTask) {
      pendingBroadcastSends.forEach((deferred, index) => deferred.resolve({ messageId: `broadcast-${index}` }));
      await Promise.race([backgroundTask, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
  });

  it('keeps broadcast deliveries running in parallel with dialog replies', async () => {
    const sharedState: MessagingQuotaSharedState = {
      queue: { high: [], normal: [] },
      active: 0,
      recentStarts: [],
      observedMaxQueue: 0,
    };

    const pendingBroadcastSends: Array<ReturnType<typeof createDeferred<{ messageId?: string }>>> = [];
    const sendEvents: string[] = [];

    const sendText = vi.fn((input: Parameters<MessagingPort['sendText']>[0]) => {
      sendEvents.push(input.chatId);

      if (input.chatId === 'admin-chat') {
        return Promise.resolve({ messageId: 'admin-reply' });
      }

      if (input.chatId === 'dialog-chat') {
        return Promise.resolve({ messageId: 'dialog-reply' });
      }

      const deferred = createDeferred<{ messageId?: string }>();
      pendingBroadcastSends.push(deferred);
      return deferred.promise;
    });

    const messagingAdapter = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText,
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as MessagingPort;

    const broadcastMessaging = createQueuedMessagingPort(messagingAdapter, {
      maxParallel: 3,
      maxRps: 10,
      logger: console,
      sharedState,
    });

    const dialogMessaging = createQueuedMessagingPort(messagingAdapter, {
      maxParallel: 3,
      maxRps: 10,
      logger: console,
      sharedState,
      priority: 'high',
    });

    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(true) };
    const sendBroadcast = createImmediateBroadcastSender({
      messaging: dialogMessaging,
      messagingBroadcast: broadcastMessaging,
      recipients: [
        { chatId: 'broadcast-1' },
        { chatId: 'broadcast-2' },
      ],
      logger: console,
      pool: { concurrency: 2 },
    });
    const pendingKvStore = new Map<string, string>();
    const pendingKv = {
      get: vi.fn(async (key: string) => pendingKvStore.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        pendingKvStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        pendingKvStore.delete(key);
      }),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    };

    const handler = createTelegramBroadcastCommandHandler({
      adminAccess,
      messaging: dialogMessaging,
      sendBroadcast,
      logger: console,
      now: () => new Date('2024-01-01T00:00:00Z'),
      recipientsRegistry: {
        listActiveRecipients: vi.fn().mockResolvedValue([
          { chatId: 'broadcast-1' },
          { chatId: 'broadcast-2' },
        ]),
      },
      pendingKv,
    });

    const transformPayload = createTelegramWebhookHandler({
      storage: createStorageMock(),
      features: {
        handleAdminCommand: (context) => handler.handleCommand(context),
        handleMessage: (message, featureContext) => handler.handleMessage(message, featureContext),
      },
    });

    const dialogEngine = {
      handleMessage: vi.fn(async (message: Parameters<DialogEngine['handleMessage']>[0]) => {
        await dialogMessaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: 'dialog-ok',
        });

        return {
          status: 'replied',
          response: { text: 'dialog-ok', messageId: 'dialog-1' },
        };
      }),
    } as unknown as DialogEngine;

    const router = createRouter({
      dialogEngine,
      messaging: dialogMessaging,
      webhookSecret: 'secret',
      transformPayload,
      systemCommands: transformPayload.systemCommands,
      typingIndicator: createTypingIndicatorMock(dialogMessaging),
    });

    const commandUpdate = {
      update_id: 3101,
      message: {
        message_id: '950',
        date: '1704067200',
        chat: { id: 'admin-chat', type: 'private' },
        from: { id: '2040', first_name: 'Admin' },
        text: '/broadcast',
        entities: [
          { type: 'bot_command', offset: 0, length: '/broadcast'.length },
        ],
      },
    };

    const audienceUpdate = {
      update_id: 3102,
      message: {
        message_id: '951',
        date: '1704067205',
        chat: { id: 'admin-chat', type: 'private' },
        from: { id: '2040', first_name: 'Admin' },
        text: '/everybody',
      },
    };

    const textUpdate = {
      update_id: 3103,
      message: {
        message_id: '952',
        date: '1704067210',
        chat: { id: 'admin-chat', type: 'private' },
        from: { id: '2040', first_name: 'Admin' },
        text: 'parallel announcement',
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
    await expect(commandResponse.json()).resolves.toEqual({ status: 'awaiting_audience' });
    expect(sendText).toHaveBeenCalledWith({
      chatId: 'admin-chat',
      threadId: undefined,
      text: BROADCAST_AUDIENCE_PROMPT,
    });

    const audienceResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(audienceUpdate),
      }),
    );

    expect(audienceResponse.status).toBe(200);
    await expect(audienceResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(sendText).toHaveBeenCalledWith({
      chatId: 'admin-chat',
      threadId: undefined,
      text: buildBroadcastPromptMessage(2),
    });

    const textWaitUntil = vi.fn();
    const textResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(textUpdate),
      }),
      { waitUntil: textWaitUntil },
    );

    expect(textResponse.status).toBe(200);
    await expect(textResponse.json()).resolves.toEqual({ status: 'ok' });
    const textBackgroundTask = textWaitUntil.mock.calls.at(-1)?.[0];
    expect(typeof textBackgroundTask?.then).toBe('function');
    if (textBackgroundTask) {
      await textBackgroundTask;
    }

    const sendUpdate = {
      update_id: 3104,
      message: {
        message_id: '953',
        date: '1704067212',
        chat: { id: 'admin-chat', type: 'private' },
        from: { id: '2040', first_name: 'Admin' },
        text: '/send',
        entities: [{ type: 'bot_command', offset: 0, length: '/send'.length }],
      },
    };

    const sendWaitUntil = vi.fn();
    const sendResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sendUpdate),
      }),
      { waitUntil: sendWaitUntil },
    );

    expect(sendResponse.status).toBe(200);
    await expect(sendResponse.json()).resolves.toEqual({ status: 'ok' });

    expect(sendWaitUntil).toHaveBeenCalledTimes(1);
    const backgroundTask = sendWaitUntil.mock.calls[0]?.[0];
    expect(typeof backgroundTask?.then).toBe('function');

    for (let attempt = 0; attempt < 5 && pendingBroadcastSends.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pendingBroadcastSends.length).toBeGreaterThanOrEqual(1);
    expect(sharedState.active).toBeGreaterThanOrEqual(1);

    const userResponse = await router.handle(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          update_id: 3105,
          message: {
            message_id: '954',
            date: '1704067216',
            chat: { id: 'dialog-chat', type: 'private' },
            from: { id: '3050', first_name: 'User' },
            text: 'ping',
          },
        }),
      }),
    );

    expect(userResponse.status).toBe(200);
    await expect(userResponse.json()).resolves.toEqual({ status: 'ok', messageId: 'dialog-1' });
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'dialog-chat', text: 'dialog-ok' }),
    );

    const broadcastSends = sendEvents.filter((chatId) => chatId.startsWith('broadcast-'));
    expect(broadcastSends.length).toBeGreaterThanOrEqual(1);
    expect(sendEvents).toContain('dialog-chat');

    if (backgroundTask) {
      pendingBroadcastSends.forEach((deferred, index) => deferred.resolve({ messageId: `broadcast-${index}` }));
      await Promise.race([backgroundTask, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
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

  it('returns 404 for d1 stress route when not configured', async () => {
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'secret',
      },
    });

    const response = await router.handle(
      new Request('https://example.com/admin/d1-stress', {
        method: 'POST',
        headers: { 'x-admin-token': 'secret' },
      }),
    );

    expect(response.status).toBe(404);
  });

  it('requires admin token for d1 stress route', async () => {
    const d1Stress = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }));
    const router = createRouter({
      dialogEngine: createDialogEngineMock(),
      messaging: createMessagingMock(),
      webhookSecret: 'secret',
      admin: {
        token: 'secret',
        d1Stress,
      },
    });

    const unauthorized = await router.handle(
      new Request('https://example.com/admin/d1-stress', { method: 'POST' }),
    );
    expect(unauthorized.status).toBe(401);
    expect(d1Stress).not.toHaveBeenCalled();

    const response = await router.handle(
      new Request('https://example.com/admin/d1-stress', {
        method: 'POST',
        headers: { 'x-admin-token': 'secret' },
      }),
    );

    expect(response.status).toBe(200);
    expect(d1Stress).toHaveBeenCalledTimes(1);
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
