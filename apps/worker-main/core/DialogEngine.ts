/**
 * FROZEN CORE MODULE.
 * Любые изменения требуют bump версии ядра и ревью владельца.
 */

import type {
  AiPort,
  ConversationTurn,
  MessagingPort,
  RateLimitPort,
  StoragePort,
  StoredMessage,
  UserProfile,
} from '../ports';
import { getFriendlyOverloadMessage } from '../adapters/openai-responses/overload-message';

export interface DialogEngineOptions {
  /**
   * Количество сообщений в истории, которое передаём модели.
   */
  recentMessagesLimit?: number;
}

export interface IncomingMessage {
  user: UserProfile;
  chat: {
    id: string;
    threadId?: string;
  };
  text: string;
  messageId?: string;
  receivedAt: Date;
}

export type DialogEngineResult =
  | {
      status: 'rate_limited';
    }
  | {
      status: 'replied';
      response: {
        text: string;
        messageId?: string;
      };
    };

export interface DialogEngineDeps {
  messaging: MessagingPort;
  ai: AiPort;
  storage: StoragePort;
  rateLimit: RateLimitPort;
  now?: () => Date;
}

export class DialogEngine {
  private readonly recentMessagesLimit: number;
  private readonly now: () => Date;

  constructor(private readonly deps: DialogEngineDeps, options: DialogEngineOptions = {}) {
    this.recentMessagesLimit = options.recentMessagesLimit ?? 15;
    this.now = deps.now ?? (() => new Date());
  }

  async handleMessage(message: IncomingMessage): Promise<DialogEngineResult> {
    const { rateLimit, storage, ai, messaging } = this.deps;

    const limitDecision = await rateLimit.checkAndIncrement({
      userId: message.user.userId,
      context: { chatId: message.chat.id, threadId: message.chat.threadId },
    });

    if (limitDecision === 'limit') {
      return { status: 'rate_limited' };
    }

    const typingPromise = messaging.sendTyping({
      chatId: message.chat.id,
      threadId: message.chat.threadId,
    });
    let typingHandled = false;
    const awaitTyping = async () => {
      try {
        await typingPromise;
      } finally {
        typingHandled = true;
      }
    };
    let mainError: unknown = null;

    const timestamp = message.receivedAt;
    const updatedAt = this.now();

    const saveUserPromise = storage.saveUser({
      ...message.user,
      updatedAt,
    });

    const appendUserMessagePromise = storage.appendMessage({
      userId: message.user.userId,
      chatId: message.chat.id,
      threadId: message.chat.threadId,
      role: 'user',
      text: message.text,
      timestamp,
      metadata: message.messageId ? { messageId: message.messageId } : undefined,
    });

    const recentMessagesPromise = storage.getRecentMessages({
      userId: message.user.userId,
      limit: this.recentMessagesLimit,
    });

    try {
      const [saveUserResult, appendUserMessageResult, recentMessagesResult] = await Promise.allSettled([
        saveUserPromise,
        appendUserMessagePromise,
        recentMessagesPromise,
      ]);

      if (saveUserResult.status === 'rejected') {
        throw saveUserResult.reason;
      }

      if (appendUserMessageResult.status === 'rejected') {
        throw appendUserMessageResult.reason;
      }

      if (recentMessagesResult.status === 'rejected') {
        throw recentMessagesResult.reason;
      }

      await awaitTyping();

      const recentMessages = recentMessagesResult.value;

      let aiReply: Awaited<ReturnType<AiPort['reply']>>;
      try {
        aiReply = await ai.reply({
          userId: message.user.userId,
          text: message.text,
          context: this.mapToConversationTurns(
            this.excludeIncomingMessageFromContext(recentMessages, message),
          ),
          languageCode: message.user.languageCode,
        });
      } catch (error) {
        if (
          error instanceof Error
          && (error.message === 'AI_QUEUE_TIMEOUT' || error.message === 'AI_QUEUE_DROPPED')
        ) {
          aiReply = {
            text: getFriendlyOverloadMessage(message.user.languageCode),
            metadata: {
              degraded: true,
              reason: error.message,
            },
          };
        } else {
          throw error;
        }
      }

      const replyTimestamp = this.now();
      const sentMessage = await this.sendAssistantReply({
        messaging,
        message,
        text: aiReply.text,
      });

      await storage.appendMessage({
        userId: message.user.userId,
        chatId: message.chat.id,
        threadId: message.chat.threadId,
        role: 'assistant',
        text: aiReply.text,
        timestamp: replyTimestamp,
        metadata: this.mergeMetadata(aiReply.metadata, sentMessage?.messageId),
      });

      return {
        status: 'replied',
        response: {
          text: aiReply.text,
          messageId: sentMessage?.messageId,
        },
      };
    } catch (error) {
      mainError = error;
      throw error;
    } finally {
      if (!typingHandled) {
        await typingPromise.catch((typingError) => {
          if (mainError == null) {
            throw typingError;
          }
          return undefined;
        });
      }
    }
  }

  private mapToConversationTurns(messages: StoredMessage[]): ConversationTurn[] {
    return messages.map((message) => ({
      role: message.role,
      text: message.text,
    }));
  }

  private excludeIncomingMessageFromContext(
    messages: StoredMessage[],
    incoming: IncomingMessage,
  ): StoredMessage[] {
    const messageId = incoming.messageId;
    const incomingTimestamp = incoming.receivedAt.getTime();

    return messages.filter((message) => {
      if (message.role !== 'user') {
        return true;
      }

      const storedMessageId = this.extractMessageId(message.metadata);

      if (messageId && storedMessageId === messageId) {
        return false;
      }

      const sameText = message.text === incoming.text;
      const sameTimestamp = message.timestamp.getTime() === incomingTimestamp;

      if (sameText && sameTimestamp) {
        return false;
      }

      return true;
    });
  }

  private extractMessageId(metadata: Record<string, unknown> | undefined): string | undefined {
    const rawMessageId = (metadata as { messageId?: unknown } | undefined)?.messageId;
    return typeof rawMessageId === 'string' ? rawMessageId : undefined;
  }

  private mergeMetadata(
    base: Record<string, unknown> | undefined,
    messageId: string | undefined,
  ): Record<string, unknown> | undefined {
    if (!base && !messageId) {
      return undefined;
    }

    return {
      ...(base ?? {}),
      ...(messageId ? { messageId } : {}),
    };
  }

  private async sendAssistantReply({
    messaging,
    message,
    text,
  }: {
    messaging: MessagingPort;
    message: IncomingMessage;
    text: string;
  }): Promise<{ messageId?: string } | undefined> {
    try {
      return await messaging.sendText({
        chatId: message.chat.id,
        threadId: message.chat.threadId,
        text,
      });
    } catch (error) {
      console.error('[dialog-engine][sendText][error]', {
        chatId: message.chat.id,
        threadId: message.chat.threadId,
        userId: message.user.userId,
        error: this.normalizeError(error),
      });
      throw error;
    }
  }

  private normalizeError(error: unknown): unknown {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return error;
  }
}
