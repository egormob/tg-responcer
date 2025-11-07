import { describe, expect, it, vi } from 'vitest';

import { createBroadcastScheduler } from '../broadcast-scheduler';
import { createInMemoryBroadcastQueue } from '../broadcast-queue';
import { createInMemoryBroadcastProgressStore } from '../broadcast-progress-store';
import type { BroadcastRecipient, BroadcastSchedulerLogger } from '../broadcast-scheduler';
import type { MessagingPort } from '../../../ports';

const createMessagingPort = () => ({
  sendText: vi.fn().mockResolvedValue({}),
  sendTyping: vi.fn(),
}) as unknown as MessagingPort;

const toRecipientKey = (recipient: BroadcastRecipient) =>
  (recipient.threadId ? `${recipient.chatId}:${recipient.threadId}` : recipient.chatId);

describe('createBroadcastScheduler', () => {
  const basePayload = { text: 'Broadcast message' } as const;

  it('processes pending jobs and marks them completed', async () => {
    let nowIndex = 0;
    const timestamps = [
      new Date('2024-01-01T00:00:00.000Z'),
      new Date('2024-01-01T00:00:01.000Z'),
      new Date('2024-01-01T00:00:02.000Z'),
      new Date('2024-01-01T00:00:03.000Z'),
    ];

    const queue = createInMemoryBroadcastQueue({
      generateId: () => 'job-1',
      now: () => timestamps[Math.min(nowIndex++, timestamps.length - 1)]!,
    });
    const progressStore = createInMemoryBroadcastProgressStore();
    const messaging = createMessagingPort();
    const wait = vi.fn().mockResolvedValue(undefined);

    const job = queue.enqueue({ payload: basePayload });

    const scheduler = createBroadcastScheduler({
      queue,
      messaging,
      progressStore,
      resolveRecipients: () => [
        { chatId: '100' },
        { chatId: '200' },
      ],
      now: () => new Date('2024-01-01T00:00:10.000Z'),
      wait,
      perRecipientDelayMs: 0,
    });

    await scheduler.processPendingJobs();

    expect(messaging.sendText).toHaveBeenCalledTimes(2);
    expect(messaging.sendText).toHaveBeenNthCalledWith(1, { chatId: '100', threadId: undefined, text: 'Broadcast message' });
    expect(messaging.sendText).toHaveBeenNthCalledWith(2, { chatId: '200', threadId: undefined, text: 'Broadcast message' });

    const storedJob = queue.getJob(job.id);
    expect(storedJob?.status).toBe('completed');
    expect(storedJob?.attempts).toBe(1);
    await expect(progressStore.read(job.id)).resolves.toBeUndefined();
  });

  it('skips already delivered recipients based on stored progress', async () => {
    const queue = createInMemoryBroadcastQueue({
      generateId: () => 'job-1',
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    });
    const progressStore = createInMemoryBroadcastProgressStore();
    const messaging = createMessagingPort();

    const job = queue.enqueue({ payload: basePayload });

    const recipients: BroadcastRecipient[] = [
      { chatId: '100' },
      { chatId: '200' },
      { chatId: '300' },
    ];

    await progressStore.write(job.id, {
      deliveredTargetKeys: [toRecipientKey(recipients[0])],
      attempt: 0,
      updatedAt: new Date('2024-01-01T00:00:01.000Z'),
      lastError: 'previous failure',
    });

    const scheduler = createBroadcastScheduler({
      queue,
      messaging,
      progressStore,
      resolveRecipients: () => recipients,
      now: () => new Date('2024-01-01T00:01:00.000Z'),
      wait: vi.fn().mockResolvedValue(undefined),
      perRecipientDelayMs: 0,
    });

    await scheduler.processPendingJobs();

    expect(messaging.sendText).toHaveBeenCalledTimes(2);
    expect(messaging.sendText).toHaveBeenNthCalledWith(1, { chatId: '200', threadId: undefined, text: 'Broadcast message' });
    expect(messaging.sendText).toHaveBeenNthCalledWith(2, { chatId: '300', threadId: undefined, text: 'Broadcast message' });

    const storedJob = queue.getJob(job.id);
    expect(storedJob?.status).toBe('completed');
    await expect(progressStore.read(job.id)).resolves.toBeUndefined();
  });

  it('retries delivery when adapter reports retryAfter and succeeds', async () => {
    const queue = createInMemoryBroadcastQueue({
      generateId: () => 'job-1',
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    });
    const progressStore = createInMemoryBroadcastProgressStore();
    const wait = vi.fn().mockResolvedValue(undefined);

    const messaging = {
      sendText: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('429'), { retryAfterMs: 25 }))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      sendTyping: vi.fn(),
    } as unknown as MessagingPort;

    queue.enqueue({ payload: basePayload });

    const scheduler = createBroadcastScheduler({
      queue,
      messaging,
      progressStore,
      resolveRecipients: () => [
        { chatId: '100' },
        { chatId: '200' },
      ],
      now: () => new Date('2024-01-01T00:02:00.000Z'),
      wait,
      perRecipientDelayMs: 0,
      recipientMaxAttempts: 2,
    });

    await scheduler.processPendingJobs();

    expect(messaging.sendText).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledWith(25);
  });

  it('marks job as failed after exceeding max attempts', async () => {
    let currentTime = 0;
    const queue = createInMemoryBroadcastQueue({
      generateId: () => 'job-1',
      now: () => new Date(`2024-01-01T00:00:0${currentTime++}.000Z`),
    });
    const progressStore = createInMemoryBroadcastProgressStore();
    const wait = vi.fn().mockResolvedValue(undefined);

    const messaging = {
      sendText: vi.fn().mockRejectedValue(new Error('network failure')),
      sendTyping: vi.fn(),
    } as unknown as MessagingPort;

    const job = queue.enqueue({ payload: basePayload });

    const scheduler = createBroadcastScheduler({
      queue,
      messaging,
      progressStore,
      resolveRecipients: () => [{ chatId: '100' }],
      now: () => new Date('2024-01-01T00:05:00.000Z'),
      wait,
      perRecipientDelayMs: 0,
      recipientMaxAttempts: 1,
      maxJobAttempts: 2,
    });

    await scheduler.processPendingJobs();

    let storedJob = queue.getJob(job.id);
    expect(storedJob?.status).toBe('pending');
    expect(storedJob?.attempts).toBe(1);

    await scheduler.processPendingJobs();

    storedJob = queue.getJob(job.id);
    expect(storedJob?.status).toBe('failed');
    expect(storedJob?.attempts).toBe(2);

    const progress = await progressStore.read(job.id);
    expect(progress?.lastError).toContain('network failure');
    expect(progress?.attempt).toBe(2);
  });

  it('skips jobs claimed by another worker between snapshot and claim', async () => {
    const queue = createInMemoryBroadcastQueue({
      generateId: () => 'job-1',
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    });
    const progressStore = createInMemoryBroadcastProgressStore();
    const messaging = createMessagingPort();
    const wait = vi.fn().mockResolvedValue(undefined);

    const job = queue.enqueue({ payload: basePayload });

    const staleSnapshot = queue.list();

    queue.updateJob(job.id, { status: 'processing', attempts: 1 });

    (queue as { list: () => typeof staleSnapshot }).list = () => staleSnapshot;

    const scheduler = createBroadcastScheduler({
      queue,
      messaging,
      progressStore,
      resolveRecipients: () => [{ chatId: '100' }],
      now: () => new Date('2024-01-01T00:10:00.000Z'),
      wait,
      perRecipientDelayMs: 0,
    });

    await scheduler.processPendingJobs();

    expect(messaging.sendText).not.toHaveBeenCalled();

    const stored = queue.getJob(job.id);
    expect(stored?.status).toBe('processing');
    expect(stored?.attempts).toBe(1);
    await expect(progressStore.read(job.id)).resolves.toBeUndefined();
  });

  it('logs delivered recipients with message identifier when available', async () => {
    const queue = createInMemoryBroadcastQueue({
      generateId: () => 'job-1',
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    });
    const progressStore = createInMemoryBroadcastProgressStore();
    const messaging = {
      sendText: vi.fn().mockResolvedValue({ messageId: '42' }),
      sendTyping: vi.fn(),
    } as unknown as MessagingPort;

    const logger: BroadcastSchedulerLogger = {
      debug: vi.fn(),
      info: vi.fn(),
    };

    const job = queue.enqueue({ payload: basePayload });

    const scheduler = createBroadcastScheduler({
      queue,
      messaging,
      progressStore,
      resolveRecipients: () => [{ chatId: '100' }],
      logger,
      wait: vi.fn().mockResolvedValue(undefined),
      perRecipientDelayMs: 0,
      now: () => new Date('2024-01-01T00:00:10.000Z'),
    });

    await scheduler.processPendingJobs();

    expect(logger.debug).toHaveBeenCalledWith('broadcast recipient delivered', {
      jobId: job.id,
      recipient: '100',
      messageId: '42',
    });
  });
});
