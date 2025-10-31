import { describe, expect, it, vi } from 'vitest';

import type { DialogEngine } from '../../core/DialogEngine';
import type { MessagingPort } from '../../ports';
import { createRouter, parseIncomingMessage } from '../router';

describe('http router', () => {
  const createDialogEngineMock = () => ({
    handleMessage: vi.fn(),
  }) as unknown as DialogEngine;

  const createMessagingMock = () => ({
    sendTyping: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({}),
  }) as unknown as MessagingPort;

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

  it('returns ok payload when dialog engine signals rate limit', async () => {
    const handleMessage = vi.fn().mockResolvedValue({ status: 'rate_limited' });
    const notify = vi.fn().mockResolvedValue(undefined);
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
  });

  it('logs warning when notifier throws but still returns ok response', async () => {
    const handleMessage = vi.fn().mockResolvedValue({ status: 'rate_limited' });
    const notify = vi.fn().mockRejectedValue(new Error('notify failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const router = createRouter({
      dialogEngine: { handleMessage } as unknown as DialogEngine,
      messaging: createMessagingMock(),
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
});
