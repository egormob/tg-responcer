import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTelegramExportCommandHandler } from '../telegram-export-command';
import type {
  AdminExportLogKvNamespace,
  AdminExportRateLimitKvNamespace,
} from '../telegram-export-command';
import type { TelegramAdminCommandContext } from '../../../http';

const createContext = (argument?: string): TelegramAdminCommandContext => ({
  command: '/admin',
  rawCommand: '/admin',
  argument,
  text: `/admin ${argument ?? ''}`.trim(),
  chat: { id: '123', threadId: '456', type: 'supergroup' },
  from: { userId: '42' },
  messageId: '789',
  update: { update_id: 1 },
  message: {
    message_id: 789,
    chat: { id: 123 },
  } as unknown as TelegramAdminCommandContext['message'],
  incomingMessage: {
    chat: { id: '123', threadId: '456' },
    messageId: '789',
    receivedAt: new Date('2024-01-01T00:00:00Z'),
    text: `/admin ${argument ?? ''}`.trim(),
    user: {
      userId: '42',
    },
  },
});

describe('createTelegramExportCommandHandler', () => {
  const botToken = 'TEST_TOKEN';
  let fetchMock: ReturnType<typeof vi.fn>;

  const createFakeKv = () => {
    const store = new Map<string, { value: string; expirationTtl?: number }>();

    const kv: AdminExportRateLimitKvNamespace & {
      store: Map<string, { value: string; expirationTtl?: number }>;
    } = {
      store,
      async get(key: string, _type: 'text') {
        const record = store.get(key);
        return record ? record.value : null;
      },
      async put(key: string, value: string, options) {
        store.set(key, { value, expirationTtl: options.expirationTtl });
      },
    };

    return kv;
  };

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const createHandler = (
    options?: {
      handleExport?: ReturnType<typeof vi.fn>;
      adminAccess?: { isAdmin: ReturnType<typeof vi.fn> };
      rateLimit?: { checkAndIncrement: ReturnType<typeof vi.fn> };
      cooldownKv?: AdminExportRateLimitKvNamespace;
      exportLogKv?: AdminExportLogKvNamespace;
      now?: () => Date;
    },
  ) => {
    const handleExport =
      options?.handleExport
        ?? vi.fn().mockResolvedValue(
          new Response('id,text\n1,hello\n', {
            status: 200,
            headers: { 'content-type': 'text/csv' },
          }),
        );

    const adminAccess = options?.adminAccess ?? { isAdmin: vi.fn().mockResolvedValue(true) };
    const rateLimit =
      options?.rateLimit ?? { checkAndIncrement: vi.fn().mockResolvedValue<'ok' | 'limit'>('ok') };

    const handler = createTelegramExportCommandHandler({
      botToken,
      handleExport,
      adminAccess,
      rateLimit,
      now: options?.now ?? (() => new Date('2024-02-01T00:00:00Z')),
      cooldownKv: options?.cooldownKv,
      exportLogKv: options?.exportLogKv,
    });

    return { handler, handleExport, adminAccess, rateLimit };
  };

  it('uploads CSV to Telegram without date filters', async () => {
    const { handler, handleExport, rateLimit } = createHandler();

    const response = await handler(createContext('export'));

    expect(response?.status).toBe(200);
    expect(handleExport).toHaveBeenCalledWith({
      from: undefined,
      to: undefined,
      cursor: undefined,
      limit: undefined,
      signal: expect.any(AbortSignal),
    });

    expect(rateLimit.checkAndIncrement).toHaveBeenCalledWith({
      userId: '42',
      context: { chatId: '123', threadId: '456', scope: 'admin_export' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${botToken}/sendDocument`);
    expect(init?.method).toBe('POST');
    const body = init?.body as FormData;
    expect(body.get('chat_id')).toBe('123');
    expect(body.get('message_thread_id')).toBe('456');
    const document = body.get('document');
    expect(document).toBeInstanceOf(Blob);
    await expect((document as Blob).text()).resolves.toBe('id,text\n1,hello\n');
  });

  it('parses date arguments and converts to UTC ISO', async () => {
    const { handler, handleExport } = createHandler();

    await handler(createContext('export 2024-01-01 2024-02-01'));

    expect(handleExport).toHaveBeenCalledWith({
      from: new Date('2024-01-01T00:00:00Z'),
      to: new Date('2024-02-01T00:00:00Z'),
      cursor: undefined,
      limit: undefined,
      signal: expect.any(AbortSignal),
    });
  });

  it('returns 400 for invalid date formats', async () => {
    const { handler, handleExport } = createHandler();

    const response = await handler(createContext('export 2024-13-01'));

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: 'from must be a valid date in YYYY-MM-DD format' });
    expect(handleExport).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin users', async () => {
    const { handleExport, rateLimit } = createHandler();
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(false) };
    const handler = createTelegramExportCommandHandler({
      botToken,
      handleExport,
      adminAccess,
      rateLimit,
    });

    const response = await handler(createContext('export'));

    expect(response?.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limit exceeded', async () => {
    const { handleExport, adminAccess } = createHandler();
    const rateLimit = { checkAndIncrement: vi.fn().mockResolvedValue<'ok' | 'limit'>('limit') };
    const handler = createTelegramExportCommandHandler({
      botToken,
      handleExport,
      adminAccess,
      rateLimit,
    });

    const response = await handler(createContext('export 2024-01-01'));

    expect(response?.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handleExport).not.toHaveBeenCalled();
  });

  it('propagates errors from export handler', async () => {
    const error = new Error('boom');
    const handleExport = vi.fn().mockRejectedValue(error);
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(true) };
    const rateLimit = { checkAndIncrement: vi.fn().mockResolvedValue<'ok' | 'limit'>('ok') };
    const handler = createTelegramExportCommandHandler({
      botToken,
      handleExport,
      adminAccess,
      rateLimit,
    });

    const response = await handler(createContext('export'));

    expect(response?.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prevents repeated export requests within cooldown window', async () => {
    const { handleExport, adminAccess, rateLimit } = createHandler();
    const cooldownKv = createFakeKv();
    const handler = createTelegramExportCommandHandler({
      botToken,
      handleExport,
      adminAccess,
      rateLimit,
      cooldownKv,
      now: () => new Date('2024-02-01T00:00:00Z'),
    });


    const firstResponse = await handler(createContext('export 2024-01-01'));
    expect(firstResponse?.status).toBe(200);
    expect(cooldownKv.store.get('rate-limit:42')).toEqual({
      value: '1',
      expirationTtl: 30,
    });

    fetchMock.mockClear();
    handleExport.mockClear();

    const secondResponse = await handler(createContext('export 2024-01-01'));
    expect(secondResponse?.status).toBe(429);
    await expect(secondResponse?.json()).resolves.toEqual({
      error: 'Please wait up to 30 seconds before requesting another export.',
    });
    expect(handleExport).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes export metadata to kv after successful upload', async () => {
    const putMock = vi.fn().mockResolvedValue(undefined);
    const exportLogKv: AdminExportLogKvNamespace = {
      put: putMock,
    };

    const { handler } = createHandler({ exportLogKv });

    const response = await handler(createContext('export'));

    expect(response?.status).toBe(200);
    expect(putMock).toHaveBeenCalledTimes(1);
    const [key, value, options] = putMock.mock.calls[0];
    expect(key).toBe('log:2024-02-01T00:00:00.000Z:42');
    expect(options).toEqual({ expirationTtl: 60 * 60 * 24 * 30 });
    expect(JSON.parse(value as string)).toEqual({
      userId: '42',
      chatId: '123',
      from: null,
      to: null,
      rowCount: 1,
    });
  });
});
