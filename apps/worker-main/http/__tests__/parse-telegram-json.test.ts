import { describe, expect, it } from 'vitest';

import { parseTelegramJson } from '../parse-telegram-json';

describe('parseTelegramJson', () => {
  it('converts integer tokens to strings', () => {
    const payload = '{"id":123,"thread":-456,"zero":0,"nested":{"value":789}}';

    const parsed = parseTelegramJson(payload) as Record<string, unknown>;

    expect(parsed.id).toBe('123');
    expect(parsed.thread).toBe('-456');
    expect(parsed.zero).toBe('0');
    expect((parsed.nested as Record<string, unknown>).value).toBe('789');
  });

  it('preserves decimals and exponent numbers', () => {
    const payload = '{"decimal":12.34,"exp":1e5,"negativeExp":-1e-3}';

    const parsed = parseTelegramJson(payload) as Record<string, unknown>;

    expect(parsed.decimal).toBe(12.34);
    expect(parsed.exp).toBe(100000);
    expect(parsed.negativeExp).toBe(-0.001);
  });

  it('keeps strings untouched', () => {
    const payload = '{"id":"123"}';

    const parsed = parseTelegramJson(payload) as Record<string, unknown>;

    expect(parsed.id).toBe('123');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseTelegramJson('not json')).toThrow();
  });
});
