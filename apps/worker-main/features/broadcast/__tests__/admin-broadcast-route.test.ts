import { describe, expect, it, vi } from 'vitest';

import { createAdminBroadcastRoute } from '../admin-broadcast-route';
import type { SendBroadcast } from '../minimal-broadcast-service';

const createSendBroadcast = () => {
  const fn = vi.fn<Parameters<SendBroadcast>, ReturnType<SendBroadcast>>();
  fn.mockResolvedValue({ delivered: 1, failed: 0, deliveries: [] });
  return fn;
};

const createWaitUntil = () => vi.fn(async (promise: Promise<unknown>) => {
  await promise;
});

const createRequest = (body: unknown, init: RequestInit = {}) =>
  new Request('https://example.com/admin/broadcast', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-token': 'secret',
      'x-admin-actor': 'ops',
      ...init.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });

describe('createAdminBroadcastRoute', () => {
  it('rejects non-POST methods', async () => {
    const sendBroadcast = createSendBroadcast();
    const route = createAdminBroadcastRoute({ adminToken: 'secret', sendBroadcast });

    const response = await route(
      new Request('https://example.com/admin/broadcast', { method: 'GET' }),
    );

    expect(response.status).toBe(405);
    expect(sendBroadcast).not.toHaveBeenCalled();
  });

  it('requires admin token', async () => {
    const sendBroadcast = createSendBroadcast();
    const route = createAdminBroadcastRoute({ adminToken: 'secret', sendBroadcast });

    const response = await route(
      new Request('https://example.com/admin/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-actor': 'ops' },
        body: JSON.stringify({ text: 'hello' }),
      }),
    );

    expect(response.status).toBe(401);
    expect(sendBroadcast).not.toHaveBeenCalled();
  });

  it('rejects invalid admin token', async () => {
    const sendBroadcast = createSendBroadcast();
    const route = createAdminBroadcastRoute({ adminToken: 'secret', sendBroadcast });

    const response = await route(
      new Request('https://example.com/admin/broadcast', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': 'invalid',
          'x-admin-actor': 'ops',
        },
        body: JSON.stringify({ text: 'hello' }),
      }),
    );

    expect(response.status).toBe(403);
    expect(sendBroadcast).not.toHaveBeenCalled();
  });

  it('requires admin actor header', async () => {
    const sendBroadcast = createSendBroadcast();
    const route = createAdminBroadcastRoute({ adminToken: 'secret', sendBroadcast });

    const response = await route(
      new Request('https://example.com/admin/broadcast', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': 'secret',
        },
        body: JSON.stringify({ text: 'hello' }),
      }),
    );

    expect(response.status).toBe(401);
    expect(sendBroadcast).not.toHaveBeenCalled();
  });

  it('rejects admin actor not present in whitelist', async () => {
    const sendBroadcast = createSendBroadcast();
    const waitUntil = createWaitUntil();
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(false) };
    const route = createAdminBroadcastRoute({
      adminToken: 'secret',
      sendBroadcast,
      waitUntil,
      adminAccess,
    });

    const response = await route(createRequest({ text: 'hello' }));

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('ops');
    expect(response.status).toBe(403);
    expect(sendBroadcast).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('accepts admin actor present in whitelist', async () => {
    const sendBroadcast = createSendBroadcast();
    const waitUntil = createWaitUntil();
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(true) };
    const route = createAdminBroadcastRoute({
      adminToken: 'secret',
      sendBroadcast,
      waitUntil,
      adminAccess,
      now: () => new Date('2024-01-01T00:00:10.000Z'),
    });

    const response = await route(createRequest({ text: 'hello' }));

    expect(response.status).toBe(202);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(sendBroadcast).toHaveBeenCalledWith({ text: 'hello', requestedBy: 'ops' });
    await expect(response.json()).resolves.toMatchObject({
      status: 'scheduled',
      scheduledAt: '2024-01-01T00:00:10.000Z',
      requestedBy: 'ops',
      filters: null,
      metadata: null,
    });
  });

  it('returns 400 for invalid payload', async () => {
    const sendBroadcast = createSendBroadcast();
    const route = createAdminBroadcastRoute({ adminToken: 'secret', sendBroadcast });

    const response = await route(createRequest({ text: '' }));

    expect(response.status).toBe(400);
    expect(sendBroadcast).not.toHaveBeenCalled();
  });

  it('validates filters when provided and schedules broadcast', async () => {
    const sendBroadcast = createSendBroadcast();
    const waitUntil = createWaitUntil();
    const route = createAdminBroadcastRoute({
      adminToken: 'secret',
      sendBroadcast,
      waitUntil,
      now: () => new Date('2024-01-01T00:00:10.000Z'),
    });

    const response = await route(
      createRequest({ text: 'hello', filters: { chatIds: ['1'] }, metadata: { dryRun: true } }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('x-scheduled-at')).toBe('2024-01-01T00:00:10.000Z');
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(sendBroadcast).toHaveBeenCalledWith({ text: 'hello', requestedBy: 'ops' });
    await expect(response.json()).resolves.toMatchObject({
      status: 'scheduled',
      scheduledAt: '2024-01-01T00:00:10.000Z',
      filters: { chatIds: ['1'] },
      metadata: { dryRun: true },
    });
  });

  it('returns 503 when waitUntil throws', async () => {
    const sendBroadcast = createSendBroadcast();
    const waitUntil = vi.fn(() => {
      throw new Error('waitUntil failed');
    });
    const route = createAdminBroadcastRoute({
      adminToken: 'secret',
      sendBroadcast,
      waitUntil,
    });

    const response = await route(createRequest({ text: 'hello' }));

    expect(response.status).toBe(503);
    expect(sendBroadcast).not.toHaveBeenCalled();
  });
});
