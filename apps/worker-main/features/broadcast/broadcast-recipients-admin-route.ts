import { json } from '../../shared';
import type { BroadcastAudienceFilter } from './broadcast-payload';
import type {
  BroadcastRecipientUpsertInput,
  BroadcastRecipientsStore,
} from './recipients-store';

interface Logger {
  info?(message: string, details?: Record<string, unknown>): void;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
}

export interface CreateBroadcastRecipientsAdminHandlersOptions {
  store: BroadcastRecipientsStore;
  logger?: Logger;
}

export interface BroadcastRecipientsAdminHandlers {
  list: (request: Request) => Promise<Response>;
  upsert: (request: Request) => Promise<Response>;
  deactivate: (request: Request, chatId: string) => Promise<Response>;
}

const toOptionalString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    const text = String(value);
    return text.length > 0 ? text : undefined;
  }

  return undefined;
};

const parseFilterFromQuery = (url: URL): BroadcastAudienceFilter | undefined => {
  const chatIds = url.searchParams.getAll('chatId');
  const userIds = url.searchParams.getAll('userId');
  const languageCodes = url.searchParams.getAll('language');

  const normalizedChatIds = chatIds.map((value) => value.trim()).filter((value) => value.length > 0);
  const normalizedUserIds = userIds.map((value) => value.trim()).filter((value) => value.length > 0);
  const normalizedLanguages = languageCodes
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  if (normalizedChatIds.length === 0 && normalizedUserIds.length === 0 && normalizedLanguages.length === 0) {
    return undefined;
  }

  return {
    chatIds: normalizedChatIds.length > 0 ? normalizedChatIds : undefined,
    userIds: normalizedUserIds.length > 0 ? normalizedUserIds : undefined,
    languageCodes: normalizedLanguages.length > 0 ? normalizedLanguages : undefined,
  } satisfies BroadcastAudienceFilter;
};

const parseUpsertPayload = async (request: Request): Promise<BroadcastRecipientUpsertInput> => {
  let body: unknown;

  try {
    body = await request.json();
  } catch (error) {
    throw new Response(JSON.stringify({ error: 'Invalid JSON payload' }), { status: 400 });
  }

  const chatId = toOptionalString((body as Record<string, unknown> | undefined)?.chatId);
  if (!chatId) {
    throw new Response(JSON.stringify({ error: 'chatId is required' }), { status: 400 });
  }

  const username = toOptionalString((body as Record<string, unknown> | undefined)?.username);
  const languageCode = toOptionalString((body as Record<string, unknown> | undefined)?.languageCode);

  return { chatId, username, languageCode } satisfies BroadcastRecipientUpsertInput;
};

export const createBroadcastRecipientsAdminHandlers = (
  options: CreateBroadcastRecipientsAdminHandlersOptions,
): BroadcastRecipientsAdminHandlers => ({
  list: async (request) => {
    const url = new URL(request.url);
    const filter = parseFilterFromQuery(url);
    const recipients = await options.store.listActiveRecipients(filter);
    return json({
      items: recipients,
      count: recipients.length,
    });
  },
  upsert: async (request) => {
    const payload = await parseUpsertPayload(request);
    await options.store.upsertRecipient(payload);
    options.logger?.info?.('broadcast recipient registered via admin route', {
      chatId: payload.chatId,
    });
    return json({ status: 'ok' }, { status: 201 });
  },
  deactivate: async (_request, chatId) => {
    const normalizedChatId = toOptionalString(chatId);
    if (!normalizedChatId) {
      return json({ error: 'chatId is required' }, { status: 400 });
    }

    await options.store.deactivateRecipient(normalizedChatId);
    options.logger?.info?.('broadcast recipient deactivated via admin route', {
      chatId: normalizedChatId,
    });
    return json({ status: 'ok' });
  },
});
