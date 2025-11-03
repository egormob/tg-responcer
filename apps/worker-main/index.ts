import { composeWorker, type PortOverrides } from './composition';
import {
  createKvRateLimitAdapter,
  createD1StorageAdapter,
  createOpenAIResponsesAdapter,
  createTelegramMessagingAdapter,
  type D1Database,
  type RateLimitKvNamespace,
} from './adapters';
import {
  createAdminBroadcastRoute,
  createAdminExportRoute,
  createBroadcastScheduler,
  createCsvExportHandler,
  createEnvzRoute,
  createInMemoryBroadcastProgressStore,
  createInMemoryBroadcastQueue,
  createRateLimitNotifier,
  createSelfTestRoute,
  type BroadcastJob,
  type BroadcastScheduler,
  type LimitsFlagKvNamespace,
} from './features';
import {
  createRouter,
  createTypingIndicator,
  transformTelegramUpdate,
  type RouterOptions,
  type TypingIndicator,
} from './http';
import type { MessagingPort } from './ports';
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
  ADMIN_BROADCAST_TOKEN?: string;
  BROADCAST_ENABLED?: string;
  RATE_LIMIT_DAILY_LIMIT?: string | number;
  RATE_LIMIT_WINDOW_MS?: string | number;
  RATE_LIMIT_NOTIFIER_WINDOW_MS?: string | number;
  DB?: D1Database;
  RATE_LIMIT_KV?: WorkerRateLimitNamespace;
}

type WorkerRateLimitNamespace = LimitsFlagKvNamespace & RateLimitKvNamespace;

type WorkerEnv = WorkerBindings & {
  [key: string]: unknown;
};

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

const broadcastQueue = createInMemoryBroadcastQueue();
const broadcastProgressStore = createInMemoryBroadcastProgressStore();

const DEFAULT_RATE_LIMIT = 20;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

const toPositiveInteger = (value: string | number | undefined): number | undefined => {
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

const toPositiveDurationMs = (value: string | number | undefined): number | undefined => {
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

const getTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
): Partial<PortOverrides> => {
  const overrides: Partial<PortOverrides> = {
    messaging: createTelegramMessagingAdapter({
      botToken: runtime.telegramBotToken,
    }),
    ai: createOpenAIResponsesAdapter(runtime.openAi),
  };

  if (env.DB) {
    overrides.storage = createD1StorageAdapter({ db: env.DB });
  }

  if (env.RATE_LIMIT_KV) {
    const limit = toPositiveInteger(env.RATE_LIMIT_DAILY_LIMIT) ?? DEFAULT_RATE_LIMIT;
    const windowMs = toPositiveDurationMs(env.RATE_LIMIT_WINDOW_MS) ?? DEFAULT_RATE_LIMIT_WINDOW_MS;

    overrides.rateLimit = createKvRateLimitAdapter({
      kv: env.RATE_LIMIT_KV,
      limit,
      windowMs,
    });
  }

  return overrides;
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

const createAdminRoutes = (
  env: WorkerEnv,
  composition: CompositionResult,
): RouterOptions['admin'] | undefined => {
  const adminToken = getTrimmedString(env.ADMIN_TOKEN);
  if (!adminToken) {
    return undefined;
  }

  const routes: RouterOptions['admin'] = {
    token: adminToken,
    selfTest: createSelfTestRoute({
      ai: composition.ports.ai,
      messaging: composition.ports.messaging,
    }),
    envz: createEnvzRoute({ env }),
  };

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

  const broadcastToken = getTrimmedString(env.ADMIN_BROADCAST_TOKEN) ?? adminToken;
  if (isEnabledFlag(env.BROADCAST_ENABLED) && broadcastToken) {
    routes.broadcast = createAdminBroadcastRoute({
      adminToken: broadcastToken,
      queue: broadcastQueue,
    });
    routes.broadcastToken = broadcastToken;
  }

  return routes;
};

const resolveBroadcastRecipientsFromJob = (job: BroadcastJob) => {
  const filters = job.payload.filters;
  const chatIds = filters?.chatIds ?? [];

  if (chatIds.length === 0) {
    throw new Error('Broadcast job requires filters.chatIds until audience resolver is implemented');
  }

  if ((filters?.userIds?.length ?? 0) > 0 || (filters?.languageCodes?.length ?? 0) > 0) {
    console.warn('[broadcast] ignoring unsupported audience selectors', {
      userIds: filters?.userIds?.length ?? 0,
      languageCodes: filters?.languageCodes?.length ?? 0,
    });
  }

  return chatIds.map((chatId) => ({ chatId }));
};

const createTransformPayload = (env: WorkerEnv) => (payload: unknown) =>
  transformTelegramUpdate(payload, {
    botUsername: env.TELEGRAM_BOT_USERNAME,
  });

interface RequestHandlerResult {
  router: ReturnType<typeof createRouter>;
  scheduler?: BroadcastScheduler;
}

const createRequestHandler = (env: WorkerEnv): RequestHandlerResult => {
  const runtime = validateRuntimeConfig(env);
  const adapters = createPortOverrides(env, runtime);

  const composition = composeWorker({
    env: {
      TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET,
      RATE_LIMIT_KV: env.RATE_LIMIT_KV,
    },
    adapters,
  });

  const typingIndicator = createTypingIndicatorIfAvailable(composition.ports.messaging);

  const adminRoutes = createAdminRoutes(env, composition);

  const router = createRouter({
    dialogEngine: composition.dialogEngine,
    messaging: composition.ports.messaging,
    webhookSecret: composition.webhookSecret,
    typingIndicator,
    rateLimitNotifier: createRateLimitNotifierIfConfigured(env, composition.ports.messaging),
    transformPayload: createTransformPayload(env),
    admin: adminRoutes,
  });

  const scheduler = adminRoutes?.broadcast
    ? createBroadcastScheduler({
        queue: broadcastQueue,
        messaging: composition.ports.messaging,
        progressStore: broadcastProgressStore,
        resolveRecipients: resolveBroadcastRecipientsFromJob,
      })
    : undefined;

  return { router, scheduler };
};

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
    const { router, scheduler } = createRequestHandler(env);
    const response = await router.handle(request);

    if (scheduler && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(scheduler.processPendingJobs());
    }

    return response;
  },
};

export const __internal = {
  parsePromptVariables,
};
