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
  type AdminAccess,
  type AdminAccessKvNamespace,
  type CreateAdminAccessOptions,
  createAdminAccess,
  createAccessDiagnosticsRoute,
  createAdminExportRoute,
  createCsvExportHandler,
  createEnvzRoute,
  createImmediateBroadcastSender,
  createRateLimitNotifier,
  createSelfTestRoute,
  createTelegramExportCommandHandler,
  createTelegramBroadcastCommandHandler,
  createTelegramWebhookHandler,
  type AdminExportRateLimitKvNamespace,
  type CreateImmediateBroadcastSenderOptions,
  type LimitsFlagKvNamespace,
  type SendBroadcast,
} from './features';
import {
  createRouter,
  createTypingIndicator,
  transformTelegramUpdate,
  type RouterOptions,
  type TypingIndicator,
  type TelegramAdminCommandContext,
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
  ADMIN_TG_IDS?: AdminAccessKvNamespace & AdminExportRateLimitKvNamespace;
  ADMIN_EXPORT_KV?: AdminExportRateLimitKvNamespace;
  ADMIN_EXPORT_LOG?: KVNamespace;
  ADMIN_ACCESS_CACHE_TTL_MS?: string | number;
  BROADCAST_ENABLED?: string;
  BROADCAST_RECIPIENTS?: string;
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

const DEFAULT_RATE_LIMIT = 50;
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

const toNonNegativeInteger = (value: string | number | undefined): number | undefined => {
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

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseBroadcastRecipients = (
  value: unknown,
): CreateImmediateBroadcastSenderOptions['recipients'] => {
  if (value === undefined || value === null) {
    return [];
  }

  let source: unknown = value;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return [];
    }

    try {
      source = JSON.parse(trimmed);
    } catch (error) {
      const details = error instanceof Error ? { name: error.name, message: error.message } : { error: String(error) };
      console.warn('[broadcast] failed to parse BROADCAST_RECIPIENTS value', details);
      return [];
    }
  }

  if (!Array.isArray(source)) {
    console.warn('[broadcast] BROADCAST_RECIPIENTS must be an array of strings or objects');
    return [];
  }

  const recipients: CreateImmediateBroadcastSenderOptions['recipients'] = [];
  const seen = new Set<string>();

  for (const item of source) {
    if (typeof item === 'string') {
      const chatId = item.trim();
      if (!chatId) {
        continue;
      }

      const key = `${chatId}:`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      recipients.push({ chatId });
      continue;
    }

    if (isObjectRecord(item)) {
      const chatIdValue = typeof item.chatId === 'string' ? item.chatId.trim() : undefined;
      if (!chatIdValue) {
        continue;
      }

      const threadIdValue =
        typeof item.threadId === 'string' ? item.threadId.trim() : undefined;
      const key = `${chatIdValue}:${threadIdValue ?? ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      recipients.push({ chatId: chatIdValue, threadId: threadIdValue });
    }
  }

  return recipients;
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
    accessDiagnostics: createAccessDiagnosticsRoute({
      env,
      composition,
      adminAccess,
    }),
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

  return routes;
};

const createTransformPayload = (
  env: WorkerEnv,
  composition: CompositionResult,
  adminAccess: AdminAccess | undefined,
) => {
  const botToken = getTrimmedString(env.TELEGRAM_BOT_TOKEN);
  const adminExportKv = env.ADMIN_EXPORT_KV ?? env.ADMIN_TG_IDS;

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
        rateLimit: composition.ports.rateLimit,
        messaging: composition.ports.messaging,
        adminAccessKv: env.ADMIN_TG_IDS,
        cooldownKv: adminExportKv,
        exportLogKv: env.ADMIN_EXPORT_LOG,
        logger: console,
        now: () => new Date(),
      })
    : undefined;

  const broadcastEnabled = isEnabledFlag(env.BROADCAST_ENABLED);
  const broadcastRecipients = broadcastEnabled ? parseBroadcastRecipients(env.BROADCAST_RECIPIENTS) : [];

  if (broadcastEnabled && broadcastRecipients.length === 0) {
    console.warn('[broadcast] BROADCAST_RECIPIENTS is empty; broadcasts will not deliver messages');
  }

  const broadcastSender: SendBroadcast | undefined = broadcastEnabled
    ? createImmediateBroadcastSender({
        messaging: composition.ports.messaging,
        recipients: broadcastRecipients,
        logger: console,
      })
    : undefined;

  const broadcastCommandHandler = adminAccess && broadcastSender
    ? createTelegramBroadcastCommandHandler({
        adminAccess,
        messaging: composition.ports.messaging,
        sendBroadcast: broadcastSender,
        logger: console,
        now: () => new Date(),
      })
    : undefined;

  type AdminCommandHandler = (
    context: TelegramAdminCommandContext,
  ) => Promise<Response | void> | Response | void;

  const adminCommandHandlers: AdminCommandHandler[] = [];

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

  if (broadcastCommandHandler) {
    adminCommandHandlers.push(broadcastCommandHandler.handleCommand);
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
  });

  return (payload: unknown) => telegramWebhookHandler(payload);
};

const createRequestHandler = (env: WorkerEnv) => {
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

  const adminAccess = createAdminAccessIfConfigured(env);
  const adminRoutes = createAdminRoutes(env, composition, adminAccess);

  return createRouter({
    dialogEngine: composition.dialogEngine,
    messaging: composition.ports.messaging,
    webhookSecret: composition.webhookSecret,
    typingIndicator,
    rateLimitNotifier: createRateLimitNotifierIfConfigured(env, composition.ports.messaging),
    transformPayload: createTransformPayload(env, composition, adminAccess),
    admin: adminRoutes,
  });
};

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: WorkerExecutionContext): Promise<Response> {
    const router = createRequestHandler(env);
    return router.handle(request);
  },
};

export const __internal = {
  parsePromptVariables,
};
