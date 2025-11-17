import { describe, expect, it, vi } from 'vitest';

import {
  BroadcastAbortedError,
  createImmediateBroadcastSender,
  type BroadcastRecipient,
} from '../minimal-broadcast-service';

const createRecipients = (count: number): BroadcastRecipient[] =>
  Array.from({ length: count }, (_, index) => ({ chatId: `chat-${index}` }));

describe('createImmediateBroadcastSender', () => {
  it('throttles large batches, retries 429 responses, and records telemetry', async () => {
    const recipients = createRecipients(50);
    const attempts = new Map<string, number>();
    const waitCalls: number[] = [];

    const sendText = vi.fn(async ({ chatId }: { chatId: string }) => {
      const attempt = attempts.get(chatId) ?? 0;
      attempts.set(chatId, attempt + 1);

      if ((chatId.endsWith('0') || chatId.endsWith('5')) && attempt === 0) {
        const error = new Error('Too many requests');
        (error as Error & { status?: number; retryAfterMs?: number }).status = 429;
        (error as Error & { status?: number; retryAfterMs?: number }).retryAfterMs = 25;
        throw error;
      }

      return { messageId: `${chatId}-${attempt}` };
    });

    const wait = vi.fn(async (ms: number) => {
      waitCalls.push(ms);
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const telemetry = { record: vi.fn(), snapshot: vi.fn() };

    const sendBroadcast = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger,
      pool: {
        concurrency: 5,
        maxAttempts: 3,
        baseDelayMs: 1,
        jitterRatio: 0,
        wait,
        random: () => 0,
      },
      telemetry,
      emergencyStop: { retryAfterMs: 500 },
    });

    const result = await sendBroadcast({ text: 'hello', requestedBy: 'ops' });

    expect(result.delivered).toBe(recipients.length);
    expect(result.failed).toBe(0);
    expect(sendText).toHaveBeenCalledTimes(recipients.length + 10);
    expect(logger.warn).toHaveBeenCalledWith(
      'broadcast throttled',
      expect.objectContaining({ poolSize: 5 }),
    );
    expect(waitCalls.some((delay) => delay >= 25)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      'broadcast_summary',
      expect.objectContaining({ delivered: recipients.length, throttled429: expect.any(Number) }),
    );
    expect(telemetry.record).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: 'ops',
        delivered: recipients.length,
        status: 'ok',
        throttled429: expect.any(Number),
      }),
    );
  });

  it('aborts broadcast when sendText reports fatal error', async () => {
    const recipients = createRecipients(5);
    const sendText = vi.fn(async () => {
      const error = new Error('unauthorized');
      (error as Error & { status?: number }).status = 401;
      throw error;
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const telemetry = { record: vi.fn(), snapshot: vi.fn() };

    const sendBroadcast = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger,
      telemetry,
      emergencyStop: { retryAfterMs: 500 },
    });

    await expect(sendBroadcast({ text: 'stop', requestedBy: 'ops' })).rejects.toBeInstanceOf(
      BroadcastAbortedError,
    );
    expect(logger.error).toHaveBeenCalledWith(
      'broadcast pool aborted',
      expect.objectContaining({ reason: 'send_text_failed' }),
    );
    expect(telemetry.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'aborted', abortReason: 'send_text_failed' }),
    );
  });

  it('ignores segmentation filters and delivers to all recipients from D1 source', async () => {
    const recipients = [
      { chatId: 'chat-1', languageCode: 'en' },
      { chatId: 'chat-2', languageCode: 'ru' },
    ];

    const sendText = vi
      .fn(async ({ chatId }: { chatId: string }) => ({ messageId: `sent-${chatId}` }))
      .mockResolvedValue({ messageId: 'sent-chat-1' });

    const sendBroadcast = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await sendBroadcast({
      text: 'hello',
      requestedBy: 'ops',
      filters: { languageCodes: ['ru'] },
    });

    expect(sendText).toHaveBeenCalledTimes(recipients.length);
    expect(result.delivered).toBe(recipients.length);
    expect(result.failed).toBe(0);
  });
});
