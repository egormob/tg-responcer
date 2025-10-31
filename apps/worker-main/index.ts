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
  createAdminExportRoute,
  createCsvExportHandler,
  createRateLimitNotifier,
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

interface WorkerBindings {
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  OPENAI_API_KEY?: string;
  OPENAI_ASSISTANT_ID?: string;
  ADMIN_EXPORT_TOKEN?: string;
  ADMIN_EXPORT_FILENAME_PREFIX?: string;
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

const createPortOverrides = (env: WorkerEnv): Partial<PortOverrides> => {
  const overrides: Partial<PortOverrides> = {};

  if (typeof env.TELEGRAM_BOT_TOKEN === 'string' && env.TELEGRAM_BOT_TOKEN.length > 0) {
    overrides.messaging = createTelegramMessagingAdapter({
      botToken: env.TELEGRAM_BOT_TOKEN,
    });
  }

  if (
    typeof env.OPENAI_API_KEY === 'string'
    && env.OPENAI_API_KEY.length > 0
    && typeof env.OPENAI_ASSISTANT_ID === 'string'
    && env.OPENAI_ASSISTANT_ID.length > 0
  ) {
    overrides.ai = createOpenAIResponsesAdapter({
      apiKey: env.OPENAI_API_KEY,
      assistantId: env.OPENAI_ASSISTANT_ID,
    });
  }

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

const createAdminRoutes = (env: WorkerEnv) => {
  if (!env.ADMIN_EXPORT_TOKEN || !env.DB) {
    return undefined;
  }

  const handleExport = createCsvExportHandler({
    db: env.DB,
    filenamePrefix: env.ADMIN_EXPORT_FILENAME_PREFIX,
  });

  return {
    export: createAdminExportRoute({
      adminToken: env.ADMIN_EXPORT_TOKEN,
      handleExport,
    }),
  } satisfies RouterOptions['admin'];
};

const createTransformPayload = (env: WorkerEnv) => (payload: unknown) =>
  transformTelegramUpdate(payload, {
    botUsername: env.TELEGRAM_BOT_USERNAME,
  });

const createRequestHandler = (env: WorkerEnv) => {
  const adapters = createPortOverrides(env);

  const composition = composeWorker({
    env: {
      TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET,
      RATE_LIMIT_KV: env.RATE_LIMIT_KV,
    },
    adapters,
  });

  const typingIndicator = createTypingIndicatorIfAvailable(composition.ports.messaging);

  const router = createRouter({
    dialogEngine: composition.dialogEngine,
    messaging: composition.ports.messaging,
    webhookSecret: composition.webhookSecret,
    typingIndicator,
    rateLimitNotifier: createRateLimitNotifierIfConfigured(env, composition.ports.messaging),
    transformPayload: createTransformPayload(env),
    admin: createAdminRoutes(env),
  });

  return router;
};

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
    void ctx;
    const router = createRequestHandler(env);
    return router.handle(request);
  },
};
