import { describe, expect, it, vi } from 'vitest';

import { transformTelegramUpdate } from '../telegram-webhook';
import type { TelegramUpdate } from '../telegram-webhook';

const createBaseUpdate = (): TelegramUpdate => ({
  update_id: 123,
  message: {
    message_id: 456,
    date: 1_710_000_000,
    text: 'hello world',
    from: {
      id: 789,
      first_name: 'Test',
      username: 'tester',
      language_code: 'en',
    },
    chat: {
      id: 555,
      type: 'private',
    },
  },
});

describe('transformTelegramUpdate', () => {
  it('returns dialog message for regular text update', async () => {
    const result = await transformTelegramUpdate(createBaseUpdate());

    if (!('kind' in result)) {
      throw new Error('Expected discriminated result');
    }

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.text).toBe('hello world');
    expect(result.message.chat.id).toBe('555');
    expect(result.message.user.userId).toBe('789');
    expect(result.message.receivedAt).toBeInstanceOf(Date);
    expect(result.message.messageId).toBe('456');
  });

  it('invokes admin command handler for /admin command', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/admin status';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/admin'.length },
    ];

    const handleAdminCommand = vi.fn().mockResolvedValue(new Response('ok', { status: 202 }));

    const result = await transformTelegramUpdate(update, {
      features: { handleAdminCommand },
    });

    if (!('kind' in result)) {
      throw new Error('Expected discriminated result');
    }

    expect(result.kind).toBe('handled');
    if (result.kind !== 'handled') {
      throw new Error('Expected handled result');
    }

    expect(result.response?.status).toBe(202);

    expect(handleAdminCommand).toHaveBeenCalledTimes(1);
    const context = handleAdminCommand.mock.calls[0][0];
    expect(context.command).toBe('/admin');
    expect(context.rawCommand).toBe('/admin');
    expect(context.argument).toBe('status');
    expect(context.chat.id).toBe('555');
    expect(context.incomingMessage.text).toBe('/admin status');
  });

  it('ignores admin commands for other bots when botUsername provided', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/admin@OtherBot do';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/admin@OtherBot'.length },
    ];

    const result = await transformTelegramUpdate(update, {
      botUsername: 'mybot',
    });

    if (!('kind' in result)) {
      throw new Error('Expected discriminated result');
    }

    expect(result.kind).toBe('message');
    if (result.kind !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.message.text).toBe('/admin@OtherBot do');
  });

  it('returns handled result when admin command has no handler', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    update.message.text = '/admin';
    update.message.entities = [
      { type: 'bot_command', offset: 0, length: '/admin'.length },
    ];

    const result = await transformTelegramUpdate(update);

    if (!('kind' in result)) {
      throw new Error('Expected discriminated result');
    }

    expect(result.kind).toBe('handled');
    if (result.kind !== 'handled') {
      throw new Error('Expected handled result');
    }

    await expect(result.response?.json()).resolves.toEqual({ status: 'ok' });
  });

  it('returns handled ignored result for non-text messages', async () => {
    const update = createBaseUpdate();
    if (!update.message) {
      throw new Error('message is required for test');
    }

    delete update.message.text;

    const result = await transformTelegramUpdate(update);

    if (!('kind' in result)) {
      throw new Error('Expected discriminated result');
    }

    expect(result.kind).toBe('handled');
    if (result.kind !== 'handled') {
      throw new Error('Expected handled result');
    }

    await expect(result.response?.json()).resolves.toEqual({ status: 'ignored' });
  });

  it('returns handled ignored result when no message present', async () => {
    const result = await transformTelegramUpdate({ update_id: 1 });

    if (!('kind' in result)) {
      throw new Error('Expected discriminated result');
    }

    expect(result.kind).toBe('handled');
    if (result.kind !== 'handled') {
      throw new Error('Expected handled result');
    }

    await expect(result.response?.json()).resolves.toEqual({ status: 'ignored' });
  });
});
