import type { StockReservationRecord } from "./m2-api.js";
import { RESERVATION_CONDITION_LABELS, reservationIssuedAt, reservationsByEngineer } from "./reservations.js";
import { companyDateText } from "./task-dates.js";
import { buildXlsxCompressed, type XlsxCell, type XlsxSheet } from "./xlsx.js";

const HEADER = ["Инженер", "Резерв", "Артикул", "Наименование", "Количество", "Состояние", "Задача", "Выдана", "Дней у инженера"];

/**
 * Лист «У инженеров»: по строке на каждую выданную запчасть, инженеры сверху вниз от
 * самой залежавшейся. Те же данные, что на вкладке, чтобы их можно было разослать.
 */
export function engineerReservationsSheets(items: readonly StockReservationRecord[], now: number = Date.now()): readonly XlsxSheet[] {
  const rows: XlsxCell[][] = reservationsByEngineer(items, now).flatMap((group) => group.items.map((row) => [
    group.engineerName,
    row.reservation.number,
    row.reservation.articleNumber,
    row.reservation.partName,
    row.reservation.quantity,
    RESERVATION_CONDITION_LABELS[row.reservation.condition],
    [row.reservation.taskNumber, row.reservation.taskTitle].filter(Boolean).join(" · "),
    { date: reservationIssuedAt(row.reservation) ?? row.reservation.updatedAt, withTime: true },
    row.days
  ]));
  return [{
    name: "У инженеров",
    rows: [HEADER, ...rows],
    headerRow: 1,
    widths: [26, 12, 20, 40, 12, 16, 40, 17, 16]
  }];
}

export function engineerReservationsFileName(now: Date = new Date()): string {
  return `Запчасти у инженеров ${companyDateText(now.toISOString())}.xlsx`;
}

export function engineerReservationsWorkbook(items: readonly StockReservationRecord[]): Promise<Uint8Array> {
  return buildXlsxCompressed(engineerReservationsSheets(items));
}
