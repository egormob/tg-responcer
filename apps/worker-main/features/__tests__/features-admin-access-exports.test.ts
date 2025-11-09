import { describe, expect, it } from 'vitest';

import {
  createAdminCommandErrorRecorder,
  readAdminMessagingErrors,
  extractTelegramErrorDetails,
  shouldInvalidateAdminAccess,
  type AdminMessagingErrorSummary,
  type AdminMessagingErrorEntry,
  type AdminMessagingErrorSource,
  type TelegramErrorDetails,
  type AdminCommandErrorRecorder,
} from '../index';

describe('features admin access exports', () => {
  it('should expose admin access exports', () => {
    expect(createAdminCommandErrorRecorder).toBeTypeOf('function');
    expect(readAdminMessagingErrors).toBeTypeOf('function');
    expect(extractTelegramErrorDetails).toBeTypeOf('function');
    expect(shouldInvalidateAdminAccess).toBeTypeOf('function');

    const summary: AdminMessagingErrorSummary | null = null;
    const entry: AdminMessagingErrorEntry | null = null;
    const source: AdminMessagingErrorSource | null = null;
    const details: TelegramErrorDetails | null = null;
    const recorder: AdminCommandErrorRecorder | null = null;

    expect(summary).toBeNull();
    expect(entry).toBeNull();
    expect(source).toBeNull();
    expect(details).toBeNull();
    expect(recorder).toBeNull();
  });
});
