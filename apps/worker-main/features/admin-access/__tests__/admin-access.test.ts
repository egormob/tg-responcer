import { describe, expect, it, vi } from 'vitest';

import { createAdminAccess } from '../admin-access';

describe('createAdminAccess', () => {
  const createKv = (value: string | null | (() => string | null | Promise<string | null>)) => {
    const getter = typeof value === 'function' ? value : async () => value;
    return {
      get: vi.fn().mockImplementation(getter),
    };
  };

  it('allows user when whitelist contains matching id', async () => {
    const kv = createKv('{"whitelist":["123"]}');
    const access = createAdminAccess({ kv });

    await expect(access.isAdmin('123')).resolves.toBe(true);
    await expect(access.isAdmin('456')).resolves.toBe(false);

    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kv.get).toHaveBeenCalledWith('whitelist', 'text');
  });

  it('supports multiple identifiers', async () => {
    const kv = createKv('{"whitelist":["123","456","789"]}');
    const access = createAdminAccess({ kv });

    await expect(access.isAdmin('456')).resolves.toBe(true);
    await expect(access.isAdmin(789)).resolves.toBe(true);
    await expect(access.isAdmin('nope')).resolves.toBe(false);
  });

  it('handles invalid json gracefully', async () => {
    const kv = createKv('{not-json');
    const access = createAdminAccess({ kv });

    await expect(access.isAdmin('123')).resolves.toBe(false);
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it('treats missing key as empty whitelist', async () => {
    const kv = createKv(null);
    const access = createAdminAccess({ kv });

    await expect(access.isAdmin('123')).resolves.toBe(false);
  });

  it('refreshes whitelist when cache ttl expires', async () => {
    let value = '{"whitelist":["1"]}';
    let currentTime = 0;
    const kv = createKv(async () => value);

    const access = createAdminAccess({ kv, cacheTtlMs: 1_000, now: () => currentTime });

    await expect(access.isAdmin('1')).resolves.toBe(true);
    expect(kv.get).toHaveBeenCalledTimes(1);

    value = '{"whitelist":["2"]}';
    currentTime = 500;
    await expect(access.isAdmin('2')).resolves.toBe(false);
    expect(kv.get).toHaveBeenCalledTimes(1);

    currentTime = 1_500;
    await expect(access.isAdmin('2')).resolves.toBe(true);
    expect(kv.get).toHaveBeenCalledTimes(2);
  });
});
