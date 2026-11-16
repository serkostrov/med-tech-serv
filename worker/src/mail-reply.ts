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
  const value = error as { code?: unknown; diagnosticCode?: unknown; name?: unknown } | undefined;
  if (typeof value?.diagnosticCode === "string") return value.diagnosticCode;
  if (typeof value?.code === "string") return value.code;
  return typeof value?.name === "string" ? value.name : "reply_failed";
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
      await database.executeSql("SELECT public.fail_task_mail_reply($1::uuid, $2)", [id, errorCode(error)]).catch(() => undefined);
    }
  }
  return { sent, failed };
}
