type DomainId = string;

export const MAX_ANNUAL_MAINTENANCE_PERIODS = 5;

export type MaintenancePlanStatus = "planned" | "generated" | "completed" | "cancelled";

export interface MaintenancePlanPeriodInput {
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly assignedEngineerId?: DomainId;
  readonly comment?: string;
}

export interface AnnualMaintenancePlanInput {
  readonly equipmentId: DomainId;
  readonly year: number;
  readonly periods: readonly MaintenancePlanPeriodInput[];
}

export interface MaintenancePlanPeriod extends MaintenancePlanPeriodInput {
  readonly id: DomainId;
  readonly equipmentId: DomainId;
  readonly year: number;
  readonly periodNo: number;
  readonly status: MaintenancePlanStatus;
  readonly generatedTaskId?: DomainId;
}

export interface MaintenanceTimelineSegment {
  /** Смещение от начала года, от 0 до 100. */
  readonly leftPercent: number;
  /** Ширина включительного периода, от 0 до 100. */
  readonly widthPercent: number;
  readonly visibleFrom: string;
  readonly visibleTo: string;
  readonly crossesYearBoundary: boolean;
}

function calendarDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`Поле ${field} должно быть календарной датой YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Поле ${field} содержит некорректную дату`);
  }
  return value;
}

function yearBounds(year: number): { readonly from: string; readonly to: string } {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new Error("Год плана должен быть целым числом от 2000 до 2200");
  }
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function utcDay(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`) / 86_400_000;
}

/**
 * Проверяет годовой план целиком, чтобы правила пяти периодов, границ года и
 * пересечений не расползались по HTTP-обработчикам и адаптерам хранения.
 */
export function assertAnnualMaintenancePlan(input: AnnualMaintenancePlanInput): void {
  if (!String(input.equipmentId).trim()) throw new Error("Прибор плана обязателен");
  const bounds = yearBounds(input.year);
  if (input.periods.length === 0 || input.periods.length > MAX_ANNUAL_MAINTENANCE_PERIODS) {
    throw new Error(`На прибор можно задать от 1 до ${MAX_ANNUAL_MAINTENANCE_PERIODS} периодов ТО в год`);
  }
  const periods = input.periods.map((period, index) => {
    const periodFrom = calendarDate(period.periodFrom, `periods[${index}].periodFrom`);
    const periodTo = calendarDate(period.periodTo, `periods[${index}].periodTo`);
    if (periodTo < periodFrom) throw new Error("Конец периода ТО не может быть раньше начала");
    if (periodTo < bounds.from || periodFrom > bounds.to) {
      throw new Error(`Период ТО должен пересекать ${input.year} год`);
    }
    if (Number(periodFrom.slice(0, 4)) !== input.year && Number(periodTo.slice(0, 4)) !== input.year) {
      throw new Error(`Начало или конец периода ТО должны относиться к ${input.year} году`);
    }
    return { periodFrom, periodTo };
  }).sort((left, right) => left.periodFrom.localeCompare(right.periodFrom));

  for (let index = 1; index < periods.length; index += 1) {
    const previous = periods[index - 1];
    const current = periods[index];
    if (previous && current && current.periodFrom <= previous.periodTo) {
      throw new Error("Периоды ТО одного годового плана не должны пересекаться");
    }
  }
}

/** Проекция периода на шкалу выбранного года; участки соседнего года обрезаются. */
export function maintenancePeriodOnYearTimeline(
  period: Pick<MaintenancePlanPeriodInput, "periodFrom" | "periodTo">,
  year: number
): MaintenanceTimelineSegment {
  const bounds = yearBounds(year);
  const periodFrom = calendarDate(period.periodFrom, "periodFrom");
  const periodTo = calendarDate(period.periodTo, "periodTo");
  if (periodTo < periodFrom) throw new Error("Конец периода ТО не может быть раньше начала");
  if (periodTo < bounds.from || periodFrom > bounds.to) throw new Error(`Период ТО не пересекает ${year} год`);

  const visibleFrom = periodFrom < bounds.from ? bounds.from : periodFrom;
  const visibleTo = periodTo > bounds.to ? bounds.to : periodTo;
  const firstDay = utcDay(bounds.from);
  const daysInYear = utcDay(bounds.to) - firstDay + 1;
  return {
    leftPercent: ((utcDay(visibleFrom) - firstDay) / daysInYear) * 100,
    widthPercent: ((utcDay(visibleTo) - utcDay(visibleFrom) + 1) / daysInYear) * 100,
    visibleFrom,
    visibleTo,
    crossesYearBoundary: periodFrom < bounds.from || periodTo > bounds.to
  };
}
