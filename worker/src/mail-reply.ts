import type { OutboxSqlExecutor } from "./outbox.js";
import type { SmtpMessage } from "./smtp.js";

/** Отправка ответа координатора клиенту: SMTP или пробный режим. */
export interface TaskMailReplySender {
  send(message: Omit<SmtpMessage, "fromAddress" | "fromName">): Promise<void>;
}

/** Message-ID со скобками: такой заголовок примет почтовый сервер. */
const MESSAGE_ID = /^<[^<>\s]{1,250}>$/u;

function messageIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && MESSAGE_ID.test(item));
}

function errorCode(error: unknown): string {
  const value = error as { diagnosticCode?: unknown } | undefined;
  // Только коды канала: их интерфейс переводит на русский. Всё остальное (ECONNRESET,
  // ошибка в коде) — общий код, иначе координатор прочитал бы «Не отправлено: ECONNRESET».
  return typeof value?.diagnosticCode === "string" ? value.diagnosticCode : "channel_delivery_failed";
}

/** Ошибки настройки почты: повтор их не вылечит, а попытки потратит. */
const SETTINGS_ERRORS: ReadonlySet<string> = new Set([
  "smtp_authentication_failed",
  "smtp_authentication_unavailable",
  "smtp_starttls_unavailable",
  "smtp_invalid_address",
  "smtp_invalid_message",
  "smtp_channel_mismatch"
]);

/**
 * Повтор уместен: почтовый сервер не ответил или ответил временным отказом.
 * Неоднозначный исход (связь оборвалась после передачи письма) повторять нельзя —
 * клиент получил бы два одинаковых ответа.
 */
function retryAllowed(error: unknown): boolean {
  const value = error as { retryAllowed?: unknown; diagnosticCode?: unknown } | undefined;
  if (typeof value?.retryAllowed !== "boolean" || typeof value.diagnosticCode !== "string") return false;
  return value.retryAllowed && !SETTINGS_ERRORS.has(value.diagnosticCode);
}

/**
 * Ответы координатора из карточки задачи. База отмечает ответ взятым до отправки,
 * поэтому клиент не получит одно письмо дважды; ошибка сохраняется и видна в карточке.
 *
 * In-Reply-To и References берутся из базы: у клиента это ответ в том же письме,
 * а его ответ по тем же заголовкам вернётся в цепочку задачи.
 */
export async function sendTaskMailReplies(
  database: OutboxSqlExecutor,
  sender: TaskMailReplySender,
  limit = 20
): Promise<{ sent: number; failed: number }> {
  const due = await database.executeSql(
    `SELECT id::text, to_address, subject, body, message_id, in_reply_to, reference_ids, task_number
       FROM public.claim_task_mail_replies($1)`,
    [limit]
  );
  let sent = 0;
  let failed = 0;
  for (const row of due.rows) {
    const id = String(row.id);
    try {
      const inReplyTo = typeof row.in_reply_to === "string" && MESSAGE_ID.test(row.in_reply_to) ? row.in_reply_to : undefined;
      const references = messageIds(row.reference_ids);
      await sender.send({
        messageId: String(row.message_id),
        toAddress: String(row.to_address),
        subject: String(row.subject ?? ""),
        body: String(row.body ?? ""),
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references.length ? { references } : {})
      });
      await database.executeSql("SELECT public.mark_task_mail_reply_sent($1::uuid)", [id]);
      sent += 1;
    } catch (error) {
      failed += 1;
      // Код без текста: в тексте ошибки SMTP бывает адрес клиента и параметры сервера.
      await database.executeSql("SELECT public.fail_task_mail_reply($1::uuid, $2, $3)", [id, errorCode(error), retryAllowed(error)]).catch(() => undefined);
    }
  }
  return { sent, failed };
}
