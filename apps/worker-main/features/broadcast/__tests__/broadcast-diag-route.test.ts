import { describe, expect, it } from 'vitest';

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
});
