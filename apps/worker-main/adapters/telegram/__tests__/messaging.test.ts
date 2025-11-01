import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { MessagingPort } from '../../../ports';
import { createTelegramMessagingAdapter } from '..';

const createWaitMock = () => {
  const wait = vi.fn<[number], Promise<void>>().mockImplementation(() => Promise.resolve());
  return wait;
};

describe('createTelegramMessagingAdapter', () => {
  const botToken = 'test-token';
  const baseUrl = 'https://api.telegram.org';

  let fetchMock: Mock<Parameters<typeof fetch>, ReturnType<typeof fetch>>;
  let waitMock: ReturnType<typeof createWaitMock>;

  beforeEach(() => {
    fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
    waitMock = createWaitMock();
  });

  const createAdapter = (): MessagingPort =>
    createTelegramMessagingAdapter({
      botToken,
      fetchApi: fetchMock,
      wait: waitMock,
      random: () => 0,
    });

  it('sends typing indicator and swallows errors', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    );

    const adapter = createAdapter();

    await expect(
      adapter.sendTyping({
        chatId: '123',
        threadId: '456',
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(`${baseUrl}/bottest-token/sendChatAction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: '123',
        action: 'typing',
        message_thread_id: '456',
      }),
    });
  });

  it('retries typing indicator on retryable errors and stops after retries', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, parameters: { retry_after: 2 } }), {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
      );

    const adapter = createAdapter();

    await adapter.sendTyping({ chatId: 'retry-chat' });

    expect(waitMock).toHaveBeenCalledWith(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends text message and returns message id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 }),
    );

    const adapter = createAdapter();

    await expect(
      adapter.sendText({
        chatId: 'chat',
        threadId: 'thread',
        text: 'hello',
      }),
    ).resolves.toEqual({ messageId: '99' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${baseUrl}/bottest-token/sendMessage`);
    expect((init as RequestInit)?.method).toBe('POST');
    expect((init as RequestInit)?.headers).toEqual({
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(((init as RequestInit)?.body ?? '{}') as string)).toEqual({
      chat_id: 'chat',
      message_thread_id: 'thread',
      text: 'hello',
    });
  });

  it('sanitizes outgoing text before sending', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );

    const adapter = createAdapter();

    await adapter.sendText({
      chatId: 'chat',
      text: 'hello\u0007world',
    });

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.text).toBe('helloworld');
  });

  it('retries on network errors for sendText and eventually succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }), { status: 200 }),
      );

    const adapter = createAdapter();

    const result = await adapter.sendText({ chatId: 'chat', text: 'ping' });

    expect(result).toEqual({ messageId: '2' });
    expect(waitMock).toHaveBeenCalledTimes(1);
  });

  it('throws on non-retryable api errors', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: 'bad request' }), { status: 400 }),
    );

    const adapter = createAdapter();

    await expect(adapter.sendText({ chatId: 'chat', text: 'test' })).rejects.toThrow(
      /bad request/i,
    );
  });

  it('uses retry_after hint when provided for sendText', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, parameters: { retry_after: 3 } }), {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), { status: 200 }),
      );

    const adapter = createAdapter();

    await adapter.sendText({ chatId: 'chat', text: 'wait please' });

    expect(waitMock).toHaveBeenCalledWith(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
