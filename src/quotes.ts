/**
 * КП — коммерческие предложения (ТЗ, блок 9). Статусы, переходы, проверки позиций и выгрузка.
 * Правила те же, что у стража базы (0071): база их держит, экран о них говорит заранее.
 */
import { formatMoney } from "./price-list.js";
import type { XlsxCell, XlsxSheet } from "./xlsx.js";

export type QuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "expired";

export const QUOTE_STATUS_LABELS: Readonly<Record<QuoteStatus, string>> = {
  draft: "Черновик",
  sent: "Отправлено",
  accepted: "Принято",
  rejected: "Отклонено",
  expired: "Истёк срок"
};

export const QUOTE_STATUS_TONES: Readonly<Record<QuoteStatus, "warning" | "purple" | "success" | "neutral" | "danger">> = {
  draft: "warning",
  sent: "purple",
  accepted: "success",
  rejected: "neutral",
  expired: "danger"
};

export interface QuoteAction {
  readonly to: QuoteStatus;
  readonly label: string;
  readonly primary: boolean;
}

/** Что можно сделать с КП в этом статусе — как в страже базы. Первое действие — главное. */
export function quoteActions(status: QuoteStatus): readonly QuoteAction[] {
  switch (status) {
    case "draft": return [
      { to: "sent", label: "Отправлено клиенту", primary: true },
      { to: "rejected", label: "Отменить черновик", primary: false }
    ];
    case "sent": return [
      { to: "accepted", label: "Клиент принял", primary: true },
      { to: "rejected", label: "Клиент отказался", primary: false },
      { to: "expired", label: "Срок истёк", primary: false },
      { to: "draft", label: "Вернуть в черновик", primary: false }
    ];
    case "rejected":
    case "expired": return [{ to: "draft", label: "Вернуть в черновик", primary: false }];
    case "accepted": return [];
  }
}

export function isQuoteStatus(value: string): value is QuoteStatus {
  return Object.hasOwn(QUOTE_STATUS_LABELS, value);
}

/** Отправленное КП, у которого прошёл срок действия: подсказка «отметить, что срок истёк». */
export function quoteOverdue(quote: { readonly status: QuoteStatus; readonly validUntil?: string }, today: string): boolean {
  return quote.status === "sent" && Boolean(quote.validUntil) && (quote.validUntil ?? "") < today;
}

/** Ошибка в позиции до сохранения; undefined — всё в порядке. */
export function quoteItemProblem(input: { readonly quantity: number; readonly unitPrice: number; readonly countable?: boolean; readonly article?: string }): string | undefined {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return "Количество должно быть больше нуля";
  if (input.countable && input.quantity !== Math.trunc(input.quantity)) {
    return `Запчасть «${input.article ?? ""}» считается штуками: укажите целое количество`;
  }
  if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) return "Цена не может быть меньше нуля";
  return undefined;
}

/** Число из поля ввода: запятая или точка, пробелы между разрядами. */
export function parseQuoteNumber(value: string): number {
  const text = value.replace(/[\s ]/gu, "").replace(",", ".");
  return text === "" ? Number.NaN : Number(text);
}

export function formatQuoteQuantity(value: number): string {
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
}

export interface QuoteForExport {
  readonly number: string;
  readonly name: string;
  readonly status: QuoteStatus;
  readonly siteName?: string;
  readonly payerName?: string;
  readonly validUntil?: string;
  readonly totalAmount: number;
}

export interface QuoteItemForExport {
  readonly description: string;
  readonly code?: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly lineTotal: number;
}

/** Лист Excel с КП: шапка, позиции с номерами, итог. Даты — настоящими датами Excel. */
export function quoteWorkbookSheet(quote: QuoteForExport, items: readonly QuoteItemForExport[]): XlsxSheet {
  const header: XlsxCell[][] = [
    [{ bold: `Коммерческое предложение ${quote.number}` }],
    [quote.name],
    ["Клиент", [quote.siteName, quote.payerName].filter(Boolean).join(" · ") || "—"],
    ["Действует до", quote.validUntil ? { date: quote.validUntil } : "—"],
    ["Статус", QUOTE_STATUS_LABELS[quote.status]],
    []
  ];
  const headerRow = header.length + 1;
  return {
    name: quote.number.slice(0, 31),
    widths: [6, 52, 18, 12, 14, 16],
    headerRow,
    rows: [
      ...header,
      ["№", "Наименование", "Артикул / вид работ", "Количество", "Цена, ₽", "Сумма, ₽"],
      ...items.map((item, index): XlsxCell[] => [index + 1, item.description, item.code ?? "", item.quantity, item.unitPrice, item.lineTotal]),
      [],
      ["", { bold: "Итого" }, "", "", "", quote.totalAmount]
    ]
  };
}

/** Итог под таблицей позиций. */
export function quoteTotalText(total: number, count: number): string {
  return `${count === 0 ? "Позиций нет" : `Позиций: ${count}`} · итого ${formatMoney(total)}`;
}
