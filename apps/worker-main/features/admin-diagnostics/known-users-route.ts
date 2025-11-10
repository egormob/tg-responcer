import { json } from '../../shared/json-response';
import { describeTelegramIdForLogs } from '../../http/telegram-ids';
import type { KnownUsersCache } from '../utm-tracking/known-users-cache';

export interface CreateKnownUsersClearRouteOptions {
  cache: Pick<KnownUsersCache, 'clear' | 'snapshot'>;
}

export const createKnownUsersClearRoute = (
  options: CreateKnownUsersClearRouteOptions,
) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return json(
        { error: 'Method Not Allowed' },
        { status: 405 },
      );
    }

    const snapshot = options.cache.snapshot();
    const cleared = options.cache.clear();

    const userIdHashes = snapshot.userIds.map((userId) =>
      describeTelegramIdForLogs(userId)?.hash ?? 'unknown',
    );

    return json({ ok: true, cleared, size: snapshot.size, userIdHashes });
  };
