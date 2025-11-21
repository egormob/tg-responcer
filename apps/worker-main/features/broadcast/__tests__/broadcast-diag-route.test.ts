import { describe, expect, it, vi } from 'vitest';

import { createBroadcastDiagRoute } from '../broadcast-diag-route';

const createRequest = () =>
  new Request('https://example.com/admin/diag?q=broadcast', { method: 'GET' });

describe('createBroadcastDiagRoute', () => {
  it('returns disabled snapshot when telemetry is unavailable', async () => {
    const route = createBroadcastDiagRoute({});

    const response = await route(createRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'disabled',
      feature: 'broadcast_metrics',
    });
  });

  it('returns telemetry snapshot from storage-aware handler', async () => {
    const snapshot = {
      status: 'ok' as const,
      feature: 'broadcast_metrics' as const,
      totalRuns: 1,
      lastRun: null,
      history: [],
    };
    const telemetry = { snapshot: vi.fn().mockResolvedValue(snapshot) };
    const route = createBroadcastDiagRoute({ telemetry });

    const response = await route(createRequest());

    expect(await response.json()).toEqual(snapshot);
    expect(telemetry.snapshot).toHaveBeenCalled();
  });
});
