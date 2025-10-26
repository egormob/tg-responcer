import { json } from '../../shared/json-response';

export interface AdminExportRequest {
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
  signal: AbortSignal;
}

export interface CreateAdminExportRouteOptions {
  adminToken: string;
  handleExport: (request: AdminExportRequest) => Promise<Response>;
}

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

const toErrorResponse = (message: string, status = 400) =>
  json(
    { error: message },
    {
      status,
    },
  );

const parseLimit = (rawLimit: string | null): number | undefined => {
  if (!rawLimit) {
    return DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(rawLimit, 10);
  if (Number.isNaN(parsed)) {
    throw new Error('limit must be an integer');
  }

  if (parsed <= 0) {
    throw new Error('limit must be greater than zero');
  }

  if (parsed > MAX_LIMIT) {
    throw new Error(`limit must not exceed ${MAX_LIMIT}`);
  }

  return parsed;
};

const parseDateParam = (value: string | null): Date | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('date must be a valid ISO string or timestamp');
  }

  return parsed;
};

const compareDates = (from?: Date, to?: Date) => {
  if (from && to && from.getTime() > to.getTime()) {
    throw new Error('from must be earlier than to');
  }
};

export const createAdminExportRoute = (options: CreateAdminExportRouteOptions) => {
  const token = options.adminToken;

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return toErrorResponse('Method Not Allowed', 405);
    }

    const providedToken = request.headers.get('x-admin-token');
    if (!providedToken) {
      return toErrorResponse('Missing X-Admin-Token header', 401);
    }

    if (providedToken !== token) {
      return toErrorResponse('Invalid admin token', 403);
    }

    const url = new URL(request.url);
    const fromRaw = url.searchParams.get('from');
    const toRaw = url.searchParams.get('to');
    const cursor = url.searchParams.get('cursor') ?? undefined;

    let from: Date | undefined;
    let to: Date | undefined;
    let limit: number | undefined;

    try {
      from = parseDateParam(fromRaw);
      to = parseDateParam(toRaw);
      limit = parseLimit(url.searchParams.get('limit'));
      compareDates(from, to);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid parameters';
      return toErrorResponse(message, 400);
    }

    return options.handleExport({
      from,
      to,
      cursor,
      limit,
      signal: request.signal,
    });
  };
};
