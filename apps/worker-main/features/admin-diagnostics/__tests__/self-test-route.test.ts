import { describe, expect, it, vi } from 'vitest';

import { createEnvzRoute } from '../envz-route';
import { createSelfTestRoute } from '../self-test-route';
import type { AiPort, MessagingPort, StoragePort } from '../../../ports';
import { createNoopAiPort } from '../../../adapters-noop';

const createRequest = (query: string) => new Request(`https://example.com/admin/selftest${query}`);

describe('createSelfTestRoute', () => {
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
    });

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
    expect(payload.errors).toContain('telegram: chatId query parameter is required');
    expect(messaging.sendTyping).not.toHaveBeenCalled();
    expect(messaging.sendText).not.toHaveBeenCalled();
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
    expect(payload.errors).toContain('openai: noop adapter response');
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
