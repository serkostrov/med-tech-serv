/**
 * Затраты в карточке прибора (ТЗ, блок 8): период и подписи. Считает база
 * (equipment_spend_summary, 0069) так же, как отчёт «Затраты по приборам».
 */
import { formatRussianCount } from "./equipment-changes.js";
import { formatMoney } from "./price-list.js";

export type EquipmentSpendPeriod = "this_year" | "last_year" | "all_time";

export const EQUIPMENT_SPEND_PERIODS: ReadonlyArray<{ readonly value: EquipmentSpendPeriod; readonly label: string }> = [
  { value: "this_year", label: "Этот год" },
  { value: "last_year", label: "Прошлый год" },
  { value: "all_time", label: "Всё время" }
];

export interface EquipmentSpend {
  readonly taskCount: number;
  readonly invoiceCount: number;
  readonly workAmount: number;
  readonly partsAmount: number;
  readonly totalAmount: number;
  readonly lastBillingAt?: string;
}

/** Границы периода по дню счёта, включительно; пустая граница — без ограничения. today — «ГГГГ-ММ-ДД» по Москве. */
export function equipmentSpendRange(period: EquipmentSpendPeriod, today: string): { readonly from?: string; readonly to?: string } {
  const year = Number(today.slice(0, 4));
  if (period === "this_year") return { from: `${year}-01-01`, to: today };
  if (period === "last_year") return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
  return {};
}

/** Строки блока: итог крупно, ниже работы и запчасти, под ними — по скольким счетам и задачам. */
export function equipmentSpendLines(spend: EquipmentSpend): { readonly total: string; readonly split: string; readonly basis: string } | null {
  if (spend.invoiceCount <= 0) return null;
  return {
    total: formatMoney(spend.totalAmount),
    split: `Работы ${formatMoney(spend.workAmount)} · запчасти ${formatMoney(spend.partsAmount)}`,
    basis: `По ${formatRussianCount(spend.invoiceCount, ["счёту", "счетам", "счетам"])} и ${formatRussianCount(spend.taskCount, ["задаче", "задачам", "задачам"])}`
  };
}

export function equipmentSpendEmptyText(period: EquipmentSpendPeriod): string {
  if (period === "this_year") return "В этом году счетов по прибору нет";
  if (period === "last_year") return "В прошлом году счетов по прибору нет";
  return "Счетов по прибору ещё не было";
}
