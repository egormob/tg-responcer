import { describe, expect, it } from 'vitest';

import { parseTelegramUpdateBody } from '../telegram-payload';

describe('parseTelegramUpdateBody', () => {
  it('quotes integer values as strings', () => {
    const payload = parseTelegramUpdateBody('{"id":123,"text":"hello"}');
    expect(payload).toEqual({ id: '123', text: 'hello' });
  });

  it('converts large integers to strings', () => {
    const payload = parseTelegramUpdateBody('{"id":12345678901234567890}');
    expect(payload).toEqual({ id: '12345678901234567890' });
  });

  it('converts negative large integers to strings', () => {
    const payload = parseTelegramUpdateBody('{"id":-123456789012345}');
    expect(payload).toEqual({ id: '-123456789012345' });
  });

  it('handles arrays and nested objects', () => {
    const payload = parseTelegramUpdateBody(
      '{"items":[1,12345678901234567890,{"id":-12345678901234567890}]}'
    );
    expect(payload).toEqual({
      items: ['1', '12345678901234567890', { id: '-12345678901234567890' }],
    });
  });

  it('preserves strings containing digits', () => {
    const payload = parseTelegramUpdateBody('{"id":"12345678901234567890"}');
    expect(payload).toEqual({ id: '12345678901234567890' });
  });

  it('preserves decimal numbers', () => {
    const payload = parseTelegramUpdateBody('{"value":12.34,"exp":1e5}');
    expect(payload).toEqual({ value: 12.34, exp: 100000 });
  });

  it('preserves exponent notation with large exponent values', () => {
    const payload = parseTelegramUpdateBody('{"value":1e-123456789012345}');
    expect(payload).toEqual({ value: 1e-123456789012345 });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseTelegramUpdateBody('not json')).toThrow();
  });
});
