import { getRawTextLength, getVisibleTextLength, json } from '../../shared';
import type { IncomingMessage } from '../../core';
import type { TelegramAdminCommandContext, TransformPayloadContext } from '../../http';
import type { MessagingPort } from '../../ports';
import type { AdminAccess } from '../admin-access';
import type { BroadcastAudienceFilter } from './broadcast-payload';
import type { BroadcastRecipientsRegistry } from './minimal-broadcast-service';
import {
  type AdminCommandErrorRecorder,
  extractTelegramErrorDetails,
  shouldInvalidateAdminAccess,
} from '../admin-access/admin-messaging-errors';
import type {
  BroadcastSendInput,
  BroadcastSendResult,
  SendBroadcast,
} from './minimal-broadcast-service';
import { ADMIN_HELP_MESSAGE } from '../export/telegram-export-command';

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

const DEFAULT_MAX_TEXT_LENGTH = 3970;
const DEFAULT_PENDING_TTL_MS = 60 * 1000;
const BROADCAST_PENDING_KV_VERSION = 2;
const BROADCAST_PENDING_KV_PREFIX = 'broadcast:pending:';
const PENDING_MAINTENANCE_INTERVAL_MS = 60 * 1000;
const MINIMUM_KV_TTL_SECONDS = 60;
const BROADCAST_EXPORT_LOG_TTL_SECONDS = 7 * 24 * 60 * 60;

export const BROADCAST_AUDIENCE_PROMPT =
  'Шаг 1. Выберите получателей /everybody или пришлите список user_id / username через запятую или пробел. Дубликаты уберём автоматически.';

export const buildBroadcastPromptMessage = (count: number, notFound: readonly string[] = []): string => {
  const base = `Шаг 2. Пришлите текст для ${count} получателей, /cancel для отмены.`;

  if (notFound.length === 0) {
    return base;
  }

  return `${base}\nНе нашли: ${notFound.join(', ')}`;
};


const BROADCAST_UNSUPPORTED_SUBCOMMAND_MESSAGE =
  'Мгновенная рассылка доступна только через команду /broadcast без аргументов.';

const buildTooLongMessage = (exceededBy: number) =>
  `Текст рассылки не укладывается в лимит на ${exceededBy} символов. /new_text чтобы отправить снова или /cancel для отмены`;

const buildNewTextPrompt = (limit: number) => `Пришлите текст длиной до ${limit} символов.`;

const BROADCAST_EMPTY_MESSAGE =
  'Текст рассылки не может быть пустым. Запустите /broadcast заново и введите сообщение.';

const BROADCAST_FAILURE_MESSAGE =
  'Не удалось отправить рассылку. Попробуйте ещё раз позже или обратитесь к оператору.';
const BROADCAST_CANCEL_MESSAGE =
  '❌ Рассылка отменена. Чтобы отправить новое сообщение, снова выполните /broadcast.';

export const BROADCAST_SUCCESS_MESSAGE = '✅ Рассылка отправлена!';

export interface PendingBroadcast {
  chatId: string;
  threadId?: string;
  expiresAt: number;
  stage: 'audience' | 'text';
  audience?: BroadcastAudience;
  awaitingTextPrompt?: boolean;
  awaitingNewText?: boolean;
  lastRejectedLength?: number;
  lastExceededBy?: number;
}

type BroadcastAudienceMode = 'all' | 'list';

interface BroadcastListAudience {
  mode: 'list';
  total: number;
  notFound: string[];
  chatIds: string[];
}

interface BroadcastAllAudience {
  mode: 'all';
  total: number;
  notFound: string[];
}

type BroadcastAudience = BroadcastListAudience | BroadcastAllAudience;

export type BroadcastPendingKvNamespace = Pick<KVNamespace, 'get' | 'put' | 'delete' | 'list'>;

const toErrorDetails = (error: unknown) =>
  error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };

const normalizeUsername = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().replace(/^@+/, '').toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

const createLogger = (logger?: Logger) => ({
  info(message: string, details?: Record<string, unknown>) {
    logger?.info?.(message, details);
  },
  warn(message: string, details?: Record<string, unknown>) {
    logger?.warn?.(message, details);
  },
  error(message: string, details?: Record<string, unknown>) {
    logger?.error?.(message, details);
  },
});

export interface CreateTelegramBroadcastCommandHandlerOptions {
  adminAccess: AdminAccess;
  messaging: Pick<MessagingPort, 'sendText'>;
  sendBroadcast: SendBroadcast;
  recipientsRegistry: BroadcastRecipientsRegistry;
  maxTextLength?: number;
  pendingTtlMs?: number;
  now?: () => Date;
  logger?: Logger;
  adminErrorRecorder?: AdminCommandErrorRecorder;
  pendingStore?: Map<string, PendingBroadcast>;
  pendingKv?: BroadcastPendingKvNamespace;
  exportLogKv: Pick<KVNamespace, 'put'>;
}

export interface TelegramBroadcastCommandHandler {
  handleCommand: (
    context: TelegramAdminCommandContext,
  ) => Promise<Response | void> | Response | void;
  handleMessage: (
    message: IncomingMessage,
    context?: TransformPayloadContext,
  ) => Promise<Response | 'handled' | void> | Response | 'handled' | void;
}

const hasArgument = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isBroadcastCommand = (context: TelegramAdminCommandContext) =>
  context.command.toLowerCase() === '/broadcast' && !hasArgument(context.argument);

const isUnsupportedAdminBroadcast = (context: TelegramAdminCommandContext) => {
  if (context.command.toLowerCase() !== '/admin') {
    return false;
  }

  if (!hasArgument(context.argument)) {
    return false;
  }

  const parts = context.argument.trim().split(/\s+/);
  return parts[0]?.toLowerCase() === 'broadcast';
};

const createBroadcastResponse = (result: BroadcastSendResult) => {
  void result;
  return BROADCAST_SUCCESS_MESSAGE;
};

const parseList = (value: string): string[] =>
  value
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

const extractBroadcastText = (value: string): { text: string; usedSendCommand: boolean } => {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();

  if (normalized.startsWith('/send')) {
    return { text: trimmed.slice('/send'.length).trim(), usedSendCommand: true };
  }

  return { text: value, usedSendCommand: false };
};

export const createTelegramBroadcastCommandHandler = (
  options: CreateTelegramBroadcastCommandHandlerOptions,
): TelegramBroadcastCommandHandler => {
  const logger = createLogger(options.logger);
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const pendingTtlMs = Math.max(1, options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS);
  const now = options.now ?? (() => new Date());

  const pendingCache = options.pendingStore ?? new Map<string, PendingBroadcast>();
  const pendingKv = options.pendingKv;

  const maintenanceState: { lastRunAt: number; promise?: Promise<void> } = { lastRunAt: 0 };

  const getUserKey = (userId: string | number | bigint): string => String(userId);

  const cleanupExpiredCache = (timestamp: number) => {
    for (const [key, entry] of pendingCache.entries()) {
      if (entry.expiresAt <= timestamp) {
        pendingCache.delete(key);
      }
    }
  };

  const getPendingKvKey = (userId: string): string => `${BROADCAST_PENDING_KV_PREFIX}${userId}`;

  const serializePendingEntry = (entry: PendingBroadcast): string =>
    JSON.stringify({ version: BROADCAST_PENDING_KV_VERSION, entry });

  const parseAudience = (value: unknown): BroadcastAudience | undefined => {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const mode = (value as { mode?: unknown }).mode;
    const total = (value as { total?: unknown }).total;
    const notFound = (value as { notFound?: unknown }).notFound;

    if (typeof total !== 'number' || !Array.isArray(notFound)) {
      return undefined;
    }

    if (mode === 'all') {
      return { mode: 'all', total, notFound: notFound.filter((entry) => typeof entry === 'string') };
    }

    if (mode === 'list') {
      const chatIds = (value as { chatIds?: unknown }).chatIds;
      if (!Array.isArray(chatIds)) {
        return undefined;
      }

      return {
        mode: 'list',
        total,
        notFound: notFound.filter((entry) => typeof entry === 'string'),
        chatIds: chatIds.filter((entry): entry is string => typeof entry === 'string'),
      } satisfies BroadcastListAudience;
    }

    return undefined;
  };

  const parsePendingEntry = (raw: string | null): PendingBroadcast | undefined => {
    if (!raw) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as {
        version?: number;
        entry?: PendingBroadcast;
      };

      if (
        parsed.version !== BROADCAST_PENDING_KV_VERSION ||
        !parsed.entry ||
        typeof parsed.entry.chatId !== 'string' ||
        typeof parsed.entry.expiresAt !== 'number' ||
        (parsed.entry.stage !== 'audience' && parsed.entry.stage !== 'text')
      ) {
        return undefined;
      }

      const audience = parseAudience(parsed.entry.audience);
      const awaitingNewText = parsed.entry.awaitingNewText === true;
      const awaitingTextPrompt = parsed.entry.awaitingTextPrompt === true;
      const lastRejectedLength =
        typeof (parsed.entry as { lastRejectedLength?: unknown }).lastRejectedLength === 'number'
          ? (parsed.entry as { lastRejectedLength: number }).lastRejectedLength
          : undefined;
      const lastExceededBy =
        typeof (parsed.entry as { lastExceededBy?: unknown }).lastExceededBy === 'number'
          ? (parsed.entry as { lastExceededBy: number }).lastExceededBy
          : undefined;

      return {
        chatId: parsed.entry.chatId,
        threadId: parsed.entry.threadId ?? undefined,
        expiresAt: parsed.entry.expiresAt,
        stage: parsed.entry.stage,
        audience,
        awaitingTextPrompt,
        awaitingNewText,
        lastRejectedLength,
        lastExceededBy,
      } satisfies PendingBroadcast;
    } catch (error) {
      logger.warn('failed to parse broadcast pending entry', { error: toErrorDetails(error) });
      return undefined;
    }
  };

  const savePendingEntry = async (userKey: string, entry: PendingBroadcast): Promise<void> => {
    pendingCache.set(userKey, entry);

    if (!pendingKv) {
      return;
    }

    const remainingMs = Math.max(1, entry.expiresAt - now().getTime());
    const ttlSeconds = Math.max(MINIMUM_KV_TTL_SECONDS, Math.ceil(remainingMs / 1000));

    try {
      await pendingKv.put(getPendingKvKey(userKey), serializePendingEntry(entry), {
        expirationTtl: ttlSeconds,
      });
    } catch (error) {
      logger.error('failed to persist broadcast pending session', {
        userId: userKey,
        error: toErrorDetails(error),
      });
    }
  };

  const deletePendingEntry = async (userKey: string): Promise<void> => {
    pendingCache.delete(userKey);

    if (!pendingKv) {
      return;
    }

    try {
      await pendingKv.delete(getPendingKvKey(userKey));
    } catch (error) {
      logger.error('failed to delete broadcast pending session', {
        userId: userKey,
        error: toErrorDetails(error),
      });
    }
  };

  const loadPendingEntry = async (userKey: string, timestamp: number): Promise<PendingBroadcast | undefined> => {
    const cached = pendingCache.get(userKey);
    if (cached) {
      if (cached.expiresAt > timestamp) {
        return cached;
      }

      pendingCache.delete(userKey);
    }

    if (!pendingKv) {
      return undefined;
    }

    try {
      const raw = await pendingKv.get(getPendingKvKey(userKey), 'text');
      const entry = parsePendingEntry(raw);

      if (!entry) {
        return undefined;
      }

      if (entry.expiresAt <= timestamp) {
        await deletePendingEntry(userKey);
        return undefined;
      }

      pendingCache.set(userKey, entry);
      return entry;
    } catch (error) {
      logger.error('failed to read broadcast pending session', {
        userId: userKey,
        error: toErrorDetails(error),
      });

      return undefined;
    }
  };

  type MaintenanceReason = 'command' | 'message';

  const runMaintenance = async (reason: MaintenanceReason, timestamp: number): Promise<void> => {
    cleanupExpiredCache(timestamp);

    if (!pendingKv) {
      return;
    }

    try {
      let cursor: string | undefined;
      let listComplete = false;
      let activePending = 0;
      let expiredPending = 0;
      const expiredKeys: string[] = [];

      while (!listComplete) {
        const result = await pendingKv.list({ prefix: BROADCAST_PENDING_KV_PREFIX, cursor });
        listComplete = result.list_complete;
        cursor = result.cursor;

        for (const key of result.keys) {
          const expirationMs = key.expiration ? key.expiration * 1000 : undefined;
          if (expirationMs && expirationMs > timestamp) {
            activePending += 1;
            continue;
          }

          expiredPending += 1;
          expiredKeys.push(key.name);
        }
      }

      if (expiredKeys.length > 0) {
        await Promise.allSettled(expiredKeys.map((name) => pendingKv.delete(name)));
      }

      logger.info('broadcast pending metrics', {
        reason,
        activePending,
        expiredPending,
      });
    } catch (error) {
      logger.error('broadcast pending maintenance failed', {
        reason,
        error: toErrorDetails(error),
      });
    }
  };

  const scheduleMaintenance = (reason: MaintenanceReason, context?: TransformPayloadContext) => {
    if (!pendingKv) {
      cleanupExpiredCache(now().getTime());
      return;
    }

    const timestamp = now().getTime();
    if (maintenanceState.promise) {
      return;
    }

    if (timestamp - maintenanceState.lastRunAt < PENDING_MAINTENANCE_INTERVAL_MS) {
      return;
    }

    const maintenancePromise = runMaintenance(reason, timestamp).finally(() => {
      maintenanceState.promise = undefined;
      maintenanceState.lastRunAt = timestamp;
    });

    maintenanceState.promise = maintenancePromise;

    if (context?.waitUntil) {
      context.waitUntil(maintenancePromise);
    } else {
      void maintenancePromise;
    }
  };

  const persistBroadcastLog = async (
    input: {
      audience: BroadcastAudience;
      result?: BroadcastSendResult;
      requestedBy: string | number | bigint;
      startedAt: Date;
    },
  ) => {
    const { audience, result, requestedBy, startedAt } = input;
    const durationMs = result?.durationMs ?? Math.max(0, now().getTime() - startedAt.getTime());
    const payload = {
      ts: startedAt.toISOString(),
      admin_id: String(requestedBy),
      mode: audience.mode,
      source: 'D1',
      recipients: result?.recipients ?? audience.total ?? 0,
      delivered: result?.delivered ?? 0,
      failed: result?.failed ?? 0,
      throttled429: result?.throttled429 ?? 0,
      duration_ms: durationMs,
      sample: (result?.sample ?? []).slice(0, 5),
      not_found: audience.notFound.slice(0, 10),
    } satisfies Record<string, unknown>;

    try {
      await options.exportLogKv.put('broadcast:last', JSON.stringify(payload), {
        expirationTtl: BROADCAST_EXPORT_LOG_TTL_SECONDS,
      });
    } catch (error) {
      logger.error('failed to persist broadcast log', {
        userId: String(requestedBy),
        error: toErrorDetails(error),
      });
    }
  };

  const buildAudienceSelection = async (tokens: string[]): Promise<BroadcastAudience> => {
    const recipients = await options.recipientsRegistry.listActiveRecipients();

    if (tokens.length === 1 && tokens[0].toLowerCase() === '/everybody') {
      return {
        mode: 'all',
        total: recipients.length,
        notFound: [],
      } satisfies BroadcastAllAudience;
    }

    const normalizedTokens = tokens.map((token) => token.trim()).filter((token) => token.length > 0);
    const seenChatIds = new Set<string>();
    const matchedChatIds: string[] = [];
    const notFound: string[] = [];

    const chatIdIndex = new Map<string, string>();
    const usernameIndex = new Map<string, string>();

    for (const recipient of recipients) {
      const chatId = recipient.chatId.trim();
      chatIdIndex.set(chatId, chatId);

      const username = normalizeUsername(recipient.username);
      if (username) {
        usernameIndex.set(username, chatId);
      }
    }

    for (const token of normalizedTokens) {
      const usernameToken = normalizeUsername(token);
      const chatIdToken = token;

      let chatId = chatIdIndex.get(chatIdToken);
      if (!chatId && usernameToken) {
        chatId = usernameIndex.get(usernameToken);
      }

      if (!chatId) {
        notFound.push(token);
        continue;
      }

      if (seenChatIds.has(chatId)) {
        continue;
      }

      seenChatIds.add(chatId);
      matchedChatIds.push(chatId);
    }

    return {
      mode: 'list',
      total: matchedChatIds.length,
      notFound,
      chatIds: matchedChatIds,
    } satisfies BroadcastListAudience;
  };

  const handleAudienceSelection = async (
    message: IncomingMessage,
    entry: PendingBroadcast,
  ): Promise<'handled'> => {
    const tokens = parseList(message.text ?? '');
    const userKey = getUserKey(message.user.userId);

    const normalizedTokens = tokens.map((token) => token.trim()).filter((token) => token.length > 0);
    const wantsEveryone =
      normalizedTokens.length === 1 && normalizedTokens[0].toLowerCase() === '/everybody';

    if (!wantsEveryone && normalizedTokens.length === 0) {
      const refreshedEntry: PendingBroadcast = {
        ...entry,
        expiresAt: now().getTime() + pendingTtlMs,
      };

      await savePendingEntry(userKey, refreshedEntry);

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: BROADCAST_AUDIENCE_PROMPT,
        });

        logger.info('broadcast awaiting audience selection', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          reason: 'empty_audience_selection',
        });
      } catch (error) {
        logger.error('failed to send broadcast prompt', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_prompt', error);
      }

      return 'handled';
    }

    const audience = await buildAudienceSelection(tokens);

    if (audience.total === 0) {
      const refreshedEntry: PendingBroadcast = {
        ...entry,
        expiresAt: now().getTime() + pendingTtlMs,
      };

      await savePendingEntry(userKey, refreshedEntry);

      const notFoundSuffix = audience.notFound.length
        ? ` Не нашли: ${audience.notFound.join(', ')}`
        : '';

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: `Аудитория пуста. Пришлите /everybody или список user_id/username.${notFoundSuffix}`,
        });

        logger.warn('broadcast empty audience selection', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          notFound: audience.notFound,
        });
      } catch (error) {
        logger.error('failed to send broadcast empty audience notice', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_empty_audience', error);
      }

      return 'handled';
    }

    const updatedEntry: PendingBroadcast = {
      ...entry,
      stage: 'text',
      audience,
      expiresAt: now().getTime() + pendingTtlMs,
      awaitingTextPrompt: true,
      awaitingNewText: false,
      lastRejectedLength: undefined,
    };

    await savePendingEntry(userKey, updatedEntry);

    const promptMessage = buildBroadcastPromptMessage(audience.total, audience.notFound);

    try {
      await options.messaging.sendText({
        chatId: message.chat.id,
        threadId: message.chat.threadId,
        text: promptMessage,
      });

      logger.info('broadcast awaiting text', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        mode: audience.mode,
        total: audience.total,
        notFound: audience.notFound,
      });
    } catch (error) {
      await deletePendingEntry(userKey);

      logger.error('failed to send broadcast text prompt', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        error: toErrorDetails(error),
      });

      await handleMessagingFailure(message.user.userId, 'broadcast_text_prompt', error);
    }

    return 'handled';
  };

  const handleMessagingFailure = async (
    userId: string | number | bigint,
    commandLabel: string,
    error: unknown,
  ) => {
    const details = extractTelegramErrorDetails(error);

    if (shouldInvalidateAdminAccess(details)) {
      options.adminAccess.invalidate?.(userId);
    }

    await options.adminErrorRecorder?.record({
      userId: String(userId),
      command: commandLabel,
      error,
      details,
    });
  };

  const handleCommand = async (context: TelegramAdminCommandContext): Promise<Response | void> => {
    const currentTime = now().getTime();
    cleanupExpiredCache(currentTime);
    scheduleMaintenance('command');

    const broadcastRequested = isBroadcastCommand(context);
    const unsupportedAdminBroadcast = !broadcastRequested && isUnsupportedAdminBroadcast(context);

    if (!broadcastRequested && !unsupportedAdminBroadcast) {
      const userKey = getUserKey(context.from.userId);
      const entry = await loadPendingEntry(userKey, currentTime);
      if (entry) {
        await deletePendingEntry(userKey);

        logger.info('broadcast pending cleared before non-broadcast command', {
          userId: context.from.userId,
          chatId: entry.chatId,
          threadId: entry.threadId ?? null,
          command: context.command,
          argument: context.argument ?? null,
        });
      }

      return undefined;
    }

    const isAdmin = await options.adminAccess.isAdmin(context.from.userId);
    if (!isAdmin) {
      return undefined;
    }

    if (unsupportedAdminBroadcast) {
      try {
        await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text: BROADCAST_UNSUPPORTED_SUBCOMMAND_MESSAGE,
        });

        logger.warn('unsupported broadcast subcommand', {
          userId: context.from.userId,
          command: context.command,
          argument: context.argument ?? null,
        });
      } catch (error) {
        logger.error('failed to send unsupported broadcast subcommand notice', {
          userId: context.from.userId,
          chatId: context.chat.id,
          threadId: context.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(context.from.userId, 'broadcast_unsupported_subcommand', error);

        return json({ error: 'Failed to send unsupported broadcast notice' }, { status: 502 });
      }

      return json({ status: 'unsupported_broadcast_subcommand' }, { status: 200 });
    }

    const timestamp = now().getTime();
    cleanupExpiredCache(timestamp);

    const userKey = getUserKey(context.from.userId);

    await savePendingEntry(userKey, {
      chatId: context.chat.id,
      threadId: context.chat.threadId,
      expiresAt: timestamp + pendingTtlMs,
      stage: 'audience',
    });

    try {
      await options.messaging.sendText({
        chatId: context.chat.id,
        threadId: context.chat.threadId,
        text: BROADCAST_AUDIENCE_PROMPT,
      });

      logger.info('broadcast awaiting audience selection', {
        userId: context.from.userId,
        chatId: context.chat.id,
        threadId: context.chat.threadId ?? null,
      });
    } catch (error) {
      await deletePendingEntry(userKey);

      logger.error('failed to send broadcast prompt', {
        userId: context.from.userId,
        chatId: context.chat.id,
        threadId: context.chat.threadId ?? null,
        error: toErrorDetails(error),
      });

      await handleMessagingFailure(context.from.userId, 'broadcast_prompt', error);

      return json({ error: 'Failed to send broadcast prompt' }, { status: 502 });
    }

    return json({ status: 'awaiting_audience' }, { status: 200 });
  };

  const handleMessage = async (
    message: IncomingMessage,
    context?: TransformPayloadContext,
  ): Promise<'handled' | void> => {
    const currentTime = now().getTime();
    cleanupExpiredCache(currentTime);
    scheduleMaintenance('message', context);

    const userKey = getUserKey(message.user.userId);
    let entry = await loadPendingEntry(userKey, currentTime);
    if (!entry) {
      return undefined;
    }

    if (entry.chatId !== message.chat.id) {
      return undefined;
    }

    const entryThreadId = entry.threadId ?? null;
    const messageThreadId = message.chat.threadId ?? null;

    if (entryThreadId !== messageThreadId) {
      return undefined;
    }

    const rawText = message.text ?? '';
    const normalized = rawText.trim().toLowerCase();

    if (normalized === '/cancel') {
      logger.info('broadcast cancelled via telegram command', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
      });

      await deletePendingEntry(userKey);

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: BROADCAST_CANCEL_MESSAGE,
        });

        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: ADMIN_HELP_MESSAGE,
        });
      } catch (error) {
        logger.error('failed to send broadcast cancel notice', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_cancel_notice', error);
      }

      return 'handled';
    }

    if (entry.awaitingNewText) {
      if (normalized === '/broadcast') {
        logger.info('broadcast restart requested while awaiting new text', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          restart: true,
        });

        await deletePendingEntry(userKey);

        return undefined;
      }

      const refreshedEntry: PendingBroadcast = {
        ...entry,
        expiresAt: now().getTime() + pendingTtlMs,
      };

      if (normalized === '/new_text') {
        const resumedEntry: PendingBroadcast = {
          ...refreshedEntry,
          awaitingNewText: false,
          lastRejectedLength: undefined,
          lastExceededBy: undefined,
        };

        await savePendingEntry(userKey, resumedEntry);

        try {
          await options.messaging.sendText({
            chatId: message.chat.id,
            threadId: message.chat.threadId,
            text: buildNewTextPrompt(maxTextLength),
          });

          logger.info('broadcast awaiting new text after rejection', {
            userId: message.user.userId,
            chatId: message.chat.id,
            threadId: message.chat.threadId ?? null,
          });
        } catch (error) {
          logger.error('failed to send broadcast new text prompt', {
            userId: message.user.userId,
            chatId: message.chat.id,
            threadId: message.chat.threadId ?? null,
            error: toErrorDetails(error),
          });

          await handleMessagingFailure(message.user.userId, 'broadcast_new_text_prompt', error);
        }

        return 'handled';
      }

      const exceededBy = Math.max(
        1,
        entry.lastExceededBy ??
          (typeof entry.lastRejectedLength === 'number'
            ? entry.lastRejectedLength - maxTextLength
            : 1),
      );

      await savePendingEntry(userKey, refreshedEntry);

      logger.info('broadcast awaiting new text', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        exceededBy,
      });

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: buildTooLongMessage(exceededBy),
        });
      } catch (error) {
        logger.error('failed to send broadcast length warning', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_length_warning', error);
      }

      return 'handled';
    }

    if (entry.stage === 'audience' && entry.audience) {
      entry = {
        ...entry,
        stage: 'text',
        expiresAt: now().getTime() + pendingTtlMs,
      };

      await savePendingEntry(userKey, entry);

      logger.info('broadcast awaiting text restored from pending', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        mode: entry.audience.mode,
        total: entry.audience.total,
      });
    }

    if (entry.stage === 'text' && entry.awaitingTextPrompt !== true && entry.awaitingNewText !== true) {
      const audience = entry.audience;

      if (!audience) {
        logger.warn('broadcast audience missing in pending entry', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
        });

        await deletePendingEntry(userKey);

        return 'handled';
      }

      const refreshedEntry: PendingBroadcast = {
        ...entry,
        expiresAt: now().getTime() + pendingTtlMs,
        awaitingTextPrompt: true,
      };

      await savePendingEntry(userKey, refreshedEntry);

      const promptMessage = buildBroadcastPromptMessage(audience.total, audience.notFound);

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: promptMessage,
        });

        logger.info('broadcast awaiting text prompt restored', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          mode: audience.mode,
          total: audience.total,
          notFound: audience.notFound,
        });
      } catch (error) {
        logger.error('failed to send broadcast text prompt restore', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_text_prompt_restore', error);
      }

      return 'handled';
    }

    if (entry.stage === 'audience') {
      return handleAudienceSelection(message, entry);
    }

    const { text, usedSendCommand } = extractBroadcastText(rawText);
    const rawLength = getRawTextLength(text);
    const visibleLength = getVisibleTextLength(text);
    const effectiveLength = Math.max(rawLength, visibleLength);
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      const refreshedEntry: PendingBroadcast = {
        ...entry,
        expiresAt: now().getTime() + pendingTtlMs,
      };

      await savePendingEntry(userKey, refreshedEntry);

      logger.warn('broadcast text rejected', {
        userId: message.user.userId,
        reason: 'empty',
        usedSendCommand,
        rawLength,
        visibleLength,
      });

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: BROADCAST_EMPTY_MESSAGE,
        });
      } catch (error) {
        logger.error('failed to send broadcast empty warning', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_empty_warning', error);
      }

      return 'handled';
    }

    if (effectiveLength > maxTextLength) {
      const exceededBy = effectiveLength - maxTextLength;
      const refreshedEntry: PendingBroadcast = {
        ...entry,
        expiresAt: now().getTime() + pendingTtlMs,
        awaitingNewText: true,
        lastRejectedLength: effectiveLength,
        lastExceededBy: exceededBy,
      };

      await savePendingEntry(userKey, refreshedEntry);

      logger.warn('broadcast text rejected', {
        userId: message.user.userId,
        reason: 'too_long',
        length: effectiveLength,
        rawLength,
        visibleLength,
        limit: maxTextLength,
      });

      logger.info('broadcast awaiting new text', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        exceededBy,
      });

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: buildTooLongMessage(exceededBy),
        });
      } catch (error) {
        logger.error('failed to send broadcast length warning', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_length_warning', error);
      }

      return 'handled';
    }

    const audience = entry.audience;

    if (!audience) {
      logger.warn('broadcast audience missing in pending entry', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
      });

      await deletePendingEntry(userKey);

      return 'handled';
    }

    const filters: BroadcastAudienceFilter | undefined =
      audience.mode === 'list' ? { chatIds: audience.chatIds } : undefined;

    const requestedBy = message.user.userId;

    logger.info('broadcast dispatch scheduled via telegram command', {
      userId: requestedBy,
      chatId: message.chat.id,
      threadId: message.chat.threadId ?? null,
    });

    const payload: BroadcastSendInput = {
      text,
      requestedBy,
      filters,
    };

    const startedAt = now();

    await deletePendingEntry(userKey);

    const runBroadcast = async () => {
      let result: BroadcastSendResult | undefined;
      try {
        result = await options.sendBroadcast(payload);

        logger.info('broadcast sent via telegram command', {
          userId: requestedBy,
          delivered: result.delivered,
          failed: result.failed,
        });

        try {
          await options.messaging.sendText({
            chatId: message.chat.id,
            threadId: message.chat.threadId,
            text: createBroadcastResponse(result),
          });
        } catch (error) {
          logger.error('failed to send broadcast confirmation', {
            userId: requestedBy,
            chatId: message.chat.id,
            threadId: message.chat.threadId ?? null,
            error: toErrorDetails(error),
          });

          await handleMessagingFailure(requestedBy, 'broadcast_confirmation', error);
        }
      } catch (error) {
        logger.error('broadcast send failed via telegram command', {
          userId: requestedBy,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        try {
          await options.messaging.sendText({
            chatId: message.chat.id,
            threadId: message.chat.threadId,
            text: BROADCAST_FAILURE_MESSAGE,
          });
        } catch (sendError) {
          logger.error('failed to send broadcast failure message', {
            userId: requestedBy,
            chatId: message.chat.id,
            threadId: message.chat.threadId ?? null,
            error: toErrorDetails(sendError),
          });

          await handleMessagingFailure(requestedBy, 'broadcast_failure_notice', sendError);
        }
      }

      await persistBroadcastLog({
        audience,
        result,
        requestedBy,
        startedAt,
      });
    };

    const broadcastPromise = runBroadcast();

    if (context?.waitUntil) {
      context.waitUntil(broadcastPromise);
    } else {
      await broadcastPromise;
    }

    return 'handled';
  };

  return {
    handleCommand,
    handleMessage,
  } satisfies TelegramBroadcastCommandHandler;
};
