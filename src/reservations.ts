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

/**
 * Состояния по ходу жизни резерва: от заявки до возврата, снятый резерв последним.
 * В этом порядке идут колонки доски и пункты фильтра по состоянию.
 */
export const RESERVATION_STATUSES_IN_ORDER: readonly StockReservationStatus[] = [
  "created", "warehouse_notified", "issued", "installed", "returned", "cancelled"
];

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

/**
 * «Собрана · Никитина Ольга Павловна · 12.11.2026 09:30». Без автора — только время.
 * С названием состояния: для списка всех шагов, где у каждого шага оно своё.
 */
export function reservationStepText(step: StockReservationStep): string {
  return [RESERVATION_STATUS_LABELS[step.status], step.actorName, companyDateTimeText(step.changedAt)].filter(Boolean).join(" · ");
}

/**
 * Тот же шаг без названия состояния: «Никитина Ольга Павловна · 12.11.2026 09:30».
 * Так подписан последний шаг рядом с бейджем состояния: бейдж уже называет его словом,
 * и повторять то же слово в подписи незачем.
 */
export function reservationStepAuthorText(step: StockReservationStep): string {
  return [step.actorName, companyDateTimeText(step.changedAt)].filter(Boolean).join(" · ");
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

/**
 * Колонки доски резервов: состояния, через которые запчасть проходит на складе.
 * Снятого резерва на доске нет: это не шаг запчасти, а отказ от неё, и такие резервы
 * остаются в списке на вкладке «Закрытые».
 */
export const RESERVATION_BOARD_STATUSES: readonly StockReservationStatus[] = [
  "created", "warehouse_notified", "issued", "installed", "returned"
];

/**
 * Чем резерв переводится в это состояние. Те же действия, что кнопками в строке:
 * других способов двигать резерв нет.
 */
const RESERVATION_DROP_STEPS: Readonly<Partial<Record<StockReservationStatus, { readonly from: StockReservationStatus; readonly action: ReservationAction }>>> = {
  warehouse_notified: { from: "created", action: "ready" },
  issued: { from: "warehouse_notified", action: "issue" },
  returned: { from: "issued", action: "return" }
};

export type ReservationDropDecision =
  | { readonly kind: "move"; readonly action: ReservationAction }
  /** Перенести нельзя: reason объясняет почему. Пустой reason — переносить нечего (та же колонка). */
  | { readonly kind: "no"; readonly reason: string };

/**
 * Что будет, если бросить карточку резерва в колонку: выполнить действие склада или
 * отказать и объяснить. Вручную ставятся только те состояния, под которые есть кнопка:
 * «Установлена» отмечает инженер при закрытии задачи, назад резерв не возвращают.
 */
export function reservationDropDecision(
  reservation: Pick<StockReservationRecord, "status" | "taskStatus" | "engineerName" | "taskNumber">,
  to: StockReservationStatus
): ReservationDropDecision {
  if (reservation.status === to) return { kind: "no", reason: "" };
  const step = RESERVATION_DROP_STEPS[to];
  if (!step) {
    if (to === "installed") return { kind: "no", reason: "«Установлена» отмечает инженер, когда закрывает задачу: со склада это состояние не ставят" };
    if (to === "created") return { kind: "no", reason: "Назад в «Ждёт сборки» резерв не возвращают" };
    return { kind: "no", reason: `В «${RESERVATION_STATUS_LABELS[to]}» карточку не переносят` };
  }
  if (reservation.status !== step.from) {
    return { kind: "no", reason: `Из «${RESERVATION_STATUS_LABELS[reservation.status]}» сразу в «${RESERVATION_STATUS_LABELS[to]}» нельзя, только в следующее состояние` };
  }
  // По отменённой и закрытой задаче запчасть не собирают и не выдают: остаётся снять резерв.
  const note = reservationTaskNote(reservation);
  if (note && !availableReservationActions(reservation).includes(step.action)) {
    return { kind: "no", reason: `${note}: запчасть уже не нужна, снимите резерв в списке` };
  }
  const blocked = step.action === "issue" ? issueBlockReason(reservation) : undefined;
  return blocked ? { kind: "no", reason: blocked } : { kind: "move", action: step.action };
}

/**
 * Условия отбора резервов в окне склада. Пустая строка значит «все», как в остальных реестрах.
 * Список резервов приходит целиком, поэтому отбираем на месте, а не запросом в базу.
 */
export interface ReservationFilters {
  readonly search: string;
  readonly status: string;
  /** Инженер, как он подписан в строке: кому выдали, иначе инженер задачи. */
  readonly engineer: string;
  readonly taskNumber: string;
  readonly partId: string;
}

export const EMPTY_RESERVATION_FILTERS: ReservationFilters = { search: "", status: "", engineer: "", taskNumber: "", partId: "" };

/** Выбрано ли хоть одно условие: от этого зависит, что писать на пустом месте. */
export function hasReservationFilters(filters: ReservationFilters): boolean {
  return Object.values(filters).some((value) => value.trim() !== "");
}

/** Инженер строки: кому выдали, иначе инженер задачи. Без них резерв ничей. */
export function reservationEngineerName(reservation: Pick<StockReservationRecord, "issuedToName" | "engineerName">): string | undefined {
  return reservation.issuedToName ?? reservation.engineerName;
}

function matchesSearch(reservation: StockReservationRecord, search: string): boolean {
  const normalized = search.trim().toLocaleLowerCase("ru-RU");
  if (!normalized) return true;
  const haystack = [reservation.number, reservation.articleNumber, reservation.partName, reservation.taskNumber, reservation.taskTitle, reservationEngineerName(reservation)]
    .filter(Boolean).join(" ").toLocaleLowerCase("ru-RU");
  return normalized.split(/\s+/u).every((word) => haystack.includes(word));
}

/** Резервы по условиям окна: все условия вместе, пустое поле ничего не отсекает. */
export function filterReservations(items: readonly StockReservationRecord[], filters: ReservationFilters): readonly StockReservationRecord[] {
  return items.filter((item) => (!filters.status || item.status === filters.status)
    && (!filters.engineer || reservationEngineerName(item) === filters.engineer)
    && (!filters.taskNumber || item.taskNumber === filters.taskNumber)
    && (!filters.partId || item.partId === filters.partId)
    && matchesSearch(item, filters.search));
}

export interface ReservationFilterOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Что предложить в фильтрах: только то, что есть в загруженных резервах. Пустых списков
 * и состояний не из этой вкладки в фильтрах не будет.
 */
export function reservationFilterOptions(items: readonly StockReservationRecord[]): {
  readonly statuses: readonly ReservationFilterOption[];
  readonly engineers: readonly ReservationFilterOption[];
  readonly tasks: readonly ReservationFilterOption[];
  readonly parts: readonly ReservationFilterOption[];
} {
  const statuses = RESERVATION_STATUSES_IN_ORDER.filter((status) => items.some((item) => item.status === status))
    .map((status) => ({ value: status, label: RESERVATION_STATUS_LABELS[status] }));
  // Из одинаковых значений оставляем подпись подробнее: у одного резерва название задачи
  // может быть, а у другого нет, и в списке должно остаться «З-000045 · Замена насоса».
  const unique = (options: readonly ReservationFilterOption[]) => {
    const byValue = new Map<string, ReservationFilterOption>();
    for (const option of options) {
      const known = byValue.get(option.value);
      if (!known || option.label.length > known.label.length) byValue.set(option.value, option);
    }
    return [...byValue.values()].sort((left, right) => left.label.localeCompare(right.label, "ru"));
  };
  return {
    statuses,
    engineers: unique(items.map(reservationEngineerName).filter((name): name is string => Boolean(name)).map((name) => ({ value: name, label: name }))),
    tasks: unique(items.filter((item) => item.taskNumber).map((item) => ({ value: item.taskNumber as string, label: item.taskTitle ? `${item.taskNumber} · ${item.taskTitle}` : item.taskNumber as string }))),
    parts: unique(items.map((item) => ({ value: item.partId, label: `${item.articleNumber} · ${item.partName}` })))
  };
}

/** Номера резервов для подписи «установлена · Р-000012, Р-000013». */
export function installedReservationNumbers(
  part: Pick<TaskPartPosition, "articleNumber" | "condition" | "reservationId">,
  reservations: readonly StockReservationRecord[]
): readonly string[] {
  return installedReservations(part, reservations).map((item) => item.number);
}
