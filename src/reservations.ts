import type { StockReservationRecord, StockReservationStatus, StockReservationStep } from "./m2-api.js";
import type { TaskPartPosition } from "./types.js";
import { companyDateTimeText } from "./task-dates.js";
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

/** Состояние запчасти буквой и словом, как в списке запчастей задачи: «Н, новая». */
export const RESERVATION_CONDITION_LABELS: Readonly<Record<StockReservationRecord["condition"], string>> = {
  G: "Г, гарантийная",
  N: "Н, новая",
  B: "Б, б/у"
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

/** Последний шаг резерва: кто и когда перевёл его в нынешнее состояние. */
export function lastReservationStep(reservation: Pick<StockReservationRecord, "steps">): StockReservationStep | undefined {
  return reservation.steps.length ? reservation.steps[reservation.steps.length - 1] : undefined;
}

/** «Собрана · Никитина Ольга Павловна · 12.11.2026 09:30». Без автора — только время. */
export function reservationStepText(step: StockReservationStep): string {
  return [RESERVATION_STATUS_LABELS[step.status], step.actorName, companyDateTimeText(step.changedAt)].filter(Boolean).join(" · ");
}

/** Когда запчасть выдали инженеру: шаг «У инженера», иначе последнее изменение резерва. */
export function reservationIssuedAt(reservation: Pick<StockReservationRecord, "steps" | "updatedAt">): string | undefined {
  const issued = [...reservation.steps].reverse().find((step) => step.status === "issued");
  return issued?.changedAt ?? reservation.updatedAt;
}

/** Сколько полных суток запчасть у инженера. Без даты выдачи — 0. */
export function daysWithEngineer(reservation: Pick<StockReservationRecord, "steps" | "updatedAt">, now: number = Date.now()): number {
  const issuedAt = Date.parse(reservationIssuedAt(reservation) ?? "");
  if (!Number.isFinite(issuedAt)) return 0;
  return Math.max(0, Math.floor((now - issuedAt) / 86_400_000));
}

/** Что инженеру делать с запчастью: забирать её или она уже у него. */
export function engineerReservationHint(status: StockReservationStatus): string | undefined {
  if (status === "created") return "ждёт сборки";
  if (status === "warehouse_notified") return "собрана, можно забрать";
  if (status === "issued") return "у вас";
  return undefined;
}

export interface EngineerReservationRow {
  readonly reservation: StockReservationRecord;
  readonly days: number;
}

export interface EngineerReservationGroup {
  readonly engineerName: string;
  readonly items: readonly EngineerReservationRow[];
  /** Сколько дней висит самая старая запчасть группы: по ней сортируем инженеров. */
  readonly oldestDays: number;
}

const NO_ENGINEER = "Инженер не указан";

/**
 * Выданные запчасти по инженерам: у кого что лежит и сколько дней. Сверху тот,
 * у кого запчасть висит дольше всех, внутри группы — тоже сначала самые старые.
 */
export function reservationsByEngineer(
  items: readonly StockReservationRecord[],
  now: number = Date.now()
): readonly EngineerReservationGroup[] {
  const groups = new Map<string, EngineerReservationRow[]>();
  for (const reservation of items.filter((item) => item.status === "issued")) {
    const name = reservation.issuedToName ?? reservation.engineerName ?? NO_ENGINEER;
    const rows = groups.get(name) ?? [];
    rows.push({ reservation, days: daysWithEngineer(reservation, now) });
    groups.set(name, rows);
  }
  return [...groups.entries()]
    .map(([engineerName, rows]) => ({
      engineerName,
      items: [...rows].sort((left, right) => right.days - left.days || left.reservation.number.localeCompare(right.reservation.number, "ru")),
      oldestDays: rows.reduce((max, row) => Math.max(max, row.days), 0)
    }))
    .sort((left, right) => right.oldestDays - left.oldestDays || left.engineerName.localeCompare(right.engineerName, "ru"));
}

/**
 * Резервы, которыми закрыта строка запчастей задачи. Строку склад собирает из всех
 * отмеченных резервов одной запчасти в одном состоянии, поэтому их может быть несколько,
 * а записанный в строке reservation_id — любой из них.
 */
export function installedReservations(
  part: Pick<TaskPartPosition, "articleNumber" | "condition" | "reservationId">,
  reservations: readonly StockReservationRecord[]
): readonly StockReservationRecord[] {
  if (!part.reservationId) return [];
  return reservations.filter((item) => item.articleNumber === part.articleNumber
    && item.condition === part.condition
    && item.installMarked
    && (item.status === "issued" || item.status === "installed"));
}

/** Номера резервов для подписи «установлена · Р-000012, Р-000013». */
export function installedReservationNumbers(
  part: Pick<TaskPartPosition, "articleNumber" | "condition" | "reservationId">,
  reservations: readonly StockReservationRecord[]
): readonly string[] {
  return installedReservations(part, reservations).map((item) => item.number);
}
