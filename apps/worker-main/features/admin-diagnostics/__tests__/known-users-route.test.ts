import { describe, expect, it, vi } from 'vitest';

import { createKnownUsersClearRoute } from '../known-users-route';
import type { KnownUsersCache } from '../../utm-tracking/known-users-cache';

const createRequest = (init?: RequestInit) =>
  new Request('https://example.com/admin/known-users/clear', init);

describe('createKnownUsersClearRoute', () => {
  it('clears the known users cache and returns count', async () => {
    const cache = {
      clear: vi.fn().mockReturnValue(42),
    } satisfies Pick<KnownUsersCache, 'clear'>;
    const route = createKnownUsersClearRoute({ cache });

    const response = await route(createRequest());

    expect(cache.clear).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cleared: 42 });
  });

  it('rejects unsupported methods', async () => {
    const cache = {
      clear: vi.fn().mockReturnValue(0),
    } satisfies Pick<KnownUsersCache, 'clear'>;
    const route = createKnownUsersClearRoute({ cache });

    const response = await route(createRequest({ method: 'POST' }));

    expect(response.status).toBe(405);
    expect(cache.clear).not.toHaveBeenCalled();
  });
});
