import { DialogEngine, type IncomingMessage } from '../core';
import type { MessagingPort } from '../ports';
import type { TypingIndicator } from './typing-indicator';
import { safeWebhookHandler } from './safe-webhook';
import {
  recordTelegramSnapshotAction,
  type TelegramSnapshotRoute,
} from './telegram-webhook';
import { applyTelegramIdLogFields, describeTelegramIdForLogs } from './telegram-ids';
import { parseTelegramUpdateBody } from './telegram-payload';
import {
  createSystemCommandRegistry,
  isCommandAllowedForRole,
  matchSystemCommand,
  type SystemCommandDescriptor,
  type SystemCommandMatch,
  type SystemCommandRegistry,
  type SystemCommandRole,
} from './system-commands';
import {
  createAdminCommandInvalidUsageHandler,
  createAdminStatusCommandHandler,
  createStartCommandHandler,
  type RouterCommandHandler,
  type StartCommandDedupe,
  type StartCommandHandlerOptions,
} from './system-command-handlers';

export const RATE_LIMIT_FALLBACK_TEXT = '🥶⌛️ Лимит ответов исчерпан. Попробуйте позже.';

const USER_ERROR_TEXT = 'Ой… 🧐 …';
const ADMIN_ROLE_MISMATCH_TEXT = 'Эта команда доступна только администратору';
const ADMIN_COMMAND_EXAMPLES: readonly string[] = [
  '/admin status — проверить доступ администратора',
  '/admin export 2024-05-01 2024-05-07 — выгрузить историю диалогов',
  '/broadcast Привет — отправить мгновенную рассылку',
];

const formatAdminUsageMessage = (examples?: readonly string[]): string => {
  if (!examples || examples.length === 0) {
    return USER_ERROR_TEXT;
  }

  const lines = [USER_ERROR_TEXT, 'Примеры админ-команд:'];
  for (const example of examples) {
    lines.push(`• ${example}`);
  }

  return lines.join('\n');
};

interface DefaultSystemCommandHandlersOptions {
  startCommandOptions?: StartCommandHandlerOptions;
}

const createDefaultSystemCommandHandlers = (
  options?: DefaultSystemCommandHandlersOptions,
): Map<string, RouterCommandHandler> =>
  new Map([
    ['/start', createStartCommandHandler(options?.startCommandOptions)],
    ['/admin status', createAdminStatusCommandHandler()],
    ['/admin', createAdminCommandInvalidUsageHandler(ADMIN_COMMAND_EXAMPLES)],
  ]);

const START_DEDUP_TTL_SECONDS = 60;
const START_DEDUP_TTL_MS = START_DEDUP_TTL_SECONDS * 1000;
type StartDedupeKvNamespace = Pick<KVNamespace, 'get' | 'put'>;

const createStartDedupeStore = (kv?: StartDedupeKvNamespace): StartCommandDedupe => {
  const memoryCache = new Map<string, number>();

  const cleanup = (now: number) => {
    for (const [key, expiresAt] of memoryCache.entries()) {
      if (expiresAt <= now) {
        memoryCache.delete(key);
      }
    }
  };

  return {
    async shouldProcess(updateId?: string | number | null) {
      if (updateId === undefined || updateId === null) {
        return true;
      }

      const key = `dedup:start:${String(updateId)}`;
      const now = Date.now();
      cleanup(now);

      const expiresAt = memoryCache.get(key);
      if (expiresAt && expiresAt > now) {
        return false;
      }

      if (kv) {
        try {
          const existing = await kv.get(key);
          if (existing !== null) {
            memoryCache.set(key, now + START_DEDUP_TTL_MS);
            return false;
          }

          await kv.put(key, '1', { expirationTtl: START_DEDUP_TTL_SECONDS });
          memoryCache.set(key, now + START_DEDUP_TTL_MS);
          return true;
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[router] start dedupe KV failed, falling back to memory', {
            updateId: key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      memoryCache.set(key, now + START_DEDUP_TTL_MS);
      return true;
    },
  };
};

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isIncomingMessageCandidate = (value: unknown): value is IncomingMessage => {
  if (!isRecord(value)) {
    return false;
  }

  const { user, chat, text, receivedAt } = value;

  if (!isRecord(user) || typeof user.userId !== 'string') {
    return false;
  }

  if (!isRecord(chat) || typeof chat.id !== 'string') {
    return false;
  }

  if (typeof text !== 'string') {
    return false;
  }

  return receivedAt instanceof Date;
};

export interface HandledWebhookResult {
  kind: 'handled';
  response?: Response;
}

export interface MessageWebhookResult {
  kind: 'message';
  message: IncomingMessage;
  chatIdRaw?: unknown;
  chatIdNormalized?: string;
  fromId?: unknown;
  messageId?: string;
  route?: string;
}

export interface NonTextWebhookResult {
  kind: 'non_text';
  chat: { id: string; threadId?: string };
  reply: 'media' | 'voice';
}

export type TransformPayloadResult =
  | IncomingMessage
  | HandledWebhookResult
  | MessageWebhookResult
  | NonTextWebhookResult;

export interface TransformPayloadContext {
  waitUntil?(promise: Promise<unknown>): void;
}

export type TransformPayload = (
  payload: unknown,
  context?: TransformPayloadContext,
) => TransformPayloadResult | Promise<TransformPayloadResult>;

type TransformPayloadWithCommands = TransformPayload & {
  systemCommands?: SystemCommandRegistry;
};

export interface DetermineCommandRoleContext {
  match: SystemCommandMatch;
  message: IncomingMessage;
}

export type DetermineSystemCommandRole = (
  context: DetermineCommandRoleContext,
) => Promise<SystemCommandRole | undefined> | SystemCommandRole | undefined;

const isHandledWebhookResult = (value: unknown): value is HandledWebhookResult =>
  isRecord(value) && value.kind === 'handled';

const isMessageWebhookResult = (value: unknown): value is MessageWebhookResult =>
  isRecord(value) && value.kind === 'message' && isIncomingMessageCandidate(value.message);

const isNonTextWebhookResult = (value: unknown): value is NonTextWebhookResult =>
  isRecord(value) &&
  value.kind === 'non_text' &&
  isRecord(value.chat) &&
  typeof value.chat.id === 'string' &&
  (value.chat.threadId === undefined || typeof value.chat.threadId === 'string') &&
  (value.reply === 'media' || value.reply === 'voice');

const toOptionalString = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.length > 0 ? value : undefined);

const parseDate = (value: unknown): Date => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return new Date();
};

const extractUpdateId = (payload: unknown): string | number | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }

  const raw = (payload as Record<string, unknown>).update_id;

  if (typeof raw === 'string') {
    return raw;
  }

  if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
    return raw;
  }

  return undefined;
};

type MessagingAction = 'sendText' | 'sendTyping';

interface MessagingLogDetails {
  action: MessagingAction;
  route: string;
  updateId?: string | number;
  chatIdRaw?: unknown;
  chatIdNormalized?: string;
  fromId?: unknown;
  messageId?: string;
  snapshotRoute?: TelegramSnapshotRoute;
}

const createMessagingLogFields = (details: MessagingLogDetails) => {
  const log: Record<string, unknown> = {
    action: details.action,
    route: details.route,
  };

  if (details.updateId !== undefined) {
    log.updateId = details.updateId;
  }

  if (details.chatIdRaw !== undefined) {
    log.chatIdRawType = typeof details.chatIdRaw;
    if (typeof details.chatIdRaw === 'string' || typeof details.chatIdRaw === 'bigint') {
      applyTelegramIdLogFields(log, 'chatIdRaw', details.chatIdRaw, { includeValue: false });
    }
  }

  if (details.chatIdNormalized) {
    applyTelegramIdLogFields(log, 'chatIdNormalized', details.chatIdNormalized, {
      includeValue: false,
    });
  }

  if (details.fromId !== undefined) {
    applyTelegramIdLogFields(log, 'fromId', details.fromId, { includeValue: false });
  }

  if (details.messageId !== undefined) {
    applyTelegramIdLogFields(log, 'messageId', details.messageId, { includeValue: false });
  }

  return log;
};

const logMessagingCall = async <T>(
  details: MessagingLogDetails,
  call: () => Promise<T>,
): Promise<T> => {
  const log = createMessagingLogFields(details);
  const snapshotRoute: TelegramSnapshotRoute = details.snapshotRoute ?? 'user';
  const emitTelemetryLog = (
    status: number | null,
    outcome: 'ok' | 'error',
    errorMessage?: string,
  ) => {
    const statusLabel = typeof status === 'number' && Number.isFinite(status) ? status : 'error';
    const payload: Record<string, unknown> = {
      ...log,
      outcome,
    };
    if (typeof status === 'number' && Number.isFinite(status)) {
      payload.statusCode = status;
    }
    if (errorMessage) {
      payload.error = errorMessage;
    }

    // eslint-disable-next-line no-console
    console.info(`[telegram] ${details.action} status=${statusLabel}`, payload);
  };
  try {
    const result = await call();
    emitTelemetryLog(200, 'ok');
    const successSnapshot: Parameters<typeof recordTelegramSnapshotAction>[0] = {
      action: details.action,
      route: snapshotRoute,
      updateId: details.updateId,
      ok: true,
      statusCode: 200,
      description: 'OK',
    };
    if (details.chatIdRaw !== undefined) {
      successSnapshot.chatIdRaw = details.chatIdRaw;
    }
    if (details.chatIdNormalized !== undefined) {
      successSnapshot.chatIdUsed = details.chatIdNormalized;
    }
    recordTelegramSnapshotAction(successSnapshot);
    return result;
  } catch (error) {
    const statusCandidate = (error as { status?: unknown }).status;
    const descriptionCandidate = (error as { description?: unknown }).description;
    const statusCode = typeof statusCandidate === 'number' ? statusCandidate : null;
    emitTelemetryLog(statusCode, 'error', error instanceof Error ? error.message : String(error));

    // eslint-disable-next-line no-console
    console.error(`[router][${details.action}] error`, {
      ...log,
      status: 'error',
      error: String(error),
    });
    const failureSnapshot: Parameters<typeof recordTelegramSnapshotAction>[0] = {
      action: details.action,
      route: snapshotRoute,
      updateId: details.updateId,
      ok: false,
      statusCode,
      description:
        typeof descriptionCandidate === 'string' && descriptionCandidate.trim().length > 0
          ? descriptionCandidate
          : undefined,
      error: error instanceof Error ? error.message : String(error),
    };
    if (details.chatIdRaw !== undefined) {
      failureSnapshot.chatIdRaw = details.chatIdRaw;
    }
    if (details.chatIdNormalized !== undefined) {
      failureSnapshot.chatIdUsed = details.chatIdNormalized;
    }
    recordTelegramSnapshotAction(failureSnapshot);
    throw error;
  }
};

export const parseIncomingMessage = (payload: unknown): IncomingMessage => {
  if (!isRecord(payload)) {
    throw new Error('Payload must be an object');
  }

  const { user, chat, text } = payload;

  if (!isRecord(user) || typeof user.userId !== 'string') {
    throw new Error('Invalid user payload');
  }

  if (!isRecord(chat) || typeof chat.id !== 'string') {
    throw new Error('Invalid chat payload');
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Text is required');
  }

  const threadId = toOptionalString(chat.threadId);
  const messageId = toOptionalString(payload.messageId);
  const receivedAt = parseDate(payload.receivedAt);

  return {
    user: {
      userId: user.userId,
      username: toOptionalString(user.username),
      firstName: toOptionalString(user.firstName),
      lastName: toOptionalString(user.lastName),
      languageCode: toOptionalString(user.languageCode),
      metadata: isRecord(user.metadata) ? user.metadata : undefined,
    },
    chat: {
      id: chat.id,
      threadId,
    },
    text,
    messageId,
    receivedAt,
  };
};

export interface RouterOptions {
  dialogEngine: DialogEngine;
  messaging: MessagingPort;
  webhookSecret?: string;
  transformPayload?: TransformPayload;
  systemCommands?: SystemCommandRegistry;
  determineCommandRole?: DetermineSystemCommandRole;
  typingIndicator?: TypingIndicator;
  rateLimitNotifier?: {
    notify(input: {
      userId: string;
      chatId: string;
      threadId?: string;
    }): Promise<{ handled: boolean }>;
  };
  startDedupeKv?: StartDedupeKvNamespace;
  admin?: {
    token: string;
    exportToken?: string;
    export?: (request: Request) => Promise<Response>;
    selfTest?: (request: Request) => Promise<Response>;
    envz?: (request: Request) => Promise<Response>;
    accessDiagnostics?: (request: Request) => Promise<Response>;
    diag?: (request: Request) => Promise<Response>;
    knownUsersClear?: (request: Request) => Promise<Response>;
    d1Stress?: (request: Request) => Promise<Response>;
    broadcastRecipients?: {
      list: (request: Request) => Promise<Response>;
      upsert: (request: Request) => Promise<Response>;
      deactivate: (request: Request, chatId: string) => Promise<Response>;
    };
  };
}

const normalizePath = (pathname: string) => pathname.replace(/\/$/, '');

const extractWebhookSecret = (pathname: string): string | undefined => {
  const segments = normalizePath(pathname)
    .split('/')
    .filter(Boolean);

  if (segments.length === 2 && segments[0] === 'webhook') {
    return decodeURIComponent(segments[1] ?? '');
  }

  return undefined;
};

export interface RouterHandleContext {
  waitUntil?(promise: Promise<unknown>): void;
}

export const createRouter = (options: RouterOptions) => {
  const defaultSystemCommands = createSystemCommandRegistry();
  const startDedupeStore = createStartDedupeStore(options.startDedupeKv);
  const systemCommandHandlers = createDefaultSystemCommandHandlers({
    startCommandOptions: { dedupe: startDedupeStore },
  });
  const defaultTransformPayload: TransformPayloadWithCommands = Object.assign(
    async (payload: unknown) => parseIncomingMessage(payload),
    { systemCommands: defaultSystemCommands },
  );

  const transformPayload = (options.transformPayload ?? defaultTransformPayload) as TransformPayloadWithCommands;
  const systemCommands =
    options.systemCommands ?? transformPayload.systemCommands ?? defaultSystemCommands;

  const handleHealthz = () => jsonResponse({ status: 'ok' });
  const handleNotFound = () => new Response('Not Found', { status: 404 });

  const unauthorizedResponse = (message: string, status: number) =>
    jsonResponse(
      { error: message },
      { status },
    );

  const ensureAdminAuthorization = (
    request: Request,
    url: URL,
    allowedTokens: string[] = [options.admin?.token ?? ''],
  ):
  | { ok: true; request: Request }
  | { ok: false; response: Response } => {
    if (!options.admin?.token) {
      return { ok: false, response: handleNotFound() };
    }

    const headerToken = request.headers.get('x-admin-token');
    const queryToken = url.searchParams.get('token');

    const validTokens = allowedTokens.filter((token) => token && token.length > 0);

    if (validTokens.length === 0) {
      return { ok: false, response: unauthorizedResponse('Invalid admin token', 403) };
    }

    if (!headerToken && !queryToken) {
      return { ok: false, response: unauthorizedResponse('Missing admin token', 401) };
    }

    if (headerToken && validTokens.includes(headerToken)) {
      return { ok: true, request };
    }

    if (queryToken && validTokens.includes(queryToken)) {
      if (headerToken === queryToken) {
        return { ok: true, request };
      }

      const headers = new Headers(request.headers);
      headers.set('x-admin-token', queryToken);
      const authorizedRequest = new Request(request, { headers });
      return { ok: true, request: authorizedRequest };
    }

    return { ok: false, response: unauthorizedResponse('Invalid admin token', 403) };
  };

  const handleWebhook = async (
    request: Request,
    url: URL,
    context?: RouterHandleContext,
  ) => {
    if (!options.webhookSecret) {
      return new Response('Webhook secret is not configured', { status: 500 });
    }

    const providedSecret = extractWebhookSecret(url.pathname);

    if (!providedSecret) {
      return new Response('Not Found', { status: 404 });
    }

    if (providedSecret !== options.webhookSecret) {
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let payload: unknown;
    let updateId: string | number | undefined;
    try {
      const rawBody = await request.text();
      payload = parseTelegramUpdateBody(rawBody);
      updateId = extractUpdateId(payload);
    } catch (error) {
      return new Response('Invalid JSON payload', { status: 400 });
    }

    let message: IncomingMessage;
    let messageLogDetails: MessagingLogDetails | undefined;
    try {
      const transformed = await transformPayload(payload, context);

      if (isHandledWebhookResult(transformed)) {
        return (
          transformed.response ?? jsonResponse({ status: 'ignored' }, { status: 200 })
        );
      }

      if (isNonTextWebhookResult(transformed)) {
        const text = transformed.reply === 'voice' ? '🔇  👉📝' : '🖼️❌  👉📝';
        try {
          await logMessagingCall(
            {
              action: 'sendText',
              route: transformed.reply === 'voice' ? 'non_text_voice' : 'non_text_media',
              updateId,
              chatIdNormalized: transformed.chat.id,
            },
            () =>
              options.messaging.sendText({
                chatId: transformed.chat.id,
                threadId: transformed.chat.threadId,
                text,
              }),
          );
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[router] failed to send non-text reminder', error);
        }
        return jsonResponse({ status: 'ignored' }, { status: 200 });
      }

      if (isMessageWebhookResult(transformed)) {
        message = transformed.message;
        messageLogDetails = {
          action: 'sendText',
          route: transformed.route ?? 'message',
          updateId,
          chatIdRaw: transformed.chatIdRaw,
          chatIdNormalized: transformed.chatIdNormalized ?? transformed.message.chat.id,
          fromId: transformed.fromId ?? transformed.message.user.userId,
          messageId: transformed.messageId ?? transformed.message.messageId,
        };
      } else if (isIncomingMessageCandidate(transformed)) {
        message = transformed;
        messageLogDetails = {
          action: 'sendText',
          route: 'incoming_message',
          updateId,
          chatIdNormalized: transformed.chat.id,
          fromId: transformed.user.userId,
          messageId: transformed.messageId,
        };
      } else {
        throw new Error('Transform payload returned invalid result');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Invalid payload';
      return new Response(reason, { status: 400 });
    }

    const maybeHandleSystemCommand = async (): Promise<Response | undefined> => {
      const matchResult = matchSystemCommand(message.text, message, systemCommands);
      if (!matchResult) {
        return undefined;
      }

      const describedUser = describeTelegramIdForLogs(message.user.userId);

      const logRoleDiagnostics = (
        route: 'system_command_role_mismatch' | 'system_command_unauthorized',
        commandName: string,
        descriptor: SystemCommandDescriptor,
        determineResult: SystemCommandRole | 'not_configured' | undefined,
      ) => {
        const logPayload: Record<string, unknown> = {
          command: commandName,
          expectedRoles: descriptor.roles,
          determineCommandRole: determineResult ?? 'undefined',
          systemCommandRegistered: systemCommands.isAllowed(commandName, message.user.userId),
        };
        if (updateId !== undefined) {
          logPayload.updateId = updateId;
        }
        if (describedUser) {
          logPayload.userIdHash = describedUser.hash;
          logPayload.userIdLength = describedUser.length;
        }

        // eslint-disable-next-line no-console
        console.info('[router] system command role diagnostics', { ...logPayload, route });
      };

      const handleImmediateRoleMismatch = async (
        route: 'system_command_role_mismatch' | 'system_command_unauthorized',
        commandName: string,
      ) => {
        const logPayload: Record<string, unknown> = {
          command: commandName,
        };
        if (updateId !== undefined) {
          logPayload.updateId = updateId;
        }
        applyTelegramIdLogFields(logPayload, 'chatId', message.chat.id, { includeValue: false });
        applyTelegramIdLogFields(logPayload, 'fromId', message.user.userId, { includeValue: false });

        // eslint-disable-next-line no-console
        console.info('[router] system command role mismatch', { ...logPayload, route });

        try {
          await logMessagingCall(
            {
              action: 'sendTyping',
              route,
              updateId,
              chatIdNormalized: message.chat.id,
              fromId: message.user.userId,
              messageId: message.messageId,
            },
            () =>
              options.messaging.sendTyping({
                chatId: message.chat.id,
                threadId: message.chat.threadId,
              }),
          );
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[router] failed to send role mismatch typing indicator', error);
        }

        const unauthorizedLog = messageLogDetails
          ? { ...messageLogDetails, route }
          : {
              action: 'sendText' as const,
              route,
              updateId,
              chatIdNormalized: message.chat.id,
              fromId: message.user.userId,
              messageId: message.messageId,
            };

        await logMessagingCall(unauthorizedLog, () =>
          options.messaging.sendText({
            chatId: message.chat.id,
            threadId: message.chat.threadId,
            text: ADMIN_ROLE_MISMATCH_TEXT,
          }),
        );

        return jsonResponse({ status: 'ok', messageId: null });
      };

      if (matchResult.kind === 'role_mismatch' && typeof options.determineCommandRole !== 'function') {
        logRoleDiagnostics(
          'system_command_role_mismatch',
          matchResult.command,
          matchResult.descriptor,
          'not_configured',
        );
        return handleImmediateRoleMismatch('system_command_role_mismatch', matchResult.command);
      }

      const resolveCommandRole = async (
        match: SystemCommandMatch,
      ): Promise<SystemCommandRole | undefined> => {
        if (isCommandAllowedForRole(match.descriptor, 'global')) {
          return 'global';
        }

        if (typeof options.determineCommandRole === 'function') {
          return options.determineCommandRole({ match, message });
        }

        return undefined;
      };

      let matchedCommand: SystemCommandMatch;
      if (matchResult.kind === 'match') {
        matchedCommand = matchResult.match;
      } else {
        matchedCommand = { command: matchResult.command, descriptor: matchResult.descriptor };

        const role = await resolveCommandRole(matchedCommand);
        if (!role || !isCommandAllowedForRole(matchedCommand.descriptor, role)) {
          if (isCommandAllowedForRole(matchedCommand.descriptor, 'scoped')) {
            logRoleDiagnostics(
              'system_command_unauthorized',
              matchedCommand.command,
              matchedCommand.descriptor,
              role,
            );
            return handleImmediateRoleMismatch('system_command_unauthorized', matchedCommand.command);
          }

          return undefined;
        }

        if (
          role === 'scoped' &&
          typeof message.user.userId === 'string' &&
          message.user.userId.length > 0
        ) {
          systemCommands.register(matchedCommand.command, message.user.userId);
        }
      }

      const handler = systemCommandHandlers.get(matchedCommand.command);
      if (!handler) {
        return jsonResponse({ status: 'ok', messageId: null });
      }

      const sendSystemCommandText = async (payload: { text: string; route: string }) => {
        const logDetails = messageLogDetails
          ? { ...messageLogDetails, route: payload.route }
          : {
              action: 'sendText' as const,
              route: payload.route,
              updateId,
              chatIdNormalized: message.chat.id,
              fromId: message.user.userId,
              messageId: message.messageId,
            };

        const sendResult = await logMessagingCall(logDetails, () =>
          options.messaging.sendText({
            chatId: message.chat.id,
            threadId: message.chat.threadId,
            text: payload.text,
          }),
        );

        return sendResult.messageId ?? null;
      };

      const handlerResult = await handler({
        match: matchedCommand,
        message,
        sendText: sendSystemCommandText,
        updateId,
      });

      if (handlerResult.kind === 'handled') {
        return jsonResponse({
          status: 'ok',
          messageId: handlerResult.messageId ?? null,
        });
      }

      if (handlerResult.kind === 'invalid_usage') {
        await sendSystemCommandText({
          text: formatAdminUsageMessage(handlerResult.examples),
          route: 'system_command_invalid_usage',
        });

        return jsonResponse({ status: 'ok', messageId: null });
      }

      return jsonResponse({ status: 'ok', messageId: null });
    };

    const systemCommandResponse = await maybeHandleSystemCommand();
    if (systemCommandResponse) {
      return systemCommandResponse;
    }

    const runDialog = async () => {
      const executeDialog = () => options.dialogEngine.handleMessage(message);

      const dialogResult = options.typingIndicator
        ? await options.typingIndicator.runWithTyping(
            { chatId: message.chat.id, threadId: message.chat.threadId },
            executeDialog,
          )
        : await executeDialog();

      if (dialogResult.status === 'rate_limited') {
        let rateLimitHandled = false;

        if (options.rateLimitNotifier) {
          try {
            const notificationResult = await options.rateLimitNotifier.notify({
              userId: message.user.userId,
              chatId: message.chat.id,
              threadId: message.chat.threadId,
            });

            rateLimitHandled = notificationResult?.handled === true;
          } catch (error) {
            // eslint-disable-next-line no-console
            console.warn('[router] rate limit notifier failed', error);
          }
        }

        if (!rateLimitHandled) {
          try {
            await logMessagingCall(
              {
                ...(messageLogDetails ?? {
                  action: 'sendText',
                  route: 'rate_limit_fallback',
                  updateId,
                  chatIdNormalized: message.chat.id,
                  fromId: message.user.userId,
                  messageId: message.messageId,
                }),
                route: 'rate_limit_fallback',
              },
              () =>
                options.messaging.sendText({
                  chatId: message.chat.id,
                  threadId: message.chat.threadId,
                  text: RATE_LIMIT_FALLBACK_TEXT,
                }),
            );
          } catch (error) {
            // eslint-disable-next-line no-console
            console.warn('[router] failed to send rate limit fallback', error);
          }
        }
      }

      return dialogResult;
    };

    return safeWebhookHandler({
      chat: { id: message.chat.id, threadId: message.chat.threadId },
      messaging: options.messaging,
      run: runDialog,
      mapResult: async (result) => {
        if (result.status === 'rate_limited') {
          return { body: { status: 'rate_limited' } };
        }

        return {
          body: {
            status: 'ok',
            messageId: result.response.messageId ?? null,
          },
        };
      },
    });
  };

  return {
    async handle(request: Request, context?: RouterHandleContext): Promise<Response> {
      const url = new URL(request.url);
      const pathname = normalizePath(url.pathname);

      if (request.method === 'GET' && pathname === '/healthz') {
        return handleHealthz();
      }

      if (pathname.startsWith('/webhook')) {
        return handleWebhook(request, url, context);
      }

      if (pathname === '/admin/export') {
        if (!options.admin?.export) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(
          request,
          url,
          [options.admin.exportToken, options.admin.token].filter(
            (token): token is string => typeof token === 'string' && token.length > 0,
          ),
        );
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.export(auth.request);
      }

      if (pathname === '/admin/selftest') {
        if (!options.admin?.selfTest) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.selfTest(auth.request);
      }

      if (pathname === '/admin/access') {
        if (!options.admin?.accessDiagnostics) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.accessDiagnostics(auth.request);
      }

      if (pathname === '/admin/envz') {
        if (!options.admin?.envz) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.envz(auth.request);
      }

      if (pathname === '/admin/known-users/clear') {
        if (!options.admin?.knownUsersClear) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.knownUsersClear(auth.request);
      }

      if (pathname === '/admin/broadcast/recipients') {
        if (!options.admin?.broadcastRecipients) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        if (request.method === 'GET') {
          return options.admin.broadcastRecipients.list(auth.request);
        }

        if (request.method === 'POST') {
          return options.admin.broadcastRecipients.upsert(auth.request);
        }

        return new Response('Method Not Allowed', { status: 405 });
      }

      if (pathname.startsWith('/admin/broadcast/recipients/')) {
        if (!options.admin?.broadcastRecipients) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        if (request.method !== 'DELETE') {
          return new Response('Method Not Allowed', { status: 405 });
        }

        const segments = normalizePath(pathname).split('/').filter(Boolean);
        const chatId = decodeURIComponent(segments[segments.length - 1] ?? '');
        return options.admin.broadcastRecipients.deactivate(auth.request, chatId);
      }

      if (pathname === '/admin/d1-stress') {
        if (!options.admin?.d1Stress) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.d1Stress(auth.request);
      }

      if (pathname === '/admin/diag') {
        if (!options.admin?.diag) {
          return handleNotFound();
        }

        const auth = ensureAdminAuthorization(request, url);
        if (!auth.ok) {
          return auth.response;
        }

        return options.admin.diag(auth.request);
      }

      return handleNotFound();
    },
  };
};
