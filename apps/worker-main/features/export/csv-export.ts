import { json } from '../../shared';
import type { AdminExportRequest } from './admin-export-route';

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface CsvExportHandlerOptions {
  db: D1Database;
  filenamePrefix?: string;
}

interface ExportRow {
  id: number;
  user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  user_created_at: string;
  user_updated_at: string;
  user_metadata: string | null;
  chat_id: string;
  utm_source: string | null;
  thread_id: string | null;
  role: string;
  text: string;
  timestamp: string;
  message_metadata: string | null;
}

interface Cursor {
  timestamp: string;
  id: number;
}

const SELECT_MESSAGES_SQL = `
  SELECT
    m.id,
    m.user_id,
    u.username,
    u.first_name,
    u.last_name,
    u.language_code,
    u.created_at AS user_created_at,
    u.updated_at AS user_updated_at,
    u.metadata AS user_metadata,
    m.chat_id,
    u.utm_source,
    m.thread_id,
    m.role,
    m.text,
    m.timestamp,
    m.metadata AS message_metadata
  FROM messages m
  INNER JOIN users u ON u.user_id = m.user_id
  WHERE (?1 IS NULL OR m.timestamp >= ?1)
    AND (?2 IS NULL OR m.timestamp <= ?2)
    AND (
      ?3 IS NULL
      OR m.timestamp > ?3
      OR (m.timestamp = ?3 AND m.id > ?4)
    )
  ORDER BY m.timestamp ASC, m.id ASC
  LIMIT ?5;
`;

const DANGEROUS_FORMULA_PREFIX = /^[=+\-@]/;

const sanitizeForCsv = (input: string): string => {
  const normalized = input.replace(/\r\n?/g, '\n');
  const trimmed = normalized.trimStart();
  const prefix = trimmed[0];
  const guarded = prefix && DANGEROUS_FORMULA_PREFIX.test(prefix)
    ? `'${normalized}`
    : normalized;
  const escaped = guarded.replace(/"/g, '""');
  return `"${escaped}"`;
};

const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '""';
  }

  if (typeof value === 'string') {
    if (value.length === 0) {
      return '""';
    }
    return sanitizeForCsv(value);
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return sanitizeForCsv(String(value));
  }

  if (value instanceof Date) {
    return sanitizeForCsv(value.toISOString());
  }

  return sanitizeForCsv(String(value));
};

const HEADER = [
  'message_id',
  'user_id',
  'username',
  'first_name',
  'last_name',
  'language_code',
  'user_created_at',
  'user_updated_at',
  'user_metadata',
  'chat_id',
  'utm_source',
  'thread_id',
  'role',
  'text',
  'timestamp',
  'message_metadata',
];

const encoder = new TextEncoder();

const encodeBase64 = (value: string): string => {
  if (typeof (globalThis as { btoa?: (input: string) => string }).btoa === 'function') {
    return (globalThis as { btoa: (input: string) => string }).btoa(value);
  }

  return Buffer.from(value, 'utf-8').toString('base64');
};

const decodeBase64 = (value: string): string => {
  if (typeof (globalThis as { atob?: (input: string) => string }).atob === 'function') {
    return (globalThis as { atob: (input: string) => string }).atob(value);
  }

  return Buffer.from(value, 'base64').toString('utf-8');
};

const parseCursor = (cursor: string | undefined): Cursor | undefined => {
  if (!cursor) {
    return undefined;
  }

  try {
    const decoded = decodeBase64(cursor);
    const parsed = JSON.parse(decoded) as Partial<Cursor>;

    if (typeof parsed.timestamp !== 'string' || typeof parsed.id !== 'number') {
      throw new Error('Invalid cursor shape');
    }

    if (Number.isNaN(new Date(parsed.timestamp).getTime())) {
      throw new Error('Invalid cursor timestamp');
    }

    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch (error) {
    throw new Error('Invalid cursor');
  }
};

const createCursor = (row: ExportRow): string =>
  encodeBase64(
    JSON.stringify({
      timestamp: row.timestamp,
      id: row.id,
    }),
  );

const createCsvStream = (rows: ExportRow[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`\uFEFF${HEADER.map(sanitizeForCsv).join(',')}\r\n`));

      for (const row of rows) {
        const line = [
          formatValue(row.id),
          formatValue(row.user_id),
          formatValue(row.username),
          formatValue(row.first_name),
          formatValue(row.last_name),
          formatValue(row.language_code),
          formatValue(row.user_created_at),
          formatValue(row.user_updated_at),
          formatValue(row.user_metadata),
          formatValue(row.chat_id),
          formatValue(row.utm_source),
          formatValue(row.thread_id),
          formatValue(row.role),
          formatValue(row.text),
          formatValue(row.timestamp),
          formatValue(row.message_metadata),
        ].join(',');

        controller.enqueue(encoder.encode(`${line}\r\n`));
      }

      controller.close();
    },
  });

export const createCsvExportHandler = (options: CsvExportHandlerOptions) => {
  const filenamePrefix = options.filenamePrefix ?? 'dialog-export';

  return async (request: AdminExportRequest): Promise<Response> => {
    const limit = Math.max(1, request.limit ?? 100);
    let cursor: Cursor | undefined;

    try {
      cursor = parseCursor(request.cursor);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : 'Invalid cursor' },
        { status: 400 },
      );
    }

    const statement = options
      .db
      .prepare(SELECT_MESSAGES_SQL)
      .bind(
        request.from ? request.from.toISOString() : null,
        request.to ? request.to.toISOString() : null,
        cursor ? cursor.timestamp : null,
        cursor ? cursor.id : null,
        limit + 1,
      );

    let results: ExportRow[] = [];
    try {
      ({ results } = await statement.all<ExportRow>());
    } catch (error) {
      return json(
        { error: 'Failed to fetch messages' },
        { status: 500 },
      );
    }

    const hasMore = results.length > limit;
    const rows = hasMore ? results.slice(0, limit) : results;

    const stream = createCsvStream(rows);
    const headers = new Headers({
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${filenamePrefix}.csv"`,
    });

    const utmSources = rows
      .map((row) => row.utm_source?.trim())
      .filter((value): value is string => Boolean(value && value.length > 0));
    const uniqueUtmSources = Array.from(new Set(utmSources));
    if (uniqueUtmSources.length > 0) {
      headers.set('x-utm-sources', JSON.stringify(uniqueUtmSources));
    }

    if (hasMore && rows.length > 0) {
      const nextCursor = createCursor(rows[rows.length - 1]);
      headers.set('x-next-cursor', nextCursor);
    }

    return new Response(stream, {
      status: 200,
      headers,
    });
  };
};
