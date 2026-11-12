import { createHash } from "node:crypto";
import { simpleParser, type ParsedMail } from "mailparser";
import { ImapFlow } from "imapflow";
import type { AiMailParser } from "./ai-parser.js";
import { mergeDrafts, parseMailByRules } from "./mail-parser.js";
import type { OutboxSqlExecutor } from "./outbox.js";
import type { MailFileStore } from "./storage-upload.js";

/** Письмо из ящика в виде, удобном для разбора. */
export interface IncomingMail {
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly receivedAt: Date;
  readonly raw: Uint8Array;
  /** Автоответ или рассылка (Auto-Submitted, «нет на месте»): заявкой не считаем. */
  readonly automatic?: boolean;
  readonly attachments: ReadonlyArray<{ readonly fileName: string; readonly contentType: string; readonly data: Uint8Array }>;
}

export interface MailIntakeResult {
  readonly fetched: number;
  readonly created: number;
  readonly parsed: number;
  readonly failed: number;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Postgres не принимает нулевой байт в тексте: одно такое письмо остановило бы приём. */
function safeText(value: string): string {
  return value.replace(/\u0000/gu, "");
}

/** Нет связи с базой: это не беда письма, попытки не считаем. */
function isConnectionError(error: unknown): boolean {
  const code = errorCode(error);
  if (/^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|57P0\d|08\w{3})$/u.test(code)) return true;
  // pg при рестарте базы посреди запроса бросает ошибку без кода.
  return /connection terminated/iu.test(String((error as { message?: unknown } | undefined)?.message ?? ""));
}

function errorCode(error: unknown): string {
  const value = error as { code?: unknown; diagnosticCode?: unknown; name?: unknown } | undefined;
  if (typeof value?.diagnosticCode === "string") return value.diagnosticCode;
  if (typeof value?.code === "string") return value.code;
  return typeof value?.name === "string" ? value.name : "unknown";
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n\s*\n+/gu, "\n\n")
    .trim();
}

export async function toIncomingMail(raw: Uint8Array, fallbackDate: Date): Promise<IncomingMail> {
  const parsed: ParsedMail = await simpleParser(Buffer.from(raw));
  const from = safeText(parsed.from?.value?.[0]?.address?.trim() ?? "");
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const text = safeText(parsed.text?.trim() || (typeof parsed.html === "string" ? htmlToText(parsed.html) : ""));
  const subject = safeText(parsed.subject?.trim() ?? "");
  // Без Message-ID дубли не отличить: строим устойчивый ключ из отправителя, даты, темы и текста.
  const fallbackId = `<no-id-${createHash("sha256").update(`${from}\n${(parsed.date ?? fallbackDate).getTime()}\n${subject}\n${text}`).digest("hex").slice(0, 32)}@medtechservice>`;
  const autoSubmitted = String(parsed.headers.get("auto-submitted") ?? "").trim().toLowerCase();
  // Только автоответы («нет на месте»). Письма веб-форм бывают auto-generated, их не пропускаем.
  const automatic = autoSubmitted.startsWith("auto-replied") || parsed.headers.has("x-autoreply") || parsed.headers.has("x-autorespond");
  return {
    ...(automatic ? { automatic: true } : {}),
    messageId: safeText(parsed.messageId?.trim() ?? "") || fallbackId,
    ...(parsed.inReplyTo ? { inReplyTo: safeText(parsed.inReplyTo.trim()) } : {}),
    references: references.map((item) => safeText(item.trim())).filter(Boolean),
    from,
    subject,
    text,
    receivedAt: parsed.date ?? fallbackDate,
    raw,
    attachments: (parsed.attachments ?? [])
      .filter((item) => item.contentDisposition !== "inline" || !item.contentId)
      .filter((item) => item.size <= MAX_ATTACHMENT_BYTES)
      .map((item) => ({ fileName: safeText(item.filename || "вложение"), contentType: item.contentType || "application/octet-stream", data: new Uint8Array(item.content) }))
  };
}

/** Разбор одного письма: очередь, файлы, черновик, поиск прибора по S/N. */
export async function processIncomingMail(
  mail: IncomingMail,
  database: OutboxSqlExecutor,
  files: MailFileStore | undefined,
  ai: AiMailParser | undefined
): Promise<"duplicate" | "parsed" | "failed" | "skipped"> {
  if (!mail.from || mail.automatic) return "skipped";
  const ingested = await database.executeSql(
    "SELECT id::text, created, needs_parse, has_files FROM public.ingest_mail_message($1, $2, $3::text[], $4, $5, $6, $7::timestamptz)",
    [mail.messageId, mail.inReplyTo ?? null, mail.references, mail.from, mail.subject, mail.text, mail.receivedAt.toISOString()]
  );
  const row = ingested.rows[0];
  const mailId = typeof row?.id === "string" ? row.id : undefined;
  // Повтор письма пропускаем, кроме оборванного разбора: его доделываем.
  if (!mailId || row?.needs_parse !== true) return "duplicate";

  // Файлы отдельно: сбой хранилища не мешает разобрать письмо, текст координатор увидит.
  let filesFailed = false;
  if (files && row?.has_files !== true) {
    try {
      const rawKey = await files.put(mailId, "message.eml", "message/rfc822", mail.raw);
      const attachments = [];
      for (const attachment of mail.attachments) {
        const key = await files.put(mailId, attachment.fileName, attachment.contentType, attachment.data);
        attachments.push({ storageKey: key, fileName: attachment.fileName, contentType: attachment.contentType, byteSize: attachment.data.byteLength });
      }
      await database.executeSql("SELECT public.set_mail_attachments($1::uuid, $2, $3::jsonb)", [mailId, rawKey, JSON.stringify(attachments)]);
    } catch (error) {
      filesFailed = true;
      console.error(`Файлы письма не сохранены: ${errorCode(error)}`);
    }
  }

  try {

    const rules = parseMailByRules(mail.subject, mail.text);
    let aiResult;
    try {
      aiResult = ai ? await ai.parse(mail.subject, mail.text) : undefined;
    } catch {
      aiResult = undefined; // нейросеть недоступна: остаётся разбор по правилам
    }
    const result = mergeDrafts(rules, aiResult);
    const serial = result.draft.serialNumber;
    const found = serial
      ? (await database.executeSql("SELECT id::text, serial_number, model, manufacturer, site_name FROM public.find_equipment_by_serial($1)", [serial])).rows[0]
      : undefined;
    let confidence = result.confidence;
    if (serial && !found) confidence = Math.min(confidence, 0.6);
    const payload = {
      summary: result.draft.description?.slice(0, 200) ?? mail.subject,
      client: result.draft.client ?? null,
      contactName: result.draft.contactName ?? null,
      contactPhone: result.draft.contactPhone ?? null,
      equipmentName: result.draft.equipmentName ?? null,
      equipmentSerial: serial ?? null,
      equipmentFound: Boolean(found),
      equipmentId: typeof found?.id === "string" ? found.id : null,
      equipmentLabel: found ? [found.manufacturer, found.model].filter(Boolean).join(" ") : null,
      equipmentSite: found?.site_name ?? null,
      description: result.draft.description ?? null,
      engineerName: result.draft.engineerName ?? null,
      partNumbers: result.draft.partNumbers ?? [],
      source: result.source,
      ...(filesFailed ? { filesFailed: true } : {}),
      // При низкой уверенности координатор видит черновик с пустыми полями и текст письма.
      lowConfidence: confidence < 0.5
    };
    await database.executeSql("SELECT public.set_mail_parse_result($1::uuid, $2::jsonb, $3, 'parsed')", [mailId, safeText(JSON.stringify(payload)), confidence]);
    return "parsed";
  } catch (error) {
    console.error(`Письмо не разобрано: ${errorCode(error)}`);
    // Если и отметка об ошибке не записалась (база недоступна), пусть приём повторит письмо.
    await database.executeSql("SELECT public.set_mail_parse_result($1::uuid, $2::jsonb, 0, 'failed')", [mailId, JSON.stringify({ summary: mail.subject, error: "mail_processing_failed" })]);
    return "failed";
  }
}

export interface ImapSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly password: string;
  readonly mailbox: string;
  readonly sinceDays: number;
  /** Забирать только письма на этот адрес (в нижнем регистре); без него все письма ящика. */
  readonly onlyTo?: string;
}

export function imapSettings(environment: NodeJS.ProcessEnv): ImapSettings {
  const required = (name: string) => {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`${name} is required when MAIL_INTAKE_ENABLED=true`);
    return value;
  };
  const port = Number(environment.IMAP_PORT?.trim() || "993");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("IMAP_PORT must be a port number");
  const sinceDays = Number(environment.MAIL_INTAKE_SINCE_DAYS?.trim() || "3");
  // Ящик для заявок по умолчанию тот же, что для отправки (SMTP): логин и пароль приложения
  // подходят и для чтения, второй раз вводить их не нужно.
  const smtpUser = environment.SMTP_USERNAME?.trim();
  const user = environment.IMAP_USER?.trim() || smtpUser || required("IMAP_USER");
  const password = environment.IMAP_PASSWORD?.trim()
    ? environment.IMAP_PASSWORD
    : smtpUser && user.toLowerCase() === smtpUser.toLowerCase() && environment.SMTP_PASSWORD?.trim()
      ? environment.SMTP_PASSWORD
      : required("IMAP_PASSWORD");
  const onlyTo = intakeAddress(environment.MAIL_INTAKE_ONLY_TO, user);
  return {
    host: required("IMAP_HOST"),
    port,
    secure: (environment.IMAP_SECURE?.trim().toLowerCase() ?? "true") !== "false",
    user,
    password,
    mailbox: environment.IMAP_MAILBOX?.trim() || "INBOX",
    sinceDays: Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : 3,
    ...(onlyTo ? { onlyTo } : {})
  };
}

/**
 * Адрес для заявок в общем ящике. «+zayavki» значит адрес ящика с приставкой:
 * user+zayavki@gmail.com (Gmail и Яндекс доставляют такие письма в тот же ящик).
 * Так в CRM попадают только заявки, а не вся почта ящика.
 */
export function intakeAddress(value: string | undefined, mailboxUser: string): string | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw.startsWith("+")) {
    const at = mailboxUser.lastIndexOf("@");
    if (at <= 0) throw new Error("MAIL_INTAKE_ONLY_TO=+… needs IMAP_USER as an e-mail address");
    const tag = raw.slice(1);
    if (!/^[a-z0-9._-]+$/u.test(tag)) throw new Error("MAIL_INTAKE_ONLY_TO: the tag after + may contain only letters, digits, dot, dash and underscore");
    return `${mailboxUser.slice(0, at).toLowerCase()}+${tag}${mailboxUser.slice(at).toLowerCase()}`;
  }
  if (!/^[^\s@]+@[^\s@]+$/u.test(raw)) throw new Error("MAIL_INTAKE_ONLY_TO must be an e-mail address or +tag");
  return raw;
}

/** Заголовки, где может стоять адрес для заявок. */
const ADDRESS_HEADERS = ["to", "cc", "delivered-to", "x-original-to", "envelope-to"];

/**
 * Письмо адресовано этому адресу: он есть в заголовках To, Cc, Delivered-To, X-Original-To
 * или Envelope-To. Смотрим только заголовки, тело письма не разбираем.
 */
export function addressedTo(source: Uint8Array, address: string): boolean {
  const text = Buffer.from(source).toString("latin1");
  const end = text.search(/\r?\n\r?\n/u);
  // Перенос длинного заголовка на следующую строку убираем, чтобы адрес не разорвался.
  const headers = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/gu, " ");
  const wanted = address.toLowerCase();
  return headers.split(/\r?\n/u).some((line) => {
    const match = /^(to|cc|delivered-to|x-original-to|envelope-to)\s*:(.*)$/iu.exec(line);
    return Boolean(match?.[2]?.toLowerCase().includes(wanted));
  });
}

/**
 * Забор писем из ящика. Ящик открывается только на чтение: флаги писем у заказчика
 * не меняем. Дубли отсекает база по Message-ID, поэтому повторный проход безопасен.
 */
export class ImapMailIntake {
  private lastUid = 0;
  private uidValidity: string | undefined;
  /** Неудачные попытки по номеру письма: после трёх письмо пропускаем, чтобы не держать очередь. */
  private readonly attempts = new Map<number, number>();

  public constructor(
    private readonly settings: ImapSettings,
    private readonly database: OutboxSqlExecutor,
    private readonly files: MailFileStore | undefined,
    private readonly ai: AiMailParser | undefined
  ) {}

  public async poll(): Promise<MailIntakeResult> {
    const client = new ImapFlow({
      host: this.settings.host,
      port: this.settings.port,
      secure: this.settings.secure,
      auth: { user: this.settings.user, pass: this.settings.password },
      logger: false
    });
    // Обрыв соединения imapflow сообщает событием; без обработчика упала бы вся служба.
    client.on("error", (error: unknown) => console.error(`Почтовый ящик: ошибка соединения ${errorCode(error)}`));
    let fetched = 0; let created = 0; let parsed = 0; let failed = 0;
    await client.connect();
    try {
      const mailbox = await client.mailboxOpen(this.settings.mailbox, { readOnly: true });
      // Если сервер перенумеровал письма, начинаем заново по дате (дубли отсечёт база).
      const validity = String(mailbox.uidValidity ?? "");
      if (validity !== this.uidValidity) { this.uidValidity = validity; this.lastUid = 0; this.attempts.clear(); }
      const since = new Date(Date.now() - this.settings.sinceDays * 24 * 60 * 60_000);
      const range = this.lastUid > 0 ? { uid: `${this.lastUid + 1}:*` } : { since };
      const messages: Array<{ uid: number; source: Uint8Array; date: Date }> = [];
      let skippedUid = 0;
      // С адресом для заявок сначала смотрим только адреса в заголовках: обычную почту ящика
      // целиком не скачиваем и не сохраняем, только запоминаем, что её уже видели.
      let sourceRange: typeof range | string | undefined = range;
      const onlyTo = this.settings.onlyTo;
      if (onlyTo) {
        const wanted: number[] = [];
        for await (const message of client.fetch(range, { uid: true, headers: ADDRESS_HEADERS }, { uid: true })) {
          if (message.uid <= this.lastUid) continue;
          if (message.headers && addressedTo(new Uint8Array(message.headers), onlyTo)) wanted.push(message.uid);
          else skippedUid = Math.max(skippedUid, message.uid);
        }
        sourceRange = wanted.length > 0 ? wanted.join(",") : undefined;
      }
      if (sourceRange !== undefined) {
        for await (const message of client.fetch(sourceRange, { uid: true, source: true, internalDate: true }, { uid: true })) {
          if (message.uid <= this.lastUid || !message.source) continue;
          messages.push({ uid: message.uid, source: new Uint8Array(message.source), date: message.internalDate instanceof Date ? message.internalDate : new Date() });
        }
      }
      for (const message of messages.sort((a, b) => a.uid - b.uid)) {
        fetched += 1;
        try {
          const mail = await toIncomingMail(message.source, message.date);
          const outcome = await processIncomingMail(mail, this.database, this.files, this.ai);
          if (outcome === "parsed" || outcome === "failed") created += 1;
          if (outcome === "parsed") parsed += 1;
          if (outcome === "failed") failed += 1;
        } catch (error) {
          // Временный сбой (база недоступна): повторим со следующим проходом.
          // Испорченное письмо после трёх попыток пропускаем, чтобы не держать остальные.
          failed += 1;
          if (isConnectionError(error)) {
            console.error(`Нет связи с базой, письма заберём следующим проходом: ${errorCode(error)}`);
            break;
          }
          const tries = (this.attempts.get(message.uid) ?? 0) + 1;
          if (tries < 3) {
            this.attempts.set(message.uid, tries);
            console.error(`Письмо из ящика не обработано, повтор: ${errorCode(error)}`);
            break;
          }
          this.attempts.delete(message.uid);
          console.error(`Письмо из ящика пропущено после 3 попыток: ${errorCode(error)}`);
        }
        this.attempts.delete(message.uid);
        this.lastUid = Math.max(this.lastUid, message.uid);
      }
      // Пропущенные письма больше не перечитываем, если все заявки до них обработаны:
      // иначе отложенная заявка с меньшим номером потерялась бы.
      const pending = messages.some((message) => message.uid > this.lastUid);
      if (!pending) this.lastUid = Math.max(this.lastUid, skippedUid);
    } finally {
      await client.logout().catch(() => undefined);
    }
    return { fetched, created, parsed, failed };
  }
}
