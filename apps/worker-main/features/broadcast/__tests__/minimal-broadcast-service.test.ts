import { describe, expect, it, vi } from 'vitest';

import { createImmediateBroadcastSender } from '../minimal-broadcast-service';
import type { BroadcastRecipient } from '../minimal-broadcast-service';

const createRecipients = (count: number): BroadcastRecipient[] =>
  Array.from({ length: count }, (_, index) => ({ chatId: `chat-${index}` }));

describe('createImmediateBroadcastSender', () => {
  it('throttles sending with configurable pool and retries 429 responses', async () => {
    const recipients = createRecipients(12);
    const attempts = new Map<string, number>();
    let active = 0;
    let maxActive = 0;

    const sendText = vi.fn(async ({ chatId }: { chatId: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const attempt = attempts.get(chatId) ?? 0;
      attempts.set(chatId, attempt + 1);

      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;

      if ((chatId.endsWith('2') || chatId.endsWith('5')) && attempt === 0) {
        const error = new Error('Too many requests');
        (error as Error & { status?: number; retryAfterMs?: number }).status = 429;
        (error as Error & { status?: number; retryAfterMs?: number }).retryAfterMs = 5;
        throw error;
      }

      return { messageId: `${chatId}-${attempt}` };
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const sendBroadcast = createImmediateBroadcastSender({
      messaging: { sendText },
      recipients,
      logger,
      pool: {
        concurrency: 3,
        maxAttempts: 3,
        baseDelayMs: 1,
        jitterRatio: 0,
        wait: (ms) => Promise.resolve(ms).then(() => undefined),
        random: () => 0,
      },
    });

    const result = await sendBroadcast({ text: 'hello', requestedBy: 'ops' });

    expect(result.delivered).toBe(recipients.length);
    expect(result.failed).toBe(0);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(sendText).toHaveBeenCalledTimes(recipients.length + 2);
    expect(logger.warn).toHaveBeenCalledWith(
      'broadcast throttled',
      expect.objectContaining({ poolSize: 3 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'broadcast pool completed',
      expect.objectContaining({ delivered: recipients.length, throttled429: 2 }),
    );
  });
});
