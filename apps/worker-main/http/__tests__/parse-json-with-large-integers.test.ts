import { describe, expect, it } from 'vitest';

import { parseJsonWithLargeIntegers } from '../parse-json-with-large-integers';

describe('parseJsonWithLargeIntegers', () => {
  it('converts 64-bit telegram identifiers to strings', () => {
    const payload = '{"id":9223372036854775807,"channel":-1002003004005006007}';

    const parsed = parseJsonWithLargeIntegers(payload) as Record<string, unknown>;

    expect(parsed.id).toBe('9223372036854775807');
    expect(parsed.channel).toBe('-1002003004005006007');
  });

  it('quotes deeply nested integer tokens inside arrays and objects', () => {
    const payload = '{"ids":[[1,-2,3],[{"thread":9223372036854775807}]],"meta":{"owner":-100}}';

    const parsed = parseJsonWithLargeIntegers(payload) as Record<string, unknown>;

    expect(parsed.ids).toEqual([
      ['1', '-2', '3'],
      [{ thread: '9223372036854775807' }],
    ]);
    expect(parsed.meta).toEqual({ owner: '-100' });
  });

  it('keeps floating point numbers as numeric values', () => {
    const payload = '{"id":12.5,"ratio":0.125}';

    const parsed = parseJsonWithLargeIntegers(payload) as Record<string, unknown>;

    expect(parsed.id).toBe(12.5);
    expect(parsed.ratio).toBe(0.125);
  });

  it('keeps exponential numbers as numeric values', () => {
    const payload = '{"id":1e5,"negative":-2.5e-4}';

    const parsed = parseJsonWithLargeIntegers(payload) as Record<string, unknown>;

    expect(parsed.id).toBe(100000);
    expect(parsed.negative).toBe(-0.00025);
  });

  it('rejects unsafe numeric chat identifiers', () => {
    expect(() => parseJsonWithLargeIntegers('{"chat_id":1e6}')).toThrowError(
      'UNSAFE_TELEGRAM_ID',
    );
  });

  it('preserves large integer tokens as strings to avoid lossy numbers', () => {
    const parsed = parseJsonWithLargeIntegers('{"value":123456789012}') as Record<string, unknown>;

    expect(parsed.value).toBe('123456789012');
  });
});
