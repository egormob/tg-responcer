import type {
  AiPort,
  MessagingPort,
  RateLimitPort,
  StoragePort,
  StoredMessage,
  UserProfile,
} from '../ports';

type WarningDetails = Record<string, unknown> | undefined;

const NOOP_PREFIX = '[noop-adapter]';

const stringifyDetails = (details?: WarningDetails) => {
  if (!details) {
    return '';
  }

  try {
    const seen = new WeakSet<object>();

    return JSON.stringify(details, (_key, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }

      if (value && typeof value === 'object') {
        if (seen.has(value as object)) {
          return '[Circular]';
        }

        seen.add(value as object);
      }

      return value;
    });
  } catch (error) {
    console.warn(`${NOOP_PREFIX} warn serialization failed`, error);
    return '';
  }
};

const warn = (target: string, message: string, details?: WarningDetails) => {
  const parts = [NOOP_PREFIX, target, message];
  const suffix = stringifyDetails(details);
  console.warn(parts.filter(Boolean).join(' '), suffix);
};

export interface CreateNoopPortsOptions {
  /**
   * Текст, который будет использован в ответах по умолчанию.
   */
  fallbackText?: string;
}

const getFallbackText = (options?: CreateNoopPortsOptions) =>
  options?.fallbackText ??
  'Ассистент временно недоступен. Пожалуйста, попробуйте позже.';

export const createNoopMessagingPort = (
  options?: CreateNoopPortsOptions,
): MessagingPort => {
  const fallbackText = getFallbackText(options);

  return {
    async sendTyping(input) {
      warn('messaging.sendTyping', 'skip typing indicator', input);
    },
    async sendText(input) {
      warn('messaging.sendText', 'pretend to send message', {
        ...input,
        text: fallbackText,
      });
      return { messageId: undefined };
    },
  };
};

export const createNoopAiPort = (options?: CreateNoopPortsOptions): AiPort => ({
  async reply(input) {
    warn('ai.reply', 'returning fallback response', {
      userId: input.userId,
      contextLength: input.context.length,
    });

    return {
      text: getFallbackText(options),
      metadata: {
        selfTestNoop: true,
        usedOutputText: false,
      },
    };
  },
});

export const createNoopStoragePort = (): StoragePort => ({
  async saveUser(input: UserProfile & { updatedAt: Date }) {
    warn('storage.saveUser', 'noop save', { userId: input.userId });
  },

  async appendMessage(message: StoredMessage) {
    warn('storage.appendMessage', 'noop append', {
      userId: message.userId,
      role: message.role,
    });
  },

  async getRecentMessages(input: { userId: string; limit: number }) {
    warn('storage.getRecentMessages', 'return empty history', input);
    return [] as StoredMessage[];
  },
});

export const createNoopRateLimitPort = (): RateLimitPort => ({
  async checkAndIncrement(input) {
    warn('rateLimit.checkAndIncrement', 'bypass rate limit', input);
    return 'ok';
  },
});

export type NoopPorts = {
  messaging: MessagingPort;
  ai: AiPort;
  storage: StoragePort;
  rateLimit: RateLimitPort;
};

export const createNoopPorts = (options?: CreateNoopPortsOptions): NoopPorts => ({
  messaging: createNoopMessagingPort(options),
  ai: createNoopAiPort(options),
  storage: createNoopStoragePort(),
  rateLimit: createNoopRateLimitPort(),
});
