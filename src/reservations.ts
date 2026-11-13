import type { StockReservationRecord, StockReservationStatus } from "./m2-api.js";
import type { StatusTone } from "./ui.js";

/** Что склад может сделать с резервом в этом статусе. */
export type ReservationAction = "ready" | "issue" | "cancel" | "return";

/** Состояние запчасти в резерве: подписи про запчасть, поэтому в женском роде. */
export const RESERVATION_STATUS_LABELS: Readonly<Record<StockReservationStatus, string>> = {
  created: "Ждёт сборки",
  warehouse_notified: "Собрана",
  issued: "У инженера",
  installed: "Установлена",
  returned: "Возвращена",
  cancelled: "Резерв снят"
};

export const RESERVATION_STATUS_TONES: Readonly<Record<StockReservationStatus, StatusTone>> = {
  created: "warning",
  warehouse_notified: "info",
  issued: "purple",
  installed: "success",
  returned: "neutral",
  cancelled: "neutral"
};

const CONDITION_LABELS: Readonly<Record<StockReservationRecord["condition"], string>> = {
  N: "новая",
  G: "гарантийная",
  B: "б/у"
};

/**
 * Шаги как в базе: собрали, выдали инженеру, приняли обратно, если не пригодилась.
 * Снять резерв можно, пока запчасть не выдана. Отметку «установлена на прибор» склад
 * не ставит: её сделаем у инженера при закрытии задачи (следующий шаг склада).
 */
export function reservationActions(status: StockReservationStatus): readonly ReservationAction[] {
  if (status === "created") return ["ready", "cancel"];
  if (status === "warehouse_notified") return ["issue", "cancel"];
  if (status === "issued") return ["return"];
  return [];
}

/**
 * Шаги для строки: по отменённой или закрытой задаче запчасть не собирают и не выдают,
 * остаётся снять резерв. Выданную запчасть по-прежнему можно принять обратно.
 */
export function availableReservationActions(reservation: Pick<StockReservationRecord, "status" | "taskStatus">): readonly ReservationAction[] {
  const actions = reservationActions(reservation.status);
  return reservationTaskNote(reservation) ? actions.filter((action) => action === "cancel" || action === "return") : actions;
}

/** «2 шт. · новая». Дробное количество (метры трубки) без «шт.»: единиц в номенклатуре пока нет. */
export function reservationQuantityText(reservation: Pick<StockReservationRecord, "quantity" | "condition">): string {
  const amount = Number.isInteger(reservation.quantity) ? `${reservation.quantity} шт.` : String(reservation.quantity).replace(".", ",");
  return `${amount} · ${CONDITION_LABELS[reservation.condition]}`;
}

const CLOSED_TASK_NOTES: Readonly<Record<string, string>> = {
  cancelled: "Задача отменена",
  closed: "Задача закрыта"
};

/** Пометка у задачи, если запчасть по ней уже не нужна. */
export function reservationTaskNote(reservation: Pick<StockReservationRecord, "taskStatus">): string | undefined {
  return reservation.taskStatus ? CLOSED_TASK_NOTES[reservation.taskStatus] : undefined;
}

/** Почему выдать нельзя (кнопка неактивна, причина в подсказке). Без причины выдать можно. */
export function issueBlockReason(reservation: Pick<StockReservationRecord, "taskStatus" | "engineerName" | "taskNumber">): string | undefined {
  if (reservation.taskStatus && CLOSED_TASK_NOTES[reservation.taskStatus]) return `${CLOSED_TASK_NOTES[reservation.taskStatus]}: запчасть выдавать не нужно, снимите резерв`;
  if (!reservation.engineerName) return "В задаче не назначен инженер: выдавать некому";
  return undefined;
}

/**
 * Сколько резервов ждут сборки, сколько собрано и можно выдать, сколько висит на инженерах.
 * Резервы по отменённым и закрытым задачам и без инженера в «ждут сборки» и «можно выдавать» не входят:
 * с ними одно действие, снять резерв.
 */
export function reservationSummary(items: readonly Pick<StockReservationRecord, "status" | "taskStatus" | "engineerName" | "taskNumber">[]): { readonly toCollect: number; readonly ready: number; readonly withEngineers: number } {
  return {
    toCollect: items.filter((item) => item.status === "created" && !reservationTaskNote(item)).length,
    ready: items.filter((item) => item.status === "warehouse_notified" && !issueBlockReason(item)).length,
    withEngineers: items.filter((item) => item.status === "issued").length
  };
}
