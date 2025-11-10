import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTelegramBroadcastCommandHandler } from '../../features/broadcast/telegram-broadcast-command';
import { createTelegramExportCommandHandler } from '../../features/export/telegram-export-command';
import type { MessagingPort } from '../../ports';
import { transformTelegramUpdate } from '../telegram-webhook';
import type { TelegramUpdate } from '../telegram-webhook';

const createBaseUpdate = (): TelegramUpdate => ({
  update_id: 123,
  message: {
    message_id: 456,
    date: 1_710_000_000,
    text: 'hello world',
    from: {
      id: 789,
      first_name: 'Test',
      username: 'tester',
      language_code: 'en',
    },
    chat: {
      id: 555,
      type: 'private',
    },
  },
});

describe('transformTelegramUpdate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns dialog message for regular text update', async () => {
    const result = await transformTelegramUpdate(createBaseUpdate());

    expect(result).toMatchObject({ kind: 'message' });
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.text).toBe('hello world');
    expect(result.message.chat.id).toBe('555');
    expect(result.message.user.userId).toBe('789');
    expect(result.message.receivedAt).toBeInstanceOf(Date);
    expect(result.message.messageId).toBe('456');
  });

  it('attaches utmSource when /start payload matches expected pattern', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/start src_SPRING-Launch';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/start'.length },
    ];

    const result = await transformTelegramUpdate(update);

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.user.utmSource).toBe('src_SPRING-Launch');
  });

  it('attaches utmSource when startapp payload provided for mini app', async () => {
    const update = createBaseUpdate();
    update.startapp = 'src_MINI-App';

    const result = await transformTelegramUpdate(update);

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.user.utmSource).toBe('src_MINI-App');
  });

  it('extracts utmSource from mini app initData payload', async () => {
    const update = createBaseUpdate();
    const initData = new URLSearchParams({
      query_id: 'AA12345',
      start_param: 'src_INIT-Data',
      user: JSON.stringify({ id: 789 }),
      auth_date: '1710000000',
      hash: 'test',
    }).toString();

    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.query_id = 'AA12345';
    update.message.web_app_data = {
      data: JSON.stringify({ initData }),
    };

    const result = await transformTelegramUpdate(update);

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.user.utmSource).toBe('src_INIT-Data');
  });

  it('preserves plus signs in mini app initData payload', async () => {
    const update = createBaseUpdate();
    const initData = new URLSearchParams({
      query_id: 'AA67890',
      start_param: 'src.Campaign+Q1',
      user: JSON.stringify({ id: 789 }),
      auth_date: '1710000000',
      hash: 'test',
    }).toString();

    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.query_id = 'AA67890';
    update.message.web_app_data = {
      data: JSON.stringify({ initData }),
    };

    const result = await transformTelegramUpdate(update);

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.user.utmSource).toBe('src.Campaign+Q1');
  });

  it('attaches utmSource with dot prefix and special characters', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/start src.Campaign+Q1';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/start'.length },
    ];

    const result = await transformTelegramUpdate(update);

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.user.utmSource).toBe('src.Campaign+Q1');
  });

  it('does not set utmSource when /start command has no payload', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/start';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/start'.length },
    ];

    const result = await transformTelegramUpdate(update);

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.user.utmSource).toBeUndefined();
  });

  it('ignores invalid /start payloads', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/start referral=42';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/start'.length },
    ];

    const result = await transformTelegramUpdate(update);

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.user.utmSource).toBeUndefined();
  });

  it('invokes admin command handler for /admin command', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/admin status';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/admin'.length },
    ];

    const handleAdminCommand = vi.fn().mockResolvedValue(new Response('ok', { status: 202 }));

    const result = await transformTelegramUpdate(update, {
      features: { handleAdminCommand },
    });

    expect(result.kind).toBe('handled');
    expect(result.response?.status).toBe(202);

    expect(handleAdminCommand).toHaveBeenCalledTimes(1);
    const context = handleAdminCommand.mock.calls[0][0];
    expect(context.command).toBe('/admin');
    expect(context.rawCommand).toBe('/admin');
    expect(context.argument).toBe('status');
    expect(context.chat.id).toBe('555');
    expect(context.incomingMessage.text).toBe('/admin status');
  });

  it('ignores admin commands for other bots when botUsername provided', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/admin@OtherBot do';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/admin@OtherBot'.length },
    ];

    const result = await transformTelegramUpdate(update, {
      botUsername: 'mybot',
    });

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.text).toBe('/admin@OtherBot do');
  });

  it('passes admin command to dialog when handler is missing', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/admin';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/admin'.length },
    ];

    const result = await transformTelegramUpdate(update);

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.text).toBe('/admin');
  });

  it('continues dialog when admin command handler returns undefined', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/admin ping';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/admin'.length },
    ];

    const handleAdminCommand = vi.fn().mockResolvedValue(undefined);

    const result = await transformTelegramUpdate(update, {
      features: { handleAdminCommand },
    });

    expect(handleAdminCommand).toHaveBeenCalledTimes(1);
    const context = handleAdminCommand.mock.calls[0][0];
    expect(context.command).toBe('/admin');
    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.text).toBe('/admin ping');
  });

  it('continues dialog when broadcast command access is denied', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/broadcast';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/broadcast'.length },
    ];

    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(false) };
    const messaging = { sendText: vi.fn().mockResolvedValue(undefined) };
    const sendBroadcast = vi.fn();
    const broadcastHandler = createTelegramBroadcastCommandHandler({
      adminAccess,
      messaging,
      sendBroadcast,
      now: () => new Date(),
    });

    const result = await transformTelegramUpdate(update, {
      features: { handleAdminCommand: broadcastHandler.handleCommand },
    });

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('789');
    expect(messaging.sendText).not.toHaveBeenCalled();
    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.text).toBe('/broadcast');
  });

  it('routes dialog after broadcast command is followed by admin status', async () => {
    const broadcastUpdate = createBaseUpdate();
    const statusUpdate = createBaseUpdate();
    const messageUpdate = createBaseUpdate();

    if (!broadcastUpdate.message || !statusUpdate.message || !messageUpdate.message) {
      throw new Error('message is required for test');
    }

    broadcastUpdate.message.text = '/broadcast';
    broadcastUpdate.message.entities = [
      { type: 'bot_command', offset: 0, length: '/broadcast'.length },
    ];

    statusUpdate.message.text = '/admin status';
    statusUpdate.message.entities = [
      { type: 'bot_command', offset: 0, length: '/admin'.length },
    ];

    messageUpdate.message.text = 'привет, бот';
    delete messageUpdate.message.entities;

    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(true) };
    const messaging = { sendText: vi.fn().mockResolvedValue(undefined) } as Pick<MessagingPort, 'sendText'>;
    const sendBroadcast = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const broadcastHandler = createTelegramBroadcastCommandHandler({
      adminAccess,
      messaging,
      sendBroadcast,
      now: () => new Date('2024-01-01T00:00:00Z'),
      logger,
    });

    const features = { handleAdminCommand: broadcastHandler.handleCommand };

    const broadcastResult = await transformTelegramUpdate(broadcastUpdate, { features });
    expect(broadcastResult.kind).toBe('handled');

    const statusResult = await transformTelegramUpdate(statusUpdate, { features });
    expect(statusResult.kind).toBe('message');
    if (statusResult.kind !== 'message') {
      throw new Error('Expected message result');
    }
    expect(statusResult.message.text).toBe('/admin status');

    const dialogResult = await transformTelegramUpdate(messageUpdate, { features });
    expect(dialogResult.kind).toBe('message');
    if (dialogResult.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(dialogResult.message.text).toBe('привет, бот');
    expect(sendBroadcast).not.toHaveBeenCalled();
    expect(messaging.sendText).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('broadcast pending cleared before non-broadcast command', {
      userId: '789',
      chatId: '555',
      threadId: null,
      command: '/admin',
      argument: 'status',
    });
  });

  it('returns non-text result for voice messages without text', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    delete update.message.text;
    update.message.voice = { duration: 5 };

    const result = await transformTelegramUpdate(update);

    expect(result).toEqual({
      kind: 'non_text',
      chat: { id: '555', threadId: undefined },
      reply: 'voice',
    });
  });

  it('returns non-text result for media messages without captions', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    delete update.message.text;
    update.message.photo = [{ file_id: 'photo' }];

    const result = await transformTelegramUpdate(update);

    expect(result).toEqual({
      kind: 'non_text',
      chat: { id: '555', threadId: undefined },
      reply: 'media',
    });
  });

  it('returns handled ignored result when no message present', async () => {
    const result = await transformTelegramUpdate({ update_id: 1 });

    expect(result.kind).toBe('handled');
    await expect(result.response?.json()).resolves.toEqual({ status: 'ignored' });
  });

  it('sends export file for /export command', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/export';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/export'.length },
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const handleExport = vi
      .fn()
      .mockResolvedValue(
        new Response('message_id,chat_id,utm_source\n1,chat-1,src_demo\n', {
          status: 200,
          headers: { 'x-utm-sources': JSON.stringify(['src_demo']) },
        }),
      );
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(true) };
    const rateLimit = { checkAndIncrement: vi.fn().mockResolvedValue<'ok' | 'limit'>('ok') };
    const sendTextMock = vi.fn().mockResolvedValue({});
    const messaging: Pick<MessagingPort, 'sendText'> = {
      sendText: sendTextMock as unknown as MessagingPort['sendText'],
    };

    const exportHandler = createTelegramExportCommandHandler({
      botToken: 'token',
      handleExport,
      adminAccess,
      rateLimit,
      messaging,
      now: () => new Date('2024-02-01T00:00:00Z'),
    });

    const result = await transformTelegramUpdate(update, {
      features: {
        handleAdminCommand: (context) => exportHandler(context),
      },
    });

    expect(result.kind).toBe('handled');
    expect(result.response?.status).toBe(200);
    expect(handleExport).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const formData = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(formData.get('chat_id')).toBe('555');
    const document = formData.get('document');
    expect(document).toBeInstanceOf(Blob);
    await expect((document as Blob).text()).resolves.toBe(
      'message_id,chat_id,utm_source\n1,chat-1,src_demo\n',
    );
  });

  it('returns forbidden for /export when user is not admin', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/export 2024-01-01';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/export'.length },
    ];

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const handleExport = vi.fn();
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(false) };
    const rateLimit = { checkAndIncrement: vi.fn().mockResolvedValue<'ok' | 'limit'>('ok') };
    const messaging: Pick<MessagingPort, 'sendText'> = {
      sendText: vi.fn().mockResolvedValue({}) as unknown as MessagingPort['sendText'],
    };

    const exportHandler = createTelegramExportCommandHandler({
      botToken: 'token',
      handleExport,
      adminAccess,
      rateLimit,
      messaging,
    });

    const result = await transformTelegramUpdate(update, {
      features: {
        handleAdminCommand: (context) => exportHandler(context),
      },
    });

    expect(result.kind).toBe('handled');
    expect(result.response?.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handleExport).not.toHaveBeenCalled();
  });

  it('throws when incoming identifiers are unsafe integers', async () => {
    const update = createBaseUpdate();
    if (!update.message || !update.message.chat) {
      throw new Error('message is required for test');
    }

    update.message.chat.id = Number.MAX_SAFE_INTEGER + 2;

    await expect(transformTelegramUpdate(update)).rejects.toThrowError('UNSAFE_TELEGRAM_ID');
  });
});
