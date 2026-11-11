import { renderNotificationTemplate, type BusinessEvent } from "./domain.js";
import {
  ChannelDeliveryError,
  channelDeliveryIdempotencyKey,
  type ChannelDeliveryCommand,
  type ChannelDeliveryReceipt,
  type DeliveryChannel,
  type EventDeliveryPlanner,
  type OutboxSqlExecutor
} from "./outbox.js";

export interface TelegramConfiguration {
  readonly botToken: string;
  readonly apiBaseUrl: string;
  readonly timeoutMs: number;
}

export type FetchLike = (input: string, init: {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

const CHAT_ID = /^-?\d{1,20}$/u;
const MESSAGE_LIMIT = 4096;

export function isValidTelegramChatId(value: string): boolean {
  return CHAT_ID.test(value.trim());
}

export function telegramConfiguration(environment: NodeJS.ProcessEnv): TelegramConfiguration {
  const botToken = environment.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required when Telegram notifications are enabled");
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/u.test(botToken)) throw new Error("TELEGRAM_BOT_TOKEN has an invalid format");
  const apiBaseUrl = (environment.TELEGRAM_API_BASE_URL?.trim() || "https://api.telegram.org").replace(/\/$/u, "");
  const parsed = new URL(apiBaseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("TELEGRAM_API_BASE_URL must use https");
  }
  const rawTimeout = environment.TELEGRAM_TIMEOUT_MS?.trim() || "15000";
  const timeoutMs = Number(rawTimeout);
  // Не меньше 11 с: иначе наш обрыв срабатывает раньше таймаута подключения Node (10 с),
  // и недоступный Telegram выглядит как «неизвестный исход» без повтора.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 11_000 || timeoutMs > 100_000) {
    throw new Error("TELEGRAM_TIMEOUT_MS must be from 11000 to 100000");
  }
  return { botToken, apiBaseUrl, timeoutMs };
}

/** Текст сообщения: тема жирным не выделяем, чтобы не экранировать разметку. */
export function telegramText(subject: string, body: string): string {
  const text = subject.trim() ? `${subject.trim()}\n\n${body.trim()}` : body.trim();
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
}

export class TelegramClient {
  public constructor(
    private readonly configuration: TelegramConfiguration,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
  ) {}

  /** Вызов Bot API. Токен есть только в URL запроса и никогда не попадает в ошибки. */
  public async call(method: string, payload: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<{ readonly status: number; readonly body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.configuration.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.configuration.apiBaseUrl}/bot${this.configuration.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const body = await response.json().catch(() => undefined);
      return { status: response.status, body };
    } catch (error) {
      // Соединиться не удалось — запрос точно не ушёл, повтор безопасен.
      const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
      // Сюда же таймаут подключения fetch и ошибки TLS-рукопожатия: до запроса дело не дошло.
      if (typeof code === "string" && (
        ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"].includes(code)
        || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || code.includes("CERT")
      )) {
        throw new ChannelDeliveryError("telegram_connection_failed");
      }
      // Таймаут или обрыв после отправки: сообщение могло дойти, повтор дал бы дубль.
      if (method === "sendMessage") throw new ChannelDeliveryError("telegram_delivery_outcome_unknown", false);
      throw new ChannelDeliveryError("telegram_connection_failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

export class TelegramDeliveryChannel implements DeliveryChannel {
  public readonly code = "telegram" as const;

  public constructor(private readonly client: TelegramClient) {}

  public async deliver(command: ChannelDeliveryCommand): Promise<ChannelDeliveryReceipt> {
    if (command.channel !== this.code) throw new ChannelDeliveryError("telegram_channel_mismatch");
    if (!isValidTelegramChatId(command.recipientAddress)) throw new ChannelDeliveryError("telegram_invalid_chat_id", false);
    const { status, body } = await this.client.call("sendMessage", {
      chat_id: command.recipientAddress.trim(),
      text: telegramText(command.subject, command.body),
      disable_web_page_preview: true
    });
    const result = body as { readonly ok?: boolean; readonly result?: { readonly message_id?: number } } | undefined;
    if (status === 200 && result?.ok === true) {
      const messageId = result.result?.message_id;
      return typeof messageId === "number"
        ? { providerMessageId: `telegram:${command.recipientAddress.trim()}:${messageId}` }
        : {};
    }
    if (status === 429 || status >= 500) throw new ChannelDeliveryError("telegram_temporary_failure");
    if (status === 401 || status === 404) throw new ChannelDeliveryError("telegram_bot_token_rejected");
    // 400/403: чат не найден, бот заблокирован или не запущен. Повтор не поможет.
    throw new ChannelDeliveryError("telegram_chat_rejected", false);
  }
}

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`PostgreSQL вернул некорректное поле плана Telegram ${key}`);
  }
  return value;
}

/** Планировщик Telegram: адресаты из load_telegram_event_plan, те же шаблоны, что у e-mail. */
export class PostgresTelegramEventDeliveryPlanner implements EventDeliveryPlanner {
  private readonly publicAppUrl: string;

  public constructor(private readonly database: OutboxSqlExecutor, publicAppUrl: string) {
    const parsed = new URL(publicAppUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("PUBLIC_APP_URL должен использовать http или https");
    }
    this.publicAppUrl = parsed.toString().replace(/\/$/u, "");
  }

  public async plan(event: BusinessEvent): Promise<readonly ChannelDeliveryCommand[]> {
    const result = await this.database.executeSql(
      `SELECT recipient_user_id::text, recipient_address, recipient_name,
              subject_template, body_template, allowed_variables,
              task_id::text, variables
         FROM public.load_telegram_event_plan($1::uuid)`,
      [String(event.id)]
    );
    const commands: ChannelDeliveryCommand[] = [];
    for (const row of result.rows) {
      const chatId = requiredText(row, "recipient_address").trim();
      // Неверный номер чата не должен блокировать остальные доставки события.
      if (!isValidTelegramChatId(chatId)) continue;
      const recipientUserId = requiredText(row, "recipient_user_id");
      const taskId = requiredText(row, "task_id");
      const variables = row.variables;
      if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
        throw new Error("PostgreSQL вернул некорректные переменные шаблона Telegram");
      }
      if (!Array.isArray(row.allowed_variables)) {
        throw new Error("PostgreSQL вернул некорректный список переменных шаблона Telegram");
      }
      const rendered = renderNotificationTemplate({
        subjectTemplate: typeof row.subject_template === "string" ? row.subject_template : "",
        bodyTemplate: requiredText(row, "body_template"),
        allowedVariables: row.allowed_variables as readonly string[]
      }, { ...(variables as Record<string, unknown>), taskUrl: `${this.publicAppUrl}/tasks/${encodeURIComponent(taskId)}` });
      commands.push({
        idempotencyKey: channelDeliveryIdempotencyKey(event, "telegram", recipientUserId),
        eventCode: event.eventCode,
        recipientUserId,
        channel: "telegram",
        recipientAddress: chatId,
        subject: rendered.subject,
        body: rendered.body,
        taskId
      });
    }
    return commands;
  }
}

/**
 * Помощник привязки: сотрудник пишет боту /start, бот отвечает номером чата,
 * администратор вписывает его в карточку сотрудника. Данных из базы бот не выдаёт.
 */
export class TelegramChatIdResponder {
  private offset: number | undefined;

  public constructor(private readonly client: TelegramClient) {}

  public async poll(): Promise<number> {
    const { status, body } = await this.client.call("getUpdates", {
      ...(this.offset === undefined ? {} : { offset: this.offset }),
      timeout: 0,
      allowed_updates: ["message"]
    });
    const parsed = body as { readonly ok?: boolean; readonly result?: readonly Record<string, unknown>[] } | undefined;
    if (status !== 200 || parsed?.ok !== true || !Array.isArray(parsed.result)) return 0;
    let replied = 0;
    for (const update of parsed.result) {
      const updateId = update.update_id;
      if (typeof updateId === "number") this.offset = updateId + 1;
      const message = update.message as { readonly text?: unknown; readonly chat?: { readonly id?: unknown; readonly type?: unknown } } | undefined;
      const chatId = message?.chat?.id;
      if (typeof chatId !== "number" || message?.chat?.type !== "private") continue;
      if (typeof message.text !== "string" || !/^\/(start|id)\b/u.test(message.text.trim())) continue;
      await this.client.call("sendMessage", {
        chat_id: chatId,
        text: `Номер вашего чата: ${chatId}\n\nПередайте его администратору МедТехСервиса, чтобы получать уведомления о задачах здесь.`
      });
      replied += 1;
    }
    return replied;
  }
}
