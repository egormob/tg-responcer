import { json } from '../../shared';
import type { TelegramAdminCommandContext } from '../../http';
import type { MessagingPort, RateLimitPort } from '../../ports';
import type { AdminAccess, AdminAccessKvNamespace } from '../admin-access';
import {
  type AdminCommandErrorRecorder,
  extractTelegramErrorDetails,
  shouldInvalidateAdminAccess,
} from '../admin-access/admin-messaging-errors';
import type { AdminExportRequest } from './admin-export-route';

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export type AdminExportRateLimitKvNamespace = Pick<
  KVNamespace,
  'get' | 'put' | 'list' | 'delete'
>;

export type AdminExportLogKvNamespace = Pick<KVNamespace, 'put'>;

export interface CreateTelegramExportCommandHandlerOptions {
  botToken: string;
  handleExport: (request: AdminExportRequest) => Promise<Response>;
  adminAccess: AdminAccess;
  rateLimit: RateLimitPort;
  messaging: Pick<MessagingPort, 'sendText'>;
  adminAccessKv?: AdminAccessKvNamespace & Pick<KVNamespace, 'put'>;
  cooldownKv?: AdminExportRateLimitKvNamespace;
  exportLogKv?: AdminExportLogKvNamespace;
  logger?: Logger;
  now?: () => Date;
  adminErrorRecorder?: AdminCommandErrorRecorder;
}

interface ExportArguments {
  from?: Date;
  to?: Date;
}

const parseDateArgument = (value: string, kind: 'from' | 'to'): Date => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${kind} date must not be empty`);
  }

  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${kind} must be a valid date in YYYY-MM-DD format`);
  }

  return date;
};

const parseExportRangeArguments = (argument: string | undefined): ExportArguments => {
  if (!argument) {
    return {};
  }

  const trimmed = argument.trim();
  if (trimmed.length === 0) {
    return {};
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length > 2) {
    throw new Error('Too many arguments. Usage: /export [from] [to]');
  }

  const from = parts[0] ? parseDateArgument(parts[0], 'from') : undefined;
  const to = parts[1] ? parseDateArgument(parts[1], 'to') : undefined;

  if (from && to && from.getTime() > to.getTime()) {
    throw new Error('`from` must be earlier than or equal to `to`');
  }

  return { from, to };
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

type LoggerInstance = ReturnType<typeof createLogger>;

interface CooldownStoreOptions {
  primary?: AdminExportRateLimitKvNamespace;
  fallback?: AdminExportRateLimitKvNamespace;
  logger: LoggerInstance;
}

interface CooldownContextDetails {
  userId: string;
  chatId: string;
}

interface ExportCooldownEntry {
  expiresAt: number;
  noticeSentAt?: number;
}

const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const parseCooldownEntry = (value: string | null): ExportCooldownEntry | undefined => {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as { expiresAt?: unknown; noticeSentAt?: unknown };
    const expiresAt = toFiniteNumber(parsed.expiresAt);
    if (typeof expiresAt !== 'number') {
      return undefined;
    }

    const entry: ExportCooldownEntry = { expiresAt };
    const noticeSentAt = toFiniteNumber(parsed.noticeSentAt);
    if (typeof noticeSentAt === 'number') {
      entry.noticeSentAt = noticeSentAt;
    }

    return entry;
  } catch (error) {
    void error;
    return undefined;
  }
};

const serializeCooldownEntry = (entry: ExportCooldownEntry): string => JSON.stringify(entry);

const calculateRemainingTtlSeconds = (
  entry: ExportCooldownEntry,
  nowMs: number,
): number | undefined => {
  const remainingMs = entry.expiresAt - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return undefined;
  }

  return Math.max(1, Math.ceil(remainingMs / 1000));
};

const createCooldownStore = (options: CooldownStoreOptions) => {
  const { primary, fallback, logger } = options;

  const attemptGet = async (
    namespace: AdminExportRateLimitKvNamespace | undefined,
    key: string,
  ): Promise<{ value?: string | null; error?: unknown; available: boolean }> => {
    if (!namespace) {
      return { available: false };
    }

    try {
      const value = await namespace.get(key, 'text');
      return { value, available: true };
    } catch (error) {
      return { available: true, error };
    }
  };

  const attemptPut = async (
    namespace: AdminExportRateLimitKvNamespace | undefined,
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<{ ok: boolean; error?: unknown }> => {
    if (!namespace) {
      return { ok: false };
    }

    try {
      await namespace.put(key, value, { expirationTtl: ttlSeconds });
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  };

  return {
    async get(key: string, context: CooldownContextDetails): Promise<string | null> {
      const primaryResult = await attemptGet(primary, key);
      if (primaryResult.value !== null && primaryResult.value !== undefined) {
        return primaryResult.value;
      }

      const fallbackResult = await attemptGet(fallback, key);
      if (fallbackResult.value !== null && fallbackResult.value !== undefined) {
        if (primaryResult.error) {
          logger.info('admin export cooldown resolved via fallback kv', {
            userId: context.userId,
            chatId: context.chatId,
            error: normalizeErrorForLog(primaryResult.error),
          });
        }
        return fallbackResult.value;
      }

      if (primaryResult.error) {
        logger.warn('failed to read admin export cooldown kv', {
          userId: context.userId,
          chatId: context.chatId,
          error: normalizeErrorForLog(primaryResult.error),
        });
      }

      if (fallbackResult.error) {
        logger.warn('failed to read admin export cooldown fallback kv', {
          userId: context.userId,
          chatId: context.chatId,
          error: normalizeErrorForLog(fallbackResult.error),
        });
      }

      return null;
    },

    async put(
      key: string,
      value: string,
      ttlSeconds: number,
      context: CooldownContextDetails,
    ): Promise<boolean> {
      const primaryResult = await attemptPut(primary, key, value, ttlSeconds);
      if (primaryResult.ok) {
        return true;
      }

      const fallbackResult = await attemptPut(fallback, key, value, ttlSeconds);
      if (fallbackResult.ok) {
        if (primaryResult.error) {
          logger.info('admin export cooldown stored in fallback kv', {
            userId: context.userId,
            chatId: context.chatId,
            error: normalizeErrorForLog(primaryResult.error),
          });
        }
        return true;
      }

      if (primaryResult.error) {
        logger.warn('failed to update admin export cooldown kv', {
          userId: context.userId,
          chatId: context.chatId,
          error: normalizeErrorForLog(primaryResult.error),
        });
      }

      if (fallbackResult.error) {
        logger.warn('failed to update admin export cooldown fallback kv', {
          userId: context.userId,
          chatId: context.chatId,
          error: normalizeErrorForLog(fallbackResult.error),
        });
      }

      return false;
    },
  };
};

const normalizeErrorForLog = (error: unknown) =>
  error instanceof Error ? { name: error.name, message: error.message } : String(error);

const buildTelegramFormData = (
  chatId: string,
  threadId: string | undefined,
  payload: Uint8Array,
) => {
  const formData = new FormData();
  formData.set('chat_id', chatId);
  if (threadId) {
    formData.set('message_thread_id', threadId);
  }

  const blob = new Blob([payload], { type: 'text/csv; charset=utf-8' });
  formData.set('document', blob, 'dialog-export.csv');

  return formData;
};

const EXPORT_COOLDOWN_KEY_PREFIX = 'rate-limit:';
const EXPORT_COOLDOWN_TTL_SECONDS = 60; // Cloudflare KV требует минимум 60 секунд TTL
const EXPORT_COOLDOWN_NOTICE = 'Экспорт формируется, подождите 60 секунд';
const EXPORT_COOLDOWN_RESPONSE = {
  error: EXPORT_COOLDOWN_NOTICE,
};
const EXPORT_LOG_TTL_SECONDS = 60 * 60 * 24 * 30;
const EXPORT_ROW_LIMIT = 5000;
const EXPORT_PAGE_LIMIT = 1000;

const textDecoder = new TextDecoder('utf-8');
const EXPORT_EMPTY_NOTICE =
  'За выбранный период нет новых сообщений — CSV содержит только заголовок. Уточните даты и повторите /export.';
const EXPORT_LIMIT_NOTICE =
  `⚠️ Экспорт ограничен первыми ${EXPORT_ROW_LIMIT} строками. Сузьте диапазон или разбейте выгрузку на несколько команд.`;

const countCsvRows = (csvText: string): number => {
  const newlineMatches = csvText.match(/\n/g) ?? [];
  return Math.max(newlineMatches.length - 1, 0);
};

const stripCsvHeaderBytes = (data: Uint8Array): Uint8Array => {
  const lfIndex = data.indexOf(0x0a);
  if (lfIndex === -1) {
    return new Uint8Array(0);
  }

  return data.subarray(lfIndex + 1);
};

const mergeCsvChunks = (chunks: Uint8Array[], totalLength: number): Uint8Array => {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }

  if (chunks.length === 1) {
    return chunks[0];
  }

  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
};

type HandleExportFn = CreateTelegramExportCommandHandlerOptions['handleExport'];

interface PaginatedExportSuccess {
  ok: true;
  data: Uint8Array;
  rowCount: number;
  utmSources?: string[];
  limitReached: boolean;
}

interface PaginatedExportFailure {
  ok: false;
  response: Response;
}

type PaginatedExportResult = PaginatedExportSuccess | PaginatedExportFailure;

const collectPaginatedExport = async (
  handleExport: HandleExportFn,
  request: Pick<AdminExportRequest, 'from' | 'to' | 'signal'>,
): Promise<PaginatedExportResult> => {
  const csvChunks: Uint8Array[] = [];
  const utmSourceSet = new Set<string>();
  let totalBytes = 0;
  let cursor: string | undefined;
  let rowCount = 0;
  let limitReached = false;

  while (rowCount < EXPORT_ROW_LIMIT) {
    const remainingRows = EXPORT_ROW_LIMIT - rowCount;
    const limit = Math.min(EXPORT_PAGE_LIMIT, Math.max(remainingRows, 1));

    const response = await handleExport({
      ...request,
      cursor,
      limit,
    });

    if (!response.ok) {
      return { ok: false, response };
    }

    const pageUtmSources = parseUtmSourcesHeader(response.headers.get('x-utm-sources'));
    if (pageUtmSources) {
      for (const source of pageUtmSources) {
        utmSourceSet.add(source);
      }
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    const csvText = textDecoder.decode(buffer);
    const pageRowCount = countCsvRows(csvText);

    const isFirstChunk = csvChunks.length === 0;
    const chunk = isFirstChunk ? buffer : stripCsvHeaderBytes(buffer);
    if (isFirstChunk || chunk.length > 0) {
      csvChunks.push(chunk);
      totalBytes += chunk.length;
    }

    rowCount += pageRowCount;

    const nextCursor = response.headers.get('x-next-cursor');
    if (!nextCursor) {
      break;
    }

    if (pageRowCount === 0) {
      break;
    }

    if (rowCount >= EXPORT_ROW_LIMIT) {
      limitReached = true;
      break;
    }

    cursor = nextCursor;
  }

  const data = mergeCsvChunks(csvChunks, totalBytes);
  const utmSources = utmSourceSet.size > 0 ? Array.from(utmSourceSet) : undefined;

  return { ok: true, data, rowCount, utmSources, limitReached };
};

const ADMIN_HELP_MESSAGE = [
  'Доступные команды администратора:',
  '- /admin status — проверить, есть ли у вас доступ администратора. Ответ: admin-ok или forbidden.',
  '- /broadcast — мгновенная рассылка',
  '- /export [from] [to] — выгрузить историю диалогов в CSV. Даты необязательные, формат YYYY-MM-DD. Запросы ограничены: не чаще одного раза в 60 секунд.',
].join('\n');

const parseUtmSourcesHeader = (value: string | null): string[] | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const normalized = parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (normalized.length === 0) {
      return undefined;
    }

    return Array.from(new Set(normalized));
  } catch (error) {
    console.warn('failed to parse x-utm-sources header', {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    return undefined;
  }
};

export const createTelegramExportCommandHandler = (
  options: CreateTelegramExportCommandHandlerOptions,
) => {
  const now = options.now ?? (() => new Date());
  const logger = createLogger(options.logger);
  const apiUrl = `https://api.telegram.org/bot${options.botToken}/sendDocument`;
  const fallbackCooldownKv =
    options.adminAccessKv && options.adminAccessKv !== options.cooldownKv ? options.adminAccessKv : undefined;
  const cooldownStore = createCooldownStore({
    primary: options.cooldownKv,
    fallback: fallbackCooldownKv,
    logger,
  });
  const hasCooldownStore = Boolean(options.cooldownKv || fallbackCooldownKv);

  const logAdminMessagingError = async (
    message: string,
    contextDetails: { userId: string; chatId: string; threadId?: string },
    error: unknown,
    commandLabel: string,
  ) => {
    const telegramDetails = extractTelegramErrorDetails(error);
    const logDetails: Record<string, unknown> = {
      ...contextDetails,
      error: normalizeErrorForLog(error),
    };

    if (telegramDetails.status !== undefined) {
      logDetails.status = telegramDetails.status;
    }

    if (telegramDetails.description) {
      logDetails.description = telegramDetails.description;
    }

    logger.error(message, logDetails);

    if (shouldInvalidateAdminAccess(telegramDetails)) {
      options.adminAccess.invalidate?.(contextDetails.userId);
    }

    await options.adminErrorRecorder?.record({
      userId: contextDetails.userId,
      command: commandLabel,
      error,
      details: telegramDetails,
    });
  };

  return async (context: TelegramAdminCommandContext): Promise<Response | void> => {
    const command = context.command.toLowerCase();
    const trimmedArgument = context.argument?.trim();

    if (command === '/admin' && (!trimmedArgument || trimmedArgument.length === 0)) {
      const userId = context.from.userId;
      const isAdmin = await options.adminAccess.isAdmin(userId);

      if (!isAdmin) {
        return undefined;
      }

      try {
        await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text: ADMIN_HELP_MESSAGE,
        });

        logger.info('admin help sent', {
          userId,
          chatId: context.chat.id,
          threadId: context.chat.threadId,
        });
      } catch (error) {
        await logAdminMessagingError(
          'failed to send admin help response',
          {
            userId,
            chatId: context.chat.id,
            threadId: context.chat.threadId,
          },
          error,
          'admin_help',
        );

        return json({ error: 'Failed to send admin help response' }, { status: 502 });
      }

      return json({ help: 'sent' }, { status: 200 });
    }

    if (command === '/admin' && trimmedArgument?.toLowerCase() === 'status') {
      const userId = context.from.userId;
      const isAdmin = await options.adminAccess.isAdmin(userId);
      const statusText = isAdmin ? 'admin-ok' : 'forbidden';

      try {
        await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text: statusText,
        });

        if (isAdmin) {
          logger.info('admin status confirmed', {
            userId,
            chatId: context.chat.id,
            threadId: context.chat.threadId,
          });
        } else {
          logger.warn('admin status denied', {
            userId,
            chatId: context.chat.id,
            threadId: context.chat.threadId,
          });
        }
      } catch (error) {
        await logAdminMessagingError(
          'failed to send admin status response',
          {
            userId,
            chatId: context.chat.id,
            threadId: context.chat.threadId,
          },
          error,
          'admin_status',
        );

        return json({ error: 'Failed to send admin status response' }, { status: 502 });
      }

      return json({ status: statusText }, { status: 200 });
    }

    let rangeArgument: string | undefined;

    if (command === '/export') {
      rangeArgument = trimmedArgument;
    } else if (command === '/admin') {
      if (!trimmedArgument) {
        return undefined;
      }

      const [firstToken, ...restTokens] = trimmedArgument.split(/\s+/);
      if (firstToken?.toLowerCase() !== 'export') {
        return undefined;
      }

      rangeArgument = restTokens.join(' ').trim();
      if (rangeArgument.length === 0) {
        rangeArgument = undefined;
      }
    } else {
      return undefined;
    }

    let args: ExportArguments;

    try {
      args = parseExportRangeArguments(rangeArgument);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid arguments';
      logger.warn('invalid export arguments', { message, chatId: context.chat.id });
      return json({ error: message }, { status: 400 });
    }

    const { from, to } = args;
    const userId = context.from.userId;

    const isAdmin = await options.adminAccess.isAdmin(userId);
    if (!isAdmin) {
      logger.warn('admin export denied', { userId, chatId: context.chat.id });
      return undefined;
    }

    const rateLimitResult = await options.rateLimit.checkAndIncrement({
      userId,
      context: {
        chatId: context.chat.id,
        threadId: context.chat.threadId,
        scope: 'admin_export',
      },
    });

    if (rateLimitResult === 'limit') {
      logger.warn('admin export rate limited', { userId, chatId: context.chat.id });
      return json({ error: 'Too many export requests' }, { status: 429 });
    }

    if (hasCooldownStore) {
      const cooldownKey = `${EXPORT_COOLDOWN_KEY_PREFIX}${userId}`;
      const cooldownContext = { userId, chatId: context.chat.id };

      const existingValue = await cooldownStore.get(cooldownKey, cooldownContext);

      if (existingValue !== null) {
        logger.warn('admin export cooldown active', {
          userId,
          chatId: context.chat.id,
        });

        const cooldownEntry = parseCooldownEntry(existingValue);
        const shouldSendNotice = !cooldownEntry || cooldownEntry.noticeSentAt === undefined;

        if (shouldSendNotice) {
          try {
            await options.messaging.sendText({
              chatId: context.chat.id,
              threadId: context.chat.threadId,
              text: EXPORT_COOLDOWN_NOTICE,
            });

            if (cooldownEntry) {
              const noticeTimestamp = now().getTime();
              const remainingTtlSeconds = calculateRemainingTtlSeconds(cooldownEntry, noticeTimestamp);
              if (typeof remainingTtlSeconds === 'number') {
                await cooldownStore.put(
                  cooldownKey,
                  serializeCooldownEntry({ ...cooldownEntry, noticeSentAt: noticeTimestamp }),
                  remainingTtlSeconds,
                  cooldownContext,
                );
              }
            }
          } catch (error) {
            await logAdminMessagingError(
              'failed to send export cooldown notice',
              { userId, chatId: context.chat.id, threadId: context.chat.threadId },
              error,
              'export_cooldown_notice',
            );
          }
        }
        return json(EXPORT_COOLDOWN_RESPONSE, { status: 429 });
      }

      const cooldownExpiresAt = now().getTime() + EXPORT_COOLDOWN_TTL_SECONDS * 1000;
      await cooldownStore.put(
        cooldownKey,
        serializeCooldownEntry({ expiresAt: cooldownExpiresAt }),
        EXPORT_COOLDOWN_TTL_SECONDS,
        cooldownContext,
      );
    }

    const abortController = new AbortController();

    let exportResult: PaginatedExportResult;
    try {
      exportResult = await collectPaginatedExport(options.handleExport, {
        from,
        to,
        signal: abortController.signal,
      });
    } catch (error) {
      logger.error('failed to execute export handler', {
        userId,
        chatId: context.chat.id,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      return json({ error: 'Failed to create export' }, { status: 500 });
    }

    if (!exportResult.ok) {
      logger.warn('export handler returned non-ok response', {
        status: exportResult.response.status,
        userId,
        chatId: context.chat.id,
      });
      return exportResult.response;
    }

    const { data, rowCount, utmSources, limitReached } = exportResult;

    const sendExportNotice = async (text: string, commandLabel: string) => {
      try {
        await options.messaging.sendText({
          chatId: context.chat.id,
          threadId: context.chat.threadId,
          text,
        });
      } catch (error) {
        await logAdminMessagingError(
          'failed to send export notification',
          { userId, chatId: context.chat.id, threadId: context.chat.threadId },
          error,
          commandLabel,
        );
      }
    };

    if (rowCount === 0) {
      await sendExportNotice(EXPORT_EMPTY_NOTICE, 'export_notice_empty');
    } else if (limitReached) {
      await sendExportNotice(EXPORT_LIMIT_NOTICE, 'export_notice_truncated');
    }

    const formData = buildTelegramFormData(context.chat.id, context.chat.threadId, data);

    const requestTimestamp = now();
    const exportLogDetails: Record<string, unknown> = {
      chatId: context.chat.id,
      threadId: context.chat.threadId,
      userId,
      from: from?.toISOString(),
      to: to?.toISOString(),
      requestedAt: requestTimestamp.toISOString(),
      rowCount,
    };
    if (utmSources) {
      exportLogDetails.utmSources = utmSources;
    }
    if (limitReached) {
      exportLogDetails.rowLimitReached = true;
    }
    logger.info('sending export to telegram', exportLogDetails);

    let telegramResponse: Response;
    try {
      telegramResponse = await fetch(apiUrl, {
        method: 'POST',
        body: formData,
      });
    } catch (error) {
      logger.error('failed to upload export to telegram', {
        chatId: context.chat.id,
        threadId: context.chat.threadId,
        userId,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      return json({ error: 'Failed to send export to Telegram' }, { status: 502 });
    }

    if (!telegramResponse.ok) {
      let description: string | undefined;
      try {
        const responseText = await telegramResponse.text();
        try {
          const parsed = JSON.parse(responseText) as { description?: unknown };
          if (typeof parsed.description === 'string') {
            description = parsed.description;
          }
        } catch (parseError) {
          logger.warn('failed to parse telegram export error response', {
            status: telegramResponse.status,
            error:
              parseError instanceof Error
                ? { name: parseError.name, message: parseError.message }
                : String(parseError),
          });
        }
      } catch (readError) {
        logger.warn('failed to read telegram export error response body', {
          status: telegramResponse.status,
          error:
            readError instanceof Error
              ? { name: readError.name, message: readError.message }
              : String(readError),
        });
      }

      const failureDetails = { status: telegramResponse.status, description };

      logger.error('failed to upload export to telegram', {
        status: telegramResponse.status,
        statusText: telegramResponse.statusText,
        description,
      });

      if (shouldInvalidateAdminAccess(failureDetails)) {
        options.adminAccess.invalidate?.(userId);
      }

      await options.adminErrorRecorder?.record({
        userId,
        command: 'export_upload',
        error: failureDetails,
        details: failureDetails,
      });

      return json({ error: 'Failed to send export to Telegram' }, { status: 502 });
    }

    if (options.exportLogKv) {
      const completedAt = now();
      const logKey = `log:${completedAt.toISOString()}:${userId}`;
      const payload: Record<string, unknown> = {
        userId,
        chatId: context.chat.id,
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        rowCount,
      };
      if (utmSources) {
        payload.utmSources = utmSources;
      }
      if (limitReached) {
        payload.rowLimitReached = true;
      }

      try {
        await options.exportLogKv.put(logKey, JSON.stringify(payload), {
          expirationTtl: EXPORT_LOG_TTL_SECONDS,
        });
      } catch (error) {
        logger.warn('failed to write admin export log', {
          userId,
          chatId: context.chat.id,
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
        });
      }
    }

    return json({ status: 'ok' }, { status: 200 });
  };
};
