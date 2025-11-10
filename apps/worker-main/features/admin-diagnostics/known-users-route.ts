import { json } from '../../shared/json-response';
import type { KnownUsersCache } from '../utm-tracking/known-users-cache';

export interface CreateKnownUsersClearRouteOptions {
  cache: Pick<KnownUsersCache, 'clear'>;
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

    const cleared = options.cache.clear();

    return json({ ok: true, cleared });
  };
