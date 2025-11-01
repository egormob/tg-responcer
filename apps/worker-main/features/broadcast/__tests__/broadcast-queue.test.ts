import { describe, expect, it } from 'vitest';

import { createInMemoryBroadcastQueue } from '../broadcast-queue';

describe('createInMemoryBroadcastQueue', () => {
  const basePayload = { text: 'Hello world' } as const;

  it('enqueues jobs with generated id and preserves payload', () => {
    let sequence = 0;
    const queue = createInMemoryBroadcastQueue({
      generateId: () => `job-${++sequence}`,
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    });

    const job = queue.enqueue({ payload: basePayload, requestedBy: 'alice' });

    expect(job.id).toBe('job-1');
    expect(job.status).toBe('pending');
    expect(job.payload.text).toBe('Hello world');
    expect(job.createdAt.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(job.requestedBy).toBe('alice');
  });

  it('returns clones to protect internal state', () => {
    const queue = createInMemoryBroadcastQueue({
      generateId: () => 'job-1',
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    });

    const original = queue.enqueue({
      payload: {
        text: 'Ping',
        filters: { chatIds: ['1', '2'] },
        metadata: { dryRun: true },
      },
    });

    original.payload.filters?.chatIds?.push('3');
    if (original.payload.metadata) {
      original.payload.metadata.newField = 'value';
    }

    const stored = queue.getJob(original.id);
    expect(stored?.payload.filters?.chatIds).toEqual(['1', '2']);
    expect(stored?.payload.metadata).toEqual({ dryRun: true });

    const snapshot = queue.list();
    expect(snapshot.jobs[0].payload.filters?.chatIds).toEqual(['1', '2']);
  });

  it('enforces maxPending limit when provided', () => {
    const queue = createInMemoryBroadcastQueue({
      generateId: () => 'job-1',
      now: () => new Date(),
      maxPending: 1,
    });

    queue.enqueue({ payload: basePayload });

    expect(() => queue.enqueue({ payload: basePayload })).toThrow('Broadcast queue is full');
  });

  it('lists jobs sorted by creation time', () => {
    let current = 0;
    const queue = createInMemoryBroadcastQueue({
      generateId: () => `job-${++current}`,
      now: () => new Date(`2024-01-0${current}T00:00:00.000Z`),
    });

    queue.enqueue({ payload: basePayload });
    queue.enqueue({ payload: basePayload });

    const ids = queue
      .list()
      .jobs.map((job) => job.id);

    expect(ids).toEqual(['job-1', 'job-2']);
  });

  it('updates job fields and returns cloned result', () => {
    let call = 0;
    const timestamps = [
      new Date('2024-01-01T00:00:00.000Z'),
      new Date('2024-01-01T00:10:00.000Z'),
      new Date('2024-01-01T00:20:00.000Z'),
    ];
    const queue = createInMemoryBroadcastQueue({
      generateId: () => 'job-1',
      now: () => timestamps[Math.min(call++, timestamps.length - 1)]!,
    });

    const original = queue.enqueue({ payload: basePayload, requestedBy: 'alice' });

    const processing = queue.updateJob(original.id, {
      status: 'processing',
      attempts: 1,
      lastError: 'temporary failure',
    });

    expect(processing?.status).toBe('processing');
    expect(processing?.attempts).toBe(1);
    expect(processing?.updatedAt.toISOString()).toBe('2024-01-01T00:10:00.000Z');

    const storedProcessing = queue.getJob(original.id);
    expect(storedProcessing?.status).toBe('processing');
    expect(storedProcessing?.lastError).toBe('temporary failure');

    const cleared = queue.updateJob(original.id, {
      status: 'pending',
      lastError: null,
      requestedBy: null,
    });

    expect(cleared?.status).toBe('pending');
    expect(cleared?.lastError).toBeUndefined();
    expect(cleared?.requestedBy).toBeUndefined();
    expect(cleared?.updatedAt.toISOString()).toBe('2024-01-01T00:20:00.000Z');

    const storedCleared = queue.getJob(original.id);
    expect(storedCleared?.lastError).toBeUndefined();
    expect(storedCleared).not.toBe(cleared);
  });
});
