/**
 * Карточка счёта: итоги, разделение строк и кнопки по статусу. Чистая логика без React —
 * правила проверяются тестами, а экран только показывает то, что здесь посчитано.
 * Суммы считает база (триггер пересчёта), здесь мы их только раскладываем по блокам
 * и сверяем со строками: если расходится, человеку надо сказать, а не показать молча.
 */
import { formatIsoCalendarDate } from "./date-format.js";
import { MAX_PRICE, roundToKopecks } from "./price-list.js";
import { companyDay } from "./task-dates.js";

export type InvoiceStatus = "cancelled" | "draft" | "issued" | "transferred_to_1c";

/** Строка счёта: берём только те поля, от которых зависят итоги и подписи. */
export interface InvoiceLine {
  readonly itemType: "part" | "work";
  readonly quantity: number;
  readonly unitPrice: number;
  readonly lineTotal: number;
  readonly modifier: "G" | "N" | null;
  readonly excludedFromTotal: boolean;
}

export const INVOICE_STATUS_LABEL: Readonly<Record<InvoiceStatus, string>> = {
  draft: "Черновик",
  issued: "Выставлен",
  transferred_to_1c: "Передан в 1С",
  cancelled: "Отменён"
};

/** Статус из базы может оказаться новым: показываем код, а не пустое место. */
export function invoiceStatusLabel(status: string): string {
  return INVOICE_STATUS_LABEL[status as InvoiceStatus] ?? status;
}

export function invoiceStatusTone(status: string): "neutral" | "purple" | "success" | "warning" {
  if (status === "transferred_to_1c") return "success";
  if (status === "issued") return "purple";
  if (status === "cancelled") return "neutral";
  return "warning";
}

/**
 * Одной фразой: что со счётом сейчас. Тому, кто ведёт счета, черновик и выставленный счёт
 * объясняет плашка со следующим шагом, поэтому фраза нужна в основном остальным ролям.
 */
export function invoiceStatusNote(status: string): string {
  switch (status) {
    case "draft": return "Черновик: клиенту счёт ещё не выставлен.";
    case "issued": return "Счёт выставлен и ждёт передачи в 1С.";
    case "transferred_to_1c": return "Счёт передан в 1С: менять его больше нельзя.";
    case "cancelled": return "Счёт отменён. Его задачи можно выставить в новый счёт.";
    default: return "";
  }
}

/**
 * Отметка работы из задачи. «Н» — это не «не гарантия», а неправильная эксплуатация:
 * сломали сами, и такая работа оплачивается. Обычная работа отметки не имеет.
 */
export function invoiceModifierLabel(modifier: string | null): string {
  if (modifier === "G") return "Гарантия";
  if (modifier === "N") return "Неправильная эксплуатация";
  return "";
}

/**
 * День работ по задаче — тот же, по которому база берёт цену из прайса (0023, 0040):
 * окончание работ, иначе день выезда, иначе закрытие задачи. Сутки — по Москве.
 */
export function invoiceWorkDate(task: {
  readonly workFinishedAt?: string | null;
  readonly visitDate?: string | null;
  readonly completedAt?: string | null;
  readonly updatedAt?: string | null;
}): string | null {
  if (task.workFinishedAt) return companyDay(task.workFinishedAt) ?? null;
  if (task.visitDate) return task.visitDate.slice(0, 10);
  const fallback = task.completedAt ?? task.updatedAt;
  return fallback ? companyDay(fallback) ?? null : null;
}

/**
 * Откуда в строке цена — подпись под ценой. Без неё непонятно, почему у ремонта
 * 7 800, а не 9 500: цена работы берётся на день работ, а не сегодняшняя.
 */
export function invoiceLineSource(item: {
  readonly itemType: "part" | "work";
  readonly unitPrice?: number;
  readonly workDate?: string | null;
}): string {
  const day = item.workDate ? formatIsoCalendarDate(item.workDate) : null;
  if (item.itemType === "part") return item.unitPrice === 0 ? "цены прихода нет" : "цена прихода со склада";
  if (item.unitPrice === 0) return day ? `в прайсе на ${day} цены нет` : "в прайсе цены нет";
  return day ? `по прайсу на ${day}` : "по прайсу на день работ";
}

/**
 * Что сделать со строками без цены — у работы и у запчасти это разные люди:
 * цену работы задают в прайсе, цену запчасти кладовщик вписывает при приходе.
 */
export function invoiceMissingPriceHint(items: readonly { readonly itemType: "part" | "work"; readonly unitPrice: number }[]): string {
  const works = items.filter((item) => item.itemType === "work" && item.unitPrice === 0).length;
  const parts = items.filter((item) => item.itemType === "part" && item.unitPrice === 0).length;
  const steps: string[] = [];
  if (works > 0) steps.push(`у ${works === 1 ? "работы" : `${works} работ`} — задайте цену в прайсе`);
  if (parts > 0) steps.push(`у ${parts === 1 ? "запчасти" : `${parts} запчастей`} — пусть кладовщик впишет цену прихода`);
  return steps.length === 0 ? "" : `Нет цены ${steps.join(", ")}. Потом нажмите «Обновить по прайсу».`;
}

export function invoiceItemTypeLabel(itemType: string): string {
  return itemType === "part" ? "Запчасть" : "Работа";
}

/**
 * Строки, которые идут в сумму, и гарантийные — которые видно в счёте, но в сумму
 * они не входят (`excluded_from_total`). Порядок строк из базы не трогаем.
 */
export function invoiceItemGroups<T extends InvoiceLine>(items: readonly T[]): {
  readonly billable: readonly T[];
  readonly guarantee: readonly T[];
} {
  return {
    billable: items.filter((item) => !item.excludedFromTotal),
    guarantee: items.filter((item) => item.excludedFromTotal)
  };
}

/**
 * Строки без цены: база заводит их с нулём, когда цены на дату в прайсе нет
 * (и пока нет цены прихода у запчасти). Молча терять работу из счёта нельзя,
 * поэтому такие строки помечаем на экране.
 */
export function invoiceLinesWithoutPrice<T extends InvoiceLine>(items: readonly T[]): readonly T[] {
  return items.filter((item) => item.unitPrice === 0);
}

/**
 * Сумма строки для показа. У гарантийной строки база держит в `line_total` ноль
 * (так посчитан сам столбец), поэтому её справочную сумму — сколько работа стоила бы
 * без гарантии — считаем здесь. В итог счёта она всё равно не идёт.
 */
export function invoiceLineAmount(line: InvoiceLine): number {
  return roundToKopecks(line.excludedFromTotal ? line.quantity * line.unitPrice : line.lineTotal);
}

/**
 * Позиции по порядку: по задаче, внутри задачи сначала работа, потом запчасти.
 * Строки без задачи — в конце. Порядок строк с одинаковым ключом сохраняем.
 */
export function invoiceItemsInOrder<T extends { readonly taskNumber: string | null; readonly itemType: "part" | "work" }>(
  items: readonly T[]
): readonly T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const byTask = (left.item.taskNumber ?? "￿").localeCompare(right.item.taskNumber ?? "￿");
      if (byTask !== 0) return byTask;
      const byType = Number(left.item.itemType === "part") - Number(right.item.itemType === "part");
      return byType !== 0 ? byType : left.index - right.index;
    })
    .map((entry) => entry.item);
}

export interface InvoiceAmounts {
  /** Сумма строк, которые идут в счёт. */
  readonly billable: number;
  /** Сумма гарантийных строк: показываем отдельно, в счёт она не идёт. */
  readonly guarantee: number;
  /** Сумма позиций по данным базы. */
  readonly subtotal: number;
  readonly adjustment: number;
  readonly total: number;
  /** Сумма строк сошлась с суммой счёта из базы. */
  readonly matches: boolean;
}

/**
 * Итог счёта. Показываем суммы базы (она считает их триггером), а сумму строк
 * пересчитываем только чтобы поймать расхождение: оно значит, что данные на экране устарели.
 */
export function invoiceAmounts(card: {
  readonly items: readonly InvoiceLine[];
  readonly subtotal: number;
  readonly adjustmentAmount: number;
  readonly totalAmount: number;
}): InvoiceAmounts {
  const groups = invoiceItemGroups(card.items);
  const sum = (lines: readonly InvoiceLine[]) => roundToKopecks(lines.reduce((total, line) => total + invoiceLineAmount(line), 0));
  const billable = sum(groups.billable);
  return {
    billable,
    guarantee: sum(groups.guarantee),
    subtotal: roundToKopecks(card.subtotal),
    adjustment: roundToKopecks(card.adjustmentAmount),
    total: roundToKopecks(card.totalAmount),
    matches: billable === roundToKopecks(card.subtotal)
  };
}

/**
 * Итог после корректировки — таким его посчитает база: сумма позиций плюс корректировка,
 * но не ниже нуля (так устроен пересчёт в базе). По нему в окне видно, что получится.
 */
export function invoicePreviewTotal(subtotal: number, adjustment: number): number {
  return Math.max(0, roundToKopecks(subtotal + adjustment));
}

export type InvoiceActionKind = "cancel" | "correct" | "issue" | "rebuild" | "transfer";

/** Главный шаг по статусу: стоит плашкой над счётом, как следующий шаг в карточке задачи. */
export interface InvoiceNextStep {
  readonly kind: "issue" | "transfer";
  readonly label: string;
  readonly title: string;
  readonly hint: string;
}

/**
 * Что можно сделать со счётом и где это стоит на экране. Каждое действие — рядом с тем,
 * что оно меняет: выставить и передать — плашкой сверху, обновить строки — у строк,
 * скидку — у итога, отмену — внизу итога, как отмену задачи. Пять кнопок в ряд
 * читались как равные, и было непонятно, что нажимать.
 *
 * Переходы ровно те, что разрешает база: черновик выставляют, выставленный передают в 1С,
 * корректируют и отменяют, пока счёт не в 1С, строки обновляют только у черновика.
 */
export interface InvoiceCardActions {
  readonly next: InvoiceNextStep | null;
  readonly canRebuild: boolean;
  readonly canCorrect: boolean;
  readonly canCancel: boolean;
}

const NO_ACTIONS: InvoiceCardActions = { next: null, canRebuild: false, canCorrect: false, canCancel: false };

export function invoiceCardActions(input: { readonly status: string; readonly canWrite: boolean }): InvoiceCardActions {
  if (!input.canWrite) return NO_ACTIONS;
  if (input.status === "draft") {
    return {
      next: {
        kind: "issue",
        label: "Выставить счёт",
        title: "Проверьте строки и выставьте счёт",
        hint: "Работы — по прайсу на день работ, запчасти — по цене прихода. После выставления строки уже не обновить."
      },
      canRebuild: true,
      canCorrect: true,
      canCancel: true
    };
  }
  if (input.status === "issued") {
    return {
      next: {
        kind: "transfer",
        label: "Передать в 1С",
        title: "Передайте счёт в 1С",
        hint: "Когда счёт отдали в бухгалтерию. После передачи сумму изменить будет нельзя."
      },
      canRebuild: false,
      canCorrect: true,
      canCancel: true
    };
  }
  return NO_ACTIONS;
}

/** Выгрузка файлом доступна всем, кто счёт видит: она ничего не меняет. */
export function canExportInvoice(input: { readonly itemCount: number }): boolean {
  return input.itemCount > 0;
}

export interface InvoiceHistoryStep {
  readonly status: string;
  readonly label: string;
  readonly at: string;
  readonly actorName: string | null;
}

/**
 * История статусов снизу вверх: от первой записи к последней. База отдаёт её как есть,
 * порядок на всякий случай выстраиваем сами — по времени.
 */
export function invoiceHistorySteps(
  history: readonly { readonly status: string; readonly at: string; readonly actorName: string | null }[]
): readonly InvoiceHistoryStep[] {
  return [...history]
    .sort((left, right) => left.at.localeCompare(right.at))
    .map((step) => ({ ...step, label: invoiceStatusLabel(step.status) }));
}

/**
 * Сумма корректировки из поля ввода: со знаком, «−500» и «-500» одинаково, до копеек.
 * Ноль не принимаем: корректировка на ноль ничего не меняет, но требует причины.
 */
export function parseInvoiceAdjustment(value: string): number | null {
  const normalized = value.replace(/[\s ]/gu, "").replace("−", "-").replace(",", ".");
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(normalized)) return null;
  const parsed = roundToKopecks(Number(normalized));
  if (parsed === 0 || Math.abs(parsed) > MAX_PRICE) return null;
  return parsed;
}

/** Имя файла выгрузки: «Счёт СЧ-000042.xlsx». */
export function invoiceFileName(invoice: { readonly number: string }): string {
  return `Счёт ${invoice.number}.xlsx`;
}
