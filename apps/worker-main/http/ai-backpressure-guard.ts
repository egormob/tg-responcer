import type { IncomingMessage } from '../core';

type KvNamespace = Pick<KVNamespace, 'get' | 'put' | 'delete'>;

export interface AiBackpressureGuardStats {
  activeChats: number;
  bufferedChats: number;
  blockedSinceBoot: number;
  mergedSinceBoot: number;
  truncatedSinceBoot: number;
  kvErrorsSinceBoot: number;
  lastBlockedAt: number | null;
}

export interface GuardTicket {
  chatKey: string;
  ticketId: number;
  kvCounted: boolean;
  kvToken?: string;
}

export type GuardDecision =
  | {
      status: 'proceed';
      ticket: GuardTicket;
    }
  | {
      status: 'buffered';
      ticket: GuardTicket;
    }
  | {
      status: 'blocked';
      reason: 'over_limit' | 'kv_error';
      merged?: boolean;
      truncated?: boolean;
      parts?: number;
      kvError?: boolean;
    };

export interface AiBackpressureGuardOptions {
  /**
   * KV для меж-инстансового подсчёта in-flight. Необязательный, деградирует в локальный режим.
   */
  kv?: {
    namespace: KvNamespace;
    ttlSeconds?: number;
    prefix?: string;
    logger?: {
      warn?: (message: string, details?: Record<string, unknown>) => void;
    };
  };
  /**
   * Максимальная длина склеенного буфера (для длинных сообщений Telegram).
   */
  maxBufferedTextLength?: number;
  now?: () => number;
}

interface ChatState {
  active?: GuardEntry;
  buffer?: BufferEntry;
}

interface GuardEntry {
  ticket: GuardTicket;
  message: IncomingMessage;
}

interface BufferEntry extends GuardEntry {
  parts: number;
  truncated: boolean;
  textParts: string[];
}

const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_KV_TTL_SECONDS = 60;
const DEFAULT_MAX_BUFFERED_TEXT_LENGTH = 3_900;
const DEFAULT_KV_TOKEN_LENGTH = 12;

const toChatKey = (message: IncomingMessage): string =>
  `${message.chat.id}::${message.chat.threadId ?? ''}`;

const appendToBuffer = (
  buffer: BufferEntry,
  text: string,
  maxLength: number,
): BufferEntry => {
  const separator = buffer.textParts.length > 0 ? '\n\n' : '';
  const combined = `${buffer.textParts.join('\n\n')}${separator}${text}`;

  let truncated = buffer.truncated;
  let nextText = combined;

  if (combined.length > maxLength) {
    truncated = true;
    nextText = combined.slice(0, maxLength);
  }

  const nextParts = [...buffer.textParts, text];

  return {
    ...buffer,
    truncated,
    parts: nextParts.length,
    textParts: nextText.split('\n\n'),
    message: {
      ...buffer.message,
      text: nextText,
    },
  };
};

const mergeBufferedText = (buffer: BufferEntry): BufferEntry => ({
  ...buffer,
  message: {
    ...buffer.message,
    text: buffer.textParts.join('\n\n'),
  },
});

export const createAiBackpressureGuard = (options: AiBackpressureGuardOptions) => {
  const now = options.now ?? (() => Date.now());
  const maxBufferedTextLength = Math.max(1, Math.floor(options.maxBufferedTextLength ?? DEFAULT_MAX_BUFFERED_TEXT_LENGTH));
  const kvTokenLength = DEFAULT_KV_TOKEN_LENGTH;

  const kvNamespace = options.kv?.namespace;
  const kvPrefix = options.kv?.prefix ?? 'ai_guard';
  const kvTtlSeconds =
    typeof options.kv?.ttlSeconds === 'number' && Number.isFinite(options.kv.ttlSeconds) && options.kv.ttlSeconds > 0
      ? Math.floor(options.kv.ttlSeconds)
      : DEFAULT_KV_TTL_SECONDS;
  const kvWarn = options.kv?.logger?.warn ?? ((message: string, details?: Record<string, unknown>) => {
    // eslint-disable-next-line no-console
    console.warn(`[ai-guard] ${message}`, details);
  });

  const chats = new Map<string, ChatState>();
  let blockedSinceBoot = 0;
  let mergedSinceBoot = 0;
  let truncatedSinceBoot = 0;
  let kvErrorsSinceBoot = 0;
  let lastBlockedAt: number | null = null;
  let ticketSeq = 0;

  const kvKey = (chatKey: string) => `${kvPrefix}:${chatKey}`;

  const generateToken = (): string => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < kvTokenLength; i += 1) {
      result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return result;
  };

  const acquireKvLock = async (chatKey: string): Promise<{ status: 'ok' | 'blocked' | 'error'; token?: string }> => {
    if (!kvNamespace) {
      return { status: 'ok' };
    }

    try {
      const raw = await kvNamespace.get(kvKey(chatKey), 'text');
      if (typeof raw === 'string' && raw.trim().length > 0) {
        return { status: 'blocked' };
      }

      const token = generateToken();
      await kvNamespace.put(kvKey(chatKey), token, { expirationTtl: kvTtlSeconds });
      return { status: 'ok', token };
    } catch (error) {
      kvWarn('kv lock acquire failed', {
        chatKey,
        error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
      });
      kvErrorsSinceBoot += 1;
      return { status: 'error' };
    }
  };

  const refreshKvLock = async (chatKey: string, token: string) => {
    if (!kvNamespace) {
      return;
    }

    try {
      await kvNamespace.put(kvKey(chatKey), token, { expirationTtl: kvTtlSeconds });
    } catch (error) {
      kvWarn('kv lock refresh failed', {
        chatKey,
        error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
      });
      kvErrorsSinceBoot += 1;
    }
  };

  const releaseKvLock = async (chatKey: string, token?: string) => {
    if (!kvNamespace) {
      return;
    }

    try {
      if (token) {
        const current = await kvNamespace.get(kvKey(chatKey), 'text');
        if (current !== token) {
          return;
        }
      }
      await kvNamespace.delete(kvKey(chatKey));
    } catch (error) {
      kvWarn('kv lock release failed', {
        chatKey,
        error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
      });
      kvErrorsSinceBoot += 1;
    }
  };

  const enter = async (message: IncomingMessage): Promise<GuardDecision> => {
    const chatKey = toChatKey(message);
    const state = chats.get(chatKey) ?? {};

    if (state.buffer) {
      const nextBuffer = appendToBuffer(state.buffer, message.text, maxBufferedTextLength);
      state.buffer = nextBuffer;
      chats.set(chatKey, state);

      blockedSinceBoot += 1;
      mergedSinceBoot += 1;
      if (nextBuffer.truncated) {
        truncatedSinceBoot += 1;
      }
      lastBlockedAt = now();

      return {
        status: 'blocked',
        reason: 'over_limit',
        merged: true,
        truncated: nextBuffer.truncated,
        parts: nextBuffer.parts,
      };
    }

    const activeCount = state.active ? 1 : 0;
    const bufferedCount = state.buffer ? 1 : 0;
    const inFlight = activeCount + bufferedCount;

    if (inFlight >= DEFAULT_MAX_IN_FLIGHT) {
      blockedSinceBoot += 1;
      lastBlockedAt = now();
      return { status: 'blocked', reason: 'over_limit' };
    }

    if (inFlight === 1) {
      ticketSeq += 1;
      const ticket: GuardTicket = {
        chatKey,
        ticketId: ticketSeq,
        kvCounted: state.active?.ticket.kvCounted ?? false,
        kvToken: state.active?.ticket.kvToken,
      };
      const buffer: BufferEntry = {
        ticket,
        message: { ...message },
        textParts: [message.text],
        parts: 1,
        truncated: false,
      };
      state.buffer = buffer;
      chats.set(chatKey, state);

      return { status: 'buffered', ticket };
    }

    const kvStatus = await acquireKvLock(chatKey);
    if (kvStatus.status === 'blocked') {
      blockedSinceBoot += 1;
      lastBlockedAt = now();
      return { status: 'blocked', reason: 'over_limit' };
    }

    if (kvStatus.status === 'error') {
      blockedSinceBoot += 1;
      lastBlockedAt = now();
      return { status: 'blocked', reason: 'kv_error', kvError: true };
    }

    ticketSeq += 1;
    const ticket: GuardTicket = {
      chatKey,
      ticketId: ticketSeq,
      kvCounted: true,
      kvToken: kvStatus.token,
    };
    if (kvStatus.token) {
      await refreshKvLock(chatKey, kvStatus.token);
    }
    state.active = { ticket, message };
    chats.set(chatKey, state);

    return { status: 'proceed', ticket };
  };

  const release = async (ticket: GuardTicket): Promise<{ ticket: GuardTicket; message: IncomingMessage } | null> => {
    const state = chats.get(ticket.chatKey);
    if (!state || !state.active || state.active.ticket.ticketId !== ticket.ticketId) {
      return null;
    }

    const kvCounted = state.active.ticket.kvCounted;
    state.active = undefined;

    if (state.buffer) {
      const promoted = mergeBufferedText(state.buffer);
      state.active = {
        ticket: promoted.ticket,
        message: promoted.message,
      };
      state.buffer = undefined;
      chats.set(ticket.chatKey, state);
      return { ticket: promoted.ticket, message: promoted.message };
    }

    if (kvCounted) {
      await releaseKvLock(ticket.chatKey, ticket.kvToken);
    }

    if (!state.active && !state.buffer) {
      chats.delete(ticket.chatKey);
    }

    return null;
  };

  const getStats = (): AiBackpressureGuardStats => {
    let bufferedChats = 0;
    for (const state of chats.values()) {
      if (state.buffer) {
        bufferedChats += 1;
      }
    }

    return {
      activeChats: chats.size,
      bufferedChats,
      blockedSinceBoot,
      mergedSinceBoot,
      truncatedSinceBoot,
      kvErrorsSinceBoot,
      lastBlockedAt,
    };
  };

  return {
    enter,
    release,
    getStats,
  };
};

export type AiBackpressureGuard = ReturnType<typeof createAiBackpressureGuard>;
