import { describe, expect, it } from 'vitest';

import { parseStartPayload } from '../parse-start-payload';

describe('parseStartPayload', () => {
  it('returns payload as provided for valid input', () => {
    expect(parseStartPayload('src_CAMPAIGN-01')).toBe('src_CAMPAIGN-01');
  });

  it('supports dot prefix and special characters while preserving case', () => {
    expect(parseStartPayload('  src.Campaign+Q1   extra  ')).toBe('src.Campaign+Q1');
  });

  it('trims whitespace and ignores extra tokens', () => {
    expect(parseStartPayload('  src_demo   extra  ')).toBe('src_demo');
  });

  it('returns undefined for invalid pattern', () => {
    expect(parseStartPayload('ref=42')).toBeUndefined();
  });

  it('returns undefined for empty values', () => {
    expect(parseStartPayload('   ')).toBeUndefined();
  });
});
