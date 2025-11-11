import type { AiPort, ConversationTurn, MessagingPort, StoragePort } from '../../ports';
import { json } from '../../shared/json-response';
import {
  getLastTelegramUpdateSnapshot,
  noteTelegramSnapshot,
  recordTelegramSnapshotAction,
} from '../../http/telegram-webhook';
import { applyTelegramIdLogFields, toTelegramIdString } from '../../http/telegram-ids';
import { ensureTelegramSnapshotIntegrity } from './telegram-id-guard';

export interface CreateSelfTestRouteOptions {
  ai: AiPort;
  messaging: MessagingPort;
  storage?: StoragePort;
  now?: () => number;
  getDefaultChatId?: () => Promise<string | undefined>;
}

const defaultNow = () => Date.now();

export const OPENAI_SELF_TEST_MARKER = '[[tg-responcer:selftest:openai-ok]]';

export const OPENAI_SELF_TEST_PROMPT_TEXT =
  'tg-responcer diagnostic ping. Reply with a short acknowledgement and append the exact marker.';

export const OPENAI_SELF_TEST_CONTEXT: ReadonlyArray<ConversationTurn> = [
  {
    role: 'system',
    text: [
      'You are running a health-check for the tg-responcer Telegram bot.',
      `Respond with a concise acknowledgement such as "pong" and append the exact marker ${OPENAI_SELF_TEST_MARKER} once at the end.`,
      'Do not add markdown, code fences, or additional explanations.',
      'If you must report a problem, include the marker after the message.',
    ].join(' '),
  },
];

const formatError = (scope: string, reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  return `${scope}: ${message}`;
};

export const createSelfTestRoute = (options: CreateSelfTestRouteOptions) => {
  const now = options.now ?? defaultNow;
  const storage = options.storage;

  const createSample = (text: string | undefined): string | undefined => {
    if (!text) {
      return undefined;
    }

    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length === 0) {
      return undefined;
    }

    const limit = 160;
    if (normalized.length <= limit) {
      return normalized;
    }

    return `${normalized.slice(0, limit - 1)}…`;
  };

  const runUtmDiagnostics = async (): Promise<Response> => {
    if (!storage) {
      return json(
        {
          test: 'utm',
          ok: false,
          errors: ['storage: adapter is not configured'],
        },
        { status: 200 },
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

    return json(payload, { status: 200 });
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
    let openAiReason: string | undefined;
    let openAiSample: string | undefined;
    let openAiResponseId: string | undefined;

    const stripMarker = (text: string | undefined): string | undefined => {
      if (typeof text !== 'string') {
        return undefined;
      }

      return text.replaceAll(OPENAI_SELF_TEST_MARKER, '');
    };

    const normalizeSample = (text: string | undefined) => createSample(stripMarker(text));

    let openAiMarkerDetected = false;

    const aiStartedAt = now();
    try {
      const reply = await options.ai.reply({
        userId: 'admin:selftest',
        text: OPENAI_SELF_TEST_PROMPT_TEXT,
        context: OPENAI_SELF_TEST_CONTEXT,
      });
      openAiLatencyMs = Math.max(0, now() - aiStartedAt);
      const metadata = reply.metadata as
        | {
            usedOutputText?: unknown;
            selfTestNoop?: unknown;
            responseId?: unknown;
          }
        | undefined;
      const usedOutputTextRaw = metadata?.usedOutputText;
      openAiUsedOutputText = usedOutputTextRaw === true;

      if (typeof metadata?.responseId === 'string') {
        const trimmed = metadata.responseId.trim();
        if (trimmed.length > 0) {
          openAiResponseId = trimmed;
        }
      }

      if (typeof reply.text === 'string') {
        openAiMarkerDetected = reply.text.includes(OPENAI_SELF_TEST_MARKER);
      }

      if (metadata?.selfTestNoop === true) {
        errors.push('openai: noop adapter response');
        openAiReason = 'noop_adapter_response';
      } else if (!openAiMarkerDetected) {
        openAiReason = 'missing_diagnostic_marker';
        openAiSample = normalizeSample(reply.text);
      } else if (usedOutputTextRaw !== true) {
        openAiReason = 'marker_in_fallback_output';
        openAiSample = normalizeSample(reply.text);
      } else {
        openAiOk = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`openai: ${message}`);
      openAiReason = 'request_failed';
    }

    let telegramOk = false;
    let telegramLatencyMs: number | undefined;
    let telegramMessageId: string | undefined;
    let telegramStatus: number | undefined;
    let telegramDescription: string | undefined;
    let telegramChatId: string | undefined;
    let telegramChatIdSource: 'query' | 'whitelist' | undefined;
    let telegramReason: 'chat_id_missing' | 'send_failed' | undefined;

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
      telegramReason = 'chat_id_missing';
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
        telegramReason = 'send_failed';
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

    responseBody.lastWebhookSnapshot = getLastTelegramUpdateSnapshot();

    if (openAiReason && !openAiOk) {
      responseBody.openAiReason = openAiReason;
    }

    if (openAiSample && !openAiOk) {
      responseBody.openAiSample = openAiSample;
    }

    if (openAiResponseId !== undefined) {
      responseBody.openAiResponseId = openAiResponseId;
    }

    if (telegramReason && !telegramOk) {
      responseBody.telegramReason = telegramReason;
    }

    const openAiLog: Record<string, unknown> = {
      scope: 'admin:selftest',
      check: 'openai',
      ok: openAiOk,
    };

    if (openAiReason) {
      openAiLog.reason = openAiReason;
    }

    if (openAiLatencyMs !== undefined) {
      openAiLog.latencyMs = openAiLatencyMs;
    }

    if (openAiResponseId) {
      openAiLog.responseId = openAiResponseId;
    }

    if (!openAiOk && openAiSample) {
      openAiLog.sample = openAiSample;
    }

    // eslint-disable-next-line no-console
    console.info('[admin:selftest][openai]', openAiLog);

    const telegramLog: Record<string, unknown> = {
      scope: 'admin:selftest',
      check: 'telegram',
      ok: telegramOk,
      route: 'admin',
    };

    if (chatIdParamRaw !== null) {
      telegramLog.chatIdRawType = typeof chatIdParamRaw;
    } else {
      telegramLog.chatIdRawType = 'missing';
    }

    applyTelegramIdLogFields(telegramLog, 'chatIdRaw', chatIdParamRaw, { includeValue: false });
    applyTelegramIdLogFields(telegramLog, 'chatIdNormalized', toTelegramIdString(telegramChatId), {
      includeValue: false,
    });

    if (telegramChatIdSource) {
      telegramLog.chatIdSource = telegramChatIdSource;
    }

    if (telegramStatus !== undefined) {
      telegramLog.status = telegramStatus;
    }

    if (telegramDescription) {
      telegramLog.description = telegramDescription;
    }

    if (telegramReason) {
      telegramLog.reason = telegramReason;
    }

    if (telegramLatencyMs !== undefined) {
      telegramLog.latencyMs = telegramLatencyMs;
    }

    // eslint-disable-next-line no-console
    console.info('[admin:selftest][telegram]', telegramLog);

    return json(responseBody, { status: 200 });
  };
};
