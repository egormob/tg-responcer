import { describe, expect, it, vi } from 'vitest';

import { createSelfTestRoute } from '../self-test-route';
import type { AiPort, MessagingPort } from '../../../ports';

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
      reply: vi.fn().mockResolvedValue({ text: 'pong' }),
    };
    const messaging: MessagingPort = {
      sendTyping: vi.fn(),
      sendText: vi.fn(),
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
      reply: vi.fn().mockResolvedValue({ text: 'pong' }),
    };
    const messaging: MessagingPort = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockRejectedValue(new Error('telegram failure')),
    };

    const route = createSelfTestRoute({ ai, messaging, now: () => 5000 });
    const response = await route(createRequest('?chatId=789'));

    expect(response.status).toBe(500);
    const payload = await response.json();

    expect(payload.openAiOk).toBe(true);
    expect(payload.telegramOk).toBe(false);
    expect(payload.errors).toContain('telegram: telegram failure');
  });
});
