import { describe, expect, it, vi } from 'vitest';

import type { AdminExportRequest } from '../admin-export-route';
import { createCsvExportHandler } from '../csv-export';

const createDb = (rows: unknown[]) => {
  const all = vi.fn().mockResolvedValue({ results: rows });
  const bind = vi.fn().mockReturnValue({ all });
  const prepare = vi.fn().mockReturnValue({ bind });

  return {
    db: { prepare },
    all,
    bind,
    prepare,
  };
};

describe('createCsvExportHandler', () => {
  const baseRequest: AdminExportRequest = {
    limit: 100,
    signal: new AbortController().signal,
  };

  it('streams CSV with BOM and headers', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: index + 1,
      user_id: `user-${index + 1}`,
      username: `name-${index + 1}`,
      first_name: null,
      last_name: null,
      language_code: 'en',
      user_created_at: '2024-01-01T00:00:00.000Z',
      user_updated_at: '2024-01-01T00:00:00.000Z',
      user_metadata: null,
      chat_id: `chat-${index + 1}`,
      utm_source: `source-${index + 1}`,
      thread_id: null,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `message ${index + 1}`,
      timestamp: `2024-01-0${index + 1}T00:00:00.000Z`,
      message_metadata: null,
    }));

    const { db } = createDb(rows);
    const handler = createCsvExportHandler({ db });

    const response = await handler(baseRequest);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('x-utm-sources')).toBe(
      JSON.stringify(['source-1', 'source-2', 'source-3']),
    );

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer.slice(0, 3));
    expect(Array.from(bytes)).toEqual([0xef, 0xbb, 0xbf]);

    const text = new TextDecoder().decode(buffer);
    expect(text.startsWith('"message_id"')).toBe(true);
    const headerColumns = text.split('\r\n')[0]?.split(',');
    expect(headerColumns?.at(10)).toBe('"utm_source"');
    expect(text.split('\r\n').length).toBe(5); // header + 3 rows + trailing empty
  });

  it('limits results and returns next cursor when more data available', async () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      user_id: 'user',
      username: null,
      first_name: null,
      last_name: null,
      language_code: null,
      user_created_at: '2024-01-01T00:00:00.000Z',
      user_updated_at: '2024-01-01T00:00:00.000Z',
      user_metadata: null,
      chat_id: 'chat',
      utm_source: 'campaign',
      thread_id: null,
      role: 'user',
      text: `row-${index + 1}`,
      timestamp: `2024-01-0${index + 1}T00:00:00.000Z`,
      message_metadata: null,
    }));

    const { db } = createDb(rows);
    const handler = createCsvExportHandler({ db });

    const response = await handler({ ...baseRequest, limit: 5 });

    expect(response.headers.get('x-next-cursor')).not.toBeNull();
    expect(response.headers.get('x-utm-sources')).toBe(JSON.stringify(['campaign']));
    const text = await response.text();
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(6); // header + 5 rows
    expect(lines.at(-1)).toContain('row-5');
  });

  it('protects against CSV injection patterns', async () => {
    const rows = [
      {
        id: 1,
        user_id: 'user',
        username: null,
        first_name: null,
        last_name: null,
        language_code: null,
        user_created_at: '2024-01-01T00:00:00.000Z',
        user_updated_at: '2024-01-01T00:00:00.000Z',
        user_metadata: null,
        chat_id: 'chat',
        utm_source: null,
        thread_id: null,
        role: 'user',
        text: '=cmd',
        timestamp: '2024-01-01T00:00:00.000Z',
        message_metadata: null,
      },
    ];

    const { db } = createDb(rows);
    const handler = createCsvExportHandler({ db });

    const response = await handler(baseRequest);
    const text = await response.text();

    expect(text).toContain("'" + '=cmd');
    expect(response.headers.get('x-utm-sources')).toBeNull();
  });

  it('returns 400 for invalid cursor', async () => {
    const { db } = createDb([]);
    const handler = createCsvExportHandler({ db });

    const response = await handler({ ...baseRequest, cursor: 'invalid-base64' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid cursor' });
  });

  it('returns 500 when database query fails', async () => {
    const all = vi.fn().mockRejectedValue(new Error('boom'));
    const bind = vi.fn().mockReturnValue({ all });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare };

    const handler = createCsvExportHandler({ db });

    const response = await handler(baseRequest);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch messages' });
  });
});
