import { describe, expect, it, vi } from 'vitest';

import {
  BROADCAST_AUDIENCE_PROMPT,
  buildAwaitingSendPromptMessage,
  buildBroadcastPromptMessage,
  createTelegramBroadcastCommandHandler,
  type PendingBroadcast,
} from '../telegram-broadcast-command';
import type { BroadcastPendingKvNamespace } from '../telegram-broadcast-command';
import type { TelegramAdminCommandContext, TransformPayloadContext } from '../../../http';
import type { MessagingPort } from '../../../ports';
import type { IncomingMessage } from '../../../core';
import type { BroadcastSendResult, SendBroadcast } from '../minimal-broadcast-service';
import type { AdminCommandErrorRecorder } from '../../admin-access/admin-messaging-errors';

const createContext = ({
  command = '/broadcast',
  argument,
}: {
  command?: '/broadcast' | '/admin';
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
    chat: { id: 'chat-1', threadId: 'thread-1', type: 'private' },
    from: { userId: 'admin-1' },
    messageId: 'message-1',
    update: { update_id: 1 },
    message: {
      message_id: '1',
      chat: { id: '1' },
    } as unknown as TelegramAdminCommandContext['message'],
    incomingMessage: {
      chat: { id: 'chat-1', threadId: 'thread-1' },
      messageId: 'message-1',
      receivedAt: new Date('2024-01-01T00:00:00Z'),
      text,
      user: { userId: 'admin-1' },
    },
  };
};

const createIncomingMessage = (text: string): IncomingMessage => ({
  user: { userId: 'admin-1' },
  chat: { id: 'chat-1', threadId: 'thread-1' },
  text,
  messageId: 'incoming-1',
  receivedAt: new Date('2024-01-01T00:01:00Z'),
});

const expectCommandPrompt = (
  text: string,
  commands: Array<{ command: string; description: string }>,
  options: { header?: string; suffix?: string } = {},
) => {
  const lines = text.split('\n');
  let index = 0;

  if (options.header) {
    expect(lines[index]).toBe(options.header);
    index += 1;
  }

  commands.forEach(({ command, description }) => {
    const expectedLine = `- ${command} — ${description}`;
    const line = lines[index];
    expect(line).toBe(expectedLine);
    expect(line.startsWith('- /') || line.startsWith('/')).toBe(true);
    index += 1;
  });

  if (options.suffix) {
    expect(lines.slice(index).join('\n')).toBe(options.suffix);
  } else {
    expect(index).toBe(lines.length);
  }
};

type AwaitingAudience = Parameters<typeof buildAwaitingSendPromptMessage>[0];

const createAudience = (overrides: Partial<AwaitingAudience> = {}): AwaitingAudience => ({
  mode: 'all',
  total: 1,
  notFound: [],
  ...overrides,
});

const buildExpectedTooLongMessage = (_overflow: number) =>
  [
    'Текст не укладывается в лимит Telegram. Выберите:',
    '- /new_text — чтобы отправить другой текст',
    '- /cancel_broadcast — для отмены',
  ].join('\n');

describe('broadcast command prompts', () => {
  it('formats audience prompt with per-command lines', () => {
    expectCommandPrompt(BROADCAST_AUDIENCE_PROMPT, [
      { command: '/everybody', description: 'чтобы выбрать всех получателей' },
    ], {
      header:
        'Шаг 1. Выберите получателей или пришлите список user_id / username через запятую или пробел. Дубликаты уберём автоматически.',
    });
  });

  it('formats broadcast prompt without missing recipients', () => {
    expectCommandPrompt(buildBroadcastPromptMessage(3), [
      { command: '/cancel_broadcast', description: 'для отмены' },
    ], {
      header: 'Шаг 2. Пришлите текст для 3 получателей.',
    });
  });

  it('formats broadcast prompt with missing recipients suffix', () => {
    const text = buildBroadcastPromptMessage(2, ['missing-one']);
    expectCommandPrompt(text, [{ command: '/cancel_broadcast', description: 'для отмены' }], {
      header: 'Шаг 2. Пришлите текст для 2 получателей.',
      suffix: 'Не нашли: missing-one',
    });
  });

  it('formats awaiting send prompt with commands', () => {
    const audience = createAudience({ total: 5 });
    expectCommandPrompt(buildAwaitingSendPromptMessage(audience), [
      { command: '/send', description: 'чтобы отправить' },
      { command: '/new_text', description: 'чтобы изменить текст' },
      { command: '/cancel_broadcast', description: 'для отмены' },
    ], {
      header: 'Текст принят. Получателей 5. Выберите:',
    });
  });

  it('formats awaiting send prompt with missing recipients suffix', () => {
    const audience = createAudience({ total: 3, notFound: ['ghost'] });
    expectCommandPrompt(buildAwaitingSendPromptMessage(audience), [
      { command: '/send', description: 'чтобы отправить' },
      { command: '/new_text', description: 'чтобы изменить текст' },
      { command: '/cancel_broadcast', description: 'для отмены' },
    ], {
      header: 'Текст принят. Получателей 3. Выберите:',
      suffix: 'Не нашли: ghost',
    });
  });
});

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

const createPendingKv = () => {
  const store = new Map<string, { value: string; expiration?: number }>();

  const kv: BroadcastPendingKvNamespace = {
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async put(key, value, options) {
      const expiration = Math.floor(Date.now() / 1000) + (options.expirationTtl ?? 0);
      store.set(key, { value, expiration });
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return {
        keys: Array.from(store.entries()).map(([name, entry]) => ({
          name,
          expiration: entry.expiration,
        })),
        list_complete: true,
        cursor: '',
      };
    },
  };

  return { kv, store };
};

describe('createTelegramBroadcastCommandHandler', () => {
  const createHandler = ({
    isAdmin = true,
    sendTextMock = vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
    sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 2,
      failed: 0,
      deliveries: [],
      recipients: 2,
      durationMs: 50,
      source: 'D1',
      sample: [],
      throttled429: 0,
    }),
    adminErrorRecorder,
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    recipients = [
      { chatId: 'subscriber-1', username: 'alice' },
      { chatId: 'subscriber-2', username: 'bob' },
      { chatId: 'subscriber-3', username: 'charlie' },
    ],
    maxTextLength,
    pendingStore,
    pendingKv,
    sendAdminHelp = vi.fn().mockResolvedValue(undefined),
  }: {
    isAdmin?: boolean;
    sendTextMock?: ReturnType<typeof vi.fn>;
    sendBroadcastMock?: SendBroadcast;
    adminErrorRecorder?: AdminCommandErrorRecorder;
    logger?: { info?: (...args: unknown[]) => unknown; warn?: (...args: unknown[]) => unknown; error?: (...args: unknown[]) => unknown };
    recipients?: Array<{ chatId: string; username?: string }>;
    maxTextLength?: number;
    pendingStore?: Map<string, PendingBroadcast>;
    pendingKv?: BroadcastPendingKvNamespace;
    sendAdminHelp?: ReturnType<typeof vi.fn>;
  } = {}) => {
    const adminAccess = { isAdmin: vi.fn().mockResolvedValue(isAdmin) };
    const messaging: Pick<MessagingPort, 'sendText'> = {
      sendText: sendTextMock as unknown as MessagingPort['sendText'],
    };

    const recipientsRegistry = {
      listActiveRecipients: vi.fn().mockResolvedValue(recipients),
    };

    const exportLogKv = { put: vi.fn() };

    const handler = createTelegramBroadcastCommandHandler({
      adminAccess,
      messaging,
      sendBroadcast: sendBroadcastMock,
      now: () => new Date('2024-01-01T00:00:00Z'),
      logger,
      adminErrorRecorder,
      recipientsRegistry,
      exportLogKv,
      maxTextLength,
      pendingStore,
      pendingKv,
      sendAdminHelp,
    });

    return { handler, adminAccess, sendTextMock, sendBroadcastMock, logger, exportLogKv, sendAdminHelp };
  };

  const startBroadcastFlow = async (
    handler: ReturnType<typeof createTelegramBroadcastCommandHandler>,
    selection = '/everybody',
  ) => {
    await handler.handleCommand(createContext());
    const selectionResult = await handler.handleMessage(createIncomingMessage(selection));
    expect(selectionResult).toBe('handled');
  };

  const withFakeTimers = async <T>(fn: () => Promise<T>): Promise<T> => {
    const alreadyFake = vi.isFakeTimers();
    if (!alreadyFake) {
      vi.useFakeTimers();
    }

    try {
      return await fn();
    } finally {
      if (!alreadyFake) {
        vi.useRealTimers();
      }
    }
  };

  const flushPendingChunks = async (waitUntil: ReturnType<typeof vi.fn>) => {
    await withFakeTimers(async () => {
      await vi.runAllTimersAsync();
      const scheduled = waitUntil.mock.calls.at(-1)?.[0];
      if (scheduled) {
        await scheduled;
      }
    });
  };

  const submitTextAndAwaitPrompt = async (
    handler: ReturnType<typeof createTelegramBroadcastCommandHandler>,
    text: string,
  ) => {
    const waitUntil = vi.fn();
    const result = await handler.handleMessage(createIncomingMessage(text), { waitUntil });
    expect(result).toBe('handled');
    await flushPendingChunks(waitUntil);
    return waitUntil;
  };

  const completeBroadcast = async (
    handler: ReturnType<typeof createTelegramBroadcastCommandHandler>,
    text: string,
    options?: { sendContext?: TransformPayloadContext },
  ) => {
    const collectionWaitUntil = await submitTextAndAwaitPrompt(handler, text);
    void collectionWaitUntil;
    const sendWaitUntil = options?.sendContext?.waitUntil ?? vi.fn();
    const sendContext = { ...options?.sendContext, waitUntil: sendWaitUntil };
    const result = await handler.handleMessage(createIncomingMessage('/send'), sendContext);
    expect(result).toBe('handled');
    return { sendWaitUntil };
  };

  describe('stage mismatch notices', () => {
    it('repeats audience prompt when broadcast text arrives before audience selection', async () => {
      const sendTextMock = vi.fn().mockResolvedValue({});
      const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

      await handler.handleCommand(createContext());

      expect(sendTextMock).toHaveBeenNthCalledWith(1, {
        chatId: 'chat-1',
        threadId: 'thread-1',
        text: BROADCAST_AUDIENCE_PROMPT,
      });

      const mismatchResult = await handler.handleMessage(createIncomingMessage('Привет всем'));

      expect(mismatchResult).toBe('handled');
      expect(sendTextMock).toHaveBeenNthCalledWith(2, {
        chatId: 'chat-1',
        threadId: 'thread-1',
        text: `Эти данные не соответствуют выполняемой команде:\n${BROADCAST_AUDIENCE_PROMPT}`,
      });
      expect(sendBroadcastMock).not.toHaveBeenCalled();
    });

    it('reminds about /send prompt when arbitrary text arrives during awaiting_send', async () => {
      const sendTextMock = vi.fn().mockResolvedValue({});
      const sendBroadcastMock = vi.fn().mockResolvedValue({
        delivered: 1,
        failed: 0,
        deliveries: [],
        recipients: 1,
        durationMs: 10,
        source: 'D1',
        sample: [],
        throttled429: 0,
      });

      const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

      await startBroadcastFlow(handler);
      await submitTextAndAwaitPrompt(handler, 'Привет!');

      const sendCallsBeforeMismatch = sendTextMock.mock.calls.length;
      const mismatchResult = await handler.handleMessage(createIncomingMessage('любая строка'));

      expect(mismatchResult).toBe('handled');
      expect(sendTextMock).toHaveBeenNthCalledWith(sendCallsBeforeMismatch + 1, {
        chatId: 'chat-1',
        threadId: 'thread-1',
        text: `Эти данные не соответствуют выполняемой команде:\n${buildAwaitingSendPromptMessage({ mode: 'all', total: 3, notFound: [] })}`,
      });
      expect(sendBroadcastMock).not.toHaveBeenCalled();
    });

    it('sends mismatch notice when media arrives during collecting_text stage', async () => {
      const sendTextMock = vi.fn().mockResolvedValue({});
      const sendBroadcastMock = vi.fn().mockResolvedValue({
        delivered: 1,
        failed: 0,
        deliveries: [],
        recipients: 1,
        durationMs: 10,
        source: 'D1',
        sample: [],
        throttled429: 0,
      });

      const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

      await startBroadcastFlow(handler);

      const waitUntil = vi.fn();
      const textResult = await handler.handleMessage(createIncomingMessage('Сообщение на модерации'), {
        waitUntil,
      });

      expect(textResult).toBe('handled');

      const mediaMessage = { ...createIncomingMessage(''), text: undefined as unknown as string };
      const mismatchResult = await handler.handleMessage(mediaMessage);

      expect(mismatchResult).toBe('handled');
      expect(sendTextMock).toHaveBeenCalledWith({
        chatId: 'chat-1',
        threadId: 'thread-1',
        text: `Эти данные не соответствуют выполняемой команде:\n${buildAwaitingSendPromptMessage({ mode: 'all', total: 3, notFound: [] })}`,
      });
      expect(sendBroadcastMock).not.toHaveBeenCalled();

      await flushPendingChunks(waitUntil);
    });
  });

  it('prompts admin for audience selection after /broadcast command', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, adminAccess } = createHandler({ sendTextMock });

    const response = await handler.handleCommand(createContext());

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('admin-1');
    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: BROADCAST_AUDIENCE_PROMPT,
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: 'awaiting_audience' });
  });

  it('ignores command when user is not an admin', async () => {
    const sendTextMock = vi.fn();
    const { handler, adminAccess } = createHandler({ isAdmin: false, sendTextMock });

    const response = await handler.handleCommand(createContext());

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('admin-1');
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(response).toBeUndefined();
  });

  it('waits for confirmation before sending broadcast text', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const deferred = createDeferred<BroadcastSendResult>();
    const sendBroadcastMock = vi
      .fn<Parameters<SendBroadcast>, ReturnType<SendBroadcast>>()
      .mockReturnValue(deferred.promise);

    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await startBroadcastFlow(handler);

    await withFakeTimers(async () => {
      const collectionWaitUntil = vi.fn();
      const initialResult = handler.handleMessage(createIncomingMessage('hello everyone'), {
        waitUntil: collectionWaitUntil,
      });

      await expect(initialResult).resolves.toBe('handled');
      expect(sendBroadcastMock).not.toHaveBeenCalled();

      expect(collectionWaitUntil).toHaveBeenCalledTimes(1);
      const collectionPromise = collectionWaitUntil.mock.calls[0]?.[0];
      expect(typeof collectionPromise?.then).toBe('function');

      await vi.runAllTimersAsync();
      await collectionPromise;
    });

    expect(sendTextMock).toHaveBeenNthCalledWith(3, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildAwaitingSendPromptMessage({ mode: 'all', total: 3, notFound: [] }),
    });

    const sendWaitUntil = vi.fn();
    const sendResult = handler.handleMessage(createIncomingMessage('/send'), { waitUntil: sendWaitUntil });
    await expect(sendResult).resolves.toBe('handled');

    expect(sendBroadcastMock).toHaveBeenCalledWith({
      text: 'hello everyone',
      requestedBy: 'admin-1',
      filters: undefined,
    });

    expect(sendWaitUntil).toHaveBeenCalledTimes(1);
    const scheduled = sendWaitUntil.mock.calls[0]?.[0];
    expect(typeof scheduled?.then).toBe('function');

    deferred.resolve({
      delivered: 3,
      failed: 0,
      deliveries: [],
      recipients: 3,
      durationMs: 120,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    await scheduled;

    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: '✅ Рассылка отправлена!',
    });
  });

  it('finalizes collecting_text entries when debounce already elapsed after restart', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn<Parameters<SendBroadcast>, ReturnType<SendBroadcast>>()
      .mockResolvedValue({
        delivered: 3,
        failed: 0,
        deliveries: [],
        recipients: 3,
        durationMs: 75,
        source: 'D1',
        sample: [],
        throttled429: 0,
      });
    const pendingStore = new Map<string, PendingBroadcast>();
    pendingStore.set('admin-1', {
      chatId: 'chat-1',
      threadId: 'thread-1',
      stage: 'collecting_text',
      audience: { mode: 'all', total: 3, notFound: [] },
      textChunks: ['Recovered text'],
      chunkCount: 1,
      debounceUntil: new Date('2023-12-31T23:59:59Z').getTime(),
      expiresAt: new Date('2024-01-01T00:05:00Z').getTime(),
    });

    const { handler } = createHandler({ sendTextMock, sendBroadcastMock, pendingStore });

    const result = await handler.handleMessage(createIncomingMessage('/send'));
    expect(result).toBe('handled');

    expect(sendTextMock).toHaveBeenNthCalledWith(1, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildAwaitingSendPromptMessage({ mode: 'all', total: 3, notFound: [] }),
    });

    expect(sendBroadcastMock).toHaveBeenCalledWith({
      text: 'Recovered text',
      requestedBy: 'admin-1',
      filters: undefined,
    });

    expect(pendingStore.has('admin-1')).toBe(false);
  });

  it('rejects multi-message text and prompts for /new_text', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

    await startBroadcastFlow(handler);

    const firstWaitUntil = vi.fn();
    await handler.handleMessage(createIncomingMessage('short chunk'), { waitUntil: firstWaitUntil });
    await handler.handleMessage(createIncomingMessage('second chunk'));

    await flushPendingChunks(firstWaitUntil);

    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(0),
    });

    const rejectionPrompt = sendTextMock.mock.calls.at(-1)?.[0]?.text ?? '';
    expectCommandPrompt(rejectionPrompt, [
      { command: '/new_text', description: 'чтобы отправить другой текст' },
      { command: '/cancel_broadcast', description: 'для отмены' },
    ], {
      header: 'Текст не укладывается в лимит Telegram. Выберите:',
    });
  });

  it('blocks further messages after length rejection until /new_text is received', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi
      .fn<Parameters<SendBroadcast>, ReturnType<SendBroadcast>>()
      .mockResolvedValue({
        delivered: 3,
        failed: 0,
        deliveries: [],
        recipients: 3,
        durationMs: 42,
        source: 'D1',
        sample: [],
        throttled429: 0,
      });

    const { handler } = createHandler({ sendTextMock, sendBroadcastMock, maxTextLength: 5 });

    await startBroadcastFlow(handler);

    await handler.handleMessage(createIncomingMessage('123456'));

    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(1),
    });

    const overflowPrompt = sendTextMock.mock.calls.at(-1)?.[0]?.text ?? '';
    expectCommandPrompt(overflowPrompt, [
      { command: '/new_text', description: 'чтобы отправить другой текст' },
      { command: '/cancel_broadcast', description: 'для отмены' },
    ], {
      header: 'Текст не укладывается в лимит Telegram. Выберите:',
    });

    await handler.handleMessage(createIncomingMessage('ok'));

    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledTimes(4);

    await handler.handleMessage(createIncomingMessage('/new_text'));

    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildBroadcastPromptMessage(3),
    });

    await completeBroadcast(handler, 'short');

    expect(sendBroadcastMock).toHaveBeenCalledWith({
      filters: undefined,
      requestedBy: 'admin-1',
      text: 'short',
    });
  });

  it('writes broadcast log with d1 source and mode', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, exportLogKv } = createHandler({
      sendTextMock,
      sendBroadcastMock: vi.fn().mockResolvedValue({
        delivered: 1,
        failed: 0,
        deliveries: [],
        recipients: 1,
        durationMs: 15,
        source: 'D1',
        sample: [{ chatId: 'subscriber-1', threadId: null, username: null, languageCode: null }],
        throttled429: 0,
      }) as unknown as SendBroadcast,
    });

    await startBroadcastFlow(handler);

    const waitUntil = vi.fn();
    const { sendWaitUntil } = await completeBroadcast(handler, '/send hello!', {
      sendContext: { waitUntil },
    });
    const scheduled = sendWaitUntil.mock.calls[0]?.[0];
    expect(typeof scheduled?.then).toBe('function');
    await scheduled;

    expect(exportLogKv.put).toHaveBeenCalledWith(
      'broadcast:last',
      expect.any(String),
      { expirationTtl: 7 * 24 * 60 * 60 },
    );

    const payload = JSON.parse(exportLogKv.put.mock.calls[0]?.[1] ?? '{}');
    expect(payload).toMatchObject({
      mode: 'all',
      source: 'D1',
      not_found: [],
      delivered: 1,
      recipients: 1,
    });
    expect(payload.duration_ms).toBeGreaterThan(0);
  });

  it('deduplicates provided chat ids and usernames', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 1,
      failed: 0,
      deliveries: [],
      recipients: 1,
      durationMs: 25,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await handler.handleCommand(createContext());
    const selectionResult = await handler.handleMessage(
      createIncomingMessage('subscriber-2 @alice subscriber-2'),
    );
    expect(selectionResult).toBe('handled');

    expect(sendTextMock).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildBroadcastPromptMessage(2),
    });

    await completeBroadcast(handler, 'Segmented message');

    expect(sendBroadcastMock).toHaveBeenCalledWith({
      text: 'Segmented message',
      requestedBy: 'admin-1',
      filters: { chatIds: ['subscriber-2', 'subscriber-1'] },
    });
  });

  it('reports unknown audience entries and keeps them in prompt', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 1,
      failed: 0,
      deliveries: [],
      recipients: 1,
      durationMs: 25,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await handler.handleCommand(createContext());
    const selectionResult = await handler.handleMessage(createIncomingMessage('missing-one subscriber-3'));
    expect(selectionResult).toBe('handled');

    expect(sendTextMock).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildBroadcastPromptMessage(1, ['missing-one']),
    });

    await completeBroadcast(handler, 'Check not found');

    expect(sendBroadcastMock).toHaveBeenCalledWith({
      text: 'Check not found',
      requestedBy: 'admin-1',
      filters: { chatIds: ['subscriber-3'] },
    });
  });

  it('handles empty audience selection', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 0,
      failed: 0,
      deliveries: [],
      recipients: 0,
      durationMs: 10,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await handler.handleCommand(createContext());
    const selectionResult = await handler.handleMessage(createIncomingMessage('   '));
    expect(selectionResult).toBe('handled');

    expect(sendTextMock).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: `Эти данные не соответствуют выполняемой команде:\n${BROADCAST_AUDIENCE_PROMPT}`,
    });
  });

  it('ignores incoming message from a different thread', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 3,
      failed: 0,
      deliveries: [],
      recipients: 3,
      durationMs: 30,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await startBroadcastFlow(handler);

    const result = await handler.handleMessage({
      ...createIncomingMessage('hello everyone'),
      chat: { id: 'chat-1', threadId: 'thread-2' },
    });

    expect(result).toBeUndefined();
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledTimes(2);
  });

  it('rejects empty broadcast text and asks to restart', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

    await startBroadcastFlow(handler);
    const result = await handler.handleMessage(createIncomingMessage('   '));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: 'Текст рассылки не может быть пустым. Запустите команду заново:\n- /broadcast — чтобы начать заново',
    });

    const emptyPrompt = sendTextMock.mock.calls.at(-1)?.[0]?.text ?? '';
    expectCommandPrompt(emptyPrompt, [{ command: '/broadcast', description: 'чтобы начать заново' }], {
      header: 'Текст рассылки не может быть пустым. Запустите команду заново:',
    });
  });

  it('logs pending rejection when long text arrives after pending restore', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { kv, store } = createPendingKv();
    const pendingStore = new Map<string, PendingBroadcast>();
    const { handler, sendBroadcastMock } = createHandler({
      sendTextMock,
      logger,
      pendingKv: kv,
      pendingStore,
    });

    await handler.handleCommand(createContext());

    const restoredEntry: PendingBroadcast = {
      chatId: 'chat-1',
      threadId: 'thread-1',
      stage: 'text',
      audience: { mode: 'all', total: 3, notFound: [] },
      awaitingTextPrompt: true,
      expiresAt: new Date('2024-01-01T00:01:00Z').getTime(),
    };

    pendingStore.clear();
    store.set('broadcast:pending:admin-1', {
      value: JSON.stringify({ version: 2, entry: restoredEntry }),
      expiration: Math.floor(new Date('2024-01-01T00:01:00Z').getTime() / 1000),
    });

    await handler.handleMessage(createIncomingMessage('a'.repeat(4000)));

    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'broadcast text rejected',
      expect.objectContaining({ reason: 'too_long', length: 4000, limit: 3970 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'broadcast awaiting new text',
      expect.objectContaining({ exceededBy: 30 }),
    );
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(30),
    });
  });

  it('rejects text when raw length exceeds limit despite short visible length', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const pendingStore = new Map<string, PendingBroadcast>();
    const { handler, sendBroadcastMock } = createHandler({
      sendTextMock,
      logger,
      pendingStore,
    });

    await startBroadcastFlow(handler);

    const rawUrl = `https://example.com/${'a'.repeat(4000)}`;
    const text = `[hello](${rawUrl})`;
    const rawLength = text.length;
    const visibleLength = 'hello'.length;
    const exceededBy = rawLength - 3970;

    const result = await handler.handleMessage(createIncomingMessage(text));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'broadcast text rejected',
      expect.objectContaining({
        reason: 'too_long',
        length: rawLength,
        rawLength,
        visibleLength,
        limit: 3970,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'broadcast awaiting new text',
      expect.objectContaining({ exceededBy }),
    );
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(exceededBy),
    });

    const pending = pendingStore.get('admin-1');
    expect(pending?.awaitingNewText).toBe(true);
    expect(pending?.lastRejectedLength).toBe(rawLength);
  });

  it('awaits new text when markdown/html link raw length exceeds limit but visible fits', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const pendingStore = new Map<string, PendingBroadcast>();
    const { handler, sendBroadcastMock } = createHandler({
      sendTextMock,
      logger,
      pendingStore,
    });

    await startBroadcastFlow(handler);

    const markdownUrl = `https://example.com/${'a'.repeat(4000)}`;
    const htmlUrl = `https://example.com/${'b'.repeat(200)}`;
    const text = `[visible](${markdownUrl})<a href="${htmlUrl}">short</a>`;
    const rawLength = text.length;
    const visibleLength = 'visibleshort'.length;
    const exceededBy = rawLength - 3970;

    const result = await handler.handleMessage(createIncomingMessage(text));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'broadcast text rejected',
      expect.objectContaining({
        reason: 'too_long',
        length: rawLength,
        rawLength,
        visibleLength,
        limit: 3970,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'broadcast awaiting new text',
      expect.objectContaining({ exceededBy }),
    );
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(exceededBy),
    });

    const pending = pendingStore.get('admin-1');
    expect(pending?.awaitingNewText).toBe(true);
    expect(pending?.lastRejectedLength).toBe(rawLength);
  });

  it('resends awaiting text prompt when restored pending entry lacks prompt flag', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { kv, store } = createPendingKv();
    const pendingStore = new Map<string, PendingBroadcast>();
    const { handler, sendBroadcastMock } = createHandler({
      sendTextMock,
      logger,
      pendingKv: kv,
      pendingStore,
    });

    await handler.handleCommand(createContext());

    const restoredEntry: PendingBroadcast = {
      chatId: 'chat-1',
      threadId: 'thread-1',
      stage: 'text',
      audience: { mode: 'all', total: 3, notFound: [] },
      expiresAt: new Date('2024-01-01T00:01:00Z').getTime(),
    };

    pendingStore.clear();
    store.set('broadcast:pending:admin-1', {
      value: JSON.stringify({ version: 2, entry: restoredEntry }),
      expiration: Math.floor(new Date('2024-01-01T00:01:00Z').getTime() / 1000),
    });

    const result = await handler.handleMessage(createIncomingMessage('hello after restore'));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'broadcast awaiting text prompt restored',
      expect.objectContaining({ mode: 'all', total: 3, notFound: [] }),
    );
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildBroadcastPromptMessage(3),
    });
    expect(pendingStore.get('admin-1')).toEqual(
      expect.objectContaining({ awaitingTextPrompt: true, stage: 'text' }),
    );
  });

  it('rejects text that exceeds telegram limit with precise overflow notice', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

    await startBroadcastFlow(handler);
    const longText = 'a'.repeat(5000);
    const result = await handler.handleMessage(createIncomingMessage(longText));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(1030),
    });
  });

  it('keeps pending broadcast after repeated too long texts', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

    await startBroadcastFlow(handler);

    const firstAttempt = await handler.handleMessage(createIncomingMessage('a'.repeat(5000)));
    const secondAttempt = await handler.handleMessage(createIncomingMessage('b'.repeat(5001)));

    expect(firstAttempt).toBe('handled');
    expect(secondAttempt).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenNthCalledWith(4, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(1030),
    });
    expect(sendTextMock).toHaveBeenCalledTimes(4);
  });

  it('ignores messages while awaiting new text and refreshes rejection details', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const pendingStore = new Map<string, PendingBroadcast>();
    const { handler, sendBroadcastMock } = createHandler({
      sendTextMock,
      logger,
      maxTextLength: 5,
      pendingStore,
    });

    await startBroadcastFlow(handler);

    await handler.handleMessage(createIncomingMessage('1234567'));

    expect(pendingStore.get('admin-1')?.awaitingNewText).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      'broadcast awaiting new text',
      expect.objectContaining({ exceededBy: 2 }),
    );

    await handler.handleMessage(createIncomingMessage('tail payload'));

    expect(sendBroadcastMock).not.toHaveBeenCalled();
    const awaitingCalls = logger.info.mock.calls.filter(([message]) => message === 'broadcast awaiting new text');

    expect(awaitingCalls.length).toBeGreaterThanOrEqual(2);
    expect(awaitingCalls.at(-1)?.[1]).toEqual(expect.objectContaining({ exceededBy: 2 }));
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(2),
    });

    await handler.handleMessage(createIncomingMessage('/new_text'));

    expect(pendingStore.get('admin-1')?.awaitingNewText).toBe(false);
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildBroadcastPromptMessage(3),
    });

    await handler.handleMessage(createIncomingMessage('abcdef'));

    expect(pendingStore.get('admin-1')?.lastExceededBy).toBe(1);
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(1),
    });
  });

  it('restores awaiting new text state from kv and resends warning until /new_text', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { kv } = createPendingKv();
    const initialPendingStore = new Map<string, PendingBroadcast>();
    const { handler: initialHandler, sendBroadcastMock } = createHandler({
      sendTextMock,
      logger,
      maxTextLength: 5,
      pendingKv: kv,
      pendingStore: initialPendingStore,
    });

    await startBroadcastFlow(initialHandler);
    await initialHandler.handleMessage(createIncomingMessage('123456'));

    sendTextMock.mockClear();
    logger.info.mockClear();

    const restoredPendingStore = new Map<string, PendingBroadcast>();
    const { handler } = createHandler({
      sendTextMock,
      logger,
      maxTextLength: 5,
      pendingKv: kv,
      pendingStore: restoredPendingStore,
      sendBroadcastMock,
    });

    const ignoredResult = await handler.handleMessage(createIncomingMessage('tail after restore'));

    expect(ignoredResult).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(1),
    });
    expect(logger.info).toHaveBeenCalledWith(
      'broadcast awaiting new text',
      expect.objectContaining({ exceededBy: 1 }),
    );

    sendTextMock.mockClear();

    const promptResult = await handler.handleMessage(createIncomingMessage('/new_text'));

    expect(promptResult).toBe('handled');
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildBroadcastPromptMessage(3),
    });

    const repeatResult = await handler.handleMessage(createIncomingMessage('abcdefg'));

    expect(repeatResult).toBe('handled');
    expect(restoredPendingStore.get('admin-1')?.lastExceededBy).toBe(2);
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(2),
    });
  });

  it('requires /new_text after a too long message before accepting another text', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

    await startBroadcastFlow(handler);

    await handler.handleMessage(createIncomingMessage('a'.repeat(5000)));
    expect(sendTextMock).toHaveBeenNthCalledWith(3, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(1030),
    });
    const followUp = await handler.handleMessage(createIncomingMessage('короткий текст'));

    expect(followUp).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenNthCalledWith(4, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(1030),
    });
    expect(sendTextMock).toHaveBeenCalledTimes(4);
  });

  it('allows restarting broadcast with /broadcast while awaiting new text', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const pendingStore = new Map<string, PendingBroadcast>();
    const { kv, store } = createPendingKv();
    const { handler, sendBroadcastMock } = createHandler({
      sendTextMock,
      pendingStore,
      pendingKv: kv,
      maxTextLength: 5,
    });

    await startBroadcastFlow(handler);
    await handler.handleMessage(createIncomingMessage('123456'));

    expect(pendingStore.get('admin-1')?.awaitingNewText).toBe(true);
    expect(store.has('broadcast:pending:admin-1')).toBe(true);
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(1),
    });

    sendTextMock.mockClear();

    const restartResult = await handler.handleMessage(createIncomingMessage('/broadcast'));

    expect(restartResult).toBeUndefined();
    expect(pendingStore.get('admin-1')).toBeUndefined();
    expect(store.has('broadcast:pending:admin-1')).toBe(false);

    await startBroadcastFlow(handler);
    await completeBroadcast(handler, 'short');
    expect(sendTextMock).toHaveBeenNthCalledWith(1, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: BROADCAST_AUDIENCE_PROMPT,
    });
    expect(sendTextMock).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildBroadcastPromptMessage(3),
    });
    expect(sendBroadcastMock).toHaveBeenCalledWith({
      filters: undefined,
      requestedBy: 'admin-1',
      text: 'short',
    });
  });

  it('runs broadcast after valid text following /new_text and logs flow', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock, logger });

    await startBroadcastFlow(handler);

    await handler.handleMessage(createIncomingMessage('a'.repeat(5000)));
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(1030),
    });
    await handler.handleMessage(createIncomingMessage('/new_text'));

    const { sendWaitUntil } = await completeBroadcast(handler, 'ок');
    const scheduled = sendWaitUntil.mock.calls[0]?.[0];
    expect(typeof scheduled?.then).toBe('function');
    await scheduled;

    expect(sendBroadcastMock).toHaveBeenCalledWith({
      text: 'ок',
      requestedBy: 'admin-1',
      filters: undefined,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'broadcast text rejected',
      expect.objectContaining({ reason: 'too_long' }),
    );
    expect(logger.info.mock.calls.map(([message]: [string]) => message)).toEqual(
      expect.arrayContaining([
        'broadcast awaiting new text',
        'broadcast awaiting new text after rejection',
        'broadcast text chunk collected',
        'broadcast awaiting send confirmation',
        'broadcast dispatch confirmed via telegram command',
        'broadcast sent via telegram command',
      ]),
    );
  });

  it('allows resending text after /new_text command', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 3,
      failed: 0,
      deliveries: [],
      recipients: 3,
      durationMs: 120,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await startBroadcastFlow(handler);

    await handler.handleMessage(createIncomingMessage('a'.repeat(5000)));
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildExpectedTooLongMessage(1030),
    });
    const promptResult = await handler.handleMessage(createIncomingMessage('/new_text'));

    expect(promptResult).toBe('handled');
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: buildBroadcastPromptMessage(3),
    });

    const waitUntil = vi.fn();
    const { sendWaitUntil } = await completeBroadcast(handler, 'готовый текст', {
      sendContext: { waitUntil },
    });

    expect(sendBroadcastMock).toHaveBeenCalledWith({
      text: 'готовый текст',
      requestedBy: 'admin-1',
      filters: undefined,
    });

    const scheduled = sendWaitUntil.mock.calls[0]?.[0];
    expect(typeof scheduled?.then).toBe('function');
    await scheduled;
  });

  it('allows text that matches telegram limit without warnings', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockResolvedValue({
      delivered: 3,
      failed: 0,
      deliveries: [],
      recipients: 3,
      durationMs: 120,
      source: 'D1',
      sample: [],
      throttled429: 0,
    });
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await startBroadcastFlow(handler);
    const waitUntil = vi.fn();
    const { sendWaitUntil } = await completeBroadcast(handler, 'a'.repeat(3970), {
      sendContext: { waitUntil },
    });

    expect(sendWaitUntil).toHaveBeenCalledTimes(1);
    const scheduled = sendWaitUntil.mock.calls[0]?.[0];
    expect(typeof scheduled?.then).toBe('function');
    await scheduled;

    expect(sendBroadcastMock).toHaveBeenCalledWith({
      text: 'a'.repeat(3970),
      requestedBy: 'admin-1',
      filters: undefined,
    });
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: '✅ Рассылка отправлена!',
    });
  });

  it('records diagnostics when prompt delivery fails', async () => {
    const error = Object.assign(new Error('blocked'), { status: 403 });
    const sendTextMock = vi.fn().mockRejectedValue(error);
    const record = vi.fn().mockResolvedValue(undefined);
    const adminErrorRecorder: AdminCommandErrorRecorder = {
      record,
      source: 'primary',
      namespace: undefined,
    };

    const { handler, adminAccess } = createHandler({ sendTextMock, adminErrorRecorder });

    const response = await handler.handleCommand(createContext());

    expect(adminAccess.isAdmin).toHaveBeenCalledWith('admin-1');
    expect(record).toHaveBeenCalledWith({
      userId: 'admin-1',
      command: 'broadcast_prompt',
      error,
      details: { status: 403 },
    });
    expect(response?.status).toBe(502);
  });

  it('notifies admin when broadcast sending fails', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendBroadcastMock = vi.fn().mockRejectedValue(new Error('network error'));
    const { handler } = createHandler({ sendTextMock, sendBroadcastMock });

    await startBroadcastFlow(handler);
    const { sendWaitUntil } = await completeBroadcast(handler, 'hello everyone');
    const scheduled = sendWaitUntil.mock.calls[0]?.[0];
    expect(typeof scheduled?.then).toBe('function');
    await scheduled;

    expect(sendBroadcastMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: 'Не удалось отправить рассылку. Попробуйте ещё раз позже или обратитесь к оператору.',
    });
  });

  it('warns admin about unsupported /admin broadcast usage', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock });

    const response = await handler.handleCommand(createContext({ command: '/admin', argument: 'broadcast status' }));

    expect(sendTextMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: 'Мгновенная рассылка доступна только через эту команду:\n- /broadcast — без аргументов',
    });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ status: 'unsupported_broadcast_subcommand' });

    const result = await handler.handleMessage(createIncomingMessage('продолжить диалог'));

    expect(result).toBeUndefined();
    expect(sendBroadcastMock).not.toHaveBeenCalled();

    const baseAliasResponse = await handler.handleCommand(createContext({ command: '/admin', argument: 'broadcast' }));

    expect(sendTextMock).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: 'Мгновенная рассылка доступна только через эту команду:\n- /broadcast — без аргументов',
    });
    const unsupportedPrompt = sendTextMock.mock.calls.at(-1)?.[0]?.text ?? '';
    expectCommandPrompt(unsupportedPrompt, [{ command: '/broadcast', description: 'без аргументов' }], {
      header: 'Мгновенная рассылка доступна только через эту команду:',
    });
    await expect(baseAliasResponse?.json()).resolves.toEqual({ status: 'unsupported_broadcast_subcommand' });
  });

  it('cancels broadcast when admin sends /cancel_broadcast', async () => {
    const sendTextMock = vi.fn().mockResolvedValue({});
    const sendAdminHelp = vi.fn().mockResolvedValue(undefined);
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock, sendAdminHelp });

    await handler.handleCommand(createContext());
    const result = await handler.handleMessage(createIncomingMessage('/cancel_broadcast'));

    expect(result).toBe('handled');
    expect(sendBroadcastMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      text: '❌ Рассылка отменена. Чтобы отправить новое сообщение, выполните команду:\n- /broadcast — чтобы начать заново',
    });
    const cancelPrompt = sendTextMock.mock.calls.at(-1)?.[0]?.text ?? '';
    expectCommandPrompt(cancelPrompt, [{ command: '/broadcast', description: 'чтобы начать заново' }], {
      header: '❌ Рассылка отменена. Чтобы отправить новое сообщение, выполните команду:',
    });
    expect(sendAdminHelp).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-1',
      userId: 'admin-1',
    });
  });

  it('clears pending broadcast when admin runs another command', async () => {
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn() };
    const sendTextMock = vi.fn().mockResolvedValue({});
    const { handler, sendBroadcastMock } = createHandler({ sendTextMock, logger });

    await handler.handleCommand(createContext());

    const statusResult = await handler.handleCommand(createContext({ command: '/admin', argument: 'status' }));

    expect(statusResult).toBeUndefined();
    expect(info).toHaveBeenCalledWith('broadcast pending cleared before non-broadcast command', {
      userId: 'admin-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      command: '/admin',
      argument: 'status',
    });

    const messageResult = await handler.handleMessage(createIncomingMessage('не рассылка'));

    expect(messageResult).toBeUndefined();
    expect(sendBroadcastMock).not.toHaveBeenCalled();
  });

  it('ignores incoming messages when there is no active broadcast session', async () => {
    const { handler, sendBroadcastMock } = createHandler();

    const result = await handler.handleMessage(createIncomingMessage('ignored text'));

    expect(result).toBeUndefined();
    expect(sendBroadcastMock).not.toHaveBeenCalled();
  });
});

describe('worker integration for broadcast command', () => {
  it('enables broadcast command by default even without BROADCAST_ENABLED flag', async () => {
    vi.resetModules();

    const handleMessage = vi.fn();
    const messaging = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };
    const storage = {
      saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
      appendMessage: vi.fn(),
      getRecentMessages: vi.fn(),
    };
    const ai = { reply: vi.fn().mockResolvedValue({ text: 'ok', metadata: {} }) };
    const rateLimit = { checkAndIncrement: vi.fn().mockResolvedValue('ok') };

    const composeWorkerMock = vi.fn(({ adapters }: { adapters?: Record<string, unknown> }) => ({
      dialogEngine: { handleMessage },
      ports: {
        messaging: (adapters?.messaging as typeof messaging | undefined) ?? messaging,
        storage: (adapters?.storage as typeof storage | undefined) ?? storage,
        ai: (adapters?.ai as typeof ai | undefined) ?? ai,
        rateLimit: (adapters?.rateLimit as typeof rateLimit | undefined) ?? rateLimit,
      },
      webhookSecret: 'secret',
    }));

    vi.doMock('../../../composition', () => ({ composeWorker: composeWorkerMock }));
    vi.doMock('../../../adapters', () => ({
      createTelegramMessagingAdapter: vi.fn(() => messaging),
      createOpenAIResponsesAdapter: vi.fn(() => ai),
      createD1StorageAdapter: vi.fn(() => storage),
      createKvRateLimitAdapter: vi.fn(() => rateLimit),
      createQueuedMessagingPort: vi.fn((port) => port),
    }));

    const module = await import('../../../index');
    module.__internal.clearRouterCache();
    const worker = module.default;

    const adminKv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ whitelist: ['admin-1'] })),
      put: vi.fn(),
      list: vi.fn().mockResolvedValue({ keys: [] }),
      delete: vi.fn(),
    };

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            {
              chatId: 'subscriber-1',
              username: null,
              languageCode: null,
              createdAt: 1710000000,
              isBot: 0,
            },
          ],
        }),
      })),
    };

    const env = {
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_BOT_USERNAME: 'demo_bot',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-test',
      DB: db,
      ADMIN_EXPORT_LOG: { put: vi.fn() },
      ADMIN_TG_IDS: adminKv,
      ENV_VERSION: '1',
    } as Record<string, unknown>;

    const ctx = { waitUntil: vi.fn() } as { waitUntil(promise: Promise<unknown>): void };

    const commandUpdate = {
      update_id: 1,
      message: {
        message_id: '100',
        date: '1710000000',
        text: '/broadcast',
        entities: [{ type: 'bot_command', offset: 0, length: '/broadcast'.length }],
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
        message_thread_id: '77',
      },
    };

    const commandResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(commandUpdate),
      }),
      env,
      ctx,
    );

    expect(commandResponse.status).toBe(200);
    await expect(commandResponse.json()).resolves.toEqual({ status: 'awaiting_audience' });
    expect(handleMessage).not.toHaveBeenCalled();
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: BROADCAST_AUDIENCE_PROMPT,
    });

    const audienceResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          update_id: 2,
          message: {
            message_id: '101',
            date: '1710000005',
            text: '/everybody',
            from: { id: 'admin-1', first_name: 'Admin' },
            chat: { id: 'chat-1', type: 'private' },
            message_thread_id: '77',
          },
        }),
      }),
      env,
      ctx,
    );

    expect(audienceResponse.status).toBe(200);
    await expect(audienceResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(messaging.sendText).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: buildBroadcastPromptMessage(1),
    });

    vi.resetModules();
  });

  it('preserves pending broadcast session between webhook requests', async () => {
    vi.resetModules();

    const handleMessage = vi.fn();
    const messaging = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };
    const storage = {
      saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
      appendMessage: vi.fn(),
      getRecentMessages: vi.fn(),
    };
    const ai = { reply: vi.fn().mockResolvedValue({ text: 'ok', metadata: {} }) };
    const rateLimit = { checkAndIncrement: vi.fn().mockResolvedValue('ok') };

    const composeWorkerMock = vi.fn(({ adapters }: { adapters?: Record<string, unknown> }) => ({
      dialogEngine: { handleMessage },
      ports: {
        messaging: (adapters?.messaging as typeof messaging | undefined) ?? messaging,
        storage: (adapters?.storage as typeof storage | undefined) ?? storage,
        ai: (adapters?.ai as typeof ai | undefined) ?? ai,
        rateLimit: (adapters?.rateLimit as typeof rateLimit | undefined) ?? rateLimit,
      },
      webhookSecret: 'secret',
    }));

    vi.doMock('../../../composition', () => ({ composeWorker: composeWorkerMock }));
    vi.doMock('../../../adapters', () => ({
      createTelegramMessagingAdapter: vi.fn(() => messaging),
      createOpenAIResponsesAdapter: vi.fn(() => ai),
      createD1StorageAdapter: vi.fn(() => storage),
      createKvRateLimitAdapter: vi.fn(() => rateLimit),
      createQueuedMessagingPort: vi.fn((port) => port),
    }));

    const module = await import('../../../index');
    module.__internal.clearRouterCache();
    const worker = module.default;

    const adminKv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ whitelist: ['admin-1'] })),
      put: vi.fn(),
      list: vi.fn().mockResolvedValue({ keys: [] }),
      delete: vi.fn(),
    };

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            {
              chatId: 'subscriber-1',
              username: null,
              languageCode: null,
              createdAt: 1710000000,
              isBot: 0,
            },
          ],
        }),
      })),
    };

    const env = {
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_BOT_USERNAME: 'demo_bot',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-test',
      BROADCAST_ENABLED: 'true',
      DB: db,
      ADMIN_EXPORT_LOG: { put: vi.fn() },
      ADMIN_TG_IDS: adminKv,
      ENV_VERSION: '1',
    } as Record<string, unknown>;

    const ctx = { waitUntil: vi.fn() } as { waitUntil(promise: Promise<unknown>): void };

    const commandUpdate = {
      update_id: 1,
      message: {
        message_id: '100',
        date: '1710000000',
        text: '/broadcast',
        entities: [{ type: 'bot_command', offset: 0, length: '/broadcast'.length }],
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
        message_thread_id: '77',
      },
    };

    const commandResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(commandUpdate),
      }),
      env,
      ctx,
    );

    expect(commandResponse.status).toBe(200);
    await expect(commandResponse.json()).resolves.toEqual({ status: 'awaiting_audience' });
    expect(composeWorkerMock).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(messaging.sendText).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: BROADCAST_AUDIENCE_PROMPT,
    });

    const audienceResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          update_id: 2,
          message: {
            message_id: '101',
            date: '1710000005',
            text: '/everybody',
            from: { id: 'admin-1', first_name: 'Admin' },
            chat: { id: 'chat-1', type: 'private' },
            message_thread_id: '77',
          },
        }),
      }),
      env,
      ctx,
    );

    expect(audienceResponse.status).toBe(200);
    await expect(audienceResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(messaging.sendText).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: buildBroadcastPromptMessage(1),
    });

    messaging.sendText.mockClear();

    const recipientDeferred = createDeferred<{ messageId?: string } | void>();
    messaging.sendText.mockImplementation(({ chatId, threadId, text: messageText }) => {
      if (chatId === 'subscriber-1') {
        return recipientDeferred.promise;
      }

      return Promise.resolve({
        messageId: `sent-${chatId}-${threadId ?? 'null'}-${messageText.slice(0, 4)}`,
      });
    });

    const broadcastTextUpdate = {
      update_id: 3,
      message: {
        message_id: '102',
        date: '1710000010',
        text: 'Всем привет',
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
        message_thread_id: '77',
      },
    };

    const textResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(broadcastTextUpdate),
      }),
      env,
      ctx,
    );

    expect(textResponse.status).toBe(200);
    await expect(textResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(composeWorkerMock).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);

    const chunkTask = ctx.waitUntil.mock.calls[0]?.[0];
    expect(typeof chunkTask?.then).toBe('function');
    await chunkTask;

    expect(messaging.sendText).toHaveBeenNthCalledWith(1, {
      chatId: 'chat-1',
      threadId: '77',
      text: buildAwaitingSendPromptMessage({ mode: 'all', total: 1, notFound: [] }),
    });

    const sendUpdate = {
      update_id: 4,
      message: {
        message_id: '103',
        date: '1710000015',
        text: '/send',
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
        message_thread_id: '77',
      },
    };

    const sendResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sendUpdate),
      }),
      env,
      ctx,
    );

    expect(sendResponse.status).toBe(200);
    await expect(sendResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);

    const backgroundTask = ctx.waitUntil.mock.calls.at(-1)?.[0];
    expect(typeof backgroundTask?.then).toBe('function');

    expect(messaging.sendText).toHaveBeenNthCalledWith(2, {
      chatId: 'subscriber-1',
      threadId: undefined,
      text: 'Всем привет',
    });

    recipientDeferred.resolve({ messageId: 'delivered-1' });
    await backgroundTask;

    expect(messaging.sendText).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: '77',
      text: '✅ Рассылка отправлена!',
    });

    expect(adminKv.get).toHaveBeenCalledWith('whitelist', 'text');

    vi.resetModules();
  });

  it('keeps pending broadcast after router cache reset and worker restart', async () => {
    vi.resetModules();

    const handleMessage = vi.fn();
    const messaging = {
      sendTyping: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue({ messageId: 'sent-1' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };
    const storage = {
      saveUser: vi.fn().mockResolvedValue({ utmDegraded: false }),
      appendMessage: vi.fn(),
      getRecentMessages: vi.fn(),
    };
    const ai = { reply: vi.fn().mockResolvedValue({ text: 'ok', metadata: {} }) };
    const rateLimit = { checkAndIncrement: vi.fn().mockResolvedValue('ok') };

    const composeWorkerMock = vi.fn(({ adapters }: { adapters?: Record<string, unknown> }) => ({
      dialogEngine: { handleMessage },
      ports: {
        messaging: (adapters?.messaging as typeof messaging | undefined) ?? messaging,
        storage: (adapters?.storage as typeof storage | undefined) ?? storage,
        ai: (adapters?.ai as typeof ai | undefined) ?? ai,
        rateLimit: (adapters?.rateLimit as typeof rateLimit | undefined) ?? rateLimit,
      },
      webhookSecret: 'secret',
    }));

    vi.doMock('../../../composition', () => ({ composeWorker: composeWorkerMock }));
    vi.doMock('../../../adapters', () => ({
      createTelegramMessagingAdapter: vi.fn(() => messaging),
      createOpenAIResponsesAdapter: vi.fn(() => ai),
      createD1StorageAdapter: vi.fn(() => storage),
      createKvRateLimitAdapter: vi.fn(() => rateLimit),
      createQueuedMessagingPort: vi.fn((port) => port),
    }));

    const module = await import('../../../index');
    module.__internal.clearRouterCache();
    const worker = module.default;

    const adminKv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ whitelist: ['admin-1'] })),
      put: vi.fn(),
      list: vi.fn().mockResolvedValue({ keys: [] }),
      delete: vi.fn(),
    };

    const pendingKv = createPendingKv();

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            {
              chatId: 'subscriber-1',
              username: null,
              languageCode: null,
              createdAt: 1710000000,
              isBot: 0,
            },
          ],
        }),
      })),
    };

    const env = {
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_BOT_USERNAME: 'demo_bot',
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'gpt-test',
      DB: db,
      ADMIN_EXPORT_LOG: { put: vi.fn() },
      ADMIN_TG_IDS: adminKv,
      ENV_VERSION: '1',
      BROADCAST_PENDING_KV: pendingKv.kv,
    } as Record<string, unknown>;

    const ctx = { waitUntil: vi.fn() } as { waitUntil(promise: Promise<unknown>): void };

    const commandUpdate = {
      update_id: 1,
      message: {
        message_id: '100',
        date: '1710000000',
        text: '/broadcast',
        entities: [{ type: 'bot_command', offset: 0, length: '/broadcast'.length }],
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
      },
    };

    const audienceUpdate = {
      update_id: 2,
      message: {
        message_id: '101',
        date: '1710000005',
        text: '/everybody',
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
      },
    };

    const commandResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(commandUpdate),
      }),
      env,
      ctx,
    );

    expect(commandResponse.status).toBe(200);
    await expect(commandResponse.json()).resolves.toEqual({ status: 'awaiting_audience' });
    expect(handleMessage).not.toHaveBeenCalled();

    module.__internal.clearRouterCache(env as never);
    module.__internal.clearBroadcastSessionStore(env as never);

    const audienceResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(audienceUpdate),
      }),
      env,
      ctx,
    );

    expect(audienceResponse.status).toBe(200);
    await expect(audienceResponse.json()).resolves.toEqual({ status: 'ok' });

    messaging.sendText.mockReset();
    const recipientDeferred = createDeferred<{ messageId?: string }>();
    messaging.sendText.mockImplementation(({ chatId, text }) => {
      if (chatId === 'subscriber-1') {
        return recipientDeferred.promise;
      }

      return Promise.resolve({ messageId: `sent-${chatId}-${text.slice(0, 4)}` });
    });

    const broadcastTextUpdate = {
      update_id: 3,
      message: {
        message_id: '102',
        date: '1710000010',
        text: 'Всем привет',
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
      },
    };

    const waitUntilCallsBeforeText = ctx.waitUntil.mock.calls.length;

    const broadcastResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(broadcastTextUpdate),
      }),
      env,
      ctx,
    );

    expect(broadcastResponse.status).toBe(200);
    await expect(broadcastResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(handleMessage).not.toHaveBeenCalled();
    expect(ctx.waitUntil.mock.calls.length).toBeGreaterThan(waitUntilCallsBeforeText);

    const chunkTask = ctx.waitUntil.mock.calls.at(-1)?.[0];
    expect(typeof chunkTask?.then).toBe('function');
    await chunkTask;

    expect(messaging.sendText).toHaveBeenNthCalledWith(1, {
      chatId: 'chat-1',
      threadId: undefined,
      text: buildAwaitingSendPromptMessage({ mode: 'all', total: 1, notFound: [] }),
    });

    module.__internal.clearRouterCache(env as never);
    module.__internal.clearBroadcastSessionStore(env as never);

    const sendUpdate = {
      update_id: 4,
      message: {
        message_id: '103',
        date: '1710000015',
        text: '/send',
        from: { id: 'admin-1', first_name: 'Admin' },
        chat: { id: 'chat-1', type: 'private' },
      },
    };

    const waitUntilCallsBeforeSend = ctx.waitUntil.mock.calls.length;

    const sendResponse = await worker.fetch(
      new Request('https://example.com/webhook/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sendUpdate),
      }),
      env,
      ctx,
    );

    expect(sendResponse.status).toBe(200);
    await expect(sendResponse.json()).resolves.toEqual({ status: 'ok' });
    expect(ctx.waitUntil.mock.calls.length).toBeGreaterThan(waitUntilCallsBeforeSend);

    const backgroundTask = ctx.waitUntil.mock.calls.at(-1)?.[0];
    expect(typeof backgroundTask?.then).toBe('function');

    expect(messaging.sendText).toHaveBeenNthCalledWith(2, {
      chatId: 'subscriber-1',
      threadId: undefined,
      text: 'Всем привет',
    });

    recipientDeferred.resolve({ messageId: 'delivered-late' });
    await backgroundTask;

    expect(messaging.sendText).toHaveBeenLastCalledWith({
      chatId: 'chat-1',
      threadId: undefined,
      text: '✅ Рассылка отправлена!',
    });

    vi.resetModules();
  });
});
