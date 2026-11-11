import { createHash } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { isValidEmailAddress } from "./domain.js";
import { ChannelDeliveryError, type ChannelDeliveryCommand, type ChannelDeliveryReceipt, type DeliveryChannel } from "./outbox.js";

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
}

export interface SmtpMessage {
  readonly messageId: string;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly toAddress: string;
  readonly subject: string;
  readonly body: string;
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
    ...(environment.SMTP_EHLO_NAME?.trim() ? { ehloName: environment.SMTP_EHLO_NAME.trim() } : {})
  };
}

function assertMailbox(value: string): void {
  if (isValidEmailAddress(value)) return;
  throw new ChannelDeliveryError("smtp_invalid_address", false);
}

function assertMessageEnvelope(message: SmtpMessage): void {
  assertMailbox(message.fromAddress);
  assertMailbox(message.toAddress);
  if (/[\r\n]/u.test(message.subject) || /[\r\n]/u.test(message.messageId)) {
    throw new ChannelDeliveryError("smtp_invalid_message", false);
  }
}

function encodedHeader(value: string): string {
  if (/^[\x20-\x7E]*$/u.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Тело в base64 строками по 76 символов: не зависит от поддержки 8BITMIME
 * сервером и от лимита длины строки (998), точка в начале строки невозможна.
 */
function encodedBody(value: string): string {
  const base64 = Buffer.from(value.replace(/\r?\n/gu, "\r\n"), "utf8").toString("base64");
  return base64.match(/.{1,76}/gu)?.join("\r\n") ?? "";
}

/** Имя в заголовке From: ASCII в кавычках с экранированием, иначе encoded-word. */
function displayName(value: string): string {
  if (/^[\x20-\x7E]*$/u.test(value)) return `"${value.replace(/["\\]/gu, "\\$&")}"`;
  return encodedHeader(value);
}

export function smtpMessageData(message: SmtpMessage): string {
  assertMessageEnvelope(message);
  return [
    `Message-ID: <${message.messageId}>`,
    `Date: ${new Date().toUTCString()}`,
    `From: ${displayName(message.fromName)} <${message.fromAddress}>`,
    `To: <${message.toAddress}>`,
    `Subject: ${encodedHeader(message.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody(message.body)
  ].join("\r\n");
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

  public async send(message: SmtpMessage): Promise<void> {
    // Конверт проверяется до connect(): недоверенные данные не достигают ни
    // SMTP-команд, ни вообще какого-либо socket.write.
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
      socket.write(`${smtpMessageData(message)}\r\n.\r\n`);
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

export class SmtpDeliveryChannel implements DeliveryChannel {
  public readonly code = "email" as const;

  public constructor(
    private readonly configuration: Pick<SmtpConfiguration, "fromAddress" | "fromName">,
    private readonly transport: SmtpTransport
  ) {}

  public async deliver(command: ChannelDeliveryCommand): Promise<ChannelDeliveryReceipt> {
    if (command.channel !== this.code) throw new ChannelDeliveryError("smtp_channel_mismatch");
    return this.send(command);
  }

  private async send(command: ChannelDeliveryCommand): Promise<ChannelDeliveryReceipt> {
    const messageId = stableMessageId(command.idempotencyKey, this.configuration.fromAddress);
    await this.transport.send({
      messageId,
      fromAddress: this.configuration.fromAddress,
      fromName: this.configuration.fromName,
      toAddress: command.recipientAddress,
      subject: command.subject,
      body: command.body
    });
    return { providerMessageId: messageId };
  }
}
