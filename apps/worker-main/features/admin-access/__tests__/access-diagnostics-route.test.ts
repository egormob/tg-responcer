import { describe, expect, it, vi } from 'vitest';

import { createAccessDiagnosticsRoute } from '../diagnostics-route';
import type { CompositionResult } from '../../../composition';

describe('createAccessDiagnosticsRoute', () => {
  const createComposition = (messaging: {
    sendTyping: ReturnType<typeof vi.fn>;
    sendText: ReturnType<typeof vi.fn>;
  }): CompositionResult => ({
    dialogEngine: {} as never,
    webhookSecret: 'secret',
    ports: {
      messaging: messaging as never,
      ai: {} as never,
      storage: {} as never,
      rateLimit: {} as never,
    },
  });

  it('returns whitelist with successful messaging health entries', async () => {
    const kv = {
      get: vi.fn().mockResolvedValue('{"whitelist":["123","456"]}'),
    };
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue({ messageId: '1' });
    const composition = createComposition({ sendTyping, sendText });

    const handleRequest = createAccessDiagnosticsRoute({
      env: { ADMIN_TG_IDS: kv },
      composition,
    });

    const response = await handleRequest(new Request('https://example.com/admin/access', { method: 'GET' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.whitelist).toEqual(['123', '456']);
    expect(payload.kvRaw).toBe('{"whitelist":["123","456"]}');
    expect(payload.health).toEqual([
      { userId: '123', status: 'ok' },
      { userId: '456', status: 'ok' },
    ]);

    expect(sendTyping).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it('reports messaging failure status when sendTyping rejects', async () => {
    const kv = {
      get: vi.fn().mockResolvedValue('{"whitelist":["789"]}'),
    };
    const error = Object.assign(new Error('blocked'), { status: 403 });
    const sendTyping = vi.fn().mockRejectedValue(error);
    const sendText = vi.fn().mockResolvedValue({});
    const composition = createComposition({ sendTyping, sendText });

    const handleRequest = createAccessDiagnosticsRoute({
      env: { ADMIN_TG_IDS: kv },
      composition,
    });

    const response = await handleRequest(new Request('https://example.com/admin/access', { method: 'GET' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.whitelist).toEqual(['789']);
    expect(payload.health).toEqual([
      { userId: '789', status: 403, lastError: 'blocked' },
    ]);
    expect(sendText).not.toHaveBeenCalled();
  });
});
