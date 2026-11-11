export const DEFAULT_MAINTENANCE_ACTIVATION_TIME_ZONE = "Europe/Moscow";
export const DEFAULT_MAINTENANCE_ACTIVATION_CRON = "0 0 * * *";

export type MaintenanceActivationRule = "period_start" | "days_before_period_start";

export interface MaintenanceActivationConfig {
  readonly cron: string;
  readonly timeZone: string;
  readonly rule: MaintenanceActivationRule;
  readonly leadDays: number;
}

export interface MaintenanceActivationResult {
  readonly cutoffDate: string;
  readonly activatedTaskIds: readonly string[];
}

export interface MaintenanceActivationRepository {
  activateDue(cutoffDate: string, activatedAt: string): Promise<readonly string[]>;
}

export interface MaintenanceActivationSqlExecutor {
  executeSql(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

/** PostgreSQL adapter calls the only command granted to the restricted worker role. */
export class PostgresMaintenanceActivationRepository implements MaintenanceActivationRepository {
  public constructor(private readonly database: MaintenanceActivationSqlExecutor) {}

  public async activateDue(cutoffDate: string, activatedAt: string): Promise<readonly string[]> {
    const result = await this.database.executeSql(
      `SELECT task_id::text AS task_id
         FROM public.activate_due_maintenance_tasks($1::date, $2::timestamptz)`,
      [cutoffDate, activatedAt]
    );
    return result.rows.map((row) => {
      const taskId = row.task_id;
      if (typeof taskId !== "string" || !taskId) {
        throw new Error("PostgreSQL returned an invalid activated task id");
      }
      return taskId;
    });
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

function integer(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 365 || String(parsed) !== (value ?? String(fallback))) {
    throw new Error(`${name} must be an integer from 0 to 365`);
  }
  return parsed;
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(0));
  } catch {
    throw new Error("MAINTENANCE_ACTIVATION_TIME_ZONE must be a valid IANA time zone");
  }
}

export function maintenanceActivationConfig(environment: Environment): MaintenanceActivationConfig {
  const cron = environment.MAINTENANCE_ACTIVATION_CRON?.trim() || DEFAULT_MAINTENANCE_ACTIVATION_CRON;
  const timeZone = environment.MAINTENANCE_ACTIVATION_TIME_ZONE?.trim() || DEFAULT_MAINTENANCE_ACTIVATION_TIME_ZONE;
  const ruleValue = environment.MAINTENANCE_ACTIVATION_RULE?.trim() || "period_start";
  if (ruleValue !== "period_start" && ruleValue !== "days_before_period_start") {
    throw new Error("MAINTENANCE_ACTIVATION_RULE must be period_start or days_before_period_start");
  }
  const configuredLeadDays = integer(
    environment.MAINTENANCE_ACTIVATION_LEAD_DAYS,
    0,
    "MAINTENANCE_ACTIVATION_LEAD_DAYS"
  );
  if (ruleValue === "period_start" && configuredLeadDays !== 0) {
    throw new Error("MAINTENANCE_ACTIVATION_LEAD_DAYS must be 0 for period_start");
  }
  if (!cron) {
    throw new Error("MAINTENANCE_ACTIVATION_CRON must not be empty");
  }
  assertTimeZone(timeZone);
  return {
    cron,
    timeZone,
    rule: ruleValue,
    leadDays: ruleValue === "period_start" ? 0 : configuredLeadDays
  };
}

function calendarDateAt(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) {
    throw new Error("Maintenance activation instant must be a valid date");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((item) => item.type === type)?.value;
    if (!value) throw new Error(`Cannot determine ${type} in ${timeZone}`);
    return value;
  };
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addCalendarDays(calendarDate: string, days: number): string {
  const [year, month, day] = calendarDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function maintenanceActivationCutoff(now: Date, config: MaintenanceActivationConfig): string {
  return addCalendarDays(calendarDateAt(now, config.timeZone), config.leadDays);
}

export async function activateDueMaintenanceTasks(
  repository: MaintenanceActivationRepository,
  config: MaintenanceActivationConfig,
  now: Date
): Promise<MaintenanceActivationResult> {
  const cutoffDate = maintenanceActivationCutoff(now, config);
  const activatedTaskIds = await repository.activateDue(cutoffDate, now.toISOString());
  return { cutoffDate, activatedTaskIds };
}
