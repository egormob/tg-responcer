import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTelegramExportCommandHandler } from '../telegram-export-command';
import type {
  AdminExportLogKvNamespace,
  AdminExportRateLimitKvNamespace,
} from '../telegram-export-command';
import { createAdminCommandErrorRecorder } from '../../admin-access/admin-messaging-errors';
import type { AdminCommandErrorRecorder } from '../../admin-access/admin-messaging-errors';
import type { MessagingPort } from '../../../ports';
import type { TelegramAdminCommandContext } from '../../../http';

const createContext = ({
  command = '/admin',
  argument,
}: {
  command?: '/admin' | '/export';
  argument?: string;
} = {}): TelegramAdminCommandContext => {
  const trimmedArgument = argument?.trim();
  const contextArgument = trimmedArgument && trimmedArgument.length > 0 ? trimmedArgument : undefined;
  const text = [command, contextArgument].filter(Boolean).join(' ').trim();

  return {
    command,
    rawCommand: command,
    argument: contextArgument,
    text,
    chat: { id: '123', threadId: '456', type: 'supergroup' },
    from: { userId: '42' },
    messageId: '789',
    update: { update_id: 1 },
    message: {
      message_id: '789',
      chat: { id: '123' },
    } as unknown as TelegramAdminCommandContext['message'],
    incomingMessage: {
      chat: { id: '123', threadId: '456' },
      messageId: '789',
      receivedAt: new Date('2024-01-01T00:00:00Z'),
      text,
      user: {
        userId: '42',
      },
    },
  };
};

describe('createTelegramExportCommandHandler', () => {
  const botToken = 'TEST_TOKEN';
  let fetchMock: ReturnType<typeof vi.fn>;

  const createFakeKv = () => {
    const store = new Map<string, { value: string; expirationTtl?: number }>();

    const kv: AdminExportRateLimitKvNamespace & {
      store: Map<string, { value: string; expirationTtl?: number }>;
    } = {
      store,
      async get(key: string, type: 'text') {
        void type;
        const record = store.get(key);
        return record ? record.value : null;
      },
      async put(key: string, value: string, options) {
        store.set(key, { value, expirationTtl: options?.expirationTtl });
      },
      async delete(key: string) {
        store.delete(key);
      },
      async list({ prefix }: { prefix?: string }) {
        const keys = Array.from(store.keys()).filter((key) =>
          prefix ? key.startsWith(prefix) : true,
        );
        return {
          keys: keys.map((key) => ({ name: key })),
          list_complete: true,
        } satisfies Awaited<ReturnType<AdminExportRateLimitKvNamespace['list']>>;
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
      adminAccessKv?: AdminExportRateLimitKvNamespace;
      cooldownKv?: AdminExportRateLimitKvNamespace;
      exportLogKv?: AdminExportLogKvNamespace;
      now?: () => Date;
      sendTextMock?: ReturnType<typeof vi.fn>;
      logger?: { info?: ReturnType<typeof vi.fn>; warn?: ReturnType<typeof vi.fn>; error?: ReturnType<typeof vi.fn> };
      adminErrorRecorder?: AdminCommandErrorRecorder;
    },
  ) => {
    const now = options?.now ?? (() => new Date('2024-02-01T00:00:00Z'));
    const handleExport =
      options?.handleExport
        ?? vi.fn().mockResolvedValue(
          new Response('message_id,chat_id,utm_source\n1,chat-1,src_demo\n', {
            status: 200,
            headers: {
              'content-type': 'text/csv',
              'x-utm-sources': JSON.stringify(['src_demo']),
            },
          }),
        );

    const adminAccess = options?.adminAccess ?? { isAdmin: vi.fn().mockResolvedValue(true) };
    const rateLimit =
      options?.rateLimit ?? { checkAndIncrement: vi.fn().mockResolvedValue<'ok' | 'limit'>('ok') };

    const sendTextMock = options?.sendTextMock ?? vi.fn().mockResolvedValue({});
    const messaging: Pick<MessagingPort, 'sendText'> = {
      sendText: sendTextMock as unknown as MessagingPort['sendText'],
    };

    const adminErrorRecorder =
      options?.adminErrorRecorder
      ?? createAdminCommandErrorRecorder({
        primaryKv: options?.adminAccessKv,
        fallbackKv: options?.cooldownKv,
        logger: options?.logger,
        now,
      });

    const handler = createTelegramExportCommandHandler({
      botToken,
      handleExport,
      adminAccess,
      rateLimit,
      messaging,
      adminAccessKv: options?.adminAccessKv,
      now,
      cooldownKv: options?.cooldownKv,
      exportLogKv: options?.exportLogKv,
      logger: options?.logger,
      adminErrorRecorder,
    });

    return { handler, handleExport, adminAccess, rateLimit, sendTextMock, logger: options?.logger };
  };

  it('sends help message for /admin without arguments when user is admin', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, adminAccess } = createHandler({ sendTextMock });

    const response = await handler(createContext({ command: '/admin' }));

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('42');
    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: '123',
      threadId: '456',
      text: [
        'Доступные команды администратора:',
        '- /admin status — проверить, есть ли у вас доступ администратора. Ответ: admin-ok или forbidden.',
        '- /broadcast — мгновенная рассылка',
        '- /export [from] [to] — выгрузить историю диалогов в CSV. Даты необязательные, формат YYYY-MM-DD. Запросы ограничены: не чаще одного раза в 60 секунд.',
      ].join('\n'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ help: 'sent' });
  });

  it('skips help message for non-admin users', async () => {
    const sendTextMock = vi.fn();
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(false) };
    const { handler } = createHandler({ sendTextMock, adminAccess });

    const response = await handler(createContext({ command: '/admin' }));

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('42');
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(response).toBeUndefined();
  });

  it('returns 502 when help message delivery fails', async () => {
    const sendTextMock = vi.fn().mockRejectedValue(new Error('network'));
    const { handler } = createHandler({ sendTextMock });

    const response = await handler(createContext({ command: '/admin' }));

    expect(sendTextMock).toHaveBeenCalledTimes(1);
    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({ error: 'Failed to send admin help response' });
  });

  it('logs status details and stores admin error when help message fails with 403', async () => {
    const error = Object.assign(new Error('bot was blocked'), {
      status: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    const sendTextMock = vi.fn().mockRejectedValue(error);
    const adminAccessKv = createFakeKv();
    const invalidate = vi.fn();
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(true), invalidate };
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const { handler } = createHandler({
      sendTextMock,
      adminAccessKv,
      adminAccess,
      logger,
    });

    const response = await handler(createContext({ command: '/admin' }));

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({ error: 'Failed to send admin help response' });
    expect(logger.error).toHaveBeenCalledWith(
      'failed to send admin help response',
      expect.objectContaining({
        userId: '42',
        status: 403,
        description: 'Forbidden: bot was blocked by the user',
      }),
    );
    expect(invalidate).toHaveBeenCalledWith('42');
    const rateLimitKey = 'admin-error-rate:42:admin_help';
    const errorKey = 'admin-error:42:20240201000000';
    const limiterRecord = adminAccessKv.store.get(rateLimitKey);
    const errorRecord = adminAccessKv.store.get(errorKey);

    expect(limiterRecord).toEqual({ value: '1', expirationTtl: 60 });
    expect(errorRecord).toBeDefined();
    expect(errorRecord?.expirationTtl).toBe(864000);
    expect(JSON.parse(errorRecord?.value as string)).toEqual({
      user_id: '42',
      cmd: 'admin_help',
      code: 403,
      desc: 'Forbidden: bot was blocked by the user',
      when: '2024-02-01T00:00:00.000Z',
    });
  });

  it('uploads CSV to Telegram without date filters', async () => {
    const { handler, handleExport, rateLimit } = createHandler();

    const response = await handler(createContext({ command: '/export' }));

    expect(response?.status).toBe(200);
    expect(handleExport).toHaveBeenCalledWith({
      from: undefined,
      to: undefined,
      cursor: undefined,
      limit: 1000,
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
    await expect((document as Blob).text()).resolves.toBe('message_id,chat_id,utm_source\n1,chat-1,src_demo\n');
  });

  it('iterates export cursor until all pages are merged', async () => {
    const firstResponse = new Response('message_id,chat_id,utm_source\n1,chat-1,src_a\n', {
      status: 200,
      headers: {
        'x-next-cursor': 'cursor-1',
        'x-utm-sources': JSON.stringify(['src_a']),
      },
    });
    const secondResponse = new Response('message_id,chat_id,utm_source\n2,chat-2,src_b\n', {
      status: 200,
      headers: {
        'x-utm-sources': JSON.stringify(['src_b']),
      },
    });
    const handleExport = vi
      .fn()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse);
    const { handler } = createHandler({ handleExport });

    const response = await handler(createContext({ command: '/export' }));

    expect(response?.status).toBe(200);
    expect(handleExport).toHaveBeenCalledTimes(2);
    expect(handleExport).toHaveBeenNthCalledWith(1, {
      from: undefined,
      to: undefined,
      cursor: undefined,
      limit: 1000,
      signal: expect.any(AbortSignal),
    });
    expect(handleExport).toHaveBeenNthCalledWith(2, {
      from: undefined,
      to: undefined,
      cursor: 'cursor-1',
      limit: 1000,
      signal: expect.any(AbortSignal),
    });

    const [, init] = fetchMock.mock.calls[0];
    const document = (init?.body as FormData).get('document');
    expect(document).toBeInstanceOf(Blob);
    await expect((document as Blob).text()).resolves.toBe(
      'message_id,chat_id,utm_source\n1,chat-1,src_a\n2,chat-2,src_b\n',
    );
  });

  it('notifies admin when row limit is reached', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const rows = Array.from({ length: 5000 }, (_, index) => `${index + 1},chat-${index + 1},src_limit`).join('\n');
    const csv = `message_id,chat_id,utm_source\n${rows}\n`;
    const handleExport = vi.fn().mockResolvedValue(
      new Response(csv, {
        status: 200,
        headers: {
          'x-next-cursor': 'cursor-limit',
          'x-utm-sources': JSON.stringify(['src_limit']),
        },
      }),
    );

    const { handler } = createHandler({ handleExport, sendTextMock });

    const response = await handler(createContext({ command: '/export' }));

    expect(response?.status).toBe(200);
    expect(handleExport).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: '123',
      threadId: '456',
      text: '⚠️ Экспорт ограничен первыми 5000 строками. Сузьте диапазон или разбейте выгрузку на несколько команд.',
    });
  });

  it('notifies admin when export has no rows', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const handleExport = vi.fn().mockResolvedValue(
      new Response('message_id,chat_id,utm_source\n', { status: 200 }),
    );

    const { handler } = createHandler({ handleExport, sendTextMock });

    const response = await handler(createContext({ command: '/export' }));

    expect(response?.status).toBe(200);
    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: '123',
      threadId: '456',
      text: 'За выбранный период нет новых сообщений — CSV содержит только заголовок. Уточните даты и повторите /export.',
    });
  });

  it('records export delivery failure diagnostics when Telegram returns an error', async () => {
    const adminAccessKv = createFakeKv();
    const invalidate = vi.fn();
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(true), invalidate };
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }),
        { status: 403 },
      ),
    );

    const { handler } = createHandler({ adminAccessKv, adminAccess, logger });

    const response = await handler(createContext({ command: '/export' }));

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({ error: 'Failed to send export to Telegram' });
    expect(invalidate).toHaveBeenCalledWith('42');
    const rateLimitKey = 'admin-error-rate:42:export_upload';
    const errorKey = 'admin-error:42:20240201000000';
    expect(adminAccessKv.store.get(rateLimitKey)).toEqual({ value: '1', expirationTtl: 60 });
    expect(JSON.parse(adminAccessKv.store.get(errorKey)?.value as string)).toEqual({
      user_id: '42',
      cmd: 'export_upload',
      code: 403,
      desc: 'Forbidden: bot was blocked by the user',
      when: '2024-02-01T00:00:00.000Z',
    });
  });

  it('parses date arguments and converts to UTC ISO', async () => {
    const { handler, handleExport } = createHandler();

    await handler(createContext({ command: '/export', argument: '2024-01-01 2024-02-01' }));

    expect(handleExport).toHaveBeenCalledWith({
      from: new Date('2024-01-01T00:00:00Z'),
      to: new Date('2024-02-01T00:00:00Z'),
      cursor: undefined,
      limit: 1000,
      signal: expect.any(AbortSignal),
    });
  });

  it('returns 400 for invalid date formats', async () => {
    const { handler, handleExport } = createHandler();

    const response = await handler(createContext({ command: '/export', argument: '2024-13-01' }));

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
      messaging: {
        sendText: vi.fn().mockResolvedValue({}) as unknown as MessagingPort['sendText'],
      },
    });

    const response = await handler(createContext({ command: '/export' }));

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
      messaging: {
        sendText: vi.fn().mockResolvedValue({}) as unknown as MessagingPort['sendText'],
      },
    });

    const response = await handler(createContext({ command: '/export', argument: '2024-01-01' }));

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
      messaging: {
        sendText: vi.fn().mockResolvedValue({}) as unknown as MessagingPort['sendText'],
      },
    });

    const response = await handler(createContext({ command: '/export' }));

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


    const firstResponse = await handler(createContext({ command: '/export', argument: '2024-01-01' }));
    expect(firstResponse?.status).toBe(200);
    expect(cooldownKv.store.get('rate-limit:42')).toEqual({
      value: '1',
      expirationTtl: 60,
    });

    fetchMock.mockClear();
    handleExport.mockClear();

    const secondResponse = await handler(createContext({ command: '/export', argument: '2024-01-01' }));
    expect(secondResponse?.status).toBe(429);
    await expect(secondResponse?.json()).resolves.toEqual({
      error: 'Please wait up to 30 seconds before requesting another export.',
    });
    expect(handleExport).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores cooldown in fallback namespace when primary kv fails', async () => {
    const fallbackKv = createFakeKv();
    const primaryErrorGet = new Error('primary get failed');
    const primaryErrorPut = new Error('primary put failed');
    const failingCooldownKv: AdminExportRateLimitKvNamespace = {
      async get() {
        throw primaryErrorGet;
      },
      async put() {
        throw primaryErrorPut;
      },
      async delete() {
        return undefined;
      },
      async list() {
        return { keys: [], list_complete: true } as const;
      },
    };

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const { handler } = createHandler({
      cooldownKv: failingCooldownKv,
      adminAccessKv: fallbackKv,
      logger,
    });

    const firstResponse = await handler(createContext({ command: '/export' }));
    expect(firstResponse?.status).toBe(200);
    expect(logger.info).toHaveBeenCalledWith(
      'admin export cooldown stored in fallback kv',
      expect.objectContaining({
        userId: '42',
        chatId: '123',
        error: { name: 'Error', message: 'primary put failed' },
      }),
    );
    expect(
      logger.warn.mock.calls.filter(([message]) => message === 'failed to update admin export cooldown kv'),
    ).toHaveLength(0);
    expect(fallbackKv.store.get('rate-limit:42')).toEqual({
      value: '1',
      expirationTtl: 60,
    });

    const secondResponse = await handler(createContext({ command: '/export' }));
    expect(secondResponse?.status).toBe(429);
    expect(logger.info).toHaveBeenCalledWith(
      'admin export cooldown resolved via fallback kv',
      expect.objectContaining({
        userId: '42',
        chatId: '123',
        error: { name: 'Error', message: 'primary get failed' },
      }),
    );
  });

  it('writes export metadata to kv after successful upload', async () => {
    const putMock = vi.fn().mockResolvedValue(undefined);
    const exportLogKv: AdminExportLogKvNamespace = {
      put: putMock,
    };

    const { handler } = createHandler({ exportLogKv });

    const response = await handler(createContext({ command: '/export' }));

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
      utmSources: ['src_demo'],
    });
  });

  it('sends admin-ok for status command when user is whitelisted', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, adminAccess } = createHandler({ sendTextMock });

    adminAccess.isAdmin.mockResolvedValueOnce(true);

    const response = await handler(createContext({ command: '/admin', argument: 'status' }));

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: 'admin-ok' });
    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: '123',
      threadId: '456',
      text: 'admin-ok',
    });
  });

  it('sends forbidden for status command when user is not in whitelist', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, adminAccess } = createHandler({ sendTextMock });

    adminAccess.isAdmin.mockResolvedValueOnce(false);

    const response = await handler(createContext({ command: '/admin', argument: 'status' }));

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: 'forbidden' });
    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: '123',
      threadId: '456',
      text: 'forbidden',
    });
  });

  it('supports legacy /admin export command', async () => {
    const { handler, handleExport } = createHandler();

    const response = await handler(createContext({ command: '/admin', argument: 'export 2024-01-01' }));

    expect(response?.status).toBe(200);
    expect(handleExport).toHaveBeenCalledWith({
      from: new Date('2024-01-01T00:00:00Z'),
      to: undefined,
      cursor: undefined,
      limit: 1000,
      signal: expect.any(AbortSignal),
    });
  });

  it('logs status details and stores admin error when status response fails with 400', async () => {
    const error = Object.assign(new Error('bad request'), {
      status: 400,
      description: 'Bad Request: chat not found',
    });
    const sendTextMock = vi.fn().mockRejectedValue(error);
    const adminAccessKv = createFakeKv();
    const invalidate = vi.fn();
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(true), invalidate };
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const { handler } = createHandler({
      sendTextMock,
      adminAccessKv,
      adminAccess,
      logger,
    });

    const response = await handler(createContext({ command: '/admin', argument: 'status' }));

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({ error: 'Failed to send admin status response' });
    expect(logger.error).toHaveBeenCalledWith(
      'failed to send admin status response',
      expect.objectContaining({
        userId: '42',
        status: 400,
        description: 'Bad Request: chat not found',
      }),
    );
    expect(invalidate).toHaveBeenCalledWith('42');
    const rateLimitKey = 'admin-error-rate:42:admin_status';
    const errorKey = 'admin-error:42:20240201000000';
    expect(adminAccessKv.store.get(rateLimitKey)).toEqual({ value: '1', expirationTtl: 60 });
    expect(JSON.parse(adminAccessKv.store.get(errorKey)?.value as string)).toEqual({
      user_id: '42',
      cmd: 'admin_status',
      code: 400,
      desc: 'Bad Request: chat not found',
      when: '2024-02-01T00:00:00.000Z',
    });
  });
});
