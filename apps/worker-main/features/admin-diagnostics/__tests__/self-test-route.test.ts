import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvzRoute } from '../envz-route';
import { createSelfTestRoute } from '../self-test-route';
import type { AiPort, MessagingPort, StoragePort } from '../../../ports';
import { createNoopAiPort } from '../../../adapters-noop';
import { resetLastTelegramUpdateSnapshot } from '../../../http/telegram-webhook';
import * as telegramIdGuard from '../telegram-id-guard';

const ensureTelegramSnapshotIntegritySpy = vi.spyOn(
  telegramIdGuard,
  'ensureTelegramSnapshotIntegrity',
);

const createRequest = (query: string) => new Request(`https://example.com/admin/selftest${query}`);

describe('createSelfTestRoute', () => {
  beforeEach(() => {
    ensureTelegramSnapshotIntegritySpy.mockReset();
    ensureTelegramSnapshotIntegritySpy.mockResolvedValue(undefined);
    resetLastTelegramUpdateSnapshot();
  });

  it('returns success report when OpenAI and Telegram checks pass', async () => {
    const reply = { text: 'pong', metadata: { usedOutputText: true } };
    const ai: AiPort = {
      reply: vi.fn().mockResolvedValue(reply),
    };
    const messaging: MessagingPort = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: '42' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };

    const route = createSelfTestRoute({ ai, messaging, now: () => 1000 });
    const response = await route(createRequest('?chatId=123&threadId=456&text=hello'));

    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload).toMatchObject({
      openAiOk: true,
      telegramOk: true,
      openAiUsedOutputText: true,
      errors: [],
      telegramMessageId: '42',
      telegramStatus: 200,
      telegramDescription: 'OK',
      telegramChatId: '123',
      telegramChatIdSource: 'query',
    });

    expect(ensureTelegramSnapshotIntegritySpy).toHaveBeenCalledTimes(1);

    expect(payload.lastWebhookSnapshot).toEqual(
      expect.objectContaining({
        route: 'admin',
        failSoft: false,
        chatIdRaw: expect.objectContaining({ present: true }),
        chatIdUsed: expect.objectContaining({ present: true }),
        sendTyping: expect.objectContaining({ ok: true }),
        sendText: expect.objectContaining({ ok: true }),
      }),
    );

    expect(ai.reply).toHaveBeenCalledWith({
      userId: 'admin:selftest',
      text: 'ping',
      context: [],
    });
    expect(messaging.sendTyping).toHaveBeenCalledWith({ chatId: '123', threadId: '456' });
    expect(messaging.sendText).toHaveBeenCalledWith({ chatId: '123', threadId: '456', text: 'hello' });
  });

  it('records OpenAI failure and continues with Telegram check', async () => {
    const ai: AiPort = {
      reply: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const messaging: MessagingPort = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({}),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };

    const route = createSelfTestRoute({ ai, messaging, now: () => 2000 });
    const response = await route(createRequest('?chatId=123'));

    expect(response.status).toBe(500);
    const payload = await response.json();

    expect(payload.openAiOk).toBe(false);
    expect(payload.telegramOk).toBe(true);
    expect(payload.errors).toContain('openai: boom');
    expect(payload.telegramStatus).toBe(200);
    expect(payload.telegramDescription).toBe('OK');
    expect(payload.telegramChatId).toBe('123');
    expect(payload.telegramChatIdSource).toBe('query');
    expect(payload.lastWebhookSnapshot).toEqual(
      expect.objectContaining({
        route: 'admin',
        sendTyping: expect.objectContaining({ ok: true }),
        sendText: expect.objectContaining({ ok: true }),
      }),
    );
  });

  it('fails Telegram check when chatId is missing', async () => {
    const ai: AiPort = {
      reply: vi.fn().mockResolvedValue({ text: 'pong', metadata: { usedOutputText: true } }),
    };
    const messaging: MessagingPort = {
      sendTyping: vi.fn(),
      sendText: vi.fn(),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };

    const route = createSelfTestRoute({ ai, messaging, now: () => 0 });
    const response = await route(createRequest(''));

    expect(response.status).toBe(500);
    const payload = await response.json();

    expect(payload.openAiOk).toBe(true);
    expect(payload.telegramOk).toBe(false);
    expect(payload.errors).toContain('telegram: chatId query parameter is required and whitelist is empty');
    expect(payload.telegramChatId).toBeUndefined();
    expect(payload.telegramChatIdSource).toBeUndefined();
    expect(payload.lastWebhookSnapshot).toEqual(
      expect.objectContaining({
        chatIdUsed: expect.objectContaining({ present: false }),
      }),
    );
    expect(messaging.sendTyping).not.toHaveBeenCalled();
    expect(messaging.sendText).not.toHaveBeenCalled();
  });

  it('uses whitelisted chat id when query param missing', async () => {
    const ai: AiPort = {
      reply: vi.fn().mockResolvedValue({
        text: 'pong',
        metadata: { usedOutputText: true, responseId: 'resp_whitelist' },
      }),
    };
    const messaging: MessagingPort = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: 'fallback-1' }),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };

    const route = createSelfTestRoute({
      ai,
      messaging,
      now: () => 3000,
      getDefaultChatId: async () => ' 555 ',
    });

    const response = await route(createRequest(''));
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.telegramOk).toBe(true);
    expect(payload.telegramChatId).toBe('555');
    expect(payload.telegramChatIdSource).toBe('whitelist');
    expect(payload.telegramStatus).toBe(200);
    expect(payload.telegramDescription).toBe('OK');
    expect(payload.errors).toEqual([]);
    expect(payload.openAiReason).toBeUndefined();
    expect(payload.openAiResponseId).toBe('resp_whitelist');
    expect(payload.lastWebhookSnapshot).toEqual(
      expect.objectContaining({
        route: 'admin',
        sendTyping: expect.objectContaining({ ok: true }),
        sendText: expect.objectContaining({ ok: true }),
      }),
    );
  });

  it('reports missing diagnostic marker as soft failure', async () => {
    const ai: AiPort = {
      reply: vi.fn().mockResolvedValue({ text: 'AI reply without marker' }),
    };
    const messaging: MessagingPort = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };

    const route = createSelfTestRoute({ ai, messaging, now: () => 4000 });
    const response = await route(createRequest('?chatId=999'));

    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.openAiOk).toBe(false);
    expect(payload.openAiReason).toBe('missing_diagnostic_marker');
    expect(payload.openAiSample).toBe('AI reply without marker');
    expect(payload.openAiResponseId).toBeUndefined();
    expect(payload.telegramOk).toBe(true);
    expect(payload.errors).toEqual([]);
    expect(payload.lastWebhookSnapshot).toEqual(
      expect.objectContaining({
        route: 'admin',
        sendTyping: expect.objectContaining({ ok: true }),
        sendText: expect.objectContaining({ ok: true }),
      }),
    );
  });

  it('captures Telegram errors', async () => {
    const ai: AiPort = {
      reply: vi.fn().mockResolvedValue({ text: 'pong', metadata: { usedOutputText: true } }),
    };
    const messaging: MessagingPort = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockRejectedValue(new Error('telegram failure')),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };

    const route = createSelfTestRoute({ ai, messaging, now: () => 5000 });
    const response = await route(createRequest('?chatId=789'));

    expect(response.status).toBe(500);
    const payload = await response.json();

    expect(payload.openAiOk).toBe(true);
    expect(payload.telegramOk).toBe(false);
    expect(payload.errors).toContain('telegram: telegram failure');
    expect(payload.telegramDescription).toBe('telegram failure');
    expect(payload.telegramChatId).toBe('789');
    expect(payload.telegramChatIdSource).toBe('query');
    expect(payload.lastWebhookSnapshot).toEqual(
      expect.objectContaining({
        route: 'admin',
        sendTyping: expect.objectContaining({ ok: true }),
        sendText: expect.objectContaining({ ok: false }),
      }),
    );
  });

  it('treats noop AI response as OpenAI failure', async () => {
    const ai = createNoopAiPort();
    const messaging: MessagingPort = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: 'noop-ignored' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };

    const route = createSelfTestRoute({ ai, messaging, now: () => 9000 });
    const response = await route(createRequest('?chatId=123'));

    expect(response.status).toBe(500);
    const payload = await response.json();

    expect(payload.openAiOk).toBe(false);
    expect(payload.openAiReason).toBe('noop_adapter_response');
    expect(payload.errors).toContain('openai: noop adapter response');
    expect(payload.telegramStatus).toBe(200);
    expect(payload.telegramChatId).toBe('123');
    expect(payload.telegramChatIdSource).toBe('query');
    expect(payload.lastWebhookSnapshot).toEqual(
      expect.objectContaining({
        route: 'admin',
        sendTyping: expect.objectContaining({ ok: true }),
        sendText: expect.objectContaining({ ok: true }),
      }),
    );
  });

  it('runs storage diagnostics when q=utm', async () => {
    const ai: AiPort = {
      reply: vi.fn().mockResolvedValue({ text: 'unused' }),
    };
    const messaging: MessagingPort = {
      sendTyping: vi.fn(),
      sendText: vi.fn(),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };
    const storage: StoragePort = {
      saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      getRecentMessages: vi.fn().mockResolvedValue([]),
    };

    const route = createSelfTestRoute({ ai, messaging, storage, now: () => 1_000 });
    const response = await route(createRequest('?q=utm'));

    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload).toMatchObject({
      test: 'utm',
      ok: true,
      saveOk: true,
      readOk: true,
      utmDegraded: false,
      errors: [],
    });

    expect(payload.lastWebhookSnapshot).toEqual(
      expect.objectContaining({ chatIdUsed: expect.objectContaining({ present: false }) }),
    );

    expect(storage.saveUser).toHaveBeenCalledTimes(1);
    const savedUser = storage.saveUser.mock.calls[0][0];
    expect(savedUser.userId).toMatch(/^admin:selftest:utm:/);
    expect(savedUser.utmSource).toBe('src_SELFTEST');
    expect(storage.getRecentMessages).toHaveBeenCalledWith({
      userId: savedUser.userId,
      limit: 1,
    });
  });

  it('signals storage errors for utm diagnostics when adapter missing', async () => {
    const ai: AiPort = {
      reply: vi.fn().mockResolvedValue({ text: 'unused' }),
    };
    const messaging: MessagingPort = {
      sendTyping: vi.fn(),
      sendText: vi.fn(),
      editMessageText: vi.fn(),
      deleteMessage: vi.fn(),
    };

    const route = createSelfTestRoute({ ai, messaging, now: () => 5_000 });
    const response = await route(createRequest('?q=utm'));

    expect(response.status).toBe(500);
    const payload = await response.json();

    expect(payload).toMatchObject({
      test: 'utm',
      ok: false,
      errors: ['storage: adapter is not configured'],
    });
  });

  it('propagates guard failures before executing diagnostics', async () => {
    ensureTelegramSnapshotIntegritySpy.mockRejectedValueOnce(
      new Error('TELEGRAM_GUARD_FAILED:unsafe'),
    );

    const route = createSelfTestRoute({
      ai: createNoopAiPort(),
      messaging: {
        sendTyping: vi.fn(),
        sendText: vi.fn(),
        editMessageText: vi.fn(),
        deleteMessage: vi.fn(),
      },
    });

    await expect(route(createRequest('?chatId=123'))).rejects.toThrow('TELEGRAM_GUARD_FAILED');
    expect(ensureTelegramSnapshotIntegritySpy).toHaveBeenCalledTimes(1);
  });
});

describe('createEnvzRoute', () => {
  it('marks Cloudflare object prompt variables as valid', async () => {
    const env = {
      OPENAI_PROMPT_VARIABLES: { tone: 'calm' },
    } as const;

    const route = createEnvzRoute({ env });
    const response = await route(new Request('https://example.com/admin/envz'));

    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload).toMatchObject({
      ok: true,
      env: { openai_prompt_variables: true },
    });
  });
});
