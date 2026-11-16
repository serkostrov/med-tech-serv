/**
 * Карточка счёта: итоги, разделение строк и кнопки по статусу. Чистая логика без React —
 * правила проверяются тестами, а экран только показывает то, что здесь посчитано.
 * Суммы считает база (триггер пересчёта), здесь мы их только раскладываем по блокам
 * и сверяем со строками: если расходится, человеку надо сказать, а не показать молча.
 */
import { MAX_PRICE, roundToKopecks } from "./price-list.js";

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

/** Одной фразой: что со счётом сейчас и что с ним можно делать дальше. */
export function invoiceStatusNote(status: string): string {
  switch (status) {
    case "draft": return "Черновик: позиции ещё можно пересобрать по прайсу, в 1С счёт не ушёл.";
    case "issued": return "Счёт выставлен и ждёт передачи в 1С.";
    case "transferred_to_1c": return "Счёт передан в 1С: менять его больше нельзя.";
    case "cancelled": return "Счёт отменён. Его задачи можно выставить в новый счёт.";
    default: return "";
  }
}

/** Г — работа по гарантии, Н — обычная. Остальное из базы показываем как есть. */
export function invoiceModifierLabel(modifier: string | null): string {
  if (modifier === "G") return "Гарантия";
  if (modifier === "N") return "Не гарантия";
  return "";
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

export interface InvoiceActionButton {
  readonly kind: InvoiceActionKind;
  readonly label: string;
  readonly variant: "danger" | "ghost" | "primary" | "secondary";
}

const ISSUE: InvoiceActionButton = { kind: "issue", label: "Выставить", variant: "primary" };
const TRANSFER: InvoiceActionButton = { kind: "transfer", label: "Передать в 1С", variant: "primary" };
const REBUILD: InvoiceActionButton = { kind: "rebuild", label: "Пересобрать по прайсу", variant: "secondary" };
const CORRECT: InvoiceActionButton = { kind: "correct", label: "Скорректировать", variant: "secondary" };
const CANCEL: InvoiceActionButton = { kind: "cancel", label: "Отменить счёт", variant: "ghost" };

/**
 * Кнопки карточки по статусу и праву `finance.write`. Переходы ровно те, что разрешает
 * база: черновик выставляют, выставленный передают в 1С, корректируют пока счёт не в 1С,
 * пересобирают только черновик. Переданный и отменённый счёт не трогают.
 */
export function invoiceActions(input: { readonly status: string; readonly canWrite: boolean }): readonly InvoiceActionButton[] {
  if (!input.canWrite) return [];
  if (input.status === "draft") return [ISSUE, REBUILD, CORRECT, CANCEL];
  if (input.status === "issued") return [TRANSFER, CORRECT, CANCEL];
  return [];
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
