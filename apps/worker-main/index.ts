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
  createEnvzRoute,
  createRateLimitNotifier,
  createSelfTestRoute,
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

interface WorkerBindings {
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_PROMPT_ID?: string;
  OPENAI_PROMPT_VARIABLES?: string;
  ADMIN_EXPORT_TOKEN?: string;
  ADMIN_EXPORT_FILENAME_PREFIX?: string;
  ADMIN_TOKEN?: string;
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

const getTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

const parsePromptVariables = (value: unknown): Record<string, unknown> | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const raw = getTrimmedString(value);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('[config] OPENAI_PROMPT_VARIABLES must be a JSON object', {
        type: Array.isArray(parsed) ? 'array' : typeof parsed,
      });
      throw new Error('OPENAI_PROMPT_VARIABLES must be a JSON object');
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[config] failed to parse OPENAI_PROMPT_VARIABLES', { error: message });
    throw new Error('OPENAI_PROMPT_VARIABLES must be valid JSON');
  }
};

const createPortOverrides = (env: WorkerEnv): Partial<PortOverrides> => {
  const overrides: Partial<PortOverrides> = {};

  if (typeof env.TELEGRAM_BOT_TOKEN === 'string' && env.TELEGRAM_BOT_TOKEN.length > 0) {
    overrides.messaging = createTelegramMessagingAdapter({
      botToken: env.TELEGRAM_BOT_TOKEN,
    });
  }

  const apiKey = getTrimmedString(env.OPENAI_API_KEY);
  const model = getTrimmedString(env.OPENAI_MODEL);

  if (apiKey && model) {
    const promptId = normalizePromptId(env.OPENAI_PROMPT_ID);
    const promptVariables = parsePromptVariables(env.OPENAI_PROMPT_VARIABLES);

    overrides.ai = createOpenAIResponsesAdapter({
      apiKey,
      model,
      promptId,
      promptVariables,
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

const createAdminRoutes = (
  env: WorkerEnv,
  composition: CompositionResult,
): RouterOptions['admin'] | undefined => {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.trim().length === 0) {
    return undefined;
  }

  const routes: RouterOptions['admin'] = {
    token: env.ADMIN_TOKEN,
    selfTest: createSelfTestRoute({ ai: composition.ports.ai }),
    envz: createEnvzRoute({ env }),
  };

  if (env.ADMIN_EXPORT_TOKEN && env.DB) {
    const handleExport = createCsvExportHandler({
      db: env.DB,
      filenamePrefix: env.ADMIN_EXPORT_FILENAME_PREFIX,
    });

    routes.export = createAdminExportRoute({
      adminToken: env.ADMIN_EXPORT_TOKEN,
      handleExport,
    });
    routes.exportToken = env.ADMIN_EXPORT_TOKEN;
  }

  return routes;
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
    admin: createAdminRoutes(env, composition),
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
