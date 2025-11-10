import { describe, expect, it, vi } from 'vitest';

import { createBindingsDiagnosticsRoute } from '../bindings-route';
import type { StoragePort } from '../../../ports';

const createRequest = (query: string) => new Request(`https://example.com/admin/diag${query}`);

const baseEnv = {
  TELEGRAM_BOT_TOKEN: '123456:ABCDEF',
  OPENAI_API_KEY: 'sk-test',
};

describe('createBindingsDiagnosticsRoute', () => {
  const baseStorage = (): StoragePort => ({
    saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
    appendMessage: vi.fn().mockResolvedValue(undefined),
    getRecentMessages: vi.fn().mockResolvedValue([]),
  });

  it('performs bindings diagnostics and returns binding details', async () => {
    const storage = baseStorage();
    const route = createBindingsDiagnosticsRoute({
      storage,
      env: baseEnv,
      now: () => new Date('2025-11-15T10:00:00.000Z'),
    });

    const response = await route(createRequest('?q=bindings'));
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload).toMatchObject({
      query: 'bindings',
      ok: true,
      errors: [],
      results: { saveUser: { utmDegraded: false }, getRecentMessages: { count: 0 } },
      secrets: {
        telegramBotToken: { present: true },
        openAiApiKey: { present: true },
      },
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
    const route = createBindingsDiagnosticsRoute({
      storage,
      env: baseEnv,
    });

    const response = await route(createRequest('?q=bindings'));
    expect(response.status).toBe(500);

    const payload = await response.json();
    expect(payload.ok).toBe(false);
    expect(payload.errors).toEqual(['storage.saveUser: save failed']);
  });

  it('rejects unsupported diagnostics queries', async () => {
    const storage = baseStorage();
    const route = createBindingsDiagnosticsRoute({
      storage,
      env: baseEnv,
    });

    const response = await route(createRequest('?q=unknown'));
    expect(response.status).toBe(400);
  });

  it('runs telegram.getMe diagnostics and masks token', async () => {
    const storage = baseStorage();
    const fetchApi = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({ ok: true }),
    });

    const route = createBindingsDiagnosticsRoute({
      storage,
      env: baseEnv,
      fetchApi,
    });

    const response = await route(createRequest('?q=telegram.getMe'));
    expect(fetchApi).toHaveBeenCalledWith('https://api.telegram.org/bot123456:ABCDEF/getMe');
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload).toEqual({
      query: 'telegram.getMe',
      ok: true,
      status: 200,
      description: 'OK',
      tokenMasked: '1234…CDEF',
    });
  });

  it('reports missing bot token for telegram.getMe diagnostics', async () => {
    const storage = baseStorage();
    const route = createBindingsDiagnosticsRoute({
      storage,
      env: { TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'sk-test' },
    });

    const response = await route(createRequest('?q=telegram.getMe'));
    expect(response.status).toBe(500);

    const payload = await response.json();
    expect(payload).toEqual({
      query: 'telegram.getMe',
      ok: false,
      status: null,
      description: 'TELEGRAM_BOT_TOKEN is not configured',
      tokenMasked: undefined,
    });
  });

  it('surfaces fetch errors for telegram.getMe diagnostics', async () => {
    const storage = baseStorage();
    const fetchApi = vi.fn().mockRejectedValue(new Error('network failure'));

    const route = createBindingsDiagnosticsRoute({
      storage,
      env: baseEnv,
      fetchApi,
    });

    const response = await route(createRequest('?q=telegram.getMe'));
    expect(response.status).toBe(502);

    const payload = await response.json();
    expect(payload).toEqual({
      query: 'telegram.getMe',
      ok: false,
      status: null,
      description: 'network failure',
      tokenMasked: '1234…CDEF',
    });
  });
});
