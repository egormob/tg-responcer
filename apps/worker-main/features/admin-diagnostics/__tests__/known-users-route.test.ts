import { describe, expect, it, vi } from 'vitest';

import { createKnownUsersClearRoute } from '../known-users-route';
import type { KnownUsersCache } from '../../utm-tracking/known-users-cache';
import { describeTelegramIdForLogs } from '../../../http/telegram-ids';

const createRequest = (init?: RequestInit) =>
  new Request('https://example.com/admin/known-users/clear', init);

describe('createKnownUsersClearRoute', () => {
  it('clears the known users cache and returns count with diagnostics', async () => {
    const cache = {
      clear: vi.fn().mockReturnValue(42),
      snapshot: vi.fn().mockReturnValue({
        size: 42,
        userIds: ['101', '202'],
      }),
    } satisfies Pick<KnownUsersCache, 'clear' | 'snapshot'>;
    const route = createKnownUsersClearRoute({ cache });

    const response = await route(createRequest());

    expect(cache.clear).toHaveBeenCalledTimes(1);
    expect(cache.snapshot).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      cleared: 42,
      size: 42,
      userIdHashes: [
        describeTelegramIdForLogs('101')?.hash,
        describeTelegramIdForLogs('202')?.hash,
      ],
    });
  });

  it('rejects unsupported methods', async () => {
    const cache = {
      clear: vi.fn().mockReturnValue(0),
      snapshot: vi.fn().mockReturnValue({ size: 0, userIds: [] }),
    } satisfies Pick<KnownUsersCache, 'clear' | 'snapshot'>;
    const route = createKnownUsersClearRoute({ cache });

    const response = await route(createRequest({ method: 'POST' }));

    expect(response.status).toBe(405);
    expect(cache.clear).not.toHaveBeenCalled();
    expect(cache.snapshot).not.toHaveBeenCalled();
  });
});
