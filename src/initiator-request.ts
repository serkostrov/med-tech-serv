/**
 * Заявка менеджера-инициатора (ТЗ, раздел 2 и блок 1): срок и название задачи из того,
 * что он ввёл. Срок в базе обязателен; инициатор его не знает, поэтому подставляем по срочности,
 * координатор поправит при назначении.
 */
import { formatIsoCalendarDate } from "./date-format.js";

export type RequestPriority = "urgent" | "planned";

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Срочная — реакция 24 часа (ТЗ 3.3): сегодня–завтра. Плановая — неделя. «Выполнить до» можно задать самому. */
export function requestPeriod(priority: RequestPriority, today: string, until?: string): { readonly from: string; readonly to: string } {
  const to = until && until >= today ? until : addDays(today, priority === "urgent" ? 1 : 7);
  return { from: today, to };
}

/** «Ремонт: Beckman Coulter AU 480, S/N 123» — так задачу видно на доске координатора. */
export function requestTitle(workTypeName: string, device: { readonly manufacturer?: string; readonly model?: string; readonly serialNumber: string }): string {
  const name = [device.manufacturer, device.model].filter(Boolean).join(" ");
  return `${workTypeName}: ${name ? `${name}, ` : ""}S/N ${device.serialNumber}`.slice(0, 200);
}

/** Чего не хватает в заявке; undefined — можно отправлять. */
export function requestProblem(input: { readonly equipmentId?: string; readonly description: string; readonly workTypeCode?: string; readonly until?: string; readonly today: string }): string | undefined {
  if (!input.equipmentId) return "Найдите прибор по заводскому номеру (S/N)";
  if (!input.workTypeCode) return "Выберите, что нужно сделать";
  if (input.description.trim().length < 5) return "Опишите неисправность или что нужно сделать";
  if (input.until && input.until < input.today) return `Дата «выполнить до» уже прошла: укажите ${formatIsoCalendarDate(input.today)} или позже`;
  return undefined;
}

/** Какой этап видит инициатор: те же слова, что у координатора, но о его задаче. */
export function requestStageHint(status: string, engineerName?: string): string {
  switch (status) {
    case "new": return "Координатор назначит инженера";
    case "planned": return "Запланирована по плану ТО";
    case "assigned": return engineerName ? `Назначен инженер: ${engineerName}` : "Инженер назначен";
    case "in_progress": return engineerName ? `${engineerName} в работе` : "Инженер в работе";
    case "under_review": return "Работы выполнены, координатор проверяет акт";
    case "closed": return "Работы завершены";
    case "cancelled": return "Задача отменена";
    default: return "";
  }
}
