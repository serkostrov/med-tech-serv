import type { MailInboxRecord } from "./types.js";

/**
 * Вкладки раздела «Письма» (встреча 18.11): главная — «Потенциальные задачи», отдельно письма,
 * по которым задача уже есть, отдельно «Не заявки» (рассылки, реклама, отмеченные вручную)
 * и «Все письма» — весь ящик. Без вкладок тысячи писем почты перемешались бы с заявками.
 */
export type MailBox = "potential" | "tasks" | "junk" | "all";

export const MAIL_BOXES: ReadonlyArray<{ readonly value: MailBox; readonly label: string; readonly hint: string }> = [
  { value: "potential", label: "Потенциальные задачи", hint: "Письма, похожие на заявки: посмотрите и создайте задачу или отметьте «Не требует работы»." },
  { value: "tasks", label: "С задачей", hint: "Письма, по которым задача уже создана, и ответы клиентов по задачам." },
  { value: "junk", label: "Не заявки", hint: "Рассылки и реклама (служба узнаёт их по ссылке «отписаться»), письма не про ремонт и отмеченные «Не требует работы»." },
  { value: "all", label: "Все письма", hint: "Весь ящик целиком." }
];

const OPEN_STATUSES: readonly MailInboxRecord["status"][] = ["pending", "parsed", "failed"];

/** Письмо во вкладке: то же правило, что у запроса к базе (m2-api) и у демо-данных. */
export function mailInBox(mail: Pick<MailInboxRecord, "status" | "notRequest">, box: MailBox): boolean {
  const open = OPEN_STATUSES.includes(mail.status);
  switch (box) {
    case "potential": return open && mail.notRequest !== true;
    case "tasks": return mail.status === "converted" || mail.status === "reply";
    case "junk": return mail.status === "ignored" || (open && mail.notRequest === true);
    default: return true;
  }
}

/** Условие вкладки для PostgREST: одна строка для or(...) или список статусов. */
export function mailBoxFilter(box: MailBox): { readonly statuses?: readonly string[]; readonly or?: string } {
  switch (box) {
    case "potential": return { statuses: OPEN_STATUSES, or: "parsed_payload->>notRequest.is.null,parsed_payload->>notRequest.eq.false" };
    case "tasks": return { statuses: ["converted", "reply"] };
    case "junk": return { or: `status.eq.ignored,and(status.in.(${OPEN_STATUSES.join(",")}),parsed_payload->>notRequest.eq.true)` };
    default: return {};
  }
}

const MONTHS_GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/**
 * Когда пришло письмо, по-человечески (18.11: «получено — нихуя непонятно»):
 * «Сегодня» / «Вчера» / «11 ноября» и отдельно время «13:12». Год — только если не текущий.
 * Время московское, как у всей системы.
 */
export function mailReceivedParts(iso: string, now: Date = new Date()): { readonly day: string; readonly time: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { day: "—", time: "" };
  const parts = (value: Date) => {
    const map = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(value).map((part) => [part.type, part.value]));
    return { year: Number(map.year), month: Number(map.month), day: Number(map.day), time: `${map.hour}:${map.minute}` };
  };
  const at = parts(date);
  const today = parts(now);
  const yesterday = parts(new Date(now.getTime() - 24 * 3600 * 1000));
  const same = (a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }) => a.year === b.year && a.month === b.month && a.day === b.day;
  const day = same(at, today) ? "Сегодня"
    : same(at, yesterday) ? "Вчера"
    : `${at.day} ${MONTHS_GENITIVE[at.month - 1]}${at.year === today.year ? "" : ` ${at.year}`}`;
  return { day, time: at.time };
}
