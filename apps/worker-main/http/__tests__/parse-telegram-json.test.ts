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

  it('handles negative identifiers and migration hints without losing data', () => {
    const migrateToChatId = '-100123456789012345';
    const migrateFromChatId = '-100999999999999999';
    const payload = `{"update_id":9007199254740993,"migrate_to_chat_id":${migrateToChatId},"message":{"message_id":1,"chat":{"id":${migrateFromChatId},"linked_chat_id":-200},"new_chat_member":{"id":-300}}}`;

    const parsed = parseTelegramJson(payload) as Record<string, unknown>;

    expect(parsed.update_id).toBe('9007199254740993');
    expect(parsed.migrate_to_chat_id).toBe(migrateToChatId);

    const message = parsed.message as Record<string, unknown>;
    expect(message.message_id).toBe('1');

    const chat = message.chat as Record<string, unknown>;
    expect(chat.id).toBe(migrateFromChatId);
    expect(chat.linked_chat_id).toBe('-200');

    const member = message.new_chat_member as Record<string, unknown>;
    expect(member.id).toBe('-300');
  });

  it('quotes integer tokens deeply inside nested arrays and objects', () => {
    const payload =
      '{"result":[{"ids":[1,-2,3],"meta":{"owner":45,"tags":[-5,0,6]}},{"value":7}],"migrate_to_chat_id":-100000000000000001}';

    const parsed = parseTelegramJson(payload) as Record<string, unknown>;

    const result = parsed.result as Array<Record<string, unknown>>;
    expect(Array.isArray(result)).toBe(true);

    const first = result[0] as Record<string, unknown>;
    expect(first.ids).toEqual(['1', '-2', '3']);
    expect((first.meta as Record<string, unknown>).owner).toBe('45');
    expect((first.meta as Record<string, unknown>).tags).toEqual(['-5', '0', '6']);

    const second = result[1] as Record<string, unknown>;
    expect(second.value).toBe('7');

    expect(parsed.migrate_to_chat_id).toBe('-100000000000000001');
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
