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
  refreshIntervalMs?: number;
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

interface ActiveChatEntry {
  count: number;
  stopRefresh: () => void;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_REFRESH_INTERVAL_MS = 4_000;

export const createTypingIndicator = (options: TypingIndicatorOptions): TypingIndicator => {
  const activeChats = new Map<string, ActiveChatEntry>();
  const warn = options.logger?.warn;
  const requestedRefreshInterval = options.refreshIntervalMs;
  let refreshInterval = DEFAULT_REFRESH_INTERVAL_MS;

  if (typeof requestedRefreshInterval === 'number') {
    if (Number.isFinite(requestedRefreshInterval) && requestedRefreshInterval > 0) {
      refreshInterval = requestedRefreshInterval;
    } else {
      warn?.('typing-indicator invalid refresh interval, using default', {
        refreshIntervalMs: requestedRefreshInterval,
      });
    }
  } else if (requestedRefreshInterval !== undefined) {
    warn?.('typing-indicator invalid refresh interval, using default', {
      refreshIntervalMs: requestedRefreshInterval,
    });
  }

  const sendTyping = async (context: TypingIndicatorContext) => {
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

  const startRefreshLoop = (context: TypingIndicatorContext) => {
    let cancelled = false;

    const loop = async () => {
      while (!cancelled) {
        await wait(refreshInterval);

        if (cancelled) {
          return;
        }

        await sendTyping(context);
      }
    };

    void loop();

    return () => {
      cancelled = true;
    };
  };

  const ensureActiveEntry = async (context: TypingIndicatorContext, key: string) => {
    const existing = activeChats.get(key);

    if (existing) {
      existing.count += 1;
      return;
    }

    const entry: ActiveChatEntry = {
      count: 1,
      stopRefresh: () => {
        /* noop until loop starts */
      },
    };

    activeChats.set(key, entry);

    await sendTyping(context);

    entry.stopRefresh = startRefreshLoop(context);
  };

  const releaseChat = (key: string) => {
    const entry = activeChats.get(key);
    if (!entry) {
      return;
    }

    if (entry.count <= 1) {
      entry.stopRefresh();
      activeChats.delete(key);
      return;
    }

    entry.count -= 1;
  };

  return {
    async runWithTyping<T>(context: TypingIndicatorContext, run: TypingIndicatorRun<T>): Promise<T> {
      const key = createChatKey(context);
      await ensureActiveEntry(context, key);

      try {
        return await run();
      } finally {
        releaseChat(key);
      }
    },
  };
};
