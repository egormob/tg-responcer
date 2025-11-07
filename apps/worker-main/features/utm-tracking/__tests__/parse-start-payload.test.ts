import { describe, expect, it } from 'vitest';

import { parseStartPayload } from '../parse-start-payload';

describe('parseStartPayload', () => {
  it('returns normalized payload for valid input', () => {
    expect(parseStartPayload('src_CAMPAIGN-01')).toBe('src_campaign-01');
  });

  it('trims whitespace and ignores extra tokens', () => {
    expect(parseStartPayload('  SRC_demo   extra  ')).toBe('src_demo');
  });

  it('returns undefined for invalid pattern', () => {
    expect(parseStartPayload('ref=42')).toBeUndefined();
  });

  it('returns undefined for empty values', () => {
    expect(parseStartPayload('   ')).toBeUndefined();
  });
});
