import { describe, expect, it } from 'vitest';

import type { IncomingMessage } from '../../core';
import {
  SYSTEM_COMMAND_DESCRIPTORS,
  createSystemCommandRegistry,
  isCommandAllowedForRole,
  matchSystemCommand,
  normalizeCommand,
} from '../system-commands';

const findDescriptor = (name: string) =>
  SYSTEM_COMMAND_DESCRIPTORS.find((descriptor) => descriptor.name === name)!;

describe('system-commands normalizeCommand', () => {
  it('normalizes bare command names with uppercase letters', () => {
    expect(normalizeCommand('/Start')).toBe('/start');
  });

  it('normalizes admin subcommands when argument matches', () => {
    expect(normalizeCommand('/admin status')).toBe('/admin status');
  });

  it('falls back to bare command when argument is unknown', () => {
    expect(normalizeCommand('/admin something')).toBe('/admin');
  });
});

describe('system-commands roles', () => {
  it('allows /start for global role only', () => {
    const descriptor = findDescriptor('/start');
    expect(isCommandAllowedForRole(descriptor, 'global')).toBe(true);
    expect(isCommandAllowedForRole(descriptor, 'scoped')).toBe(false);
  });

  it('allows /admin status only for scoped role', () => {
    const descriptor = findDescriptor('/admin status');
    expect(isCommandAllowedForRole(descriptor, 'global')).toBe(false);
    expect(isCommandAllowedForRole(descriptor, 'scoped')).toBe(true);
  });

  it('allows broadcast helper commands only for scoped role', () => {
    const everyone = findDescriptor('/everybody');
    const cancel = findDescriptor('/cancel');
    const send = findDescriptor('/send');

    for (const descriptor of [everyone, cancel, send]) {
      expect(isCommandAllowedForRole(descriptor, 'global')).toBe(false);
      expect(isCommandAllowedForRole(descriptor, 'scoped')).toBe(true);
    }
  });
});

describe('system-commands matchSystemCommand', () => {
  it('matches registered scoped command for given user', () => {
    const registry = createSystemCommandRegistry();
    registry.register('/admin status', '42');

    const incoming: IncomingMessage = {
      user: { userId: '42' },
      chat: { id: 'chat-1' },
      text: '/admin status',
      messageId: 'msg-1',
      receivedAt: new Date('2024-05-20T00:00:00.000Z'),
    };

    const outsider: IncomingMessage = {
      ...incoming,
      user: { userId: '7' },
    };

    const allowed = matchSystemCommand('/admin status', incoming, registry);
    expect(allowed?.kind).toBe('match');
    expect(allowed && allowed.kind === 'match' ? allowed.match.command : undefined).toBe(
      '/admin status',
    );

    const mismatch = matchSystemCommand('/admin status', outsider, registry);
    expect(mismatch).toEqual({
      kind: 'role_mismatch',
      command: '/admin status',
      descriptor: findDescriptor('/admin status'),
    });
  });
});
