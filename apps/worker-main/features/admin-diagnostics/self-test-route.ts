import type { AiPort, MessagingPort, StoragePort } from '../../ports';
import { json } from '../../shared/json-response';
import {
  getLastTelegramUpdateSnapshot,
  noteTelegramSnapshot,
  recordTelegramSnapshotAction,
} from '../../http/telegram-webhook';
import { ensureTelegramSnapshotIntegrity } from './telegram-id-guard';

export interface CreateSelfTestRouteOptions {
  ai: AiPort;
  messaging: MessagingPort;
  storage?: StoragePort;
  now?: () => number;
  getDefaultChatId?: () => Promise<string | undefined>;
}

const defaultNow = () => Date.now();

const formatError = (scope: string, reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  return `${scope}: ${message}`;
};

export const createSelfTestRoute = (options: CreateSelfTestRouteOptions) => {
  const now = options.now ?? defaultNow;
  const storage = options.storage;

  const runUtmDiagnostics = async (): Promise<Response> => {
    if (!storage) {
      return json(
        {
          test: 'utm',
          ok: false,
          errors: ['storage: adapter is not configured'],
        },
        { status: 500 },
      );
    }

    const timestamp = now();
    const userId = `admin:selftest:utm:${timestamp.toString(36)}`;
    const updatedAt = new Date(timestamp);
    const errors: string[] = [];

    let saveOutcome: { utmDegraded: boolean } | undefined;
    try {
      saveOutcome = await storage.saveUser({
        userId,
        utmSource: 'src_SELFTEST',
        metadata: { scope: 'selftest', feature: 'utm' },
        updatedAt,
      });
      // eslint-disable-next-line no-console
      console.info('[admin:selftest][utm] saveUser result', {
        userId,
        utmDegraded: saveOutcome.utmDegraded,
      });
    } catch (error) {
      errors.push(formatError('storage.saveUser', error));
    }

    let readOk = false;
    if (errors.length === 0) {
      try {
        const messages = await storage.getRecentMessages({ userId, limit: 1 });
        readOk = Array.isArray(messages);
      } catch (error) {
        errors.push(formatError('storage.getRecentMessages', error));
      }
    }

    const ok = errors.length === 0 && saveOutcome?.utmDegraded === false;
    const payload: Record<string, unknown> = {
      test: 'utm',
      ok,
      saveOk: saveOutcome !== undefined && errors.length === 0,
      readOk,
      utmDegraded: saveOutcome?.utmDegraded ?? true,
      errors,
    };

    payload.lastWebhookSnapshot = getLastTelegramUpdateSnapshot();

    if (ok) {
      // eslint-disable-next-line no-console
      console.info('[admin:selftest][utm] completed', { userId });
    }

    return json(payload, { status: ok ? 200 : 500 });
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return json(
        { error: 'Method Not Allowed' },
        { status: 405 },
      );
    }

    await ensureTelegramSnapshotIntegrity();

    const url = new URL(request.url);
    const query = url.searchParams.get('q');

    if (query?.toLowerCase() === 'utm') {
      return runUtmDiagnostics();
    }

    const chatIdParamRaw = url.searchParams.get('chatId') ?? url.searchParams.get('chat_id');
    const chatIdParam = typeof chatIdParamRaw === 'string' ? chatIdParamRaw.trim() : undefined;
    const threadIdParam = url.searchParams.get('threadId') ?? url.searchParams.get('thread_id') ?? undefined;
    const textParam = url.searchParams.get('text') ?? 'Self-test ping';

    const errors: string[] = [];

    let openAiOk = false;
    let openAiLatencyMs: number | undefined;
    let openAiUsedOutputText: boolean | undefined;

    const aiStartedAt = now();
    try {
      const reply = await options.ai.reply({
        userId: 'admin:selftest',
        text: 'ping',
        context: [],
      });
      openAiLatencyMs = Math.max(0, now() - aiStartedAt);
      const metadata = reply.metadata as
        | {
            usedOutputText?: unknown;
            selfTestNoop?: unknown;
          }
        | undefined;
      const usedOutputTextRaw = metadata?.usedOutputText;
      openAiUsedOutputText = usedOutputTextRaw === true;

      if (metadata?.selfTestNoop === true) {
        errors.push('openai: noop adapter response');
      } else if (usedOutputTextRaw !== true) {
        errors.push('openai: missing diagnostic marker');
      } else {
        openAiOk = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`openai: ${message}`);
    }

    let telegramOk = false;
    let telegramLatencyMs: number | undefined;
    let telegramMessageId: string | undefined;
    let telegramStatus: number | undefined;
    let telegramDescription: string | undefined;
    let telegramChatId: string | undefined;
    let telegramChatIdSource: 'query' | 'whitelist' | undefined;

    if (chatIdParam && chatIdParam.length > 0) {
      telegramChatId = chatIdParam;
      telegramChatIdSource = 'query';
    } else if (options.getDefaultChatId) {
      try {
        const fallbackChatId = await options.getDefaultChatId();
        if (typeof fallbackChatId === 'string') {
          const trimmedFallback = fallbackChatId.trim();
          if (trimmedFallback.length > 0) {
            telegramChatId = trimmedFallback;
            telegramChatIdSource = 'whitelist';
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`telegram: failed to resolve admin chatId (${message})`);
      }
    }

    if (!telegramChatId) {
      errors.push('telegram: chatId query parameter is required and whitelist is empty');
    } else {
      const telegramStartedAt = now();
      const snapshotContext = {
        route: 'admin' as const,
        chatIdRaw: chatIdParamRaw ?? telegramChatId,
        chatIdUsed: telegramChatId,
      };

      noteTelegramSnapshot({
        ...snapshotContext,
        resetMessaging: true,
        failSoft: false,
      });

      const recordFailure = (
        action: 'sendTyping' | 'sendText',
        error: unknown,
      ) => {
        const statusCandidate = (error as { status?: unknown }).status;
        const descriptionCandidate = (error as { description?: unknown }).description;
        recordTelegramSnapshotAction({
          ...snapshotContext,
          action,
          ok: false,
          statusCode: typeof statusCandidate === 'number' ? statusCandidate : null,
          description:
            typeof descriptionCandidate === 'string' && descriptionCandidate.trim().length > 0
              ? descriptionCandidate
              : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      };

      let sendTypingCompleted = false;

      try {
        await options.messaging.sendTyping({
          chatId: telegramChatId,
          threadId: threadIdParam ?? undefined,
        });

        recordTelegramSnapshotAction({
          ...snapshotContext,
          action: 'sendTyping',
          ok: true,
          statusCode: 200,
          description: 'OK',
        });

        sendTypingCompleted = true;

        const result = await options.messaging.sendText({
          chatId: telegramChatId,
          threadId: threadIdParam ?? undefined,
          text: textParam,
        });

        recordTelegramSnapshotAction({
          ...snapshotContext,
          action: 'sendText',
          ok: true,
          statusCode: 200,
          description: 'OK',
        });

        telegramOk = true;
        telegramLatencyMs = Math.max(0, now() - telegramStartedAt);
        telegramMessageId = result.messageId;
        telegramStatus = 200;
        telegramDescription = 'OK';
      } catch (error) {
        recordFailure(sendTypingCompleted ? 'sendText' : 'sendTyping', error);
        const message = error instanceof Error ? error.message : String(error);
        const status = (error as { status?: unknown }).status;
        const description = (error as { description?: unknown }).description;

        if (typeof status === 'number' && Number.isFinite(status)) {
          telegramStatus = status;
        }

        if (typeof description === 'string' && description.trim().length > 0) {
          telegramDescription = description;
        }

        if (telegramDescription === undefined) {
          telegramDescription = message;
        }

        errors.push(`telegram: ${message}`);
      }
    }

    const responseBody: Record<string, unknown> = {
      openAiOk,
      telegramOk,
      errors,
    };

    if (openAiLatencyMs !== undefined) {
      responseBody.openAiLatencyMs = openAiLatencyMs;
    }

    if (openAiUsedOutputText !== undefined) {
      responseBody.openAiUsedOutputText = openAiUsedOutputText;
    }

    if (telegramLatencyMs !== undefined) {
      responseBody.telegramLatencyMs = telegramLatencyMs;
    }

    if (telegramMessageId !== undefined) {
      responseBody.telegramMessageId = telegramMessageId;
    }

    if (telegramStatus !== undefined) {
      responseBody.telegramStatus = telegramStatus;
    }

    if (telegramDescription !== undefined) {
      responseBody.telegramDescription = telegramDescription;
    }

    if (telegramChatId !== undefined) {
      responseBody.telegramChatId = telegramChatId;
    }

    if (telegramChatIdSource !== undefined) {
      responseBody.telegramChatIdSource = telegramChatIdSource;
    }

    const hasErrors = errors.length > 0;

    responseBody.lastWebhookSnapshot = getLastTelegramUpdateSnapshot();

    return json(responseBody, { status: hasErrors ? 500 : 200 });
  };
};
