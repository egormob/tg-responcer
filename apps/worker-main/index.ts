import { composeWorker, type PortOverrides } from './composition';
import {
  createKvRateLimitAdapter,
  createD1StorageAdapter,
  createOpenAIResponsesAdapter,
  createTelegramMessagingAdapter,
  createQueuedMessagingPort,
  type MessagingQuotaSharedState,
  type D1Database,
  type RateLimitKvNamespace,
} from './adapters';
import {
  type AdminAccess,
  type AdminAccessKvNamespace,
  type CreateAdminAccessOptions,
  createAdminAccess,
  createAccessDiagnosticsRoute,
  createAdminExportRoute,
  createAdminCommandErrorRecorder,
  createCsvExportHandler,
  createExportRateDiagRoute,
  createExportRateTelemetry,
  createEnvzRoute,
  createBindingsDiagnosticsRoute,
  createAiQueueDiagRoute,
  createKnownUsersClearRoute,
  createD1StressRoute,
  createRegistryBroadcastSender,
  createRateLimitNotifier,
  createSelfTestRoute,
  readAdminWhitelist,
  createTelegramExportCommandHandler,
  createTelegramBroadcastCommandHandler,
  createTelegramWebhookHandler,
  type TelegramWebhookHandler,
  type AdminExportRateLimitKvNamespace,
  type ExportRateTelemetry,
  type LimitsFlagKvNamespace,
  type SendBroadcast,
  type AdminCommandErrorRecorder,
  type PendingBroadcast,
  type BroadcastPendingKvNamespace,
  createBroadcastRecipientsStore,
  createBroadcastRecipientsAdminHandlers,
  type BroadcastRecipientsStore,
  createBroadcastDiagRoute,
  createBroadcastTelemetry,
  type BroadcastTelemetry,
} from './features';
import {
  createRouter,
  createSystemCommandRegistry,
  createTypingIndicator,
  isCommandAllowedForRole,
  type DetermineSystemCommandRole,
  type RouterOptions,
  type TypingIndicator,
  type TelegramAdminCommandContext,
} from './http';
import type { AiQueueConfigSources, MessagingPort } from './ports';
import type { CompositionResult } from './composition';
import { parsePromptVariables } from './shared/prompt-variables';

interface WorkerBindings {
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_PROMPT_ID?: string;
  OPENAI_PROMPT_VARIABLES?: unknown;
  ADMIN_EXPORT_TOKEN?: string;
  ADMIN_EXPORT_FILENAME_PREFIX?: string;
  ADMIN_TOKEN?: string;
  ADMIN_TG_IDS?: AdminAccessKvNamespace & AdminExportRateLimitKvNamespace;
  ADMIN_EXPORT_KV?: AdminExportRateLimitKvNamespace;
  ADMIN_EXPORT_LOG?: KVNamespace;
  BROADCAST_RECIPIENTS_KV?: KVNamespace;
  BROADCAST_PENDING_KV?: BroadcastPendingKvNamespace;
  ADMIN_ACCESS_CACHE_TTL_MS?: string | number;
  BROADCAST_TELEMETRY_KV?: KVNamespace;
  BROADCAST_ENABLED?: string;
  BROADCAST_MAX_PARALLEL?: string | number;
  BROADCAST_MAX_RPS?: string | number;
  RATE_LIMIT_DAILY_LIMIT?: string | number;
  RATE_LIMIT_WINDOW_MS?: string | number;
  RATE_LIMIT_NOTIFIER_WINDOW_MS?: string | number;
  DB?: D1Database;
  RATE_LIMIT_KV?: WorkerRateLimitNamespace;
  STRESS_TEST_ENABLED?: unknown;
  AI_CONTROL_KV?: KVNamespace;
  AI_MAX_CONCURRENCY?: string | number;
  AI_QUEUE_MAX_SIZE?: string | number;
  AI_TIMEOUT_MS?: string | number;
  AI_RETRY_MAX?: string | number;
  AI_BASE_URLS?: string | string[];
  AI_ENDPOINT_FAILOVER_THRESHOLD?: string | number;
}

type WorkerRateLimitNamespace = LimitsFlagKvNamespace & RateLimitKvNamespace;

type WorkerEnv = WorkerBindings & {
  [key: string]: unknown;
};

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

const DEFAULT_RATE_LIMIT = 50;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

interface BroadcastRuntimeConfig {
  maxParallel: number;
  maxRps: number;
  emergencyStopRetryAfterMs: number;
  baseDelayMs: number;
  jitterRatio: number;
  rateJitterRatio: number;
}

const DEFAULT_AI_MAX_CONCURRENCY = 4;
const DEFAULT_AI_QUEUE_MAX_SIZE = 64;
const DEFAULT_AI_TIMEOUT_MS = 18_000;
const DEFAULT_AI_RETRY_MAX = 3;
const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_AI_ENDPOINT_FAILOVER_THRESHOLD = 3;
const DEFAULT_BROADCAST_MAX_PARALLEL = 4;
const DEFAULT_BROADCAST_MAX_RPS = 28;
const DEFAULT_BROADCAST_EMERGENCY_RETRY_AFTER_MS = 5_000;
const DEFAULT_BROADCAST_BASE_DELAY_MS = 1_000;
const DEFAULT_BROADCAST_JITTER_RATIO = 0.2;
const DEFAULT_BROADCAST_RATE_JITTER_RATIO = 0.1;

const toPositiveInteger = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
};

const toNonNegativeInteger = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
};

const toPositiveDurationMs = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
};

const toClampedRatio = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) {
      return undefined;
    }

    return Math.min(1, value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(1, parsed);
    }
  }

  return undefined;
};

const normalizeAiBaseUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return undefined;
    }

    parsed.hash = '';

    if (parsed.pathname !== '/v1/responses') {
      return undefined;
    }

    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
};

const parseAiBaseUrls = (value: unknown): string[] | undefined => {
  const toArray = (candidate: unknown): unknown[] | undefined => {
    if (Array.isArray(candidate)) {
      return candidate;
    }

    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length === 0) {
        return undefined;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // fall through to comma-separated format
      }

      const pieces = trimmed
        .split(',')
        .map((piece) => piece.trim())
        .filter((piece) => piece.length > 0);

      return pieces.length > 0 ? pieces : undefined;
    }

    return undefined;
  };

  const candidateArray = toArray(value);
  if (!candidateArray) {
    return undefined;
  }

  const normalized = candidateArray
    .map((entry) => normalizeAiBaseUrl(entry))
    .filter((entry): entry is string => typeof entry === 'string');

  const unique = [...new Set(normalized)];

  return unique.length > 0 ? unique : undefined;
};

const getTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readRateLimitConfig = (env: WorkerEnv): RateLimitConfig => ({
  limit: toPositiveInteger(env.RATE_LIMIT_DAILY_LIMIT) ?? DEFAULT_RATE_LIMIT,
  windowMs: toPositiveDurationMs(env.RATE_LIMIT_WINDOW_MS) ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
});

const readBroadcastRuntimeConfig = (env: WorkerEnv): BroadcastRuntimeConfig => {
  const maxParallel = toPositiveInteger(env.BROADCAST_MAX_PARALLEL)
    ?? DEFAULT_BROADCAST_MAX_PARALLEL;
  const maxRps = toPositiveInteger(env.BROADCAST_MAX_RPS) ?? DEFAULT_BROADCAST_MAX_RPS;
  const baseDelayMs = toPositiveDurationMs(env.BROADCAST_BASE_DELAY_MS)
    ?? DEFAULT_BROADCAST_BASE_DELAY_MS;
  const jitterRatio = toClampedRatio(env.BROADCAST_JITTER_RATIO)
    ?? DEFAULT_BROADCAST_JITTER_RATIO;
  const rateJitterRatio = toClampedRatio(env.BROADCAST_RATE_JITTER_RATIO)
    ?? DEFAULT_BROADCAST_RATE_JITTER_RATIO;
  const emergencyStopRetryAfterMs = Math.max(
    DEFAULT_BROADCAST_EMERGENCY_RETRY_AFTER_MS,
    Math.ceil((1000 / Math.max(1, maxRps)) * 5),
  );

  return {
    maxParallel,
    maxRps,
    emergencyStopRetryAfterMs,
    baseDelayMs,
    jitterRatio,
    rateJitterRatio,
  } satisfies BroadcastRuntimeConfig;
};

const isEnabledFlag = (value: unknown): boolean => {
  const trimmed = getTrimmedString(value);
  if (!trimmed) {
    return false;
  }

  switch (trimmed.toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'enabled':
      return true;
    default:
      return false;
  }
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readAiConcurrencyConfig = async (env: WorkerEnv): Promise<AiConcurrencyConfig> => {
  const kv = env.AI_CONTROL_KV;

  const readKvConfig = async (): Promise<Record<string, unknown> | undefined> => {
    if (!kv) {
      return undefined;
    }

    try {
      const raw = await kv.get('AI_QUEUE_CONFIG');
      if (typeof raw !== 'string') {
        return undefined;
      }

      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        return undefined;
      }

      const parsed = JSON.parse(trimmed) as unknown;
      if (!isObjectRecord(parsed)) {
        console.warn('[ai-config] AI_QUEUE_CONFIG must be a JSON object', { value: trimmed });
        return undefined;
      }

      return parsed;
    } catch (error) {
      console.error('[ai-config] failed to read AI_QUEUE_CONFIG', { error });
      return undefined;
    }
  };

  const kvConfig = await readKvConfig();
  const sources: AiQueueConfigSources = {
    maxConcurrency: 'default',
    maxQueueSize: 'default',
    requestTimeoutMs: 'default',
    retryMax: 'default',
    baseUrls: 'default',
    endpointFailoverThreshold: 'default',
    kvConfig: kvConfig ? 'AI_QUEUE_CONFIG' : null,
  };

  const setSource = (
    key: keyof Omit<AiQueueConfigSources, 'kvConfig'>,
    source: AiQueueConfigSources[keyof Omit<AiQueueConfigSources, 'kvConfig'>],
  ) => {
    sources[key] = source;
  };

  const setNumericSourceForKey = (
    key:
      | 'AI_MAX_CONCURRENCY'
      | 'AI_QUEUE_MAX_SIZE'
      | 'AI_TIMEOUT_MS'
      | 'AI_RETRY_MAX'
      | 'AI_ENDPOINT_FAILOVER_THRESHOLD',
    source: 'kv' | 'env' | 'default',
  ) => {
    if (key === 'AI_MAX_CONCURRENCY') {
      setSource('maxConcurrency', source);
    } else if (key === 'AI_QUEUE_MAX_SIZE') {
      setSource('maxQueueSize', source);
    } else if (key === 'AI_TIMEOUT_MS') {
      setSource('requestTimeoutMs', source);
    } else if (key === 'AI_RETRY_MAX') {
      setSource('retryMax', source);
    } else {
      setSource('endpointFailoverThreshold', source);
    }
  };

  const resolveValue = (
    key:
      | 'AI_MAX_CONCURRENCY'
      | 'AI_QUEUE_MAX_SIZE'
      | 'AI_TIMEOUT_MS'
      | 'AI_RETRY_MAX'
      | 'AI_ENDPOINT_FAILOVER_THRESHOLD',
    envValue: unknown,
    parser: (value: unknown) => number | undefined,
    fallback: number,
  ): number => {
    const kvCandidate = kvConfig ? kvConfig[key] : undefined;
    if (kvCandidate !== undefined) {
      const parsed = parser(kvCandidate);
      if (parsed !== undefined) {
        setNumericSourceForKey(key, 'kv');
        return parsed;
      }

      console.warn('[ai-config] invalid AI_QUEUE_CONFIG override', { key, value: kvCandidate });
    }

    const parsedEnv = parser(envValue);
    if (parsedEnv !== undefined) {
      setNumericSourceForKey(key, 'env');
      return parsedEnv;
    }

    if (envValue !== undefined && envValue !== null) {
      console.warn('[ai-config] invalid environment override', { key, value: envValue });
    }

    setNumericSourceForKey(key, 'default');
    return fallback;
  };

  const maxConcurrency = resolveValue(
    'AI_MAX_CONCURRENCY',
    env.AI_MAX_CONCURRENCY,
    toPositiveInteger,
    DEFAULT_AI_MAX_CONCURRENCY,
  );
  const maxQueueSize = resolveValue(
    'AI_QUEUE_MAX_SIZE',
    env.AI_QUEUE_MAX_SIZE,
    toNonNegativeInteger,
    DEFAULT_AI_QUEUE_MAX_SIZE,
  );
  const requestTimeoutMs = resolveValue(
    'AI_TIMEOUT_MS',
    env.AI_TIMEOUT_MS,
    toPositiveDurationMs,
    DEFAULT_AI_TIMEOUT_MS,
  );
  const retryMax = resolveValue(
    'AI_RETRY_MAX',
    env.AI_RETRY_MAX,
    toPositiveInteger,
    DEFAULT_AI_RETRY_MAX,
  );
  const endpointFailoverThreshold = resolveValue(
    'AI_ENDPOINT_FAILOVER_THRESHOLD',
    env.AI_ENDPOINT_FAILOVER_THRESHOLD,
    toPositiveInteger,
    DEFAULT_AI_ENDPOINT_FAILOVER_THRESHOLD,
  );

  const baseUrls = (() => {
    const kvCandidate = kvConfig
      ? ((kvConfig as Record<string, unknown>)['AI_BASE_URLS']
          ?? (kvConfig as Record<string, unknown>).aiBaseUrls)
      : undefined;
    if (kvCandidate !== undefined) {
      const parsed = parseAiBaseUrls(kvCandidate);
      if (parsed && parsed.length > 0) {
        setSource('baseUrls', 'kv');
        return parsed;
      }

      console.warn('[ai-config] invalid AI_QUEUE_CONFIG override', { key: 'AI_BASE_URLS', value: kvCandidate });
    }

    const envCandidate = env.AI_BASE_URLS;
    if (envCandidate !== undefined) {
      const parsed = parseAiBaseUrls(envCandidate);
      if (parsed && parsed.length > 0) {
        setSource('baseUrls', 'env');
        return parsed;
      }

      console.warn('[ai-config] invalid environment override', { key: 'AI_BASE_URLS', value: envCandidate });
    }

    setSource('baseUrls', 'default');
    return [DEFAULT_AI_BASE_URL];
  })();

  console.info('[ai][config]', {
    values: {
      maxConcurrency,
      maxQueueSize,
      requestTimeoutMs,
      retryMax,
      baseUrls,
      endpointFailoverThreshold,
    },
    sources,
  });

  return {
    maxConcurrency,
    maxQueueSize,
    requestTimeoutMs,
    retryMax,
    baseUrls,
    endpointFailoverThreshold,
    sources,
  };
};

const normalizePromptId = (value: unknown): string | undefined => {
  const trimmed = getTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }

  if (!/^pmpt_[A-Za-z0-9-]+$/.test(trimmed)) {
    console.error('[config] invalid OPENAI_PROMPT_ID', { promptId: trimmed });
    throw new Error('OPENAI_PROMPT_ID must start with "pmpt_" and refer to a published OpenAI prompt');
  }

  return trimmed;
};

interface AiConcurrencyConfig {
  readonly maxConcurrency: number;
  readonly maxQueueSize: number;
  readonly requestTimeoutMs: number;
  readonly retryMax: number;
  readonly baseUrls: ReadonlyArray<string>;
  readonly endpointFailoverThreshold: number;
  readonly sources: AiQueueConfigSources;
}

interface RuntimeConfig {
  readonly telegramBotToken: string;
  readonly openAi: {
    readonly apiKey: string;
    readonly model: string;
    readonly promptId?: string;
    readonly promptVariables?: Record<string, unknown>;
  };
}

const validateRuntimeConfig = (env: WorkerEnv): RuntimeConfig => {
  const apiKey = getTrimmedString(env.OPENAI_API_KEY);
  if (!apiKey) {
    console.error('[config] OPENAI_API_KEY is required');
    throw new Error('Missing OPENAI_API_KEY environment variable');
  }

  const model = getTrimmedString(env.OPENAI_MODEL);
  if (!model) {
    console.error('[config] OPENAI_MODEL is required');
    throw new Error('Missing OPENAI_MODEL environment variable');
  }

  const botToken = getTrimmedString(env.TELEGRAM_BOT_TOKEN);
  if (!botToken) {
    console.error('[config] TELEGRAM_BOT_TOKEN is required');
    throw new Error('Missing TELEGRAM_BOT_TOKEN environment variable');
  }

  const promptId = normalizePromptId(env.OPENAI_PROMPT_ID);
  const promptVariables = parsePromptVariables(env.OPENAI_PROMPT_VARIABLES);

  return {
    telegramBotToken: botToken,
    openAi: {
      apiKey,
      model,
      promptId,
      promptVariables,
    },
  };
};

const createPortOverrides = (
  env: WorkerEnv,
  runtime: RuntimeConfig,
  aiRuntime: AiConcurrencyConfig,
  rateLimitConfig: RateLimitConfig,
  broadcastRuntime: BroadcastRuntimeConfig,
): { overrides: Partial<PortOverrides>; broadcastMessaging: MessagingPort } => {
  const telegramMessaging = createTelegramMessagingAdapter({
    botToken: runtime.telegramBotToken,
  });

  const sharedQuotaState: MessagingQuotaSharedState = {
    queue: { high: [], normal: [] },
    active: 0,
    recentStarts: [],
    observedMaxQueue: 0,
  };

  const broadcastMessaging = createQueuedMessagingPort(telegramMessaging, {
    maxParallel: broadcastRuntime.maxParallel,
    maxRps: broadcastRuntime.maxRps,
    logger: console,
    sharedState: sharedQuotaState,
  });

  const dialogMessaging = createQueuedMessagingPort(telegramMessaging, {
    maxParallel: broadcastRuntime.maxParallel,
    maxRps: broadcastRuntime.maxRps,
    logger: console,
    priority: 'high',
    sharedState: sharedQuotaState,
  });

  const overrides: Partial<PortOverrides> = {
    messaging: dialogMessaging,
    ai: createOpenAIResponsesAdapter({
      apiKey: runtime.openAi.apiKey,
      model: runtime.openAi.model,
      promptId: runtime.openAi.promptId,
      promptVariables: runtime.openAi.promptVariables,
      baseUrls: [...aiRuntime.baseUrls],
      endpointFailoverThreshold: aiRuntime.endpointFailoverThreshold,
      runtime: aiRuntime,
      requestTimeoutMs: aiRuntime.requestTimeoutMs,
      maxRetries: aiRuntime.retryMax,
    }),
  };

  if (env.DB) {
    overrides.storage = createD1StorageAdapter({ db: env.DB });
  }

  if (env.RATE_LIMIT_KV) {
    overrides.rateLimit = createKvRateLimitAdapter({
      kv: env.RATE_LIMIT_KV,
      limit: rateLimitConfig.limit,
      windowMs: rateLimitConfig.windowMs,
    });
  }

  return { overrides, broadcastMessaging };
};

const createTypingIndicatorIfAvailable = (messagingPort: MessagingPort): TypingIndicator =>
  createTypingIndicator({
    messaging: messagingPort,
  });

const createRateLimitNotifierIfConfigured = (
  env: WorkerEnv,
  messagingPort: MessagingPort,
) => {
  if (!env.RATE_LIMIT_KV) {
    return undefined;
  }

  const limit = toPositiveInteger(env.RATE_LIMIT_DAILY_LIMIT) ?? DEFAULT_RATE_LIMIT;
  const windowMs = toPositiveDurationMs(env.RATE_LIMIT_NOTIFIER_WINDOW_MS)
    ?? toPositiveDurationMs(env.RATE_LIMIT_WINDOW_MS)
    ?? DEFAULT_RATE_LIMIT_WINDOW_MS;

  return createRateLimitNotifier({
    messaging: messagingPort,
    limit,
    windowMs,
  });
};

const createAdminAccessIfConfigured = (env: WorkerEnv): AdminAccess | undefined => {
  const adminAccessKv = env.ADMIN_TG_IDS;
  if (!adminAccessKv) {
    return undefined;
  }

  const cacheTtlMs = toNonNegativeInteger(env.ADMIN_ACCESS_CACHE_TTL_MS);
  const options: CreateAdminAccessOptions = { kv: adminAccessKv };

  if (cacheTtlMs !== undefined) {
    options.cacheTtlMs = cacheTtlMs;
  }

  return createAdminAccess(options);
};

const createAdminRoutes = (
  env: WorkerEnv,
  composition: CompositionResult,
  adminAccess: AdminAccess | undefined,
  adminErrorRecorder: AdminCommandErrorRecorder,
  knownUsers: TelegramWebhookHandler['knownUsers'],
  broadcastRecipientsStore: BroadcastRecipientsStore | undefined,
  exportRateTelemetry?: ExportRateTelemetry,
  broadcastTelemetry?: BroadcastTelemetry,
): RouterOptions['admin'] | undefined => {
  const adminToken = getTrimmedString(env.ADMIN_TOKEN);
  if (!adminToken) {
    return undefined;
  }

  const bindingsDiagRoute = createBindingsDiagnosticsRoute({
    storage: composition.ports.storage,
    env,
  });
  const aiQueueDiagRoute = createAiQueueDiagRoute({ ai: composition.ports.ai });
  const exportRateDiagRoute = createExportRateDiagRoute({ telemetry: exportRateTelemetry });
  const broadcastDiagRoute = createBroadcastDiagRoute({
    telemetry: broadcastTelemetry,
    progressKv: env.BROADCAST_PENDING_KV,
    now: () => Date.now(),
  });

  const routes: RouterOptions['admin'] = {
    token: adminToken,
    selfTest: createSelfTestRoute({
      ai: composition.ports.ai,
      messaging: composition.ports.messaging,
      storage: composition.ports.storage,
      getDefaultChatId:
        env.ADMIN_TG_IDS
          ? async () => {
              const snapshot = await readAdminWhitelist(env.ADMIN_TG_IDS);
              return snapshot.ids[0];
            }
          : undefined,
    }),
    envz: createEnvzRoute({ env }),
    accessDiagnostics: createAccessDiagnosticsRoute({
      env,
      composition,
      adminAccess,
      adminErrorRecorder,
    }),
    diag: async (request) => {
      const url = new URL(request.url);
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      if (query === 'ai-queue') {
        return aiQueueDiagRoute(request);
      }
      if (query === 'export-rate') {
        return exportRateDiagRoute(request);
      }
      if (query === 'broadcast') {
        return broadcastDiagRoute(request);
      }
      return bindingsDiagRoute(request);
    },
    knownUsersClear: createKnownUsersClearRoute({
      cache: knownUsers,
    }),
  };

  if (isEnabledFlag(env.STRESS_TEST_ENABLED) && env.DB) {
    routes.d1Stress = createD1StressRoute({
      storage: composition.ports.storage,
    });
  }

  const exportToken = getTrimmedString(env.ADMIN_EXPORT_TOKEN);
  if (exportToken && env.DB) {
    const handleExport = createCsvExportHandler({
      db: env.DB,
      filenamePrefix: env.ADMIN_EXPORT_FILENAME_PREFIX,
    });

    routes.export = createAdminExportRoute({
      adminToken: exportToken,
      handleExport,
    });
    routes.exportToken = exportToken;
  }

  if (broadcastRecipientsStore) {
    routes.broadcastRecipients = createBroadcastRecipientsAdminHandlers({
      store: broadcastRecipientsStore,
      logger: console,
    });
  }

  return routes;
};

const createTransformPayload = (
  env: WorkerEnv,
  composition: CompositionResult,
  adminAccess: AdminAccess | undefined,
  adminErrorRecorder: AdminCommandErrorRecorder,
  broadcastRegistry: BroadcastRecipientsStore | undefined,
  exportRateTelemetry?: ExportRateTelemetry,
  broadcastRuntime?: BroadcastRuntimeConfig,
  broadcastTelemetry?: BroadcastTelemetry,
  messagingBroadcast?: MessagingPort,
): TelegramWebhookHandler => {
  const botToken = getTrimmedString(env.TELEGRAM_BOT_TOKEN);
  const adminExportKv = env.ADMIN_EXPORT_KV ?? env.ADMIN_TG_IDS;
  const systemCommands = createSystemCommandRegistry();

  const csvExportHandler = env.DB
    ? createCsvExportHandler({
        db: env.DB,
        filenamePrefix: env.ADMIN_EXPORT_FILENAME_PREFIX,
      })
    : undefined;

  const exportCommandHandler = botToken && adminAccess && csvExportHandler
    ? createTelegramExportCommandHandler({
        botToken,
        adminAccess,
        handleExport: csvExportHandler,
        rateLimit: composition.ports.rawRateLimit,
        messaging: composition.ports.messaging,
        adminAccessKv: env.ADMIN_TG_IDS,
        cooldownKv: adminExportKv,
        exportLogKv: env.ADMIN_EXPORT_LOG,
        logger: console,
        now: () => new Date(),
        adminErrorRecorder,
        telemetry: exportRateTelemetry,
      })
    : undefined;

  const broadcastEnabled =
    !!broadcastRegistry
    && !!env.ADMIN_EXPORT_LOG
    && (typeof env.BROADCAST_ENABLED === 'undefined' ? true : isEnabledFlag(env.BROADCAST_ENABLED));
  const broadcastPendingStore = broadcastEnabled ? getBroadcastSessionStore(env) : undefined;

  const poolOverrides = broadcastRuntime
    ? {
        concurrency: broadcastRuntime.maxParallel,
        maxRps: broadcastRuntime.maxRps,
        baseDelayMs: broadcastRuntime.baseDelayMs,
        jitterRatio: broadcastRuntime.jitterRatio,
        rateJitterRatio: broadcastRuntime.rateJitterRatio,
      }
    : undefined;
  const emergencyStop = broadcastRuntime
    ? { retryAfterMs: broadcastRuntime.emergencyStopRetryAfterMs }
    : undefined;
  const broadcastSender: SendBroadcast | undefined = broadcastEnabled && broadcastRegistry
    ? createRegistryBroadcastSender({
        messaging: composition.ports.messaging,
        messagingBroadcast,
        registry: broadcastRegistry,
        logger: console,
        pool: poolOverrides,
        telemetry: broadcastTelemetry,
        emergencyStop,
        progressKv: env.BROADCAST_PENDING_KV,
        progressTtlSeconds: 24 * 60 * 60,
        onAdminNotification: async ({ adminChat, jobId, status, reason, checkpoint }) => {
          if (!adminChat) {
            return;
          }

          const statusLabel = status === 'paused' ? '⏸ Пауза' : '❌ Прервано';
          const stopReason = checkpoint?.reason ?? reason;
          const reasonLabel = stopReason.replaceAll('_', ' ');
          const remaining = checkpoint ? Math.max(0, checkpoint.total - checkpoint.offset) : null;
          const ttlSeconds = checkpoint?.expiresAt
            ? Math.max(0, Math.floor((new Date(checkpoint.expiresAt).getTime() - Date.now()) / 1000))
            : checkpoint?.ttlSeconds ?? null;

          const lines = [
            `${statusLabel}: jobId=${jobId}`,
            `Статус: ${checkpoint?.status ?? status}`,
            `Причина: ${reasonLabel}`,
            checkpoint
              ? `Прогресс: delivered=${checkpoint.delivered}, failed=${checkpoint.failed}, throttled429=${checkpoint.throttled429}`
              : null,
            checkpoint
              ? `Курсор: offset=${checkpoint.offset}/${checkpoint.total}${remaining !== null ? `, remaining=${remaining}` : ''}`
              : null,
            ttlSeconds !== null ? `TTL чекпоинта: ${ttlSeconds}s` : null,
            `Команды: /broadcast_resume ${jobId}, /broadcast_pause ${jobId}, /broadcast_status ${jobId}, /broadcast_end ${jobId}, /cancel_broadcast`,
          ].filter((line): line is string => Boolean(line));

          const message = lines.join('\n');

          await composition.ports.messaging.sendText({
            chatId: adminChat.chatId,
            threadId: adminChat.threadId,
            text: message,
          });
        },
      })
    : undefined;

  const broadcastCommandHandler = adminAccess && broadcastSender
    ? createTelegramBroadcastCommandHandler({
        adminAccess,
        messaging: composition.ports.messaging,
        sendBroadcast: broadcastSender,
        recipientsRegistry: broadcastRegistry,
        logger: console,
        now: () => new Date(),
        adminErrorRecorder,
        pendingStore: broadcastPendingStore,
        pendingKv: env.BROADCAST_PENDING_KV,
        exportLogKv: env.ADMIN_EXPORT_LOG,
      })
    : undefined;

  type AdminCommandHandler = (
    context: TelegramAdminCommandContext,
  ) => Promise<Response | void> | Response | void;

  const adminCommandHandlers: AdminCommandHandler[] = [];

  if (broadcastCommandHandler) {
    adminCommandHandlers.push(broadcastCommandHandler.handleCommand);
  }

  if (exportCommandHandler) {
    const handler: AdminCommandHandler = (context) => {
      const command = context.command.toLowerCase();

      if (command === '/export') {
        return exportCommandHandler(context);
      }

      if (command !== '/admin') {
        return undefined;
      }

      const argument = context.argument?.trim();
      if (!argument) {
        return exportCommandHandler(context);
      }

      const firstToken = argument.split(/\s+/)[0]?.toLowerCase();
      if (firstToken !== 'export' && firstToken !== 'status') {
        return undefined;
      }

      return exportCommandHandler(context);
    };

    adminCommandHandlers.push(handler);
  }

  const handleAdminCommand = adminCommandHandlers.length > 0
    ? async (context: TelegramAdminCommandContext) => {
        for (const handler of adminCommandHandlers) {
          const result = await handler(context);
          if (result !== undefined) {
            return result;
          }
        }

        return undefined;
      }
    : undefined;

  const webhookFeatures: Parameters<typeof createTelegramWebhookHandler>[0]['features'] | undefined =
    handleAdminCommand || broadcastCommandHandler
      ? {
          ...(handleAdminCommand ? { handleAdminCommand } : {}),
          ...(broadcastCommandHandler ? { handleMessage: broadcastCommandHandler.handleMessage } : {}),
        }
      : undefined;

  const telegramWebhookHandler = createTelegramWebhookHandler({
    storage: composition.ports.storage,
    botUsername: env.TELEGRAM_BOT_USERNAME,
    features: webhookFeatures,
    systemCommands,
  });

  return telegramWebhookHandler;
};

const createRequestHandler = async (env: WorkerEnv) => {
  const rateLimitConfig = readRateLimitConfig(env);
  const broadcastRuntime = readBroadcastRuntimeConfig(env);
  const exportRateTelemetry = createExportRateTelemetry({
    limit: rateLimitConfig.limit,
    windowMs: rateLimitConfig.windowMs,
  });
  const environmentVersion = getEnvironmentVersion(env);
  const broadcastTelemetry = createBroadcastTelemetry({
    logger: console,
    storage: env.BROADCAST_TELEMETRY_KV
      ? {
          kv: env.BROADCAST_TELEMETRY_KV,
          environment: environmentVersion === undefined ? 'default' : String(environmentVersion),
        }
      : undefined,
  });
  const runtime = validateRuntimeConfig(env);
  const aiRuntime = await readAiConcurrencyConfig(env);
  const { overrides: adapters, broadcastMessaging } = createPortOverrides(
    env,
    runtime,
    aiRuntime,
    rateLimitConfig,
    broadcastRuntime,
  );

  const composition = composeWorker({
    env: {
      TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET,
      RATE_LIMIT_KV: env.RATE_LIMIT_KV,
    },
    adapters,
  });

  const typingIndicator = createTypingIndicatorIfAvailable(composition.ports.messaging);

  const adminAccess = createAdminAccessIfConfigured(env);
  const determineCommandRole: DetermineSystemCommandRole | undefined = adminAccess
    ? async ({ match, message }) => {
        if (!isCommandAllowedForRole(match.descriptor, 'scoped')) {
          return undefined;
        }

        const isAdmin = await adminAccess.isAdmin(message.user.userId);
        return isAdmin ? 'scoped' : undefined;
      }
    : undefined;
  const adminErrorRecorder = createAdminCommandErrorRecorder({
    primaryKv: env.ADMIN_TG_IDS,
    fallbackKv: env.ADMIN_TG_IDS ? undefined : env.ADMIN_EXPORT_KV,
    logger: console,
    now: () => new Date(),
  });
  const broadcastRegistry = env.DB
    ? createBroadcastRecipientsStore({
        db: env.DB,
        cache: env.BROADCAST_RECIPIENTS_KV,
        logger: console,
      })
    : undefined;
  const transformPayload = createTransformPayload(
    env,
    composition,
    adminAccess,
    adminErrorRecorder,
    broadcastRegistry,
    exportRateTelemetry,
    broadcastRuntime,
    broadcastTelemetry,
    broadcastMessaging,
  );
  const adminRoutes = createAdminRoutes(
    env,
    composition,
    adminAccess,
    adminErrorRecorder,
    transformPayload.knownUsers,
    broadcastRegistry,
    exportRateTelemetry,
    broadcastTelemetry,
  );

  const router = createRouter({
    dialogEngine: composition.dialogEngine,
    messaging: composition.ports.messaging,
    webhookSecret: composition.webhookSecret,
    typingIndicator,
    rateLimitNotifier: createRateLimitNotifierIfConfigured(env, composition.ports.messaging),
    transformPayload,
    systemCommands: transformPayload.systemCommands,
    determineCommandRole,
    startDedupeKv: env.ADMIN_EXPORT_LOG,
    admin: adminRoutes,
  });

  return { router, transformPayload };
};

type RequestHandlerResult = Awaited<ReturnType<typeof createRequestHandler>>;

type RouterCacheEntry = RequestHandlerResult & { version?: string | number };

const CACHE_VERSION_KEYS = [
  'WORKER_VERSION',
  'ENV_VERSION',
  'ENVIRONMENT_VERSION',
  'CONFIG_VERSION',
  'CACHE_VERSION',
  'BINDINGS_VERSION',
];

const toCacheVersionValue = (value: unknown): string | number | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return undefined;
};

const getEnvironmentVersion = (env: WorkerEnv): string | number | undefined => {
  for (const key of CACHE_VERSION_KEYS) {
    const candidate = toCacheVersionValue((env as Record<string, unknown>)[key]);
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return undefined;
};

type RouterCacheValue = { version?: string | number; promise: Promise<RouterCacheEntry> };

let routerCache: WeakMap<WorkerEnv, RouterCacheValue> = new WeakMap();
type BroadcastSessionStore = Map<string, PendingBroadcast>;
let broadcastSessionStores: WeakMap<WorkerEnv, BroadcastSessionStore> = new WeakMap();

const getBroadcastSessionStore = (env: WorkerEnv): BroadcastSessionStore => {
  let store = broadcastSessionStores.get(env);
  if (!store) {
    store = new Map<string, PendingBroadcast>();
    broadcastSessionStores.set(env, store);
  }

  return store;
};

const clearBroadcastSessionStore = (env?: WorkerEnv) => {
  if (env) {
    broadcastSessionStores.delete(env);
    return;
  }

  broadcastSessionStores = new WeakMap();
};

const getCachedRequestHandler = async (env: WorkerEnv): Promise<RouterCacheEntry> => {
  const version = getEnvironmentVersion(env);
  const cached = routerCache.get(env);

  if (cached) {
    try {
      const entry = await cached.promise;
      if (cached.version === version && entry.version === version) {
        return entry;
      }
    } catch {
      // ignore errors from previous initialization attempts
    }
  }

  const promise = createRequestHandler(env).then((entry) => {
    const enriched: RouterCacheEntry = { ...entry, version };
    routerCache.set(env, { version, promise: Promise.resolve(enriched) });
    return enriched;
  });

  routerCache.set(env, { version, promise });
  return promise;
};

const clearRouterCache = (env?: WorkerEnv) => {
  if (env) {
    routerCache.delete(env);
    return;
  }

  routerCache = new WeakMap();
  clearBroadcastSessionStore();
};

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
    const { router } = await getCachedRequestHandler(env);
    return router.handle(request, ctx);
  },
};

export const __internal = {
  parsePromptVariables,
  clearRouterCache,
  clearBroadcastSessionStore,
};
