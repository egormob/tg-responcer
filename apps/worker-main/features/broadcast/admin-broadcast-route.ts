import { json } from '../../shared/json-response';
import type { AdminAccess } from '../admin-access';
import type {
  BroadcastAudienceFilter,
  BroadcastMessagePayload,
  BroadcastQueue,
} from './broadcast-queue';
import {
  DEFAULT_MAX_TEXT_LENGTH,
  buildBroadcastPayload,
} from './broadcast-payload';

export interface CreateAdminBroadcastRouteOptions {
  readonly adminToken: string;
  readonly queue: BroadcastQueue;
  readonly maxTextLength?: number;
  readonly now?: () => Date;
  readonly adminAccess?: AdminAccess;
}

export interface AdminBroadcastRequest {
  readonly text: string;
  readonly filters?: BroadcastAudienceFilter;
  readonly metadata?: Record<string, unknown>;
}

const toErrorResponse = (message: string, status: number) =>
  json(
    { error: message },
    { status },
  );

const ensureJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Invalid JSON payload';
    throw new Error(`Invalid JSON payload: ${reason}`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty`);
  }

  return trimmed;
};

const parseStringArray = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }

  const result = value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`${field}[${index}] must be a string`);
    }

    const trimmed = item.trim();
    if (!trimmed) {
      throw new Error(`${field}[${index}] must not be empty`);
    }

    return trimmed;
  });

  if (result.length === 0) {
    throw new Error(`${field} must not be empty`);
  }

  return result;
};

const parseFilters = (value: unknown): BroadcastAudienceFilter | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error('filters must be an object');
  }

  const chatIds = parseStringArray(value.chatIds, 'filters.chatIds');
  const userIds = parseStringArray(value.userIds, 'filters.userIds');
  const languageCodes = parseStringArray(value.languageCodes, 'filters.languageCodes');

  if (!chatIds && !userIds && !languageCodes) {
    throw new Error('filters must specify at least one selector');
  }

  return { chatIds, userIds, languageCodes };
};

const parseMetadata = (value: unknown): Record<string, unknown> | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error('metadata must be an object');
  }

  return { ...value };
};

const extractRequestedBy = (request: Request): string | undefined => {
  const header = request.headers.get('x-admin-actor');
  if (!header) {
    return undefined;
  }

  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const createAdminBroadcastRoute = (options: CreateAdminBroadcastRouteOptions) => {
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const now = options.now ?? (() => new Date());

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return toErrorResponse('Method Not Allowed', 405);
    }

    const token = request.headers.get('x-admin-token');
    if (!token) {
      return toErrorResponse('Missing X-Admin-Token header', 401);
    }

    if (token !== options.adminToken) {
      return toErrorResponse('Invalid admin token', 403);
    }

    const actor = extractRequestedBy(request);
    if (!actor) {
      return toErrorResponse('Missing X-Admin-Actor header', 401);
    }

    if (options.adminAccess && !(await options.adminAccess.isAdmin(actor))) {
      return toErrorResponse('Forbidden admin actor', 403);
    }

    let payload: AdminBroadcastRequest;
    try {
      const body = await ensureJson(request);
      if (!isRecord(body)) {
        throw new Error('Request body must be an object');
      }

      payload = {
        text: body.text as string,
        filters: body.filters as BroadcastAudienceFilter | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid JSON payload';
      return toErrorResponse(message, 400);
    }

    let messagePayload: BroadcastMessagePayload;
    try {
      const text = parseString(payload.text, 'text');
      const filters = parseFilters(payload.filters);
      const metadata = parseMetadata(payload.metadata);

      messagePayload = buildBroadcastPayload({ text, filters, metadata }, { maxTextLength });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid payload';
      return toErrorResponse(message, 400);
    }

    let job;
    try {
      job = options.queue.enqueue({
        payload: messagePayload,
        requestedBy: actor,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to enqueue broadcast';
      return toErrorResponse(message, 503);
    }

    return json(
      {
        status: 'queued',
        jobId: job.id,
        enqueuedAt: job.createdAt.toISOString(),
        requestedBy: job.requestedBy ?? null,
        filters: job.payload.filters ?? null,
      },
      { status: 202, headers: { 'x-queued-at': now().toISOString() } },
    );
  };
};
