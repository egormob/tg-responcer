import { describe, expect, it, vi } from 'vitest';

import { createAdminExportRoute } from '../admin-export-route';

const createRequest = (url: string, init?: RequestInit) => new Request(url, init);

const createHandler = () => vi.fn().mockResolvedValue(new Response('ok'));

describe('createAdminExportRoute', () => {
  it('rejects non-GET methods', async () => {
    const handleExport = createHandler();
    const route = createAdminExportRoute({ adminToken: 'secret', handleExport });

    const response = await route(
      createRequest('https://example.com/admin/export', { method: 'POST' }),
    );

    expect(response.status).toBe(405);
    expect(handleExport).not.toHaveBeenCalled();
  });

  it('rejects requests without admin token', async () => {
    const handleExport = createHandler();
    const route = createAdminExportRoute({ adminToken: 'secret', handleExport });

    const response = await route(createRequest('https://example.com/admin/export'));

    expect(response.status).toBe(401);
    expect(handleExport).not.toHaveBeenCalled();
  });

  it('rejects requests with invalid token', async () => {
    const handleExport = createHandler();
    const route = createAdminExportRoute({ adminToken: 'secret', handleExport });

    const response = await route(
      createRequest('https://example.com/admin/export', {
        headers: { 'x-admin-token': 'invalid' },
      }),
    );

    expect(response.status).toBe(403);
    expect(handleExport).not.toHaveBeenCalled();
  });

  it('validates and forwards parameters to handler', async () => {
    const handleExport = createHandler();
    const route = createAdminExportRoute({ adminToken: 'secret', handleExport });

    const response = await route(
      createRequest('https://example.com/admin/export?from=2024-01-01&to=2024-01-31&limit=50&cursor=abc', {
        method: 'GET',
        headers: { 'x-admin-token': 'secret' },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(handleExport).toHaveBeenCalledTimes(1);
    const args = handleExport.mock.calls[0][0];
    expect(args.from).toBeInstanceOf(Date);
    expect(args.to).toBeInstanceOf(Date);
    expect(args.limit).toBe(50);
    expect(args.cursor).toBe('abc');
    expect(args.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses default limit when not provided', async () => {
    const handleExport = createHandler();
    const route = createAdminExportRoute({ adminToken: 'secret', handleExport });

    await route(
      createRequest('https://example.com/admin/export', {
        method: 'GET',
        headers: { 'x-admin-token': 'secret' },
      }),
    );

    expect(handleExport).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('returns 400 for invalid parameters', async () => {
    const handleExport = createHandler();
    const route = createAdminExportRoute({ adminToken: 'secret', handleExport });

    const response = await route(
      createRequest('https://example.com/admin/export?limit=-1', {
        method: 'GET',
        headers: { 'x-admin-token': 'secret' },
      }),
    );

    expect(response.status).toBe(400);
    expect(handleExport).not.toHaveBeenCalled();
  });
});
