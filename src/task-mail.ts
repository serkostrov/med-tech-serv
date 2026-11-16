import type { EquipmentFileResponse, TaskMailAttachment, TaskMailMessage } from "./types.js";

/** Длина ответа в базе (send_task_mail_reply): интерфейс проверяет то же и до отправки. */
export const MAX_TASK_MAIL_REPLY = 20_000;

/**
 * Почему ответ клиенту не отправится. Те же проверки, что в базе: пустой текст
 * и слишком длинное письмо. NULL — ответ можно отправлять.
 */
export function taskMailReplyRefusal(body: string): string | null {
  const text = body.trim();
  if (!text) return "Напишите текст ответа клиенту";
  // Считаем символы, а не единицы UTF-16: база проверяет char_length, и эмодзи
  // не должны съедать лимит вдвое быстрее, чем написано в подсказке.
  if ([...text].length > MAX_TASK_MAIL_REPLY) return `Ответ клиенту длиннее ${MAX_TASK_MAIL_REPLY.toLocaleString("ru")} символов: сократите текст`;
  return null;
}

/**
 * Кому уйдёт ответ: адрес последнего письма клиента в задаче — то же правило,
 * что и у send_task_mail_reply в базе. Координатор видит адрес до отправки.
 */
export function taskMailReplyAddress(messages: readonly TaskMailMessage[]): string | undefined {
  // Письма без разбираемого адреса база тоже пропускает, когда выбирает, кому отвечать.
  const addresses = messages
    .filter((message) => message.direction === "incoming")
    .map((message) => taskMailAuthor(message.author).address)
    .filter((address): address is string => Boolean(address));
  return addresses[addresses.length - 1];
}

/** Имя и адрес из заголовка письма: «Имя <адрес>», «адрес» или только имя. */
export function taskMailAuthor(value: string): { readonly name: string; readonly address?: string } {
  const raw = value.trim();
  const inBrackets = /<([^<>]+)>/u.exec(raw)?.[1]?.trim();
  if (inBrackets) {
    const name = raw.slice(0, raw.indexOf("<")).trim().replace(/^"|"$/gu, "");
    return { name: name || inBrackets, ...(inBrackets ? { address: inBrackets } : {}) };
  }
  if (/^[^\s@]+@[^\s@]+$/u.test(raw)) return { name: raw, address: raw };
  return { name: raw || "Неизвестный отправитель" };
}

/**
 * Что стало с ответом координатора: словами, рядом с самим ответом.
 * Причину неудачи служба сохраняет кодом (в тексте SMTP бывает адрес клиента),
 * поэтому код переводит на русский тот же словарь, что и в журнале уведомлений.
 */
export function taskMailReplyStatus(message: TaskMailMessage, errorText: (code: string) => string = (code) => code): string | undefined {
  if (message.direction !== "outgoing") return undefined;
  if (message.status === "sent") return "Отправлено клиенту";
  // В очереди после неудачи: служба повторит отправку сама, писать заново не нужно.
  const retry = message.error ? `, прошлая попытка не удалась: ${errorText(message.error)}` : "";
  if (message.status === "sending") return `Отправляется${retry}`;
  if (message.status === "queued") return `В очереди на отправку${retry}`;
  return message.error ? `Не отправлено: ${errorText(message.error)}` : "Не отправлено";
}

/** Ответ ещё не ушёл или не ушёл совсем: карточка подсвечивает такой ответ. */
export function taskMailReplyPending(message: TaskMailMessage): boolean {
  return message.direction === "outgoing" && message.status !== "sent";
}

/** Ответ больше не уйдёт сам: координатору нужно написать заново или позвонить. */
export function taskMailReplyLost(message: TaskMailMessage): boolean {
  return message.direction === "outgoing" && message.status === "failed";
}

/**
 * Вложение письма в виде файла задачи: ту же плитку с превью и скачиванием рисует
 * обычная галерея файлов задачи, и права на файл те же (их проверяет база).
 */
export function taskMailAttachmentFile(message: TaskMailMessage, attachment: TaskMailAttachment): EquipmentFileResponse {
  return {
    id: attachment.fileId ?? attachment.storageKey ?? `${message.id}-${attachment.fileName}`,
    kind: "mail_attachment",
    originalName: attachment.fileName,
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
    createdAt: message.occurredAt,
    ...(attachment.storageKey ? { storageKey: attachment.storageKey } : {})
  };
}
