import { describe, expect, it } from 'vitest';

import { createExportRateTelemetry } from '../export-rate-telemetry';

describe('createExportRateTelemetry', () => {
  it('tracks buckets, totals and last limit event', () => {
    const telemetry = createExportRateTelemetry({ limit: 3, windowMs: 60_000 });
    const timestamps = [
      new Date('2024-01-01T00:00:05Z'),
      new Date('2024-01-01T00:00:10Z'),
      new Date('2024-01-01T00:00:15Z'),
      new Date('2024-01-01T00:00:20Z'),
    ];

    telemetry.record({ decision: 'ok', userIdHash: 'user#1', timestamp: timestamps[0] });
    telemetry.record({ decision: 'ok', userIdHash: 'user#1', timestamp: timestamps[1] });
    telemetry.record({ decision: 'ok', userIdHash: 'user#1', timestamp: timestamps[2] });
    const limitRecord = telemetry.record({
      decision: 'limit',
      userIdHash: 'user#1',
      timestamp: timestamps[3],
    });

    expect(limitRecord.bucket).toBe(Math.floor(timestamps[3].getTime() / 60_000));
    expect(limitRecord.remaining).toBe(0);

    const snapshot = telemetry.snapshot();
    expect(snapshot.status).toBe('ok');
    expect(snapshot.feature).toBe('admin_export_rate_limit');
    expect(snapshot.totals).toEqual({ ok: 3, limit: 1 });
    expect(snapshot.buckets).toHaveLength(1);
    expect(snapshot.buckets[0]).toMatchObject({ ok: 3, limit: 1, lastUserIdHash: 'user#1' });
    expect(snapshot.lastLimit).toMatchObject({ userIdHash: 'user#1', remaining: 0 });
  });
});
