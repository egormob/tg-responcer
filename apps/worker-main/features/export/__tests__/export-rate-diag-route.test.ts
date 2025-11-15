import { describe, expect, it, vi } from 'vitest';

import { createExportRateDiagRoute } from '../export-rate-diag-route';

describe('createExportRateDiagRoute', () => {
  it('rejects non-GET requests', async () => {
    const route = createExportRateDiagRoute({});
    const response = await route(new Request('https://example.test/admin/diag?q=export-rate', { method: 'POST' }));

    expect(response.status).toBe(405);
  });

  it('returns disabled snapshot when telemetry unavailable', async () => {
    const route = createExportRateDiagRoute({});
    const response = await route(new Request('https://example.test/admin/diag?q=export-rate'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'disabled', feature: 'admin_export_rate_limit' });
  });

  it('returns telemetry snapshot when available', async () => {
    const snapshot = { status: 'ok', feature: 'admin_export_rate_limit', limit: 5, windowMs: 60_000, totals: { ok: 1, limit: 0 }, buckets: [], lastLimit: null };
    const telemetry = { snapshot: vi.fn().mockReturnValue(snapshot) };
    const route = createExportRateDiagRoute({ telemetry });

    const response = await route(new Request('https://example.test/admin/diag?q=export-rate'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(snapshot);
    expect(telemetry.snapshot).toHaveBeenCalledTimes(1);
  });
});
