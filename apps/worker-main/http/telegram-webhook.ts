import type { IncomingMessage } from '../core';

import type {
  HandledWebhookResult,
  MessageWebhookResult,
  TransformPayloadResult,
} from './router';
import { parseStartPayload } from '../features/utm-tracking/parse-start-payload';

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });

const handledOk = (): HandledWebhookResult => ({
  kind: 'handled',
  response: jsonResponse({ status: 'ok' }, { status: 200 }),
});

const handledIgnored = (): HandledWebhookResult => ({
  kind: 'handled',
  response: jsonResponse({ status: 'ignored' }, { status: 200 }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toOptionalString = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  return undefined;
};

const toOptionalTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toIdString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value).toString(10);
  }

  if (typeof value === 'bigint') {
    return value.toString(10);
  }

  return undefined;
};

const snapshotUpdate = (update: unknown) => {
  if (typeof update !== 'object' || update === null) {
    return { type: typeof update };
  }

  const record = update as Record<string, unknown>;
  const message =
    record.message && typeof record.message === 'object' && record.message !== null
      ? (record.message as Record<string, unknown>)
      : undefined;
  const chat =
    message?.chat && typeof message.chat === 'object' && message.chat !== null
      ? (message.chat as Record<string, unknown>)
      : undefined;
  const from =
    message?.from && typeof message.from === 'object' && message.from !== null
      ? (message.from as Record<string, unknown>)
      : undefined;

  return {
    updateId: typeof record.update_id === 'number' ? record.update_id : undefined,
    messageId: toIdString(message?.message_id),
    chatId: toIdString(chat?.id),
    chatType: typeof chat?.type === 'string' ? chat.type : undefined,
    fromId: toIdString(from?.id),
    hasText: typeof message?.text === 'string',
    hasWebAppData: typeof message?.web_app_data === 'object' && message?.web_app_data !== null,
    hasStartapp: typeof record.startapp === 'string' && record.startapp.length > 0,
  };
};

const toDate = (value: unknown): Date => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return new Date();
};

const createUserMetadata = (source: TelegramUser): Record<string, unknown> | undefined => {
  const metadata: Record<string, unknown> = {};

  if (typeof source.is_bot === 'boolean') {
    metadata.isBot = source.is_bot;
  }

  if (typeof source.is_premium === 'boolean') {
    metadata.isPremium = source.is_premium;
  }

  if (Object.keys(metadata).length === 0) {
    return undefined;
  }

  return metadata;
};

const extractCommandEntity = (message: TelegramMessage): TelegramMessageEntity | undefined =>
  message.entities?.find((entity) => entity.type === 'bot_command' && entity.offset === 0);

const stripCommandMention = (command: string): string => {
  const atIndex = command.indexOf('@');
  if (atIndex === -1) {
    return command;
  }

  return command.slice(0, atIndex);
};

const extractCommandMention = (command: string): string | undefined => {
  const atIndex = command.indexOf('@');
  if (atIndex === -1) {
    return undefined;
  }

  return command.slice(atIndex + 1);
};

const isCommandForThisBot = (command: string, botUsername?: string) => {
  const mention = extractCommandMention(command);
  if (!mention) {
    return true;
  }

  if (!botUsername) {
    return false;
  }

  return mention.toLowerCase() === botUsername.toLowerCase();
};

const normalizeCommand = (command: string): string => stripCommandMention(command.toLowerCase());

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramUser {
  id: number | string | bigint;
  is_bot?: boolean;
  is_premium?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number | string | bigint;
  type?: string;
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number | string | bigint;
  date?: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
  message_thread_id?: number | string | bigint;
  entities?: TelegramMessageEntity[];
  voice?: unknown;
  video?: unknown;
  photo?: unknown;
  document?: unknown;
  video_note?: unknown;
  web_app_data?: {
    data?: string;
    button_text?: string;
    [key: string]: unknown;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  [key: string]: unknown;
}

export interface TelegramCommandUser {
  userId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  isBot?: boolean;
  isPremium?: boolean;
}

export interface TelegramAdminCommandContext {
  command: string;
  rawCommand: string;
  argument?: string;
  text: string;
  chat: {
    id: string;
    threadId?: string;
    type?: string;
  };
  from: TelegramCommandUser;
  messageId: string;
  update: TelegramUpdate;
  message: TelegramMessage;
  incomingMessage: IncomingMessage;
}

export interface TelegramWebhookFeatures {
  handleAdminCommand?: (
    context: TelegramAdminCommandContext,
  ) => Promise<Response | void> | Response | void;
  handleMessage?: (
    message: IncomingMessage,
  ) => Promise<Response | 'handled' | void> | Response | 'handled' | void;
}

export interface TelegramWebhookOptions {
  botUsername?: string;
  features?: TelegramWebhookFeatures;
}

const toHandledResult = (response?: Response): HandledWebhookResult => ({
  kind: 'handled',
  response: response ?? jsonResponse({ status: 'ok' }, { status: 200 }),
});

const buildIncomingMessage = (
  message: TelegramMessage,
  from: TelegramUser,
  text: string,
): IncomingMessage | undefined => {
  const userId = toIdString(from.id);
  const chatId = toIdString(message.chat?.id);
  const messageId = toIdString(message.message_id);

  if (!userId || !chatId || !messageId) {
    return undefined;
  }

  const threadId = toIdString(message.message_thread_id);

  const incoming: IncomingMessage = {
    user: {
      userId,
      username: toOptionalString(from.username),
      firstName: toOptionalString(from.first_name),
      lastName: toOptionalString(from.last_name),
      languageCode: toOptionalString(from.language_code),
      metadata: createUserMetadata(from),
    },
    chat: {
      id: chatId,
      threadId,
    },
    text,
    messageId,
    receivedAt: toDate(message.date),
  };

  return incoming;
};

const findRelevantMessage = (update: TelegramUpdate): TelegramMessage | undefined =>
  update.message ?? undefined;

const handleAdminCommand = async (
  context: TelegramAdminCommandContext,
  options: TelegramWebhookOptions,
): Promise<HandledWebhookResult | undefined> => {
  const handler = options.features?.handleAdminCommand;
  if (!handler) {
    return undefined;
  }

  const response = await handler(context);
  if (!response) {
    return undefined;
  }

  return toHandledResult(response);
};

export const transformTelegramUpdate = async (
  payload: unknown,
  options: TelegramWebhookOptions = {},
): Promise<TransformPayloadResult> => {
  if (!isRecord(payload)) {
    throw new Error('Telegram update must be an object');
  }

  const update = payload as TelegramUpdate;
  // eslint-disable-next-line no-console
  console.info('[telegram-webhook] incoming update', snapshotUpdate(update));
  const message = findRelevantMessage(update);

  if (!message || !isRecord(message.chat)) {
    return handledIgnored();
  }

  const from = message.from;
  if (!from) {
    return handledIgnored();
  }

  const chatId = toIdString(message.chat?.id);
  const threadId = toIdString(message.message_thread_id);

  const rawText = typeof message.text === 'string' ? message.text : undefined;
  const caption = typeof message.caption === 'string' ? message.caption : undefined;
  const content = rawText ?? caption;

  if (!content || content.trim().length === 0) {
    if (chatId) {
      if (message.voice || message.video_note) {
        return {
          kind: 'non_text',
          chat: { id: chatId, threadId },
          reply: 'voice',
        };
      }

      if (message.video || message.photo || message.document) {
        return {
          kind: 'non_text',
          chat: { id: chatId, threadId },
          reply: 'media',
        };
      }
    }

    return handledIgnored();
  }

  const incoming = buildIncomingMessage(message, from, content);
  if (!incoming) {
    return handledIgnored();
  }

  const commandEntity = extractCommandEntity(message);

  const extractStartPayloadFromInitData = (initData: string | undefined): string | undefined => {
    if (!initData) {
      return undefined;
    }

    try {
      const initDataPreservingPlus = initData.replace(/\+/g, '%2B');
      const params = new URLSearchParams(initDataPreservingPlus);
      const startParam = params.get('start_param') ?? params.get('startapp');
      if (!startParam) {
        return undefined;
      }

      return parseStartPayload(startParam);
    } catch (error) {
      return undefined;
    }
  };

  const extractStartPayloadFromWebAppData = (): string | undefined => {
    const rawWebAppData = message.web_app_data;
    if (!isRecord(rawWebAppData)) {
      return undefined;
    }

    const rawData = toOptionalTrimmedString(rawWebAppData.data);
    if (!rawData) {
      return undefined;
    }

    let parsed: unknown = rawData;
    if (rawData.startsWith('{') || rawData.startsWith('[')) {
      try {
        parsed = JSON.parse(rawData);
      } catch (error) {
        parsed = rawData;
      }
    }

    if (typeof parsed === 'string') {
      return extractStartPayloadFromInitData(parsed);
    }

    if (!isRecord(parsed)) {
      return undefined;
    }

    const initData = toOptionalTrimmedString(parsed.initData ?? parsed.init_data);
    const fromInitData = extractStartPayloadFromInitData(initData);
    if (fromInitData) {
      return fromInitData;
    }

    const directStartParam = toOptionalTrimmedString(parsed.startParam ?? parsed.start_param);
    return parseStartPayload(directStartParam);
  };

  const startPayloadFromMiniApp =
    parseStartPayload(update.startapp)
    ?? parseStartPayload(update.query_id)
    ?? extractStartPayloadFromWebAppData();

  let startPayload: string | undefined = startPayloadFromMiniApp;

  if (commandEntity) {
    const rawCommand = incoming.text.slice(
      commandEntity.offset,
      commandEntity.offset + commandEntity.length,
    );

    if (rawCommand.length > 0 && isCommandForThisBot(rawCommand, options.botUsername)) {
      const normalizedCommand = normalizeCommand(rawCommand);

      const argumentSlice = incoming.text.slice(commandEntity.offset + commandEntity.length);
      const argumentText = argumentSlice.trim();

      if (normalizedCommand === '/start') {
        startPayload = parseStartPayload(argumentSlice) ?? startPayload;
      }

      if (normalizedCommand === '/broadcast') {
        const context: TelegramAdminCommandContext = {
          command: normalizedCommand,
          rawCommand,
          argument: argumentText.length > 0 ? argumentText : undefined,
          text: incoming.text,
          chat: {
            id: incoming.chat.id,
            threadId: incoming.chat.threadId,
            type: toOptionalString(message.chat.type),
          },
          from: {
            userId: incoming.user.userId,
            username: incoming.user.username,
            firstName: incoming.user.firstName,
            lastName: incoming.user.lastName,
            languageCode: incoming.user.languageCode,
            isBot: typeof from.is_bot === 'boolean' ? from.is_bot : undefined,
            isPremium: typeof from.is_premium === 'boolean' ? from.is_premium : undefined,
          },
          messageId: incoming.messageId ?? '',
          update,
          message,
          incomingMessage: incoming,
        };

        const adminResult = await handleAdminCommand(context, options);
        if (adminResult) {
          return adminResult;
        }
      }

      if (normalizedCommand === '/export' || normalizedCommand.startsWith('/admin')) {
        const context: TelegramAdminCommandContext = {
          command: normalizedCommand,
          rawCommand,
          argument: argumentText.length > 0 ? argumentText : undefined,
          text: incoming.text,
          chat: {
            id: incoming.chat.id,
            threadId: incoming.chat.threadId,
            type: toOptionalString(message.chat.type),
          },
          from: {
            userId: incoming.user.userId,
            username: incoming.user.username,
            firstName: incoming.user.firstName,
            lastName: incoming.user.lastName,
            languageCode: incoming.user.languageCode,
            isBot: typeof from.is_bot === 'boolean' ? from.is_bot : undefined,
            isPremium: typeof from.is_premium === 'boolean' ? from.is_premium : undefined,
          },
          messageId: incoming.messageId ?? '',
          update,
          message,
          incomingMessage: incoming,
        };

        const adminResult = await handleAdminCommand(context, options);
        if (adminResult) {
          return adminResult;
        }
      }
    }
  }

  const result: MessageWebhookResult = {
    kind: 'message',
    message: startPayload
      ? {
          ...incoming,
          user: {
            ...incoming.user,
            utmSource: startPayload,
          },
        }
      : incoming,
  };

  // eslint-disable-next-line no-console
  console.info('[telegram-webhook] normalized message', {
    updateId: update.update_id,
    chatId: incoming.chat.id,
    threadId: incoming.chat.threadId,
    userId: incoming.user.userId,
    hasStartPayload: Boolean(startPayload),
  });

  return result;
};
