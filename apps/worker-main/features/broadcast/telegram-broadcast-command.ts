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
import {
  listBroadcastCheckpoints,
  loadBroadcastCheckpoint,
  type BroadcastSendInput,
  type BroadcastSendResult,
  type SendBroadcast,
  type BroadcastProgressKvNamespace,
  type BroadcastProgressCheckpoint,
} from './minimal-broadcast-service';
import { createAdminHelpSender, type SendAdminHelp } from '../export/telegram-export-command';

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
const TEXT_CHUNK_DEBOUNCE_MS = 1000;
const NEW_TEXT_WARNING_THROTTLE_MS = 5 * 1000;

export const BROADCAST_AUDIENCE_PROMPT =
  'Шаг 1. Выберите получателей /everybody или пришлите список user_id / username через запятую или пробел. Дубликаты уберём автоматически.';

export const buildBroadcastPromptMessage = (count: number, notFound: readonly string[] = []): string => {
  const base = `Шаг 2. Пришлите текст для ${count} получателей, /cancel_broadcast для отмены.`;

  if (notFound.length === 0) {
    return base;
  }

  return `${base}\nНе нашли: ${notFound.join(', ')}`;
};


const BROADCAST_UNSUPPORTED_SUBCOMMAND_MESSAGE =
  'Мгновенная рассылка доступна только через команду /broadcast без аргументов.';

const buildTooLongMessage = (_overflow: number) =>
  'Текст не укладывается в лимит Telegram, выберите: /new_text чтобы отправить другой текст или /cancel_broadcast для отмены.';

export const buildAwaitingSendPromptMessage = (audience: BroadcastAudience): string => {
  const base = `Текст принят. Получателей ${audience.total}. Выберите: /send чтобы отправить, /new_text чтобы изменить текст или /cancel_broadcast для отмены.`;

  if (audience.notFound.length === 0) {
    return base;
  }

  return `${base}\nНе нашли: ${audience.notFound.join(', ')}`;
};

const BROADCAST_AWAITING_SEND_WARNING =
  'Сейчас доступны только команды /send, /new_text или /cancel_broadcast.';

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
  stage: 'audience' | 'text' | 'collecting_text' | 'awaiting_send';
  audience?: BroadcastAudience;
  awaitingTextPrompt?: boolean;
  awaitingNewText?: boolean;
  awaitingNewTextPrompt?: boolean;
  awaitingSendCommand?: boolean;
  lastRejectedLength?: number;
  lastExceededBy?: number;
  lastWarningMessageId?: string;
  lastWarningAt?: number;
  lastWarningText?: string;
  lastReceivedText?: string;
  lastReceivedLength?: number;
  textChunks?: string[];
  chunkCount?: number;
  debounceUntil?: number;
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
  progressKv?: BroadcastProgressKvNamespace;
  exportLogKv: Pick<KVNamespace, 'put'>;
  sendAdminHelp?: SendAdminHelp;
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

const isBroadcastResumeCommand = (context: TelegramAdminCommandContext) =>
  context.command.toLowerCase() === '/broadcast_resume' && hasArgument(context.argument);

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseCancelCommand = (
  value: string,
): { canonical: '/cancel_broadcast'; original: '/cancel' | '/cancel_broadcast' } | undefined => {
  if (value === '/cancel_broadcast') {
    return { canonical: '/cancel_broadcast', original: '/cancel_broadcast' };
  }

  if (value === '/cancel') {
    return { canonical: '/cancel_broadcast', original: '/cancel' };
  }

  return undefined;
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
  const progressKv = options.progressKv ?? options.pendingKv;
  const sendAdminHelp =
    options.sendAdminHelp ??
    createAdminHelpSender({
      messaging: options.messaging,
      logger,
      adminAccess: options.adminAccess,
      adminErrorRecorder: options.adminErrorRecorder,
    });

  const maintenanceState: { lastRunAt: number; promise?: Promise<void> } = { lastRunAt: 0 };

  const getUserKey = (userId: string | number | bigint): string => String(userId);

  const generateJobId = () => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }

    return `job-${now().getTime()}`;
  };

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

      const isValidStage =
        parsed.entry?.stage === 'audience' ||
        parsed.entry?.stage === 'text' ||
        parsed.entry?.stage === 'collecting_text' ||
        parsed.entry?.stage === 'awaiting_send';

      if (
        parsed.version !== BROADCAST_PENDING_KV_VERSION ||
        !parsed.entry ||
        typeof parsed.entry.chatId !== 'string' ||
        typeof parsed.entry.expiresAt !== 'number' ||
        !isValidStage
      ) {
        return undefined;
      }

      const audience = parseAudience(parsed.entry.audience);
      const awaitingNewText = parsed.entry.awaitingNewText === true;
      const awaitingTextPrompt = parsed.entry.awaitingTextPrompt === true;
      const awaitingNewTextPrompt = parsed.entry.awaitingNewTextPrompt === true;
      const awaitingSendCommand = parsed.entry.awaitingSendCommand === true;
      const lastRejectedLength =
        typeof (parsed.entry as { lastRejectedLength?: unknown }).lastRejectedLength === 'number'
          ? (parsed.entry as { lastRejectedLength: number }).lastRejectedLength
          : undefined;
      const lastExceededBy =
        typeof (parsed.entry as { lastExceededBy?: unknown }).lastExceededBy === 'number'
          ? (parsed.entry as { lastExceededBy: number }).lastExceededBy
          : undefined;
      const textChunks = Array.isArray(parsed.entry.textChunks)
        ? parsed.entry.textChunks.filter((chunk): chunk is string => typeof chunk === 'string')
        : undefined;
      const chunkCount =
        typeof (parsed.entry as { chunkCount?: unknown }).chunkCount === 'number'
          ? (parsed.entry as { chunkCount: number }).chunkCount
          : undefined;
      const debounceUntil =
        typeof (parsed.entry as { debounceUntil?: unknown }).debounceUntil === 'number'
          ? (parsed.entry as { debounceUntil: number }).debounceUntil
          : undefined;
      const lastWarningMessageId =
        typeof (parsed.entry as { lastWarningMessageId?: unknown }).lastWarningMessageId === 'string'
          ? (parsed.entry as { lastWarningMessageId: string }).lastWarningMessageId
          : undefined;
      const lastWarningText =
        typeof (parsed.entry as { lastWarningText?: unknown }).lastWarningText === 'string'
          ? (parsed.entry as { lastWarningText: string }).lastWarningText
          : undefined;

      return {
        chatId: parsed.entry.chatId,
        threadId: parsed.entry.threadId ?? undefined,
        expiresAt: parsed.entry.expiresAt,
        stage: parsed.entry.stage,
        audience,
        awaitingTextPrompt,
        awaitingNewText,
        awaitingNewTextPrompt,
        awaitingSendCommand,
        lastRejectedLength,
        lastExceededBy,
        lastWarningMessageId,
        lastWarningText,
        textChunks,
        chunkCount,
        debounceUntil,
      } satisfies PendingBroadcast;
    } catch (error) {
      logger.warn('failed to parse broadcast pending entry', { error: toErrorDetails(error) });
      return undefined;
    }
  };

  const readActiveCheckpoint = async (): Promise<BroadcastProgressCheckpoint | undefined> => {
    if (!progressKv) {
      return undefined;
    }

    const checkpoints = await listBroadcastCheckpoints(progressKv, logger);
    return checkpoints.find((entry) => entry.checkpoint.status === 'running' || entry.checkpoint.status === 'paused')
      ?.checkpoint;
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

  const finalizeCollectingTextEntry = async ({
    entry,
    userKey,
    message,
  }: {
    entry: PendingBroadcast;
    userKey: string;
    message: IncomingMessage;
  }): Promise<void> => {
    const audience = entry.audience;
    if (!audience) {
      logger.warn('broadcast collecting text missing audience', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
      });

      await deletePendingEntry(userKey);
      return;
    }

    if ((entry.chunkCount ?? 0) <= 1 && entry.textChunks?.length === 1) {
      const awaitingEntry: PendingBroadcast = {
        ...entry,
        stage: 'awaiting_send',
        awaitingSendCommand: true,
        awaitingNewText: false,
        awaitingNewTextPrompt: undefined,
        chunkCount: undefined,
        debounceUntil: undefined,
        expiresAt: now().getTime() + pendingTtlMs,
      };

      await savePendingEntry(userKey, awaitingEntry);

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: buildAwaitingSendPromptMessage(audience),
        });

        logger.info('broadcast awaiting send confirmation', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          total: audience.total,
        });
      } catch (error) {
        logger.error('failed to send broadcast send confirmation prompt', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_send_confirmation_prompt', error);
      }

      return;
    }

    const warningTimestamp = now().getTime();
    const rejectionEntry: PendingBroadcast = {
      ...entry,
      stage: 'text',
      awaitingNewText: true,
      awaitingNewTextPrompt: true,
      awaitingSendCommand: undefined,
      lastWarningMessageId: message.messageId,
      lastWarningAt: warningTimestamp,
      lastWarningText: message.text ?? '',
      textChunks: undefined,
      chunkCount: undefined,
      debounceUntil: undefined,
      expiresAt: now().getTime() + pendingTtlMs,
    };

    await savePendingEntry(userKey, rejectionEntry);

    try {
      await options.messaging.sendText({
        chatId: message.chat.id,
        threadId: message.chat.threadId,
        text: buildTooLongMessage(0),
      });

      logger.warn('broadcast text rejected due to multiple chunks', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
      });
    } catch (error) {
      logger.error('failed to send broadcast chunk length warning', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        error: toErrorDetails(error),
      });

      await handleMessagingFailure(message.user.userId, 'broadcast_chunk_length_warning', error);
    }
  };

  const scheduleTextChunkFinalization = ({
    userKey,
    message,
    context,
  }: {
    userKey: string;
    message: IncomingMessage;
    context?: TransformPayloadContext;
  }) => {
    const finalizePromise = (async () => {
      await delay(TEXT_CHUNK_DEBOUNCE_MS);

      const latest = await loadPendingEntry(userKey, now().getTime());
      if (!latest || latest.stage !== 'collecting_text') {
        return;
      }

      await finalizeCollectingTextEntry({ entry: latest, userKey, message });
    })();

    if (context?.waitUntil) {
      context.waitUntil(finalizePromise);
    } else {
      void finalizePromise;
    }
  };

  const handleCommand = async (context: TelegramAdminCommandContext): Promise<Response | void> => {
    const currentTime = now().getTime();
    cleanupExpiredCache(currentTime);
    scheduleMaintenance('command');

    const broadcastRequested = isBroadcastCommand(context);
    const resumeRequested = isBroadcastResumeCommand(context);
    const unsupportedAdminBroadcast = !broadcastRequested && isUnsupportedAdminBroadcast(context);

    if (!broadcastRequested && !unsupportedAdminBroadcast && !resumeRequested) {
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

    if (resumeRequested) {
      const jobId = context.argument?.trim().split(/\s+/)[0];

      if (!jobId) {
        await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text: 'Укажите jobId: /broadcast_resume <jobId>',
        });

        return json({ error: 'jobId_required' }, { status: 400 });
      }

      const checkpoint = await loadBroadcastCheckpoint(progressKv, jobId, logger);

      if (!checkpoint) {
        await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text: `Не найдено сохранённое состояние для ${jobId}.`,
        });

        return json({ error: 'checkpoint_not_found' }, { status: 404 });
      }

      if (checkpoint.status === 'running') {
        await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text: `Задача ${jobId} уже выполняется.`,
        });

        return json({ status: 'already_running', jobId }, { status: 200 });
      }

      const payload: BroadcastSendInput = {
        text: checkpoint.text,
        requestedBy: String(context.from.userId),
        filters: checkpoint.filters,
        jobId: checkpoint.jobId,
        resumeFrom: checkpoint,
        adminChat: { chatId: context.chat.id, threadId: context.chat.threadId },
      };

      const startedAt = now();
      const runBroadcast = async () => {
        try {
          await options.sendBroadcast(payload);

          await options.messaging.sendText({
            chatId: context.chat.id,
            threadId: context.chat.threadId,
            text: `Возобновление ${jobId} завершено.`,
          });
        } catch (error) {
          logger.error('broadcast resume failed', {
            userId: context.from.userId,
            chatId: context.chat.id,
            threadId: context.chat.threadId ?? null,
            jobId,
            error: toErrorDetails(error),
          });

          await options.messaging.sendText({
            chatId: context.chat.id,
            threadId: context.chat.threadId,
            text: `Не удалось возобновить ${jobId}. Попробуйте позже.`,
          });
        } finally {
          await persistBroadcastLog({
            audience: { mode: 'all', notFound: [], total: checkpoint.total },
            requestedBy: context.from.userId,
            startedAt,
          });
        }
      };

      const resumePromise = runBroadcast();
      if (context.waitUntil) {
        context.waitUntil(resumePromise);
      } else {
        await resumePromise;
      }

      return json({ status: 'resuming', jobId }, { status: 200 });
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

    const activeCheckpoint = await readActiveCheckpoint();
    if (activeCheckpoint) {
      await options.messaging.sendText({
        chatId: context.chat.id,
        threadId: context.chat.threadId,
        text: `Уже запущена рассылка jobId=${activeCheckpoint.jobId} (status=${activeCheckpoint.status}).\nИспользуйте /broadcast_resume ${activeCheckpoint.jobId} или /cancel_broadcast.`,
      });

      return json({ status: 'job_active', jobId: activeCheckpoint.jobId }, { status: 200 });
    }

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

    const cancelCommand = parseCancelCommand(normalized);
    if (cancelCommand) {
      logger.info('broadcast cancelled via telegram command', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        command: cancelCommand.original,
      });

      if (cancelCommand.original === '/cancel') {
        logger.warn('deprecated broadcast cancel alias used', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
        });
      }

      await deletePendingEntry(userKey);

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: BROADCAST_CANCEL_MESSAGE,
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

      try {
        await sendAdminHelp({
          userId: String(message.user.userId),
          chatId: message.chat.id,
          threadId: message.chat.threadId,
        });
      } catch (error) {
        logger.error('failed to send admin help after broadcast cancel', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });
      }

      return 'handled';
    }

    if (entry.stage === 'collecting_text') {
      const debounceUntil = entry.debounceUntil ?? 0;
      if (typeof debounceUntil === 'number' && debounceUntil > 0 && debounceUntil <= currentTime) {
        await finalizeCollectingTextEntry({ entry, userKey, message });

        entry = await loadPendingEntry(userKey, now().getTime());
        if (!entry) {
          return 'handled';
        }

        if (entry.chatId !== message.chat.id) {
          return 'handled';
        }

        const refreshedThreadId = entry.threadId ?? null;
        if (refreshedThreadId !== messageThreadId) {
          return 'handled';
        }
      }
    }

    if (entry.stage === 'collecting_text') {
      if (normalized.startsWith('/')) {
        return 'handled';
      }

      const refreshedEntry: PendingBroadcast = {
        ...entry,
        chunkCount: Math.max(entry.chunkCount ?? 1, 1) + 1,
        textChunks: undefined,
        expiresAt: now().getTime() + pendingTtlMs,
      };

      await savePendingEntry(userKey, refreshedEntry);

      logger.warn('broadcast text chunk rejected due to multiple messages', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        chunkCount: refreshedEntry.chunkCount,
      });

      return 'handled';
    }

    if (entry.stage === 'awaiting_send' && entry.awaitingSendCommand === true) {
      const audience = entry.audience;
      if (!audience) {
        logger.warn('broadcast awaiting send without audience', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
        });

        await deletePendingEntry(userKey);

        return 'handled';
      }

      if (normalized === '/send') {
        const textChunk = entry.textChunks?.[0];
        if (!textChunk) {
          logger.warn('broadcast awaiting send without text chunk', {
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

        logger.info('broadcast dispatch confirmed via telegram command', {
          userId: requestedBy,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
        });

        const jobId = generateJobId();
        const payload: BroadcastSendInput = {
          text: textChunk,
          requestedBy,
          filters,
          jobId,
          adminChat: { chatId: message.chat.id, threadId: message.chat.threadId },
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
      }

      if (normalized === '/new_text') {
        const updatedEntry: PendingBroadcast = {
          ...entry,
          stage: 'text',
          awaitingSendCommand: undefined,
          awaitingNewText: false,
          awaitingNewTextPrompt: undefined,
          awaitingTextPrompt: true,
          textChunks: undefined,
          chunkCount: undefined,
          debounceUntil: undefined,
          expiresAt: now().getTime() + pendingTtlMs,
        };

        await savePendingEntry(userKey, updatedEntry);

        const promptMessage = buildBroadcastPromptMessage(audience.total, audience.notFound);

        try {
          await options.messaging.sendText({
            chatId: message.chat.id,
            threadId: message.chat.threadId,
            text: promptMessage,
          });

          logger.info('broadcast awaiting text restarted before send', {
            userId: message.user.userId,
            chatId: message.chat.id,
            threadId: message.chat.threadId ?? null,
          });
        } catch (error) {
          logger.error('failed to send broadcast text prompt restart', {
            userId: message.user.userId,
            chatId: message.chat.id,
            threadId: message.chat.threadId ?? null,
            error: toErrorDetails(error),
          });

          await handleMessagingFailure(message.user.userId, 'broadcast_text_prompt_restart', error);
        }

        return 'handled';
      }

      logger.warn('broadcast awaiting send received invalid input', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        text: rawText,
      });

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: BROADCAST_AWAITING_SEND_WARNING,
        });
      } catch (error) {
        logger.error('failed to send broadcast awaiting send warning', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          error: toErrorDetails(error),
        });

        await handleMessagingFailure(message.user.userId, 'broadcast_awaiting_send_warning', error);
      }

      return 'handled';
    }

    if (entry.awaitingNewText) {
      const audience = entry.audience;
      if (!audience) {
        logger.warn('broadcast awaiting new text without audience', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
        });

        await deletePendingEntry(userKey);

        return 'handled';
      }

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

      const rawLength = getRawTextLength(rawText);
      const visibleLength = getVisibleTextLength(rawText);
      const effectiveLength = Math.max(rawLength, visibleLength);
      const warningTimestamp = now().getTime();

      const refreshedEntry: PendingBroadcast = {
        ...entry,
        expiresAt: now().getTime() + pendingTtlMs,
      };

      const overflow = Math.max(
        1,
        entry.lastExceededBy ??
          (typeof entry.lastRejectedLength === 'number'
            ? entry.lastRejectedLength - maxTextLength
            : 1),
      );

      const alreadyWarnedRecently =
        entry.awaitingNewTextPrompt === true &&
        typeof entry.lastWarningAt === 'number' &&
        warningTimestamp - entry.lastWarningAt < NEW_TEXT_WARNING_THROTTLE_MS;

      const isDuplicateWarning =
        (entry.awaitingNewTextPrompt === true || entry.awaitingNewText === true) &&
        entry.lastReceivedText === rawText &&
        entry.lastReceivedLength === effectiveLength;

      const updatedEntry: PendingBroadcast = {
        ...refreshedEntry,
        awaitingNewTextPrompt: true,
        lastWarningMessageId: message.messageId,
        lastWarningText: rawText,
        lastReceivedText: rawText,
        lastReceivedLength: effectiveLength,
        lastWarningAt: alreadyWarnedRecently ? entry.lastWarningAt : warningTimestamp,
      };

      await savePendingEntry(userKey, updatedEntry);

      if (isDuplicateWarning) {
        return 'handled';
      }

      if (normalized === '/new_text') {
        const resumedEntry: PendingBroadcast = {
          ...refreshedEntry,
          stage: 'text',
          awaitingNewText: false,
          awaitingNewTextPrompt: undefined,
          awaitingTextPrompt: true,
          awaitingSendCommand: undefined,
          textChunks: undefined,
          chunkCount: undefined,
          debounceUntil: undefined,
          lastRejectedLength: undefined,
          lastExceededBy: undefined,
          lastReceivedText: undefined,
          lastReceivedLength: undefined,
        };

        await savePendingEntry(userKey, resumedEntry);

        const promptMessage = buildBroadcastPromptMessage(audience.total, audience.notFound);

        try {
          await options.messaging.sendText({
            chatId: message.chat.id,
            threadId: message.chat.threadId,
            text: promptMessage,
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

      if (alreadyWarnedRecently) {
        logger.info('broadcast awaiting new text throttled', {
          userId: message.user.userId,
          chatId: message.chat.id,
          threadId: message.chat.threadId ?? null,
          exceededBy: overflow,
        });

        return 'handled';
      }

      logger.info('broadcast awaiting new text', {
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId ?? null,
        exceededBy: overflow,
      });

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: buildTooLongMessage(overflow),
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
      const overflow = effectiveLength - maxTextLength;
      const warningTimestamp = now().getTime();
      const refreshedEntry: PendingBroadcast = {
        ...entry,
        expiresAt: now().getTime() + pendingTtlMs,
        awaitingNewText: true,
        awaitingNewTextPrompt: true,
        lastRejectedLength: effectiveLength,
        lastExceededBy: overflow,
        lastWarningMessageId: message.messageId,
        lastWarningAt: warningTimestamp,
        lastWarningText: rawText,
        lastReceivedText: rawText,
        lastReceivedLength: effectiveLength,
      };

      const isDuplicateWarning =
        (entry.awaitingNewTextPrompt === true || entry.awaitingNewText === true) &&
        entry.lastReceivedText === rawText &&
        entry.lastReceivedLength === effectiveLength;

      await savePendingEntry(userKey, refreshedEntry);

      if (isDuplicateWarning) {
        return 'handled';
      }

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
        exceededBy: overflow,
      });

      try {
        await options.messaging.sendText({
          chatId: message.chat.id,
          threadId: message.chat.threadId,
          text: buildTooLongMessage(overflow),
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

    const collectingEntry: PendingBroadcast = {
      ...entry,
      stage: 'collecting_text',
      awaitingSendCommand: undefined,
      awaitingNewText: false,
      awaitingNewTextPrompt: undefined,
      textChunks: [text],
      chunkCount: 1,
      debounceUntil: now().getTime() + TEXT_CHUNK_DEBOUNCE_MS,
      expiresAt: now().getTime() + pendingTtlMs,
      lastRejectedLength: undefined,
      lastExceededBy: undefined,
      lastReceivedText: undefined,
      lastReceivedLength: undefined,
    };

    await savePendingEntry(userKey, collectingEntry);

    logger.info('broadcast text chunk collected', {
      userId: message.user.userId,
      chatId: message.chat.id,
      threadId: message.chat.threadId ?? null,
      usedSendCommand,
      rawLength,
      visibleLength,
    });

    scheduleTextChunkFinalization({ userKey, message, context });

    return 'handled';
  };

  return {
    handleCommand,
    handleMessage,
  } satisfies TelegramBroadcastCommandHandler;
};
