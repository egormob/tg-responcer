import type { MessagingPort } from '../../ports';
import { getRawTextLength, getVisibleTextLength } from '../../shared';
import type { BroadcastAudienceFilter } from './broadcast-payload';
import type { BroadcastTelemetry } from './broadcast-telemetry';

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export type BroadcastAbortReason =
  | 'telegram_limit_exceeded'
  | 'send_text_failed'
  | 'aborted_by_admin'
  | 'oom_signal'
  | 'checkpoint_mismatch';

export interface BroadcastEmergencyStopOptions {
  retryAfterMs?: number;
}

export class BroadcastAbortedError extends Error {
  readonly reason: BroadcastAbortReason;
  readonly context?: Record<string, unknown>;

  constructor(reason: BroadcastAbortReason, context?: Record<string, unknown>, cause?: unknown) {
    super(`broadcast aborted: ${reason}`);
    this.name = 'BroadcastAbortedError';
    this.reason = reason;
    this.context = context;
    if (cause !== undefined) {
      try {
        // @ts-expect-error cause might not be supported in target runtime
        this.cause = cause;
      } catch (error) {
        // ignore when cause assignment is not supported
      }
    }
  }
}

export interface BroadcastRecipient {
  chatId: string;
  threadId?: string;
  username?: string;
  languageCode?: string;
}

export interface BroadcastSendInput {
  text: string;
  requestedBy: string;
  filters?: BroadcastAudienceFilter;
  jobId?: string;
  resumeFrom?: BroadcastProgressCheckpoint;
  adminChat?: { chatId: string; threadId?: string };
  abortSignal?: AbortSignal;
  oomSignal?: AbortSignal;
}

export interface BroadcastSendResultDelivery {
  recipient: BroadcastRecipient;
  messageId?: string;
  error?: { name: string; message: string };
}

export interface BroadcastSendResult {
  delivered: number;
  failed: number;
  deliveries: ReadonlyArray<BroadcastSendResultDelivery>;
  recipients: number;
  durationMs: number;
  source?: string | null;
  sample: ReadonlyArray<{
    chatId: string;
    threadId?: string | null;
    username?: string | null;
    languageCode?: string | null;
  }>;
  throttled429?: number;
}

export type SendBroadcast = (input: BroadcastSendInput) => Promise<BroadcastSendResult>;

export interface BroadcastProgressCheckpoint {
  jobId: string;
  status: 'running' | 'paused' | 'aborted' | 'completed';
  offset: number;
  delivered: number;
  failed: number;
  throttled429: number;
  reason?: BroadcastAbortReason;
  total: number;
  text: string;
  textHash: string;
  audienceHash: string;
  pool: Pick<Required<BroadcastPoolOptions>, 'concurrency' | 'maxRps'>;
  batchSize?: number;
  maxBatchTextBytes?: number;
  filters?: BroadcastAudienceFilter;
  source?: string | null;
  updatedAt: string;
  ttlSeconds?: number;
  expiresAt?: string;
}

export interface BroadcastAdminNotificationInput {
  jobId: string;
  status: 'paused' | 'aborted';
  reason: BroadcastAbortReason;
  checkpoint: BroadcastProgressCheckpoint;
  adminChat?: { chatId: string; threadId?: string };
}

export type BroadcastProgressKvNamespace = Pick<KVNamespace, 'get' | 'put' | 'delete' | 'list'>;

export interface BroadcastPoolOptions {
  concurrency?: number;
  /**
   * Максимальное число попыток доставки одному получателю.
   */
  maxAttempts?: number;
  /**
   * Базовая задержка для экспоненциального бэкоффа (мс).
   */
  baseDelayMs?: number;
  /**
   * Коэффициент джиттера (0-1). Используется для сдвига задержек.
   */
  jitterRatio?: number;
  /**
   * Глобальный лимит отправок (сообщений в секунду).
   */
  maxRps?: number;
  /**
   * Джиттер для глобального лимитера отправок.
   */
  rateJitterRatio?: number;
  /**
   * Позволяет подменить генератор случайных чисел (например, в тестах).
   */
  random?: () => number;
  /**
   * Позволяет переопределить ожидание (используется в тестах).
   */
  wait?: (ms: number) => Promise<void>;
  /**
   * Используется вместе с кастомным ожиданием для детерминированных тестов.
   */
  now?: () => number;
}

export interface BroadcastWatchdogOptions {
  memoryLimitBytes?: number;
  memoryUsage?: () => number;
  logIntervalMs?: number;
}

export interface CreateImmediateBroadcastSenderOptions {
  messaging: Pick<MessagingPort, 'sendText'>;
  messagingBroadcast?: Pick<MessagingPort, 'sendText'>;
  recipients: readonly BroadcastRecipient[];
  logger?: Logger;
  pool?: BroadcastPoolOptions;
  telemetry?: BroadcastTelemetry;
  emergencyStop?: BroadcastEmergencyStopOptions;
  maxTextLength?: number;
  progressKv?: BroadcastProgressKvNamespace;
  progressTtlSeconds?: number;
  batchSize?: number;
  maxBatchTextBytes?: number;
  jobIdGenerator?: () => string;
  onAdminNotification?: (input: BroadcastAdminNotificationInput) => Promise<void> | void;
  watchdog?: BroadcastWatchdogOptions;
}

export interface BroadcastRecipientsRegistry {
  listActiveRecipients(filter?: BroadcastAudienceFilter): Promise<BroadcastRecipient[]>;
}

export interface CreateRegistryBroadcastSenderOptions {
  messaging: Pick<MessagingPort, 'sendText'>;
  messagingBroadcast?: Pick<MessagingPort, 'sendText'>;
  registry: BroadcastRecipientsRegistry;
  logger?: Logger;
  pool?: BroadcastPoolOptions;
  telemetry?: BroadcastTelemetry;
  emergencyStop?: BroadcastEmergencyStopOptions;
  maxTextLength?: number;
  progressKv?: BroadcastProgressKvNamespace;
  progressTtlSeconds?: number;
  batchSize?: number;
  maxBatchTextBytes?: number;
  jobIdGenerator?: () => string;
  onAdminNotification?: (input: BroadcastAdminNotificationInput) => Promise<void> | void;
  watchdog?: BroadcastWatchdogOptions;
}

const DEFAULT_POOL_OPTIONS: Required<
  Omit<BroadcastPoolOptions, 'wait' | 'random' | 'now'>
> = {
  concurrency: 4,
  maxAttempts: 3,
  baseDelayMs: 1000,
  jitterRatio: 0.2,
  maxRps: 28,
  rateJitterRatio: 0.1,
};

const DEFAULT_BROADCAST_MAX_TEXT_LENGTH = 3970;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_BATCH_TEXT_BYTES = DEFAULT_BROADCAST_MAX_TEXT_LENGTH * DEFAULT_BATCH_SIZE;
const BROADCAST_PROGRESS_KV_VERSION = 1;
const BROADCAST_PROGRESS_KEY_PREFIX = 'broadcast:progress:';
const DEFAULT_PROGRESS_TTL_SECONDS = 24 * 60 * 60;
const MIN_PROGRESS_TTL_SECONDS = 60;
const THROTTLE_DEGRADE_THRESHOLD = 5;

const createWait = (wait?: (ms: number) => Promise<void>) =>
  wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const computeHash = async (value: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', data);
      return toHex(digest);
    } catch (error) {
      // fall through to node:crypto
      void error;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(data).digest('hex');
};

const buildProgressKey = (jobId: string): string => `${BROADCAST_PROGRESS_KEY_PREFIX}${jobId}`;

const buildAudienceHash = async (recipients: readonly BroadcastRecipient[]): Promise<string> => {
  const payload = recipients.map((recipient) => ({
    chatId: recipient.chatId,
    threadId: recipient.threadId ?? null,
  }));

  return computeHash(JSON.stringify(payload));
};

const computeDelay = (
  retryIndex: number,
  baseDelayMs: number,
  jitterRatio: number,
  random: () => number,
  retryAfterMs?: number,
): number => {
  const exponential = baseDelayMs * 2 ** retryIndex;
  const jitter = exponential * clamp(jitterRatio, 0, 1) * random();
  const computedDelay = exponential + jitter;

  if (retryAfterMs === undefined) {
    return computedDelay;
  }

  return Math.max(computedDelay, retryAfterMs);
};

const tryGetMemoryUsage = (): number | undefined => {
  const performanceMemory = globalThis.performance?.memory as
    | { usedJSHeapSize?: number }
    | undefined;

  if (typeof performanceMemory?.usedJSHeapSize === 'number') {
    return performanceMemory.usedJSHeapSize;
  }

  if (
    typeof process !== 'undefined'
    && typeof (process as { memoryUsage?: () => { heapUsed: number } }).memoryUsage === 'function'
  ) {
    return (process as { memoryUsage: () => { heapUsed: number } }).memoryUsage().heapUsed;
  }

  return undefined;
};

const createRateLimiter = (
  maxRps: number,
  rateJitterRatio: number,
  random: () => number,
  wait: (ms: number) => Promise<void>,
  now: () => number,
): (() => Promise<void>) => {
  const intervalMs = Math.ceil(1000 / Math.max(1, Math.floor(maxRps)));
  const jitterRatio = clamp(rateJitterRatio, 0, 1);
  let nextSlotAt = 0;

  return async () => {
    const current = now();

    if (nextSlotAt === 0) {
      nextSlotAt = current + intervalMs;
      return;
    }

    const slotAt = Math.max(current, nextSlotAt);
    const jitterMs = intervalMs * jitterRatio * random();
    const scheduledAt = slotAt + jitterMs;
    const delayMs = Math.max(0, Math.floor(scheduledAt - current));

    nextSlotAt = slotAt + intervalMs;

    if (delayMs > 0) {
      await wait(delayMs);
    }
  };
};

const isTooManyRequestsError = (error: unknown): error is Error & { status?: number } => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  return status === 429;
};

const getRetryAfterMs = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const retryAfter = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter;
  }

  const parameters = (error as { parameters?: { retry_after?: unknown } }).parameters;
  const retryAfterSeconds = parameters?.retry_after;
  if (
    typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
  ) {
    return retryAfterSeconds * 1000;
  }

  return undefined;
};

const getErrorStatus = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
};

const shouldAbortOnFailure = (error: unknown): boolean => {
  const status = getErrorStatus(error);
  if (status === undefined) {
    return true;
  }

  if (status >= 500 || status === 401) {
    return true;
  }

  return false;
};

const sanitizeEmergencyStopThreshold = (value: number | undefined): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
};

const toErrorDetails = (error: unknown): { name: string; message: string } => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  const message = typeof error === 'string' ? error : JSON.stringify(error);
  return { name: 'Error', message };
};

const serializeCheckpoint = (checkpoint: BroadcastProgressCheckpoint): string =>
  JSON.stringify({ version: BROADCAST_PROGRESS_KV_VERSION, checkpoint });

const parseCheckpoint = (raw: string | null): BroadcastProgressCheckpoint | undefined => {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      checkpoint?: BroadcastProgressCheckpoint;
    };

    if (parsed.version !== BROADCAST_PROGRESS_KV_VERSION) {
      return undefined;
    }

    if (!parsed.checkpoint?.jobId || typeof parsed.checkpoint.jobId !== 'string') {
      return undefined;
    }

    if (
      parsed.checkpoint.status !== 'running'
      && parsed.checkpoint.status !== 'paused'
      && parsed.checkpoint.status !== 'aborted'
      && parsed.checkpoint.status !== 'completed'
    ) {
      return undefined;
    }

    return parsed.checkpoint;
  } catch (error) {
    void error;
    return undefined;
  }
};

const saveCheckpoint = async (
  kv: BroadcastProgressKvNamespace | undefined,
  checkpoint: BroadcastProgressCheckpoint,
  logger?: Logger,
): Promise<void> => {
  if (!kv) {
    return;
  }

  try {
    await kv.put(
      buildProgressKey(checkpoint.jobId),
      serializeCheckpoint(checkpoint),
      checkpoint.ttlSeconds ? { expirationTtl: checkpoint.ttlSeconds } : undefined,
    );
  } catch (error) {
    logger?.warn?.('broadcast_progress_save_failed', { error: toErrorDetails(error) });
  }
};

const deleteCheckpoint = async (
  kv: BroadcastProgressKvNamespace | undefined,
  jobId: string,
  logger?: Logger,
): Promise<void> => {
  if (!kv) {
    return;
  }

  try {
    await kv.delete(buildProgressKey(jobId));
  } catch (error) {
    logger?.warn?.('broadcast_progress_delete_failed', { error: toErrorDetails(error) });
  }
};

const readCheckpoint = async (
  kv: BroadcastProgressKvNamespace | undefined,
  jobId: string,
  logger?: Logger,
): Promise<BroadcastProgressCheckpoint | undefined> => {
  if (!kv) {
    return undefined;
  }

  try {
    const raw = await kv.get(buildProgressKey(jobId), 'text');
    return parseCheckpoint(raw);
  } catch (error) {
    logger?.warn?.('broadcast_progress_read_failed', { error: toErrorDetails(error) });
    return undefined;
  }
};

export interface BroadcastCheckpointEntry {
  jobId: string;
  checkpoint: BroadcastProgressCheckpoint;
}

export const loadBroadcastCheckpoint = async (
  kv: BroadcastProgressKvNamespace | undefined,
  jobId: string,
  logger?: Logger,
): Promise<BroadcastProgressCheckpoint | undefined> => readCheckpoint(kv, jobId, logger);

export const listBroadcastCheckpoints = async (
  kv: BroadcastProgressKvNamespace | undefined,
  logger?: Logger,
): Promise<BroadcastCheckpointEntry[]> => {
  if (!kv) {
    return [];
  }

  try {
    let cursor: string | undefined;
    const checkpoints: BroadcastCheckpointEntry[] = [];

    do {
      const result = await kv.list({ prefix: BROADCAST_PROGRESS_KEY_PREFIX, cursor });
      for (const key of result.keys) {
        const jobId = key.name.slice(BROADCAST_PROGRESS_KEY_PREFIX.length);
        const checkpoint = await readCheckpoint(kv, jobId, logger);
        if (checkpoint) {
          checkpoints.push({ jobId, checkpoint });
        }
      }

      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return checkpoints;
  } catch (error) {
    logger?.warn?.('broadcast_progress_list_failed', { error: toErrorDetails(error) });
    return [];
  }
};

export const deleteBroadcastCheckpoint = async (
  kv: BroadcastProgressKvNamespace | undefined,
  jobId: string,
  logger?: Logger,
): Promise<void> => deleteCheckpoint(kv, jobId, logger);

const deduplicateRecipients = (
  recipients: readonly BroadcastRecipient[],
): BroadcastRecipient[] => {
  const seen = new Map<string, number>();
  const unique: BroadcastRecipient[] = [];

  for (const recipient of recipients) {
    const key = `${recipient.chatId}:${recipient.threadId ?? ''}`;
    const existingIndex = seen.get(key);

    if (existingIndex !== undefined) {
      const existing = unique[existingIndex];
      if (!existing.username && recipient.username) {
        unique[existingIndex] = { ...existing, username: recipient.username };
      }
      if (!existing.languageCode && recipient.languageCode) {
        unique[existingIndex] = { ...existing, languageCode: recipient.languageCode };
      }
      continue;
    }

    seen.set(key, unique.length);
    unique.push(recipient);
  }

  return unique;
};

const applyAudienceFilters = (
  recipients: readonly BroadcastRecipient[],
  filters: BroadcastAudienceFilter | undefined,
): BroadcastRecipient[] => {
  if (!filters) {
    return Array.from(recipients);
  }

  let result = Array.from(recipients);

  if (filters.chatIds?.length) {
    const chatIds = new Set(filters.chatIds.map((id) => id.trim()));
    result = result.filter((recipient) => chatIds.has(recipient.chatId));
  }

  if (filters.userIds?.length) {
    const userIds = new Set(filters.userIds.map((id) => id.trim()));
    result = result.filter((recipient) => userIds.has(recipient.chatId));
  }

  return result;
};

interface ResolveRecipientsResult {
  recipients: readonly BroadcastRecipient[];
  source?: string;
}

type ResolveRecipients = (
  filters?: BroadcastAudienceFilter,
) =>
  | Promise<readonly BroadcastRecipient[] | ResolveRecipientsResult>
  | readonly BroadcastRecipient[]
  | ResolveRecipientsResult;

interface CreateBroadcastSenderOptions {
  messaging: Pick<MessagingPort, 'sendText'>;
  messagingBroadcast?: Pick<MessagingPort, 'sendText'>;
  resolveRecipients: ResolveRecipients;
  logger?: Logger;
  pool?: BroadcastPoolOptions;
  telemetry?: BroadcastTelemetry;
  emergencyStop?: BroadcastEmergencyStopOptions;
  maxTextLength?: number;
  progressKv?: BroadcastProgressKvNamespace;
  progressTtlSeconds?: number;
  batchSize?: number;
  jobIdGenerator?: () => string;
  onAdminNotification?: (input: BroadcastAdminNotificationInput) => Promise<void> | void;
}

const createBroadcastSender = (options: CreateBroadcastSenderOptions): SendBroadcast => {
  const poolOptions = {
    ...DEFAULT_POOL_OPTIONS,
    ...options.pool,
  } satisfies Required<Omit<BroadcastPoolOptions, 'wait' | 'random' | 'now'>>;
  const wait = createWait(options.pool?.wait);
  const random = options.pool?.random ?? Math.random;
  const now = options.pool?.now ?? Date.now;
  const configuredConcurrency = Math.max(1, Math.floor(poolOptions.concurrency));
  const maxAttempts = Math.max(1, Math.floor(poolOptions.maxAttempts));
  const configuredMaxRps = Math.max(1, Math.floor(poolOptions.maxRps));
  const emergencyStopThresholdMs = sanitizeEmergencyStopThreshold(options.emergencyStop?.retryAfterMs);
  const deliveryMessaging = options.messagingBroadcast ?? options.messaging;
  const maxTextLength = options.maxTextLength ?? DEFAULT_BROADCAST_MAX_TEXT_LENGTH;
  const configuredBatchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const maxBatchTextBytes = Math.max(1, Math.floor(options.maxBatchTextBytes ?? DEFAULT_BATCH_TEXT_BYTES));
  const watchdogMemoryLimitBytes = options.watchdog?.memoryLimitBytes;
  const watchdogMemoryUsage = options.watchdog?.memoryUsage ?? tryGetMemoryUsage;
  const watchdogLogIntervalMs = Math.max(1000, options.watchdog?.logIntervalMs ?? 30_000);

  const normalizeResolveResult = (
    result: Awaited<ReturnType<ResolveRecipients>>,
  ): ResolveRecipientsResult => {
    if (Array.isArray(result)) {
      return { recipients: result } satisfies ResolveRecipientsResult;
    }

    return result;
  };

  const generateJobId = () => {
    if (options.jobIdGenerator) {
      return options.jobIdGenerator();
    }

    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }

    return `job-${now()}`;
  };

  return async (input) => {
    const text = (input.resumeFrom?.text ?? input.text).trim();
    const rawLength = getRawTextLength(text);
    const visibleLength = getVisibleTextLength(text);
    const effectiveLength = Math.max(rawLength, visibleLength);

    if (effectiveLength > maxTextLength) {
      const exceededBy = effectiveLength - maxTextLength;
      const context = {
        requestedBy: input.requestedBy,
        rawLength,
        visibleLength,
        length: effectiveLength,
        limit: maxTextLength,
        exceededBy,
      } satisfies Record<string, unknown>;

      options.logger?.warn?.('broadcast text exceeds limit', context);
      throw new BroadcastAbortedError('telegram_limit_exceeded', context);
    }

    const jobId = input.resumeFrom?.jobId ?? input.jobId ?? generateJobId();
    let currentConcurrency = Math.max(
      1,
      Math.floor(input.resumeFrom?.pool?.concurrency ?? configuredConcurrency),
    );
    let currentMaxRps = Math.max(
      1,
      Math.floor(input.resumeFrom?.pool?.maxRps ?? configuredMaxRps),
    );
    let rateLimiter = createRateLimiter(
      currentMaxRps,
      poolOptions.rateJitterRatio,
      random,
      wait,
      now,
    );
    const resolveBatchSize = () => {
      const limitByText = Math.max(1, Math.floor(maxBatchTextBytes / Math.max(1, effectiveLength)));
      return Math.max(1, Math.min(configuredBatchSize, limitByText));
    };
    let effectiveBatchSize = resolveBatchSize();
    if (typeof input.resumeFrom?.batchSize === 'number') {
      effectiveBatchSize = Math.max(1, Math.min(effectiveBatchSize, Math.floor(input.resumeFrom.batchSize)));
    }
    let lastWatchdogLogAt = now();
    const filters = input.resumeFrom?.filters ?? input.filters;
    const resolved = normalizeResolveResult(await options.resolveRecipients(filters));
    const filtersToApply = filters;
    const recipients = deduplicateRecipients(
      applyAudienceFilters(
        resolved.recipients.filter((recipient) => recipient.chatId.trim().length > 0),
        filtersToApply,
      ),
    );
    const startedAt = now();
    const recipientsSample = recipients.slice(0, 5).map((recipient) => ({
      chatId: recipient.chatId,
      threadId: recipient.threadId ?? null,
      username: recipient.username ?? null,
      languageCode: recipient.languageCode ?? null,
    }));

    const textHash = await computeHash(text);
    const audienceHash = await buildAudienceHash(recipients);

    const downgradePool = (reason: 'throttled429' | 'memory') => {
      const nextConcurrency = Math.max(1, Math.floor(currentConcurrency / 2));
      const nextMaxRps = Math.max(1, Math.floor(currentMaxRps / 2));

      if (nextConcurrency === currentConcurrency && nextMaxRps === currentMaxRps) {
        return;
      }

      currentConcurrency = nextConcurrency;
      currentMaxRps = nextMaxRps;
      rateLimiter = createRateLimiter(
        currentMaxRps,
        poolOptions.rateJitterRatio,
        random,
        wait,
        now,
      );

      options.logger?.warn?.('broadcast pool degraded', {
        reason,
        concurrency: currentConcurrency,
        maxRps: currentMaxRps,
        jobId,
      });
    };

    const runWatchdog = (phase: 'start' | 'batch') => {
      const usedMemory = watchdogMemoryUsage?.();

      if (usedMemory === undefined) {
        return;
      }

      if (typeof watchdogMemoryLimitBytes === 'number' && usedMemory > watchdogMemoryLimitBytes) {
        options.logger?.warn?.('broadcast_watchdog_memory', {
          jobId,
          phase,
          usedMemory,
          limit: watchdogMemoryLimitBytes,
          concurrency: currentConcurrency,
          maxRps: currentMaxRps,
        });
        downgradePool('memory');
        lastWatchdogLogAt = now();
        return;
      }

      if (now() - lastWatchdogLogAt >= watchdogLogIntervalMs) {
        options.logger?.info?.('broadcast_watchdog', {
          jobId,
          phase,
          usedMemory,
          concurrency: currentConcurrency,
          maxRps: currentMaxRps,
        });
        lastWatchdogLogAt = now();
      }
    };

    if (input.resumeFrom) {
      if (
        input.resumeFrom.jobId !== jobId
        || input.resumeFrom.textHash !== textHash
        || input.resumeFrom.audienceHash !== audienceHash
      ) {
        throw new BroadcastAbortedError('checkpoint_mismatch', {
          jobId,
          expectedText: input.resumeFrom.textHash,
          actualText: textHash,
          expectedAudience: input.resumeFrom.audienceHash,
          actualAudience: audienceHash,
        });
      }
    }

    options.logger?.info?.('broadcast_resolve', {
      requestedBy: input.requestedBy,
      filters: filters ?? null,
      source: resolved.source ?? null,
      recipients: recipients.length,
      sample: recipientsSample,
      jobId,
    });

    if (recipients.length === 0) {
      options.logger?.warn?.('broadcast recipients list is empty', {
        requestedBy: input.requestedBy,
        filters: filters ?? null,
        source: resolved.source ?? null,
        jobId,
      });

      return {
        delivered: input.resumeFrom?.delivered ?? 0,
        failed: input.resumeFrom?.failed ?? 0,
        deliveries: [],
        recipients: 0,
        durationMs: 0,
        source: resolved.source ?? null,
        sample: recipientsSample,
        throttled429: input.resumeFrom?.throttled429 ?? 0,
      } satisfies BroadcastSendResult;
    }

    options.logger?.info?.('broadcast pool initialized', {
      requestedBy: input.requestedBy,
      recipients: recipients.length,
      filters: filters ?? null,
      source: resolved.source ?? null,
      poolSize: currentConcurrency,
      maxAttempts,
      baseDelayMs: poolOptions.baseDelayMs,
      jitterRatio: poolOptions.jitterRatio,
      maxRps: currentMaxRps,
      rateJitterRatio: poolOptions.rateJitterRatio,
      batchSize: effectiveBatchSize,
      maxBatchTextBytes,
      jobId,
    });

    runWatchdog('start');

    const progressTtlSeconds = Math.max(
      MIN_PROGRESS_TTL_SECONDS,
      Math.floor(input.resumeFrom?.ttlSeconds ?? options.progressTtlSeconds ?? DEFAULT_PROGRESS_TTL_SECONDS),
    );

    let throttledErrors = input.resumeFrom?.throttled429 ?? 0;
    let deliveredCount = input.resumeFrom?.delivered ?? 0;
    let failedCount = input.resumeFrom?.failed ?? 0;
    let offset = Math.max(0, Math.min(input.resumeFrom?.offset ?? 0, recipients.length));
    let abortedError: BroadcastAbortedError | undefined;
    let notifiedAbort = false;

    const deliveries: BroadcastSendResultDelivery[] = Array.from(
      { length: recipients.length },
      (_, index) =>
        index < offset
          ? {
              recipient: recipients[index],
              error: { name: 'Skipped', message: 'already processed in checkpoint' },
            }
          : undefined as unknown as BroadcastSendResultDelivery,
    );

    const seenKeys = new Set<string>();
    for (let index = 0; index < offset; index += 1) {
      const recipient = recipients[index];
      const key = `${recipient.chatId}:${recipient.threadId ?? ''}`;
      seenKeys.add(key);
    }

    const getCompletedOffset = (): number => {
      let completedOffset = 0;
      while (completedOffset < deliveries.length && deliveries[completedOffset]) {
        completedOffset += 1;
      }

      return completedOffset;
    };

    const buildCheckpoint = (
      status: BroadcastProgressCheckpoint['status'],
      reason?: BroadcastAbortReason,
    ): BroadcastProgressCheckpoint => {
      const processedCount = deliveredCount + failedCount;
      const checkpointOffset = Math.max(offset, getCompletedOffset(), processedCount);
      const expiresAt = new Date(now() + progressTtlSeconds * 1000).toISOString();
      offset = checkpointOffset;

      return {
        jobId,
        status,
        offset: checkpointOffset,
        delivered: deliveredCount,
        failed: failedCount,
        throttled429: throttledErrors,
        total: recipients.length,
        text,
        textHash,
        audienceHash,
        pool: { concurrency: currentConcurrency, maxRps: currentMaxRps },
        batchSize: effectiveBatchSize,
        maxBatchTextBytes,
        filters: filters ?? undefined,
        source: resolved.source ?? null,
        updatedAt: new Date(now()).toISOString(),
        ttlSeconds: progressTtlSeconds,
        expiresAt,
        reason,
      } satisfies BroadcastProgressCheckpoint;
    };

    const persistCheckpoint = async (
      status: BroadcastProgressCheckpoint['status'],
      reason?: BroadcastAbortReason,
    ) => {
      const checkpoint = buildCheckpoint(status, reason);
      await saveCheckpoint(options.progressKv, checkpoint, options.logger);
      return checkpoint;
    };

    const notifyAdmin = async (
      status: 'paused' | 'aborted',
      reason: BroadcastAbortReason,
    ): Promise<void> => {
      if (!options.onAdminNotification) {
        return;
      }

      const checkpoint = await persistCheckpoint(status, reason);
      notifiedAbort = true;
      await options.onAdminNotification({ jobId, status, reason, checkpoint, adminChat: input.adminChat });
    };

    const ensureNotAborted = () => {
      if (input.abortSignal?.aborted) {
        abortedError = new BroadcastAbortedError('aborted_by_admin', { jobId });
        throw abortedError;
      }

      if (input.oomSignal?.aborted) {
        abortedError = new BroadcastAbortedError('oom_signal', { jobId });
        throw abortedError;
      }

      if (abortedError) {
        throw abortedError;
      }
    };

    const abortBroadcast = async (
      reason: BroadcastAbortReason,
      context: Record<string, unknown>,
      cause?: unknown,
    ): Promise<never> => {
      if (!abortedError) {
        abortedError = new BroadcastAbortedError(reason, context, cause);
        options.logger?.error?.('broadcast pool aborted', {
          requestedBy: input.requestedBy,
          reason,
          context,
          jobId,
        });
      }

      const status =
        reason === 'telegram_limit_exceeded' || reason === 'oom_signal' ? 'paused' : 'aborted';

      await notifyAdmin(status, reason);

      throw abortedError;
    };

    const handleEmergencyThrottle = async (retryAfterMs?: number, cause?: unknown) => {
      if (
        typeof emergencyStopThresholdMs === 'number'
        && typeof retryAfterMs === 'number'
        && retryAfterMs >= emergencyStopThresholdMs
      ) {
        await abortBroadcast(
          'telegram_limit_exceeded',
          {
            retryAfterMs,
            thresholdMs: emergencyStopThresholdMs,
            requestedBy: input.requestedBy,
            jobId,
          },
          cause,
        );
      }
    };

    const sendWithRetry = async (
      recipient: BroadcastRecipient,
    ): Promise<BroadcastSendResultDelivery> => {
      ensureNotAborted();
      let attempt = 0;

      const recipientKey = `${recipient.chatId}:${recipient.threadId ?? ''}`;
      if (seenKeys.has(recipientKey)) {
        return {
          recipient,
          error: { name: 'Skipped', message: 'already processed in checkpoint' },
        } satisfies BroadcastSendResultDelivery;
      }

      while (attempt < maxAttempts) {
        ensureNotAborted();
        try {
          await rateLimiter();
          const result = await deliveryMessaging.sendText({
            chatId: recipient.chatId,
            threadId: recipient.threadId,
            text,
          });

          options.logger?.info?.('broadcast delivered', {
            requestedBy: input.requestedBy,
            chatId: recipient.chatId,
            threadId: recipient.threadId ?? null,
            messageId: result?.messageId ?? null,
            attempt: attempt + 1,
            jobId,
          });

          deliveredCount += 1;
          seenKeys.add(recipientKey);

          return {
            recipient,
            messageId: result?.messageId,
          } satisfies BroadcastSendResultDelivery;
        } catch (error) {
          ensureNotAborted();
          const tooManyRequests = isTooManyRequestsError(error);
          const shouldRetry = tooManyRequests && attempt < maxAttempts - 1;
          const retryAfterMs = getRetryAfterMs(error);

          if (tooManyRequests) {
            throttledErrors += 1;
            await handleEmergencyThrottle(retryAfterMs, error);
            if (
              throttledErrors % THROTTLE_DEGRADE_THRESHOLD === 0
              || (retryAfterMs ?? 0) >= poolOptions.baseDelayMs * 2
            ) {
              downgradePool('throttled429');
              throttledErrors = 0;
            }
          }

          if (!shouldRetry) {
            const details = toErrorDetails(error);

            if (!tooManyRequests && shouldAbortOnFailure(error)) {
              await abortBroadcast(
                'send_text_failed',
                {
                  requestedBy: input.requestedBy,
                  chatId: recipient.chatId,
                  threadId: recipient.threadId ?? null,
                  status: getErrorStatus(error) ?? null,
                  jobId,
                },
                error,
              );
            }

            options.logger?.error?.('broadcast delivery failed', {
              requestedBy: input.requestedBy,
              chatId: recipient.chatId,
              threadId: recipient.threadId ?? null,
              error: details,
              attempt: attempt + 1,
              jobId,
            });

            failedCount += 1;
            seenKeys.add(recipientKey);

            return {
              recipient,
              error: details,
            } satisfies BroadcastSendResultDelivery;
          }

          const retryIndex = attempt;
          const delayMs = computeDelay(
            retryIndex,
            poolOptions.baseDelayMs,
            poolOptions.jitterRatio,
            random,
            retryAfterMs,
          );

          options.logger?.warn?.('broadcast throttled', {
            requestedBy: input.requestedBy,
            chatId: recipient.chatId,
            threadId: recipient.threadId ?? null,
            attempt: attempt + 1,
            delayMs,
            retryAfterMs: retryAfterMs ?? null,
            poolSize: currentConcurrency,
            jobId,
          });

          await wait(delayMs);
          attempt += 1;
        }
      }

      const details = toErrorDetails(new Error('broadcast delivery exceeded retries'));
      failedCount += 1;
      seenKeys.add(recipientKey);

      return {
        recipient,
        error: details,
      } satisfies BroadcastSendResultDelivery;
    };

    const processBatch = async (startIndex: number, endIndex: number) => {
      let nextIndex = startIndex;

      const worker = async (): Promise<void> => {
        while (true) {
          ensureNotAborted();
          const currentIndex = nextIndex;
          nextIndex += 1;

          if (currentIndex >= endIndex) {
            return;
          }

          deliveries[currentIndex] = await sendWithRetry(recipients[currentIndex]);
        }
      };

      await Promise.all(Array.from({ length: currentConcurrency }, () => worker()));
    };

    let aborted = false;
    try {
      while (offset < recipients.length) {
        ensureNotAborted();
        effectiveBatchSize = Math.max(1, resolveBatchSize());
        const startIndex = offset;
        const endIndex = Math.min(recipients.length, startIndex + effectiveBatchSize);

        runWatchdog('batch');

        await processBatch(startIndex, endIndex);

        offset = endIndex;
        await persistCheckpoint('running');
      }
    } catch (error) {
      if (error instanceof BroadcastAbortedError) {
        aborted = true;
        if (!notifiedAbort) {
          const status =
            error.reason === 'telegram_limit_exceeded' || error.reason === 'oom_signal'
              ? 'paused'
              : 'aborted';
          const checkpoint = await persistCheckpoint(status, error.reason);
          if (options.onAdminNotification) {
            await options.onAdminNotification({
              jobId,
              status,
              reason: error.reason,
              checkpoint,
              adminChat: input.adminChat,
            });
          }
        }
        for (let index = 0; index < deliveries.length; index += 1) {
          if (!deliveries[index]) {
            deliveries[index] = {
              recipient: recipients[index],
              error: {
                name: 'BroadcastAborted',
                message: error.message,
              },
            } satisfies BroadcastSendResultDelivery;
          }
        }
      } else {
        throw error;
      }
    }

    const durationMs = now() - startedAt;
    const topErrors = Object.entries(
      deliveries
        .filter((entry): entry is BroadcastSendResultDelivery & { error: { name: string } } => !!entry?.error)
        .reduce<Record<string, number>>((acc, entry) => {
          const key = `${entry.error.name}:${entry.error.message}`;
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
    )
      .sort(([, leftCount], [, rightCount]) => rightCount - leftCount)
      .slice(0, 3)
      .map(([error, count]) => ({ error, count }));

    const summaryDetails = {
      requestedBy: input.requestedBy,
      recipients: recipients.length,
      filters: filters ?? null,
      source: resolved.source ?? null,
      delivered: deliveredCount,
      failed: failedCount,
      poolSize: currentConcurrency,
      throttled429: throttledErrors,
      durationMs,
      topErrors,
      jobId,
    };

    if (aborted && abortedError) {
      options.logger?.error?.('broadcast_summary', {
        ...summaryDetails,
        aborted: true,
        reason: abortedError.reason,
      });
    } else {
      options.logger?.info?.('broadcast_summary', summaryDetails);
    }

    const completedAt = new Date(startedAt + durationMs);

    await options.telemetry?.record({
      requestedBy: input.requestedBy,
      recipients: recipients.length,
      delivered: deliveredCount,
      failed: failedCount,
      throttled429: throttledErrors,
      durationMs,
      startedAt: new Date(startedAt),
      completedAt,
      status: aborted && abortedError ? 'aborted' : 'ok',
      abortReason: abortedError?.reason,
      error: abortedError
        ? { name: abortedError.name, message: abortedError.message }
        : undefined,
      filters,
    });

    if (!aborted) {
      await deleteCheckpoint(options.progressKv, jobId, options.logger);
    }

    if (aborted && abortedError) {
      throw abortedError;
    }

    return {
      delivered: deliveredCount,
      failed: failedCount,
      deliveries,
      recipients: recipients.length,
      durationMs,
      source: resolved.source ?? null,
      sample: recipientsSample,
      throttled429: throttledErrors,
    } satisfies BroadcastSendResult;
  };
};

export const createImmediateBroadcastSender = (
  options: CreateImmediateBroadcastSenderOptions,
): SendBroadcast =>
  createBroadcastSender({
    messaging: options.messaging,
    messagingBroadcast: options.messagingBroadcast,
    resolveRecipients: () => {
      options.logger?.info?.('broadcast using env recipients', {
        filters: null,
        recipients: options.recipients.length,
      });

      return { recipients: options.recipients, source: 'env' } satisfies ResolveRecipientsResult;
    },
    logger: options.logger,
    pool: options.pool,
    telemetry: options.telemetry,
    emergencyStop: options.emergencyStop,
    maxTextLength: options.maxTextLength,
    progressKv: options.progressKv,
    progressTtlSeconds: options.progressTtlSeconds,
    batchSize: options.batchSize,
    maxBatchTextBytes: options.maxBatchTextBytes,
    jobIdGenerator: options.jobIdGenerator,
    onAdminNotification: options.onAdminNotification,
    watchdog: options.watchdog,
  });

export const createRegistryBroadcastSender = (
  options: CreateRegistryBroadcastSenderOptions,
): SendBroadcast => {
  const resolveRecipients = async (filters?: BroadcastAudienceFilter) => {
    const sanitizedFilters = filters
      ? (Object.fromEntries(
          (
            [
              ['chatIds', filters.chatIds],
              ['userIds', filters.userIds],
              ['languageCodes', filters.languageCodes],
            ] as const
          ).filter(([, value]) => value?.length),
        ) as BroadcastAudienceFilter)
      : undefined;

    try {
      const fromRegistry = await options.registry.listActiveRecipients(sanitizedFilters);
      if (fromRegistry.length > 0) {
        options.logger?.info?.('broadcast using registry recipients', {
          filters: sanitizedFilters ?? null,
          recipients: fromRegistry.length,
        });

        return { recipients: fromRegistry, source: 'D1' } satisfies ResolveRecipientsResult;
      }

      options.logger?.info?.('broadcast registry returned empty result', {
        filters: sanitizedFilters ?? null,
      });
    } catch (error) {
      options.logger?.warn?.('broadcast registry lookup failed', {
        error: toErrorDetails(error),
        filters: sanitizedFilters ?? null,
      });
    }

    options.logger?.warn?.('no broadcast recipients resolved', {
      filters: sanitizedFilters ?? null,
    });
    return { recipients: [], source: 'D1' } satisfies ResolveRecipientsResult;
  };

  return createBroadcastSender({
    messaging: options.messaging,
    messagingBroadcast: options.messagingBroadcast,
    resolveRecipients,
    logger: options.logger,
    pool: options.pool,
    telemetry: options.telemetry,
    emergencyStop: options.emergencyStop,
    maxTextLength: options.maxTextLength,
    progressKv: options.progressKv,
    progressTtlSeconds: options.progressTtlSeconds,
    batchSize: options.batchSize,
    maxBatchTextBytes: options.maxBatchTextBytes,
    jobIdGenerator: options.jobIdGenerator,
    onAdminNotification: options.onAdminNotification,
    watchdog: options.watchdog,
  });
};
