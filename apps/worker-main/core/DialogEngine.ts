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

    const timestamp = message.receivedAt;
    await storage.saveUser({
      ...message.user,
      updatedAt: this.now(),
    });

    await storage.appendMessage({
      userId: message.user.userId,
      chatId: message.chat.id,
      threadId: message.chat.threadId,
      role: 'user',
      text: message.text,
      timestamp,
      metadata: message.messageId ? { messageId: message.messageId } : undefined,
    });

    const recentMessages = await storage.getRecentMessages({
      userId: message.user.userId,
      limit: this.recentMessagesLimit,
    });

    await messaging.sendTyping({
      chatId: message.chat.id,
      threadId: message.chat.threadId,
    });

    const aiReply = await ai.reply({
      userId: message.user.userId,
      text: message.text,
      context: this.mapToConversationTurns(recentMessages),
    });

    const replyTimestamp = this.now();
    await storage.appendMessage({
      userId: message.user.userId,
      chatId: message.chat.id,
      threadId: message.chat.threadId,
      role: 'assistant',
      text: aiReply.text,
      timestamp: replyTimestamp,
      metadata: aiReply.metadata,
    });

    const sentMessage = await messaging.sendText({
      chatId: message.chat.id,
      threadId: message.chat.threadId,
      text: aiReply.text,
    });

    return {
      status: 'replied',
      response: {
        text: aiReply.text,
        messageId: sentMessage?.messageId,
      },
    };
  }

  private mapToConversationTurns(messages: StoredMessage[]): ConversationTurn[] {
    return messages.map((message) => ({
      role: message.role,
      text: message.text,
    }));
  }
}
