import { describe, expect, it, vi, type Mock } from 'vitest';
import type { StoragePort } from '../../../ports';
import { createD1StressRoute, type CreateD1StressRouteOptions } from '../d1-stress-route';

const createScheduler = () => {
  let current = 0;
  return {
    now: () => current,
    wait: async (ms: number) => {
      current += Math.max(ms, 1);
    },
  };
};

const createRequest = (query = '') =>
  new Request(`https://example.com/admin/d1-stress${query}`, { method: 'POST' });

const createStorage = (overrides?: Partial<StoragePort>): StoragePort => ({
  saveUser: vi.fn<StoragePort['saveUser']>().mockResolvedValue({ utmDegraded: false }),
  appendMessage: vi.fn<StoragePort['appendMessage']>().mockResolvedValue(undefined),
  getRecentMessages: vi.fn<StoragePort['getRecentMessages']>().mockResolvedValue([]),
  ...overrides,
});

describe('createD1StressRoute', () => {
  it('rejects non-POST requests', async () => {
    const scheduler = createScheduler();
    const route = createD1StressRoute({
      storage: createStorage(),
      uuid: () => 'run',
      now: scheduler.now,
      wait: scheduler.wait,
    });

    const response = await route(new Request('https://example.com/admin/d1-stress'));
    expect(response.status).toBe(405);
  });

  it('marks saved entities with stress metadata and logs start/done', async () => {
    const scheduler = createScheduler();
    const storage = createStorage();
    const logger: Required<NonNullable<CreateD1StressRouteOptions['logger']>> = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const route = createD1StressRoute({
      storage,
      uuid: () => 'run-1',
      now: scheduler.now,
      wait: scheduler.wait,
      logger,
    });

    const response = await route(createRequest('?durationSec=2&concurrency=2'));
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.runId).toBe('run-1');
    expect(payload.concurrency).toBe(2);
    expect(payload.totals.ops.all).toBeGreaterThan(0);

    expect(storage.saveUser).toHaveBeenCalled();
    expect(storage.appendMessage).toHaveBeenCalled();

    const saveCall = (storage.saveUser as unknown as Mock).mock.calls[0]?.[0];
    expect(saveCall.metadata).toEqual({ stress: true, runId: 'run-1', op: 'saveUser' });

    const appendCall = (storage.appendMessage as unknown as Mock).mock.calls[0]?.[0];
    expect(appendCall.metadata).toEqual({ stress: true, runId: 'run-1', op: 'appendMessage' });
    expect(appendCall.chatId).toMatch(/^stress:run-1:/);

    const infoMessages = logger.info.mock.calls.map(([message]) => message as string);
    expect(infoMessages.some((message) => message.includes('[d1-stress][start]'))).toBe(true);
    expect(infoMessages.some((message) => message.includes('[d1-stress][done]'))).toBe(true);
  });

  it('handles retries, logs outcomes, and respects deadline', async () => {
    const scheduler = createScheduler();
    const retryableError = new Error('transient');
    const nonRetryableError = Object.assign(new Error('constraint failed'), { code: 'SQLITE_CONSTRAINT' });

    const saveUser = vi
      .fn<StoragePort['saveUser']>()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(new Error('still failing'))
      .mockResolvedValue({ utmDegraded: false });

    const appendMessage = vi
      .fn<StoragePort['appendMessage']>()
      .mockRejectedValueOnce(nonRetryableError)
      .mockResolvedValue(undefined);

    const storage = createStorage({ saveUser, appendMessage });
    const logger: Required<NonNullable<CreateD1StressRouteOptions['logger']>> = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const route = createD1StressRoute({
      storage,
      uuid: () => 'run-2',
      now: scheduler.now,
      wait: scheduler.wait,
      logger,
    });

    const response = await route(createRequest('?durationSec=3&concurrency=1'));
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.totals.successAfterRetryGe3).toBeGreaterThanOrEqual(1);
    expect(payload.totals.nonRetryable).toBeGreaterThanOrEqual(1);
    expect(payload.attemptsDistribution['3']).toBeGreaterThanOrEqual(1);
    expect(payload.attemptsDistribution['1']).toBeGreaterThanOrEqual(1);
    expect(payload.durationMs).toBeLessThanOrEqual(3000 + 100);

    const warnMessages = logger.warn.mock.calls.map(([message]) => message as string);
    expect(warnMessages.some((message) => message.includes('[d1-stress][retry]'))).toBe(true);

    const errorMessages = logger.error.mock.calls.map(([message]) => message as string);
    expect(errorMessages.some((message) => message.includes('[d1-stress][non_retryable]'))).toBe(true);
    expect(errorMessages.some((message) => message.includes('[d1-stress][max_retries_exceeded]'))).toBe(false);
  });

  it('uses auto concurrency when not specified', async () => {
    const scheduler = createScheduler();
    const storage = createStorage();

    const route = createD1StressRoute({
      storage,
      uuid: () => 'run-auto',
      now: scheduler.now,
      wait: scheduler.wait,
    });

    const response = await route(createRequest('?durationSec=2'));
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.concurrency).toBeGreaterThanOrEqual(8);
    expect(payload.concurrency).toBeLessThanOrEqual(32);
  });
});

