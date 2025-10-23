/**
 * Порты определяют стабильные контракты между ядром и внешними адаптерами.
 * Изменение сигнатур требует bump версии ядра и ревью владельца.
 */

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ConversationTurn {
  readonly role: MessageRole;
  readonly text: string;
}

export interface MessagingPort {
  /**
   * Отправляет индикатор набора текста, чтобы пользователь видел прогресс ответа.
   */
  sendTyping(input: {
    chatId: string;
    threadId?: string;
  }): Promise<void>;

  /**
   * Отправляет финальный текст пользователю.
   */
  sendText(input: {
    chatId: string;
    threadId?: string;
    text: string;
  }): Promise<{ messageId?: string }>;
}

export interface AiPort {
  /**
   * Запрашивает ответ у модели, используя текущий ввод пользователя и контекст диалога.
   */
  reply(input: {
    userId: string;
    text: string;
    context: ReadonlyArray<ConversationTurn>;
  }): Promise<{
    text: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface UserProfile {
  userId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredMessage {
  userId: string;
  chatId: string;
  threadId?: string;
  role: MessageRole;
  text: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface StoragePort {
  /**
   * Создаёт или обновляет профиль пользователя.
   */
  saveUser(input: UserProfile & {
    updatedAt: Date;
  }): Promise<void>;

  /**
   * Добавляет сообщение в историю диалога.
   */
  appendMessage(message: StoredMessage): Promise<void>;

  /**
   * Возвращает хвост истории для формирования контекста ИИ.
   */
  getRecentMessages(input: {
    userId: string;
    limit: number;
  }): Promise<StoredMessage[]>;
}

export interface RateLimitContext {
  chatId?: string;
  threadId?: string;
  scope?: string;
}

export interface RateLimitPort {
  /**
   * Увеличивает счётчик и сообщает, можно ли продолжать диалог.
   */
  checkAndIncrement(input: {
    userId: string;
    context?: RateLimitContext;
  }): Promise<'ok' | 'limit'>;
}
