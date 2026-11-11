import type { OutboxSqlExecutor } from "./outbox.js";
import type { SmtpMessage } from "./smtp.js";

/** Отправка автоответа «заявка принята»: SMTP или пробный режим. */
export interface AutoreplySender {
  send(message: Omit<SmtpMessage, "fromAddress" | "fromName">): Promise<void>;
}

export function autoreplyText(taskNumber: string, taskTitle: string): string {
  return [
    "Здравствуйте!",
    "",
    `Ваша заявка принята и зарегистрирована под номером ${taskNumber}.`,
    `Тема: ${taskTitle}`,
    "",
    "Мы сообщим, когда будет назначен инженер. Если нужно что-то уточнить, ответьте на это письмо, указав номер заявки.",
    "",
    "МедТехСервис"
  ].join("\n");
}

function replySubject(subject: string, taskNumber: string): string {
  const base = subject.replace(/[\r\n]+/gu, " ").trim() || "Заявка";
  const re = /^re:/iu.test(base) ? base : `Re: ${base}`;
  return `${re} (заявка ${taskNumber} принята)`.slice(0, 250);
}

/**
 * Автоответы по письмам, из которых создана задача. База отмечает письмо до
 * отправки, поэтому ответ уходит не больше одного раза; ошибка сохраняется.
 */
export async function sendMailAutoreplies(database: OutboxSqlExecutor, sender: AutoreplySender, limit = 20): Promise<{ sent: number; failed: number }> {
  const due = await database.executeSql(
    "SELECT id::text, sender, subject, external_message_id, task_number, task_title FROM public.claim_mail_autoreplies($1)",
    [limit]
  );
  let sent = 0; let failed = 0;
  for (const row of due.rows) {
    const id = String(row.id);
    const taskNumber = String(row.task_number ?? "");
    try {
      // В ответ ставим только корректный Message-ID, иначе SMTP отклонит всё письмо.
      const messageId = typeof row.external_message_id === "string" && /^<[^<>\s]{1,250}>$/u.test(row.external_message_id) ? row.external_message_id : undefined;
      await sender.send({
        messageId: `autoreply-${id}@medtechservice`,
        toAddress: String(row.sender),
        subject: replySubject(String(row.subject ?? ""), taskNumber),
        body: autoreplyText(taskNumber, String(row.task_title ?? "")),
        autoSubmitted: true,
        ...(messageId ? { inReplyTo: messageId } : {})
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      const code = (error as { diagnosticCode?: unknown })?.diagnosticCode;
      await database.executeSql("SELECT public.fail_mail_autoreply($1::uuid, $2)", [id, typeof code === "string" ? code : "autoreply_failed"]).catch(() => undefined);
    }
  }
  return { sent, failed };
}
