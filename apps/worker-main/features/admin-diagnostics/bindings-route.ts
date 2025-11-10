import type { StoragePort } from '../../ports';
import { json } from '../../shared/json-response';
import { getLastTelegramUpdateSnapshot } from '../../http/telegram-webhook';

export interface CreateBindingsDiagnosticsRouteOptions {
  storage: StoragePort;
  env: {
    TELEGRAM_BOT_TOKEN?: unknown;
    OPENAI_API_KEY?: unknown;
  };
  now?: () => Date;
  fetchApi?: typeof fetch;
  botApiBaseUrl?: string;
}

const defaultNow = () => new Date();
const defaultFetch = fetch;

const maskToken = (token: string): string => {
  const trimmed = token.trim();
  if (trimmed.length <= 8) {
    return trimmed.replace(/.(?=.$)/g, '*');
  }

  const prefix = trimmed.slice(0, 4);
  const suffix = trimmed.slice(-4);
  return `${prefix}…${suffix}`;
};

const getTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const sanitizeMetadata = (metadata: Record<string, unknown>) =>
  JSON.stringify(metadata, Object.keys(metadata).sort());

export const createBindingsDiagnosticsRoute = (options: CreateBindingsDiagnosticsRouteOptions) => {
  const now = options.now ?? defaultNow;
  const fetchApi = options.fetchApi ?? defaultFetch;
  const baseUrl = options.botApiBaseUrl ?? 'https://api.telegram.org';

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return json(
        { error: 'Method Not Allowed' },
        { status: 405 },
      );
    }

    const url = new URL(request.url);
    const query = url.searchParams.get('q');

    const normalizedQuery = query?.toLowerCase();

    if (normalizedQuery === 'telegram.getme' || normalizedQuery === 'telegram') {
      const botToken = getTrimmedString(options.env.TELEGRAM_BOT_TOKEN);
      const maskedToken = botToken ? maskToken(botToken) : undefined;

      if (!botToken) {
        return json(
          {
            query: 'telegram.getMe',
            ok: false,
            status: null,
            description: 'TELEGRAM_BOT_TOKEN is not configured',
            tokenMasked: maskedToken,
            lastWebhookSnapshot: getLastTelegramUpdateSnapshot(),
          },
          { status: 500 },
        );
      }

      const endpoint = `${baseUrl.replace(/\/?$/, '')}/bot${botToken}/getMe`;

      try {
        const response = await fetchApi(endpoint);
        let description: string | undefined;
        let ok = response.ok;
        let payload: unknown;

        try {
          payload = await response.json();
        } catch (error) {
          payload = undefined;
        }

        if (payload && typeof payload === 'object') {
          const telegramPayload = payload as {
            ok?: unknown;
            description?: unknown;
          };

          if (typeof telegramPayload.ok === 'boolean') {
            ok = telegramPayload.ok;
          }

          if (typeof telegramPayload.description === 'string') {
            description = telegramPayload.description;
          }
        }

        if (!description) {
          description = response.statusText || undefined;
        }

        return json(
          {
            query: 'telegram.getMe',
            ok,
            status: response.status,
            description,
            tokenMasked: maskedToken,
            lastWebhookSnapshot: getLastTelegramUpdateSnapshot(),
          },
          { status: ok ? 200 : 502 },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return json(
          {
            query: 'telegram.getMe',
            ok: false,
            status: null,
            description: message,
            tokenMasked: maskedToken,
            lastWebhookSnapshot: getLastTelegramUpdateSnapshot(),
          },
          { status: 502 },
        );
      }
    }

    if (normalizedQuery !== 'bindings') {
      return json(
        { error: 'Unsupported diagnostics query' },
        { status: 400 },
      );
    }

    const updatedAt = now();
    const metadata = { scope: 'diagnostics', feature: 'bindings' };
    const userId = 'admin:diag:bindings';
    const userPayload = {
      userId,
      username: undefined,
      firstName: undefined,
      lastName: undefined,
      languageCode: 'en',
      utmSource: 'src_DIAG-Bindings',
      metadata,
      updatedAt,
    };

    const bindings = {
      saveUser: [
        userPayload.userId,
        null,
        null,
        null,
        userPayload.languageCode,
        userPayload.utmSource,
        sanitizeMetadata(metadata),
        updatedAt.toISOString(),
      ],
      getRecentMessages: [userPayload.userId, 1],
    };

    const errors: string[] = [];
    let saveOutcome: { utmDegraded: boolean } | undefined;
    try {
      saveOutcome = await options.storage.saveUser(userPayload);
      // eslint-disable-next-line no-console
      console.info('[admin:diag][bindings] saveUser result', {
        userId,
        utmDegraded: saveOutcome.utmDegraded,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`storage.saveUser: ${message}`);
    }

    let recentMessagesCount: number | undefined;
    if (errors.length === 0) {
      try {
        const messages = await options.storage.getRecentMessages({ userId, limit: 1 });
        recentMessagesCount = Array.isArray(messages) ? messages.length : 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`storage.getRecentMessages: ${message}`);
      }
    }

    const ok = errors.length === 0;
    const telegramBotTokenPresent = Boolean(getTrimmedString(options.env.TELEGRAM_BOT_TOKEN));
    const openAiKeyPresent = Boolean(getTrimmedString(options.env.OPENAI_API_KEY));

    const payload: Record<string, unknown> = {
      query: 'bindings',
      ok,
      bindings,
      secrets: {
        telegramBotToken: { present: telegramBotTokenPresent },
        openAiApiKey: { present: openAiKeyPresent },
      },
      results: {
        saveUser: saveOutcome ? { utmDegraded: saveOutcome.utmDegraded } : undefined,
        getRecentMessages: recentMessagesCount !== undefined ? { count: recentMessagesCount } : undefined,
      },
      errors,
      lastWebhookSnapshot: getLastTelegramUpdateSnapshot(),
    };

    if (ok) {
      // eslint-disable-next-line no-console
      console.info('[admin:diag][bindings] completed', { userId });
    }

    return json(payload, { status: ok ? 200 : 500 });
  };
};
