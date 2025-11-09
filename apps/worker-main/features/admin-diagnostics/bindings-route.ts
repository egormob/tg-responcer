import type { StoragePort } from '../../ports';
import { json } from '../../shared/json-response';

export interface CreateBindingsDiagnosticsRouteOptions {
  storage: StoragePort;
  now?: () => Date;
}

const defaultNow = () => new Date();

const sanitizeMetadata = (metadata: Record<string, unknown>) =>
  JSON.stringify(metadata, Object.keys(metadata).sort());

export const createBindingsDiagnosticsRoute = (options: CreateBindingsDiagnosticsRouteOptions) => {
  const now = options.now ?? defaultNow;

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return json(
        { error: 'Method Not Allowed' },
        { status: 405 },
      );
    }

    const url = new URL(request.url);
    const query = url.searchParams.get('q');

    if (query?.toLowerCase() !== 'bindings') {
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
    const payload: Record<string, unknown> = {
      query: 'bindings',
      ok,
      bindings,
      results: {
        saveUser: saveOutcome ? { utmDegraded: saveOutcome.utmDegraded } : undefined,
        getRecentMessages: recentMessagesCount !== undefined ? { count: recentMessagesCount } : undefined,
      },
      errors,
    };

    if (ok) {
      // eslint-disable-next-line no-console
      console.info('[admin:diag][bindings] completed', { userId });
    }

    return json(payload, { status: ok ? 200 : 500 });
  };
};
