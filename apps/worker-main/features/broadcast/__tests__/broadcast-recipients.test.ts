import { describe, expect, it, vi } from 'vitest';

import { parseBroadcastRecipients } from '../broadcast-recipients';

describe('parseBroadcastRecipients', () => {
  it('parses JSON arrays with strings and objects', () => {
    const input = JSON.stringify([
      '123',
      { chatId: '456', threadId: '10', username: '@Alice' },
      { chatId: '123', threadId: '10' },
      { chatId: '123' },
    ]);

    const recipients = parseBroadcastRecipients(input);

    expect(recipients).toEqual([
      { chatId: '123', threadId: undefined, username: undefined },
      { chatId: '456', threadId: '10', username: 'alice' },
      { chatId: '123', threadId: '10', username: undefined },
    ]);
  });

  it('accepts comma or newline separated chat identifiers', () => {
    const recipients = parseBroadcastRecipients('111, 222\n333;444');

    expect(recipients).toEqual([
      { chatId: '111', threadId: undefined, username: undefined },
      { chatId: '222', threadId: undefined, username: undefined },
      { chatId: '333', threadId: undefined, username: undefined },
      { chatId: '444', threadId: undefined, username: undefined },
    ]);
  });

  it('supports inline username mapping with "=" or ":" separators', () => {
    const recipients = parseBroadcastRecipients('@bob=555,carol:666');

    expect(recipients).toEqual([
      { chatId: '555', threadId: undefined, username: 'bob' },
      { chatId: '666', threadId: undefined, username: 'carol' },
    ]);
  });

  it('deduplicates recipients by chat and thread identifiers', () => {
    const recipients = parseBroadcastRecipients(
      JSON.stringify([
        { chatId: '123', threadId: '1' },
        { chatId: '123', threadId: '1', username: 'bob' },
        { chatId: '123' },
        '123',
        '123',
      ]),
    );

    expect(recipients).toEqual([
      { chatId: '123', threadId: '1', username: 'bob' },
      { chatId: '123', threadId: undefined, username: undefined },
    ]);
  });

  it('logs warnings and skips invalid entries', () => {
    const warn = vi.fn();

    const recipients = parseBroadcastRecipients('[{"threadId":"x"}, null, true]', { warn });

    expect(recipients).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
