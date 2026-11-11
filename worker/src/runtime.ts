import { createHash } from "node:crypto";
import { activateDueMaintenanceTasks, PostgresMaintenanceActivationRepository, type MaintenanceActivationConfig } from "./maintenance-activation.js";
import { enqueueOverdueTaskEvents } from "./email-planner.js";
import {
  dispatchOutboxBatch,
  type ChannelDeliveryCommand,
  type ChannelDeliveryReceipt,
  type DeliveryChannel,
  type DispatchOutboxResult,
  type EventDeliveryPlanner,
  type EventOutboxRepository,
  type OutboxSqlExecutor
} from "./outbox.js";
import type { BusinessEvent, NotificationChannelCode } from "./domain.js";

/** Объединяет планы нескольких каналов в одну доставку события. */
export class CompositeEventDeliveryPlanner implements EventDeliveryPlanner {
  public constructor(private readonly planners: readonly EventDeliveryPlanner[]) {}

  public async plan(event: BusinessEvent): Promise<readonly ChannelDeliveryCommand[]> {
    const commands: ChannelDeliveryCommand[] = [];
    for (const planner of this.planners) commands.push(...await planner.plan(event));
    return commands;
  }
}

export function maskAddress(channel: NotificationChannelCode, address: string): string {
  if (channel === "email") {
    const [local = "", domain = ""] = address.split("@");
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `${address.slice(0, 2)}***`;
}

/**
 * Пробный режим: ничего не отправляет наружу, только пишет в журнал службы.
 * Нужен для локальной проверки и стенда без реальных SMTP и Telegram.
 */
export class DryRunDeliveryChannel implements DeliveryChannel {
  public constructor(
    public readonly code: NotificationChannelCode,
    private readonly log: (line: string) => void = (line) => console.log(line)
  ) {}

  public async deliver(command: ChannelDeliveryCommand): Promise<ChannelDeliveryReceipt> {
    const id = createHash("sha256").update(command.idempotencyKey).digest("hex").slice(0, 16);
    this.log(`[пробный режим] ${command.channel} → ${maskAddress(command.channel, command.recipientAddress)}: ${command.subject || command.eventCode}`);
    return { providerMessageId: `dry-run:${id}` };
  }
}

export interface PollCycleOptions {
  readonly database: OutboxSqlExecutor;
  readonly repository: EventOutboxRepository;
  readonly planner: EventDeliveryPlanner;
  readonly channels: readonly DeliveryChannel[];
  readonly maintenance: MaintenanceActivationConfig;
  readonly now: Date;
  readonly runMaintenance: boolean;
  readonly shouldStop?: () => boolean;
}

export interface PollCycleResult {
  readonly overdueEvents: number;
  readonly activatedMaintenanceTasks: number;
  readonly dispatch: DispatchOutboxResult;
}

/**
 * Один проход: ТО «Запланировано → Новая» (по дате, идемпотентно), регистрация
 * просрочек, затем рассылка очереди. Ошибка ТО не мешает уведомлениям.
 */
export async function runPollCycle(options: PollCycleOptions): Promise<PollCycleResult> {
  let activatedMaintenanceTasks = 0;
  if (options.runMaintenance) {
    try {
      const result = await activateDueMaintenanceTasks(
        new PostgresMaintenanceActivationRepository(options.database),
        options.maintenance,
        options.now
      );
      activatedMaintenanceTasks = result.activatedTaskIds.length;
    } catch {
      console.error("Активация задач ТО не выполнена");
    }
  }
  const overdueEvents = await enqueueOverdueTaskEvents(options.database, options.now);
  const dispatch = await dispatchOutboxBatch(options.repository, options.planner, options.channels, options.now,
    options.shouldStop ? { shouldStop: options.shouldStop } : {});
  return { overdueEvents, activatedMaintenanceTasks, dispatch };
}
