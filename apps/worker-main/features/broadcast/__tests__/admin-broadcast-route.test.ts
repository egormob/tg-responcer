import { describe, expect, it, vi } from 'vitest';

import { createAdminBroadcastRoute } from '../admin-broadcast-route';
import type { BroadcastQueue } from '../broadcast-queue';

const createQueue = () => ({
  enqueue: vi.fn(),
} as unknown as BroadcastQueue);

const createRequest = (body: unknown, init: RequestInit = {}) =>
  new Request('https://example.com/admin/broadcast', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-token': 'secret',
      ...init.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });

describe('createAdminBroadcastRoute', () => {
  it('rejects non-POST methods', async () => {
    const queue = createQueue();
    const route = createAdminBroadcastRoute({ adminToken: 'secret', queue });

    const response = await route(new Request('https://example.com/admin/broadcast', { method: 'GET' }));

    expect(response.status).toBe(405);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('requires admin token', async () => {
    const queue = createQueue();
    const route = createAdminBroadcastRoute({ adminToken: 'secret', queue });

    const response = await route(
      new Request('https://example.com/admin/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      }),
    );

    expect(response.status).toBe(401);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('rejects invalid admin token', async () => {
    const queue = createQueue();
    const route = createAdminBroadcastRoute({ adminToken: 'secret', queue });

    const response = await route(
      new Request('https://example.com/admin/broadcast', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': 'invalid',
        },
        body: JSON.stringify({ text: 'hello' }),
      }),
    );

    expect(response.status).toBe(403);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid payload', async () => {
    const queue = createQueue();
    const route = createAdminBroadcastRoute({ adminToken: 'secret', queue });

    const response = await route(createRequest({ text: '' }));

    expect(response.status).toBe(400);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('validates filters when provided', async () => {
    const queue = createQueue();
    queue.enqueue = vi.fn().mockReturnValue({
      id: 'job-1',
      status: 'pending',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      attempts: 0,
      payload: { text: 'hello', filters: { chatIds: ['1'] } },
    } as any);

    const route = createAdminBroadcastRoute({ adminToken: 'secret', queue });

    const response = await route(
      createRequest({ text: 'hello', filters: { chatIds: ['1'] } }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: 'queued',
      jobId: 'job-1',
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      payload: { text: 'hello', filters: { chatIds: ['1'] }, metadata: undefined },
      requestedBy: undefined,
    });
  });

  it('propagates metadata and actor header', async () => {
    const queue = createQueue();
    queue.enqueue = vi.fn().mockReturnValue({
      id: 'job-1',
      status: 'pending',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      attempts: 0,
      requestedBy: 'ops',
      payload: { text: 'hello', metadata: { dryRun: true } },
    } as any);

    const route = createAdminBroadcastRoute({ adminToken: 'secret', queue, now: () => new Date('2024-01-01T00:00:10.000Z') });

    const response = await route(
      createRequest(
        { text: 'hello', metadata: { dryRun: true } },
        { headers: { 'x-admin-token': 'secret', 'x-admin-actor': 'ops' } },
      ),
    );

    expect(queue.enqueue).toHaveBeenCalledWith({
      payload: { text: 'hello', filters: undefined, metadata: { dryRun: true } },
      requestedBy: 'ops',
    });
    expect(response.headers.get('x-queued-at')).toBe('2024-01-01T00:00:10.000Z');
  });

  it('returns 503 when queue rejects job', async () => {
    const queue = createQueue();
    queue.enqueue = vi.fn().mockImplementation(() => {
      throw new Error('full');
    });

    const route = createAdminBroadcastRoute({ adminToken: 'secret', queue });

    const response = await route(createRequest({ text: 'hello' }));

    expect(response.status).toBe(503);
  });
});
