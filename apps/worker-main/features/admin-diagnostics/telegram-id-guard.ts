import { getLastTelegramUpdateSnapshot, transformTelegramUpdate } from '../../http/telegram-webhook';

const TELEGRAM_GUARD_UPDATE = {
  update_id: '0',
  message: {
    message_id: 'admin:selftest:guard:message',
    chat: {
      id: 'admin:selftest:guard:chat',
      type: 'private',
    },
    from: {
      id: 'admin:selftest:guard:user',
      first_name: 'Guard',
    },
    voice: {},
  },
} as const;

const SNAPSHOT_FIELDS: Array<'chatIdRaw' | 'chatIdUsed'> = ['chatIdRaw', 'chatIdUsed'];

export const ensureTelegramSnapshotIntegrity = async (): Promise<void> => {
  try {
    await transformTelegramUpdate(TELEGRAM_GUARD_UPDATE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`TELEGRAM_GUARD_FAILED:${message}`);
  }

  const snapshot = getLastTelegramUpdateSnapshot();

  for (const field of SNAPSHOT_FIELDS) {
    const descriptor = snapshot[field];
    if (descriptor?.present === true) {
      const descriptorType = descriptor.type;
      if (descriptorType && descriptorType !== 'string') {
        throw new Error(`TELEGRAM_SNAPSHOT_UNSAFE_CHAT_ID:${field}:${descriptorType}`);
      }
    }
  }
};
