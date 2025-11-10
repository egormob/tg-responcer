import { describe, expect, it } from 'vitest';

import { parseJsonWithLargeIntegers } from '../parse-json-with-large-integers';

describe('parseJsonWithLargeIntegers', () => {
  it('returns strings for integer tokens with length ≥ 15', () => {
    const payload = '{"id":9223372036854775807,"thread":-9223372036854775808,"small":12345}';

    const parsed = parseJsonWithLargeIntegers(payload) as Record<string, unknown>;

    expect(parsed.id).toBe('9223372036854775807');
    expect(parsed.thread).toBe('-9223372036854775808');
    expect(parsed.small).toBe(12345);
  });
});
