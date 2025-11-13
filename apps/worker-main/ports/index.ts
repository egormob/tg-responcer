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
   *
   * Контракт:
   * - Запрос должен уходить как можно быстрее (в идеале <250 мс от вызова).
   * - Адаптер обязан проглатывать recoverable-ошибки (сетевые сбои, 429) после
   *   ограниченного числа повторов и логировать предупреждение, не прерывая
   *   обработку сообщения.
   * - Метод никогда не должен бросать исключение наружу — ядро продолжает
   *   работу даже без typing-индикации.
   */
  sendTyping(input: {
    chatId: string; // Передаём каноническую строку Telegram без числовых преобразований.
    threadId?: string;
  }): Promise<void>;

  /**
   * Отправляет финальный текст пользователю.
   *
   * Контракт:
   * - Метод обязан пытаться доставить сообщение минимум три раза с
   *   экспоненциальной задержкой и джиттером между повторами.
   * - После исчерпания повторов выбрасывает ошибку, чтобы верхний уровень мог
   *   зафиксировать сбой; при успехе возвращает идентификатор сообщения, если он
   *   доступен у платформы.
   * - Входной текст должен быть очищен от управляющих символов, чтобы Telegram
   *   не отклонял сообщение.
   */
  sendText(input: {
    chatId: string; // Строго строковый идентификатор; адаптер не делает String(value).
    threadId?: string;
    text: string;
  }): Promise<{ messageId?: string }>;

  /**
   * Обновляет текст ранее отправленного сообщения.
   *
   * Контракт:
   * - Метод обязан повторять запрос минимум три раза при временных ошибках.
   * - При окончательном сбое выбрасывает исключение; верхний уровень решает,
   *   как уведомить оператора.
   * - Текст проходит такую же санитизацию, как и при отправке нового
   *   сообщения, чтобы Telegram не отклонял запрос.
   */
  editMessageText(input: {
    chatId: string;
    messageId: string;
    threadId?: string;
    text: string;
  }): Promise<void>;

  /**
   * Удаляет сообщение из чата.
   *
   * Контракт:
   * - Метод повторяет запрос при временных ошибках и выбрасывает исключение
   *   при окончательном сбое.
   * - Если сообщение уже удалено, адаптер должен вернуть успешный результат,
   *   чтобы операция считалась идемпотентной.
   */
  deleteMessage(input: {
    chatId: string; // Любые number/bigint нужно конвертировать заранее.
    messageId: string;
    threadId?: string;
  }): Promise<void>;
}

export type AiQueueConfigSource = 'kv' | 'env' | 'default';

export interface AiQueueConfigSources {
  maxConcurrency: AiQueueConfigSource;
  maxQueueSize: AiQueueConfigSource;
  requestTimeoutMs: AiQueueConfigSource;
  retryMax: AiQueueConfigSource;
  kvConfig: 'AI_QUEUE_CONFIG' | null;
}

export interface AiQueueStats {
  active: number;
  queued: number;
  maxConcurrency: number;
  maxQueue: number;
  droppedSinceBoot: number;
  avgWaitMs: number;
  lastDropAt: number | null;
  requestTimeoutMs?: number;
  retryMax?: number;
  sources?: AiQueueConfigSources;
}

export interface AiPort {
  /**
   * Запрашивает ответ у модели, используя текущий ввод пользователя и контекст диалога.
   *
   * Контракт:
   * - Метод должен укладываться в общий таймаут ≤20 с, включая два повторных
   *   запроса при временных ошибках.
   * - При окончательном сбое выбрасывает исключение с контекстом (requestId,
   *   статус, описание), но без чувствительных данных пользователя.
   * - Возвращаемый текст должен быть безопасным к отображению, без управляющих
   *   символов и не пустым (минимум одно видимое сообщение).
   */
  reply(input: {
    userId: string;
    text: string;
    context: ReadonlyArray<ConversationTurn>;
    languageCode?: string;
  }): Promise<{
    text: string;
    metadata?: Record<string, unknown>;
  }>;
  getQueueStats?(): AiQueueStats;
}

export interface UserProfile {
  userId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  utmSource?: string;
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
   *
   * Контракт:
   * - Операция идемпотентна и атомарна для одного пользователя.
   * - Сохраняется не более 1 КБ метаданных на пользователя, избыточные поля
   *   отбрасываются.
   * - В typical-кейсе выполняется <100 мс; при превышении таймаута адаптер
   *   обязан логировать предупреждение.
   */
  saveUser(input: UserProfile & {
    updatedAt: Date;
  }): Promise<{ utmDegraded: boolean }>;

  /**
   * Добавляет сообщение в историю диалога.
   *
   * Контракт:
   * - Метод должен быть устойчив к повторным вызовам с тем же `messageId`.
   * - Сохраняет сообщения в хронологическом порядке; timestamp принимает UTC.
   * - В случае сбоя выбрасывает ошибку, чтобы верхний уровень решил судьбу
   *   сообщения (повтор или деградация).
   */
  appendMessage(message: StoredMessage): Promise<void>;

  /**
   * Возвращает хвост истории для формирования контекста ИИ.
   *
   * Контракт:
   * - Сообщения возвращаются в порядке возрастания времени (от старых к новым).
   * - Метод не должен возвращать больше `limit` элементов.
   * - При недоступности хранилища возвращает пустой список и логирует
   *   предупреждение вместо выброса ошибки.
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
   *
   * Контракт:
   * - Инкремент выполняется атомарно — гонки между параллельными запросами не
   *   допускаются.
   * - TTL счётчика устанавливается на 24 часа; при сбое обновления TTL адаптер
   *   логирует предупреждение, но продолжает выполнение.
   * - В случае деградации сервис должен по умолчанию пропускать пользователя
   *   (`'ok'`), чтобы не блокировать диалог, и логировать incident-level событие.
   */
  checkAndIncrement(input: {
    userId: string;
    context?: RateLimitContext;
  }): Promise<'ok' | 'limit'>;
}
