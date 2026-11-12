import { renderNotificationTemplate, type BusinessEvent } from "./domain.js";
import { chatIdWidgetHtml, clipText, escapeHtml, taskWidgetHtml, WIDGET_CAPTION_LIMIT, widgetFitsLimits, type TaskWidgetData } from "./telegram-widget.js";
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
      if (method === "sendMessage" || method === "sendWidget") throw new ChannelDeliveryError("telegram_delivery_outcome_unknown", false);
      throw new ChannelDeliveryError("telegram_connection_failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Данные для карточки задачи; undefined, если их не удалось получить (тогда уйдёт обычное сообщение). */
export interface TelegramTaskCardSource {
  load(delivery: ChannelDeliveryCommand): Promise<TaskWidgetData | undefined>;
}

/**
 * Данные карточки берём из той же функции базы, что и план рассылки: при отправке у доставки
 * есть номер события, функция отдаёт переменные задачи для этого получателя.
 */
export class PostgresTelegramTaskCardSource implements TelegramTaskCardSource {
  public constructor(private readonly database: OutboxSqlExecutor) {}

  public async load(delivery: ChannelDeliveryCommand): Promise<TaskWidgetData | undefined> {
    if (!delivery.outboxEventId) return undefined;
    const result = await this.database.executeSql(
      "SELECT recipient_address, variables FROM public.load_telegram_event_plan($1::uuid)",
      [delivery.outboxEventId]
    );
    const row = result.rows.find((item) => typeof item.recipient_address === "string" && item.recipient_address.trim() === delivery.recipientAddress.trim());
    const variables = row?.variables;
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) return undefined;
    const text = (key: string): string | undefined => {
      const value = (variables as Record<string, unknown>)[key];
      return typeof value === "string" && value.trim() ? value : undefined;
    };
    return {
      eventCode: delivery.eventCode,
      ...optional("taskNumber", text("taskNumber")),
      ...optional("taskTitle", text("taskTitle")),
      ...optional("siteName", text("siteName")),
      ...optional("engineerName", text("engineerName")),
      ...optional("periodFrom", text("periodFrom")),
      ...optional("periodTo", text("periodTo")),
      ...optional("reworkComment", text("reworkComment"))
    };
  }
}

function optional<K extends string>(key: K, value: string | undefined): { readonly [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: string };
}

/**
 * Обычное сообщение, если виджет не получился: заголовок жирным, текст без ссылки
 * на карточку (она в кнопке). Разметка HTML, текст из шаблона экранирован.
 */
export function telegramHtmlText(subject: string, body: string, taskUrl?: string): string {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n").filter((line) => !taskUrl || !line.includes(taskUrl));
  const trimEnd = (): void => { while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop(); };
  trimEnd();
  // Подпись к ссылке («Карточка задачи:») без самой ссылки не нужна.
  const last = lines[lines.length - 1] ?? "";
  if (taskUrl && /:\s*$/u.test(last) && /карточк/iu.test(last)) lines.pop();
  trimEnd();
  const title = clipText(subject, 256);
  const text = lines.join("\n").trim();
  // Лимит Telegram 4096 символов после разметки: заголовок и текст укладываем с запасом.
  const clipped = [...text].length > 3_700 ? `${[...text].slice(0, 3_699).join("").trimEnd()}…` : text;
  if (!title) return escapeHtml(clipped);
  return clipped ? `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(clipped)}` : `<b>${escapeHtml(title)}</b>`;
}

function failDelivery(status: number): never {
  if (status === 429 || status >= 500) throw new ChannelDeliveryError("telegram_temporary_failure");
  if (status === 401 || status === 404) throw new ChannelDeliveryError("telegram_bot_token_rejected");
  // 400/403: чат не найден, бот заблокирован или не запущен. Повтор не поможет.
  throw new ChannelDeliveryError("telegram_chat_rejected", false);
}

function deliveryReceipt(chatId: string, body: unknown): ChannelDeliveryReceipt {
  const result = body as { readonly result?: { readonly message_id?: number } } | undefined;
  const messageId = result?.result?.message_id;
  return typeof messageId === "number" ? { providerMessageId: `telegram:${chatId}:${messageId}` } : {};
}

function isOk(status: number, body: unknown): boolean {
  return status === 200 && (body as { readonly ok?: boolean } | undefined)?.ok === true;
}

export class TelegramDeliveryChannel implements DeliveryChannel {
  public readonly code = "telegram" as const;
  private readonly publicAppUrl: string | undefined;

  public constructor(
    private readonly client: TelegramClient,
    private readonly options: { readonly publicAppUrl?: string; readonly cards?: TelegramTaskCardSource } = {}
  ) {
    this.publicAppUrl = options.publicAppUrl?.replace(/\/$/u, "");
  }

  public async deliver(command: ChannelDeliveryCommand): Promise<ChannelDeliveryReceipt> {
    if (command.channel !== this.code) throw new ChannelDeliveryError("telegram_channel_mismatch");
    if (!isValidTelegramChatId(command.recipientAddress)) throw new ChannelDeliveryError("telegram_invalid_chat_id", false);
    const chatId = command.recipientAddress.trim();
    const taskUrl = command.taskId && this.publicAppUrl ? `${this.publicAppUrl}/tasks/${encodeURIComponent(command.taskId)}` : undefined;
    // Ссылка на карточку — кнопкой под сообщением, а не длинной строкой в тексте.
    const replyMarkup = taskUrl ? { inline_keyboard: [[{ text: "Открыть задачу", url: taskUrl }]] } : undefined;

    // Сначала карточка-виджет. Нет данных или Telegram её не принял (400) — обычное сообщение.
    let card: TaskWidgetData | undefined;
    try {
      card = await this.options.cards?.load(command);
    } catch {
      card = undefined;
    }
    const html = card ? taskWidgetHtml(card) : undefined;
    if (html && widgetFitsLimits(html)) {
      const caption = clipText(command.subject, WIDGET_CAPTION_LIMIT) ?? `${card?.taskNumber ?? "Задача"}`;
      const { status, body } = await this.client.call("sendWidget", {
        chat_id: chatId,
        html,
        caption,
        show_caption_above_media: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      });
      if (isOk(status, body)) return deliveryReceipt(chatId, body);
      if (status !== 400) failDelivery(status);
    }

    const { status, body } = await this.client.call("sendMessage", {
      chat_id: chatId,
      text: telegramHtmlText(command.subject, command.body, taskUrl),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    if (isOk(status, body)) return deliveryReceipt(chatId, body);
    return failDelivery(status);
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
      // Карточка с номером и кнопкой «Скопировать номер»; если виджет не принят — обычный текст.
      const widget = await this.client.call("sendWidget", {
        chat_id: chatId,
        html: chatIdWidgetHtml(String(chatId)),
        caption: `Номер вашего чата: ${chatId}`
      });
      if (!isOk(widget.status, widget.body)) {
        await this.client.call("sendMessage", {
          chat_id: chatId,
          text: `Номер вашего чата: ${chatId}\n\nПередайте его администратору МедТехСервиса, чтобы получать уведомления о задачах здесь.`
        });
      }
      replied += 1;
    }
    return replied;
  }
}
