import type { MessagingPort } from '../ports';

export interface TypingIndicatorContext {
  chatId: string;
  threadId?: string;
}

export interface TypingIndicatorRun<T> {
  (): Promise<T>;
}

export interface TypingIndicatorOptions {
  messaging: Pick<MessagingPort, 'sendTyping'>;
  logger?: {
    warn?: (message: string, details?: Record<string, unknown>) => void;
  };
}

export interface TypingIndicator {
  runWithTyping<T>(context: TypingIndicatorContext, run: TypingIndicatorRun<T>): Promise<T>;
}

const createChatKey = (context: TypingIndicatorContext): string =>
  `${context.chatId}::${context.threadId ?? ''}`;

const toErrorDetails = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return { message: 'Unknown error' };
};

export const createTypingIndicator = (options: TypingIndicatorOptions): TypingIndicator => {
  const activeChats = new Map<string, number>();
  const warn = options.logger?.warn;

  const startTyping = async (context: TypingIndicatorContext, key: string) => {
    activeChats.set(key, 1);

    try {
      await options.messaging.sendTyping({
        chatId: context.chatId,
        threadId: context.threadId,
      });
    } catch (error) {
      warn?.('typing-indicator sendTyping failed', {
        chatId: context.chatId,
        threadId: context.threadId,
        ...toErrorDetails(error),
      });
    }
  };

  const incrementRefCount = (key: string) => {
    const current = activeChats.get(key) ?? 0;
    activeChats.set(key, current + 1);
  };

  const releaseChat = (key: string) => {
    const current = activeChats.get(key);
    if (current === undefined) {
      return;
    }

    if (current <= 1) {
      activeChats.delete(key);
      return;
    }

    activeChats.set(key, current - 1);
  };

  return {
    async runWithTyping<T>(context: TypingIndicatorContext, run: TypingIndicatorRun<T>): Promise<T> {
      const key = createChatKey(context);
      const isActive = activeChats.has(key);

      if (isActive) {
        incrementRefCount(key);
      } else {
        await startTyping(context, key);
      }

      try {
        return await run();
      } finally {
        releaseChat(key);
      }
    },
  };
};
