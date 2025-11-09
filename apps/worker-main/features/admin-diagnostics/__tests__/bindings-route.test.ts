import { describe, expect, it, vi } from 'vitest';

import { createBindingsDiagnosticsRoute } from '../bindings-route';
import type { StoragePort } from '../../../ports';

const createRequest = (query: string) => new Request(`https://example.com/admin/diag${query}`);

describe('createBindingsDiagnosticsRoute', () => {
  const baseStorage = (): StoragePort => ({
    saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
    appendMessage: vi.fn().mockResolvedValue(undefined),
    getRecentMessages: vi.fn().mockResolvedValue([]),
  });

  it('performs bindings diagnostics and returns binding details', async () => {
    const storage = baseStorage();
    const route = createBindingsDiagnosticsRoute({ storage, now: () => new Date('2025-11-15T10:00:00.000Z') });

    const response = await route(createRequest('?q=bindings'));
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload).toMatchObject({
      query: 'bindings',
      ok: true,
      errors: [],
      results: { saveUser: { utmDegraded: false }, getRecentMessages: { count: 0 } },
    });

    expect(Array.isArray(payload.bindings.saveUser)).toBe(true);
    expect(payload.bindings.saveUser[0]).toBe('admin:diag:bindings');
    expect(storage.saveUser).toHaveBeenCalledTimes(1);
    expect(storage.getRecentMessages).toHaveBeenCalledWith({ userId: 'admin:diag:bindings', limit: 1 });
  });

  it('reports storage failures during diagnostics', async () => {
    const storage: StoragePort = {
      saveUser: vi.fn().mockRejectedValue(new Error('save failed')),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      getRecentMessages: vi.fn().mockResolvedValue([]),
    };
    const route = createBindingsDiagnosticsRoute({ storage });

    const response = await route(createRequest('?q=bindings'));
    expect(response.status).toBe(500);

    const payload = await response.json();
    expect(payload.ok).toBe(false);
    expect(payload.errors).toEqual(['storage.saveUser: save failed']);
  });

  it('rejects unsupported diagnostics queries', async () => {
    const storage = baseStorage();
    const route = createBindingsDiagnosticsRoute({ storage });

    const response = await route(createRequest('?q=unknown'));
    expect(response.status).toBe(400);
  });
});
