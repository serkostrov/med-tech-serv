import { createHash } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { isValidEmailAddress, taskLinkSuitsRecipient } from "./domain.js";
import { taskEmailHtml } from "./email-html.js";
import { ChannelDeliveryError, type ChannelDeliveryCommand, type ChannelDeliveryReceipt, type DeliveryChannel, type OutboxSqlExecutor } from "./outbox.js";
import type { StoredFileReader } from "./storage-upload.js";
import { loadTaskCardFromPlan, type TaskCardData } from "./task-card.js";

export type SmtpStartTlsMode = "disabled" | "optional" | "required";

export interface SmtpConfiguration {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly startTls: SmtpStartTlsMode;
  readonly username?: string;
  readonly password?: string;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly timeoutMs: number;
  /** Имя своего узла в EHLO; по умолчанию домен адреса отправителя. */
  readonly ehloName?: string;
  /**
   * Тестовый стенд: все письма уходят на этот адрес, а в теме видно, кому они предназначались.
   * Так настоящие клиенты из тестовых данных ничего не получают. Пусто — письма идут адресатам.
   */
  readonly testRedirectTo?: string;
}

export interface SmtpMessage {
  readonly messageId: string;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly toAddress: string;
  readonly subject: string;
  /** Текст письма; с html уходит текстовой версией в multipart/alternative. */
  readonly body: string;
  /** HTML-версия письма. Нет — письмо только текстом, как раньше. */
  readonly html?: string;
  /** Message-ID письма, на которое отвечаем, вместе с угловыми скобками. */
  readonly inReplyTo?: string;
  /**
   * Вся переписка по порядку для заголовка References (каждый Message-ID со скобками).
   * Нет — в References уходит одно письмо из inReplyTo, как было раньше.
   */
  readonly references?: readonly string[];
  /** Автоматический ответ (RFC 3834): почтовые программы не отвечают на него автоответом. */
  readonly autoSubmitted?: boolean;
  /** Куда отвечать, если не на адрес отправителя (например, на адрес для заявок). */
  readonly replyTo?: string;
  /** Файлы во вложении (акт в письме «Работы завершены»). Нет — письмо без вложений, как раньше. */
  readonly attachments?: readonly SmtpAttachment[];
}

export interface SmtpAttachment {
  /** Имя файла у получателя, например «Акт З-000123.pdf». */
  readonly fileName: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

export interface SmtpTransport {
  send(message: SmtpMessage): Promise<void>;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required to start e-mail delivery`);
  return value;
}

function booleanEnvironment(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = environment[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function integerEnvironment(environment: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

export function smtpConfiguration(environment: NodeJS.ProcessEnv): SmtpConfiguration {
  const secure = booleanEnvironment(environment, "SMTP_SECURE", false);
  const startTlsValue = environment.SMTP_STARTTLS?.trim().toLowerCase() || (secure ? "disabled" : "required");
  if (!["disabled", "optional", "required"].includes(startTlsValue)) {
    throw new Error("SMTP_STARTTLS must be disabled, optional or required");
  }
  const username = environment.SMTP_USERNAME?.trim();
  const password = environment.SMTP_PASSWORD;
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("SMTP_USERNAME and SMTP_PASSWORD must be configured together");
  }
  const fromAddress = requiredEnvironment(environment, "SMTP_FROM_ADDRESS");
  assertMailbox(fromAddress);
  const host = requiredEnvironment(environment, "SMTP_HOST");
  if (/[\s\r\n]/u.test(host)) throw new Error("SMTP_HOST must be a host name or IP address");
  return {
    host,
    port: integerEnvironment(environment, "SMTP_PORT", secure ? 465 : 587, 1, 65_535),
    secure,
    startTls: startTlsValue as SmtpStartTlsMode,
    ...(username && password ? { username, password } : {}),
    fromAddress,
    fromName: environment.SMTP_FROM_NAME?.trim() || "МедТехСервис",
    // Не больше 30 с: вся сессия (4 × таймаут) должна укладываться в аренду попытки (120 с).
    timeoutMs: integerEnvironment(environment, "SMTP_TIMEOUT_MS", 15_000, 1_000, 30_000),
    ...(environment.SMTP_EHLO_NAME?.trim() ? { ehloName: environment.SMTP_EHLO_NAME.trim() } : {}),
    ...testRedirectConfiguration(environment)
  };
}

function testRedirectConfiguration(environment: NodeJS.ProcessEnv): { readonly testRedirectTo?: string } {
  const value = environment.EMAIL_TEST_REDIRECT_TO?.trim();
  if (!value) return {};
  if (!isValidEmailAddress(value)) throw new Error("EMAIL_TEST_REDIRECT_TO must be an e-mail address");
  return { testRedirectTo: value };
}

/** Письмо для тестового стенда: на один адрес, в теме — кому оно предназначалось. */
export function testRedirectedMessage(message: SmtpMessage, redirectTo: string | undefined): SmtpMessage {
  if (!redirectTo || message.toAddress.toLowerCase() === redirectTo.toLowerCase()) return message;
  return { ...message, toAddress: redirectTo, subject: `[Тест, для ${message.toAddress}] ${message.subject}` };
}

function assertMailbox(value: string): void {
  if (isValidEmailAddress(value)) return;
  throw new ChannelDeliveryError("smtp_invalid_address", false);
}

/** Message-ID в заголовке: ровно <что-то без пробелов и скобок>. */
const MESSAGE_ID = /^<[^<>\s\r\n]{1,250}>$/u;

function assertMessageEnvelope(message: SmtpMessage): void {
  assertMailbox(message.fromAddress);
  assertMailbox(message.toAddress);
  if (message.replyTo !== undefined) assertMailbox(message.replyTo);
  if (/[\r\n]/u.test(message.subject) || /[\r\n]/u.test(message.messageId) || (message.inReplyTo !== undefined && !MESSAGE_ID.test(message.inReplyTo))) {
    throw new ChannelDeliveryError("smtp_invalid_message", false);
  }
  // Чужой Message-ID в References не должен превратиться в свой заголовок письма.
  if (message.references?.some((item) => !MESSAGE_ID.test(item))) {
    throw new ChannelDeliveryError("smtp_invalid_message", false);
  }
}

/**
 * References: переписка по порядку. Заголовок переносим по строкам (RFC 5322, 2.2.3):
 * у долгой переписки он легко перерастёт предел длины строки SMTP.
 */
function referencesHeader(message: SmtpMessage): readonly string[] {
  const chain = message.references?.length ? [...message.references] : message.inReplyTo ? [message.inReplyTo] : [];
  if (chain.length === 0) return [];
  return [`References: ${chain.join("\r\n ")}`];
}

/** Короткий ASCII-заголовок идёт как есть; остальное — словами RFC 2047. */
const PLAIN_HEADER_LIMIT = 200;
/**
 * 39 байт дают 52 символа base64: слово =?UTF-8?B?…?= из 64 символов, и строка заголовка
 * с ним («Subject: » + слово) не длиннее 76 символов, как требует RFC 2047.
 */
const ENCODED_WORD_BYTES = 39;

function isPlainHeader(value: string): boolean {
  return /^[\x20-\x7E]*$/u.test(value) && value.length <= PLAIN_HEADER_LIMIT;
}

/**
 * Заголовок с кириллицей или длинный: словами =?UTF-8?B?…?= по строкам. Символ не делится
 * между словами, строки заголовка короткие — до лимита SMTP в 998 символов далеко.
 */
function encodedHeader(value: string): string {
  if (isPlainHeader(value)) return value;
  const words: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (chunk && bytes + size > ENCODED_WORD_BYTES) {
      words.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

/**
 * Тело в base64 строками по 76 символов: не зависит от поддержки 8BITMIME
 * сервером и от лимита длины строки (998), точка в начале строки невозможна.
 */
function encodedBody(value: string): string {
  return base64Lines(Buffer.from(value.replace(/\r?\n/gu, "\r\n"), "utf8"));
}

function base64Lines(data: Uint8Array): string {
  const base64 = Buffer.from(data).toString("base64");
  return base64.match(/.{1,76}/gu)?.join("\r\n") ?? "";
}

/** Имя в заголовке From: ASCII в кавычках с экранированием, иначе encoded-word. */
function displayName(value: string): string {
  if (isPlainHeader(value)) return `"${value.replace(/["\\]/gu, "\\$&")}"`;
  return encodedHeader(value);
}

/**
 * Граница частей multipart. Части в base64, в его алфавите нет «-», поэтому строка
 * «--=_mts_…» внутри частей встретиться не может.
 */
function mimeBoundary(messageId: string): string {
  return `=_mts_${createHash("sha256").update(messageId).digest("hex").slice(0, 32)}`;
}

function textPart(contentType: "text/plain" | "text/html", value: string): readonly string[] {
  return [`Content-Type: ${contentType}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", encodedBody(value)];
}

/** Тип файла из базы идёт в заголовок только в виде «тип/подтип»: иначе — application/octet-stream. */
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/u;

export function attachmentContentType(value: string): string {
  const type = value.trim().toLowerCase();
  return MIME_TYPE.test(type) ? type : "application/octet-stream";
}

/**
 * Имя файла без управляющих символов, кавычек и путей, не длиннее 80 символов
 * (расширение сохраняется). Пустое — «Вложение».
 */
export function attachmentFileName(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = [...clean];
  if (chars.length === 0) return "Вложение";
  if (chars.length <= 80) return clean;
  const extension = /\.[A-Za-z0-9]{1,10}$/u.exec(clean)?.[0] ?? "";
  return `${chars.slice(0, 80 - extension.length).join("").trimEnd()}${extension}`;
}

/**
 * Часть-вложение. Имя дважды: словами RFC 2047 в name (его читают Outlook и старые программы)
 * и по RFC 2231 в filename* (Gmail, Яндекс, Mail.ru, Apple Mail). Сам файл — base64.
 */
function attachmentPart(attachment: SmtpAttachment): readonly string[] {
  const name = attachmentFileName(attachment.fileName);
  const plain = isPlainHeader(name) && !/[;=]/u.test(name);
  const encoded = encodeURIComponent(name).replace(/['()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return [
    `Content-Type: ${attachmentContentType(attachment.contentType)};`,
    ` name="${plain ? name : encodedHeader(name).replace(/\r\n /gu, " ")}"`,
    "Content-Transfer-Encoding: base64",
    plain ? `Content-Disposition: attachment; filename="${name}"` : `Content-Disposition: attachment;\r\n filename*=UTF-8''${encoded}`,
    "",
    base64Lines(attachment.data)
  ];
}

/**
 * Письмо целиком. С html — multipart/alternative: сначала текст из шаблона, затем HTML
 * (почта показывает последнюю часть, которую умеет). Без html — только текст, как раньше.
 * С вложениями — multipart/mixed: письмо (текст или alternative), затем файлы.
 */
export function smtpMessageData(message: SmtpMessage): string {
  assertMessageEnvelope(message);
  const headers = [
    `Message-ID: <${message.messageId}>`,
    `Date: ${new Date().toUTCString()}`,
    `From: ${displayName(message.fromName)} <${message.fromAddress}>`,
    `To: <${message.toAddress}>`,
    `Subject: ${encodedHeader(message.subject)}`,
    ...(message.replyTo ? [`Reply-To: <${message.replyTo}>`] : []),
    ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...referencesHeader(message),
    ...(message.autoSubmitted ? ["Auto-Submitted: auto-replied"] : []),
    "MIME-Version: 1.0"
  ];
  const boundary = mimeBoundary(message.messageId);
  const content: readonly string[] = message.html
    ? [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      ...textPart("text/plain", message.body),
      `--${boundary}`,
      ...textPart("text/html", message.html),
      `--${boundary}--`
    ]
    : textPart("text/plain", message.body);
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return [...headers, ...content].join("\r\n");
  // Своя граница у внешней части той же длины: ни одна граница не начинается с другой.
  const mixed = mimeBoundary(`${message.messageId}:mixed`);
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    ...content,
    ...attachments.flatMap((attachment) => [`--${mixed}`, ...attachmentPart(attachment)]),
    `--${mixed}--`
  ].join("\r\n");
}

/**
 * RFC 5321, 4.5.2: строке письма, которая начинается с точки, добавляется ещё одна точка.
 * Сейчас таких строк нет (заголовки, границы и base64), но строка «.» не должна закончить DATA
 * раньше времени, даже если формат частей когда-нибудь изменится.
 */
export function dotStuffed(data: string): string {
  return data.replace(/(^|\r\n)\./gu, "$1..");
}

interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

export type SmtpSocket = Socket | TLSSocket;

export interface SmtpConnectionFactory {
  connect(configuration: SmtpConfiguration): SmtpSocket;
  upgrade(socket: SmtpSocket, servername: string): SmtpSocket;
}

const nodeSmtpConnectionFactory: SmtpConnectionFactory = {
  connect(configuration) {
    return configuration.secure
      ? connectTls({ host: configuration.host, port: configuration.port, servername: configuration.host })
      : connectTcp({ host: configuration.host, port: configuration.port });
  },
  upgrade(socket, servername) {
    return connectTls({ socket, servername });
  }
};

class ReplyReader {
  private buffer = "";
  private readonly waiting: Array<{ resolve: (reply: SmtpReply) => void; reject: (error: Error) => void }> = [];
  private readonly replies: SmtpReply[] = [];
  private lines: string[] = [];
  private closed = false;

  public constructor(private socket: SmtpSocket) {
    this.bind(socket);
  }

  public replaceSocket(socket: SmtpSocket): void {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("end");
    this.socket.removeAllListeners("close");
    this.socket = socket;
    this.buffer = "";
    this.bind(socket);
  }

  public next(): Promise<SmtpReply> {
    const reply = this.replies.shift();
    if (reply) return Promise.resolve(reply);
    // Сервер мог закрыть соединение без ответа: не ждём вечно.
    if (this.closed) return Promise.reject(new ChannelDeliveryError("smtp_connection_failed"));
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private bind(socket: SmtpSocket): void {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const end = this.buffer.indexOf("\r\n");
        if (end < 0) break;
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        this.lines.push(line);
        const match = /^(\d{3})([ -])/u.exec(line);
        if (!match || match[2] !== " ") continue;
        const reply = { code: Number(match[1]), lines: this.lines };
        this.lines = [];
        const waiter = this.waiting.shift();
        if (waiter) waiter.resolve(reply);
        else this.replies.push(reply);
      }
    });
    const fail = () => {
      this.closed = true;
      const error = new ChannelDeliveryError("smtp_connection_failed");
      for (const waiter of this.waiting.splice(0)) waiter.reject(error);
    };
    socket.on("error", fail);
    socket.on("end", fail);
    socket.on("close", fail);
  }
}

function waitForConnection(socket: SmtpSocket, event: "connect" | "secureConnect"): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    socket.once("error", reject);
  });
}

function responseIncludes(reply: SmtpReply, capability: string): boolean {
  return reply.lines.some((line) => line.slice(4).toUpperCase().split(/[\s=]/u)[0] === capability);
}

function authMechanisms(reply: SmtpReply): readonly string[] {
  const auth = reply.lines.find((line) => /^\d{3}[ -]AUTH(?:=|\s)/iu.test(line));
  return auth ? auth.slice(4).replace(/^AUTH(?:=|\s)+/iu, "").trim().toUpperCase().split(/\s+/u) : [];
}

function classifyReply(reply: SmtpReply, expected: readonly number[], stage: string): void {
  if (expected.includes(reply.code)) return;
  if (stage === "auth" || reply.code === 535) throw new ChannelDeliveryError("smtp_authentication_failed");
  // Постоянный отказ (5xx) на адресата или на письмо: повтор не поможет и портит репутацию отправителя.
  if (stage === "recipient" && reply.code >= 500) throw new ChannelDeliveryError("smtp_recipient_rejected", false);
  if (stage === "message" && reply.code >= 500) throw new ChannelDeliveryError("smtp_message_rejected", false);
  if (reply.code >= 400 && reply.code < 500) throw new ChannelDeliveryError("smtp_temporary_failure");
  throw new ChannelDeliveryError("smtp_protocol_error");
}

export class NodeSmtpTransport implements SmtpTransport {
  public constructor(
    private readonly configuration: SmtpConfiguration,
    private readonly connectionFactory: SmtpConnectionFactory = nodeSmtpConnectionFactory
  ) {}

  public async send(original: SmtpMessage): Promise<void> {
    // Конверт проверяется до connect(): недоверенные данные не достигают ни
    // SMTP-команд, ни вообще какого-либо socket.write.
    assertMessageEnvelope(original);
    const message = testRedirectedMessage(original, this.configuration.testRedirectTo);
    assertMessageEnvelope(message);
    let socket: SmtpSocket | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let messageSubmitted = false;
    try {
      socket = this.connectionFactory.connect(this.configuration);
      socket.setTimeout(this.configuration.timeoutMs, () => socket?.destroy(new Error("timeout")));
      // Общий предел на всю сессию: медленный сервер не может держать службу бесконечно.
      const sessionSocket = socket;
      deadline = setTimeout(() => sessionSocket.destroy(new Error("deadline")), this.configuration.timeoutMs * 4);
      await waitForConnection(socket, this.configuration.secure ? "secureConnect" : "connect");
      const reader = new ReplyReader(socket);
      classifyReply(await reader.next(), [220], "greeting");
      let capabilities = await this.command(socket, reader, `EHLO ${this.ehloName()}`, [250], "ehlo");

      if (!this.configuration.secure && this.configuration.startTls !== "disabled") {
        if (responseIncludes(capabilities, "STARTTLS")) {
          await this.command(socket, reader, "STARTTLS", [220], "starttls");
          const upgraded = this.connectionFactory.upgrade(socket, this.configuration.host);
          await waitForConnection(upgraded, "secureConnect");
          socket = upgraded;
          reader.replaceSocket(upgraded);
          capabilities = await this.command(socket, reader, `EHLO ${this.ehloName()}`, [250], "ehlo");
        } else if (this.configuration.startTls === "required") {
          throw new ChannelDeliveryError("smtp_starttls_unavailable");
        }
      }

      if (this.configuration.username && this.configuration.password) {
        if (!responseIncludes(capabilities, "AUTH")) throw new ChannelDeliveryError("smtp_authentication_unavailable");
        const mechanisms = authMechanisms(capabilities);
        if (mechanisms.includes("PLAIN")) {
          const credentials = Buffer.from(`\0${this.configuration.username}\0${this.configuration.password}`, "utf8").toString("base64");
          await this.command(socket, reader, `AUTH PLAIN ${credentials}`, [235], "auth");
        } else if (mechanisms.includes("LOGIN")) {
          await this.command(socket, reader, "AUTH LOGIN", [334], "auth");
          await this.command(socket, reader, Buffer.from(this.configuration.username, "utf8").toString("base64"), [334], "auth");
          await this.command(socket, reader, Buffer.from(this.configuration.password, "utf8").toString("base64"), [235], "auth");
        } else {
          throw new ChannelDeliveryError("smtp_authentication_unavailable");
        }
      }

      await this.command(socket, reader, `MAIL FROM:<${message.fromAddress}>`, [250], "sender");
      await this.command(socket, reader, `RCPT TO:<${message.toAddress}>`, [250, 251], "recipient");
      await this.command(socket, reader, "DATA", [354], "data");
      messageSubmitted = true;
      socket.write(`${dotStuffed(smtpMessageData(message))}\r\n.\r\n`);
      classifyReply(await reader.next(), [250], "message");
      // После 250 на DATA сервер уже принял письмо. QUIT закрывает сессию,
      // но его ошибка не должна превращать успешную доставку в повторную.
      await this.command(socket, reader, "QUIT", [221], "quit").catch(() => undefined);
    } catch (error) {
      if (error instanceof ChannelDeliveryError) {
        if (messageSubmitted && error.diagnosticCode === "smtp_connection_failed") {
          throw new ChannelDeliveryError("smtp_delivery_outcome_unknown", false);
        }
        throw error;
      }
      if (messageSubmitted) throw new ChannelDeliveryError("smtp_delivery_outcome_unknown", false);
      throw new ChannelDeliveryError("smtp_connection_failed");
    } finally {
      if (deadline) clearTimeout(deadline);
      socket?.destroy();
    }
  }

  private ehloName(): string {
    const name = this.configuration.ehloName ?? this.configuration.fromAddress.split("@")[1] ?? "localhost";
    return /^[A-Za-z0-9.-]+$/u.test(name) ? name : "localhost";
  }

  private async command(
    socket: SmtpSocket,
    reader: ReplyReader,
    command: string,
    expected: readonly number[],
    stage: string
  ): Promise<SmtpReply> {
    socket.write(`${command}\r\n`);
    const reply = await reader.next();
    classifyReply(reply, expected, stage);
    return reply;
  }
}

function stableMessageId(idempotencyKey: string, fromAddress: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  const domain = fromAddress.split("@")[1] ?? "medtech.invalid";
  return `${digest}@${domain}`;
}

/**
 * Сколько ждать данных для HTML-письма: дольше — письмо уходит только текстом.
 * Ожидание идёт до SMTP-сессии и входит в ту же аренду попытки.
 */
const TASK_CARD_TIMEOUT_MS = 5_000;
/** Gmail обрезает письма больше ~100 КБ; наше письмо около 9 КБ, больший HTML не отправляем (страховка). */
const TASK_HTML_LIMIT_BYTES = 64 * 1024;

/** Данные письма о задаче; undefined, если их не удалось получить (тогда письмо уйдёт только текстом). */
export interface EmailTaskCardSource {
  load(delivery: ChannelDeliveryCommand): Promise<TaskCardData | undefined>;
}

/**
 * Данные карточки берём из той же функции базы, что и план рассылки (как у Telegram): при отправке
 * у доставки есть номер события, функция отдаёт переменные задачи для этого получателя.
 */
export class PostgresEmailTaskCardSource implements EmailTaskCardSource {
  public constructor(private readonly database: OutboxSqlExecutor) {}

  public load(delivery: ChannelDeliveryCommand): Promise<TaskCardData | undefined> {
    return loadTaskCardFromPlan(this.database, "email", delivery);
  }
}

/**
 * Акт больше 10 МБ к письму не прикладываем: в base64 он вырастет на треть, а Gmail и Яндекс
 * принимают письма до 25 МБ. Акт — скан или фото, обычно до 2–3 МБ.
 */
export const ACT_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;
/** Сколько ждать акт из базы и хранилища; дольше — письмо уходит без вложения. */
const ACT_TIMEOUT_MS = 25_000;

/** Акт к письму «Работы завершены»; undefined — письмо уходит без вложения. */
export interface EmailActSource {
  load(delivery: ChannelDeliveryCommand): Promise<SmtpAttachment | undefined>;
}

/** Имя файла акта у клиента: «Акт З-000123.pdf» — номер задачи и расширение исходного файла. */
export function actFileName(taskNumber: string | undefined, originalName: string): string {
  const extension = /\.([A-Za-z0-9]{1,10})$/u.exec(originalName.trim())?.[1]?.toLowerCase();
  const number = taskNumber?.trim();
  return `Акт${number ? ` ${number}` : ""}${extension ? `.${extension}` : ""}`;
}

/**
 * Акт задачи: база по номеру события отдаёт файл принятого акта (0068), файл берём из хранилища.
 * Только для письма «Работы завершены» — в остальных письмах вложений нет.
 */
export class PostgresEmailActSource implements EmailActSource {
  public constructor(
    private readonly database: OutboxSqlExecutor,
    private readonly files: StoredFileReader,
    private readonly limitBytes = ACT_ATTACHMENT_LIMIT_BYTES
  ) {}

  public async load(delivery: ChannelDeliveryCommand): Promise<SmtpAttachment | undefined> {
    if (delivery.eventCode !== "task_work_completed" || !delivery.outboxEventId) return undefined;
    const result = await this.database.executeSql(
      "SELECT task_number, storage_key, original_name, content_type, byte_size FROM public.task_act_for_event($1::uuid)",
      [delivery.outboxEventId]
    );
    const row = result.rows[0];
    if (!row || typeof row.storage_key !== "string" || typeof row.original_name !== "string") return undefined;
    const size = Number(row.byte_size);
    if (!Number.isFinite(size) || size <= 0 || size > this.limitBytes) return undefined;
    const data = await this.files.get(row.storage_key, this.limitBytes);
    if (!data) return undefined;
    return {
      fileName: actFileName(typeof row.task_number === "string" ? row.task_number : undefined, row.original_name),
      contentType: typeof row.content_type === "string" ? row.content_type : "application/octet-stream",
      data
    };
  }
}

export interface SmtpDeliveryOptions {
  /** Адрес CRM: кнопка «Открыть задачу» в HTML-письме. */
  readonly publicAppUrl?: string;
  /** Данные для HTML-письма о задаче. Нет источника или данных — письмо только текстом. */
  readonly cards?: EmailTaskCardSource;
  readonly cardTimeoutMs?: number;
  /** Акт во вложении письма «Работы завершены». Нет источника — письмо без вложения. */
  readonly acts?: EmailActSource;
  readonly actTimeoutMs?: number;
}

async function withinTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, timeoutMs, undefined); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class SmtpDeliveryChannel implements DeliveryChannel {
  public readonly code = "email" as const;
  private readonly publicAppUrl: string | undefined;

  public constructor(
    private readonly configuration: Pick<SmtpConfiguration, "fromAddress" | "fromName">,
    private readonly transport: SmtpTransport,
    private readonly options: SmtpDeliveryOptions = {}
  ) {
    this.publicAppUrl = options.publicAppUrl?.replace(/\/$/u, "");
  }

  public async deliver(command: ChannelDeliveryCommand): Promise<ChannelDeliveryReceipt> {
    if (command.channel !== this.code) throw new ChannelDeliveryError("smtp_channel_mismatch");
    return this.send(command);
  }

  private async send(command: ChannelDeliveryCommand): Promise<ChannelDeliveryReceipt> {
    const messageId = stableMessageId(command.idempotencyKey, this.configuration.fromAddress);
    const act = await this.taskAct(command);
    const html = await this.taskHtml(command, act !== undefined);
    await this.transport.send({
      messageId,
      fromAddress: this.configuration.fromAddress,
      fromName: this.configuration.fromName,
      toAddress: command.recipientAddress,
      subject: command.subject,
      body: act ? `${command.body.trimEnd()}\n\nАкт выполненных работ — во вложении к письму.` : command.body,
      ...(html ? { html } : {}),
      ...(act ? { attachments: [act] } : {})
    });
    return { providerMessageId: messageId };
  }

  /**
   * Акт для письма «Работы завершены». Нет акта, сбой хранилища или долгий ответ — undefined,
   * и письмо уходит без вложения: из-за акта уведомление не задерживается и не теряется.
   */
  private async taskAct(command: ChannelDeliveryCommand): Promise<SmtpAttachment | undefined> {
    const acts = this.options.acts;
    if (!acts || command.eventCode !== "task_work_completed") return undefined;
    try {
      const act = await withinTimeout(acts.load(command), this.options.actTimeoutMs ?? ACT_TIMEOUT_MS);
      if (!act) console.warn(`Письмо «Работы завершены» уходит без акта: акт не найден или больше ${ACT_ATTACHMENT_LIMIT_BYTES / 1024 / 1024} МБ`);
      return act;
    } catch (error) {
      console.warn(`Письмо «Работы завершены» уходит без акта: ${error instanceof Error ? error.message : "ошибка чтения файла"}`);
      return undefined;
    }
  }

  /**
   * HTML-версия письма о задаче. Данные ищутся по исходному адресу доставки: тестовый режим
   * меняет адрес позже, в транспорте. Нет данных, сбой или долгий ответ базы — undefined,
   * и письмо уходит только текстом: из-за HTML доставка не ломается.
   */
  private async taskHtml(command: ChannelDeliveryCommand, actAttached = false): Promise<string | undefined> {
    const cards = this.options.cards;
    if (!cards) return undefined;
    try {
      const card = await withinTimeout(cards.load(command), this.options.cardTimeoutMs ?? TASK_CARD_TIMEOUT_MS);
      if (!card) return undefined;
      const taskUrl = command.taskId && this.publicAppUrl && taskLinkSuitsRecipient(command.eventCode)
        ? `${this.publicAppUrl}/tasks/${encodeURIComponent(command.taskId)}`
        : undefined;
      const html = taskEmailHtml(card, { subject: command.subject, ...(taskUrl ? { taskUrl } : {}), ...(actAttached ? { actAttached } : {}) });
      return Buffer.byteLength(html, "utf8") <= TASK_HTML_LIMIT_BYTES ? html : undefined;
    } catch {
      return undefined;
    }
  }
}
