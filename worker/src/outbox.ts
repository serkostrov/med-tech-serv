import {
  NOTIFICATION_CHANNEL_CODES,
  assertBusinessEvent,
  toDomainId,
  toIsoDateTime,
  type BusinessEvent,
  type BusinessEventCode,
  type NotificationChannelCode
} from "./domain.js";

export { NOTIFICATION_CHANNEL_CODES };
export type { NotificationChannelCode };

export interface ChannelDeliveryCommand {
  /** Один и тот же ключ обязан означать одну доставку при любом числе повторов. */
  readonly idempotencyKey: string;
  readonly eventCode: BusinessEventCode;
  readonly recipientUserId?: string;
  readonly channel: NotificationChannelCode;
  readonly recipientAddress: string;
  readonly subject: string;
  readonly body: string;
  readonly taskId?: string;
  readonly equipmentId?: string;
  readonly reservationId?: string;
}

export interface ChannelDeliveryReceipt {
  readonly providerMessageId?: string;
}

/** Безопасный код для журнала; текст исключения внешнего provider-а не хранится. */
export class ChannelDeliveryError extends Error {
  public constructor(
    public readonly diagnosticCode: string,
    /** false означает неоднозначный исход: повтор может создать дубль. */
    public readonly retryAllowed: boolean = true
  ) {
    super(diagnosticCode);
    this.name = "ChannelDeliveryError";
  }
}

/**
 * Seam внешнего канала. Adapter вызывается только после постоянной аренды;
 * повтор допустим только для явно повторяемого результата предыдущей попытки.
 */
export interface DeliveryChannel {
  readonly code: NotificationChannelCode;
  deliver(command: ChannelDeliveryCommand): Promise<ChannelDeliveryReceipt>;
}

/** Планировщик выбирает адресатов, включённые каналы и текст, не отправляя их. */
export interface EventDeliveryPlanner {
  plan(event: BusinessEvent): Promise<readonly ChannelDeliveryCommand[]>;
}

export interface StoredChannelDelivery extends ChannelDeliveryCommand {
  readonly id: string;
  readonly outboxEventId: string;
  readonly attempts: number;
}

export interface EventOutboxRepository {
  claim(limit: number, now: string, leaseUntil: string): Promise<readonly BusinessEvent[]>;
  stage(event: BusinessEvent, commands: readonly ChannelDeliveryCommand[], now: string): Promise<readonly StoredChannelDelivery[]>;
  /** Атомарно арендует внешнюю попытку; политика повтора хранится постоянно. */
  recordDeliveryAttempt(deliveryId: string, now: string, leaseUntil: string): Promise<boolean>;
  markDeliveryDelivered(deliveryId: string, deliveredAt: string, receipt: ChannelDeliveryReceipt): Promise<void>;
  markDeliveryFailed(
    deliveryId: string,
    errorCode: string,
    retryAt: string,
    retryAllowed?: boolean
  ): Promise<void>;
  markEventProcessed(eventId: string, processedAt: string): Promise<void>;
  markEventForRetry(eventId: string, errorCode: string, retryAt: string): Promise<void>;
}

export interface DispatchOutboxOptions {
  readonly batchSize?: number;
  /** Аренда одной внешней попытки, считается от её фактического начала. */
  readonly leaseMs?: number;
  /** Аренда всей пачки событий: должна покрывать обработку пачки целиком. */
  readonly claimLeaseMs?: number;
  readonly retryDelayMs?: number;
  /** Предел паузы между повторами (пауза растёт вдвое с каждой попыткой). */
  readonly maxRetryDelayMs?: number;
  /** После стольких попыток доставка считается окончательно неудачной. */
  readonly maxAttempts?: number;
  /** Служба останавливается: новые попытки не начинать. */
  readonly shouldStop?: () => boolean;
}

export interface DispatchOutboxResult {
  readonly claimedEvents: number;
  readonly processedEvents: number;
  readonly retryEvents: number;
  readonly deliveredMessages: number;
  readonly failedMessages: number;
}

const DEFAULT_BATCH_SIZE = 50;
// Больше предела SMTP-сессии (4 × SMTP_TIMEOUT_MS = 60 с по умолчанию).
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_CLAIM_LEASE_MS = 10 * 60_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 12;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function isoAfter(now: Date, milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString();
}

function channelMap(channels: readonly DeliveryChannel[]): ReadonlyMap<NotificationChannelCode, DeliveryChannel> {
  const result = new Map<NotificationChannelCode, DeliveryChannel>();
  for (const channel of channels) {
    if (result.has(channel.code)) {
      throw new Error(`Канал ${channel.code} зарегистрирован более одного раза`);
    }
    result.set(channel.code, channel);
  }
  return result;
}

/** Стабильный ключ одной доставки события конкретному адресату по одному каналу. */
export function channelDeliveryIdempotencyKey(
  event: Pick<BusinessEvent, "idempotencyKey">,
  channel: NotificationChannelCode,
  recipientKey: string
): string {
  const normalizedRecipient = recipientKey.trim();
  if (!normalizedRecipient) throw new Error("Для доставки нужен ключ адресата");
  return `${event.idempotencyKey}:${channel}:${normalizedRecipient}`;
}

/**
 * Глубокий модуль обработки: claim, повторы и изоляция ошибок скрыты за одним
 * вызовом. Ошибка одного adapter-а переводит только его доставку и событие в
 * retry; доставленные и неоднозначные SMTP-попытки повторно не возвращаются.
 */
export async function dispatchOutboxBatch(
  repository: EventOutboxRepository,
  planner: EventDeliveryPlanner,
  channels: readonly DeliveryChannel[],
  now: Date = new Date(),
  options: DispatchOutboxOptions = {}
): Promise<DispatchOutboxResult> {
  if (Number.isNaN(now.getTime())) throw new Error("Outbox dispatch time must be valid");
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
  const leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs");
  const retryDelayMs = positiveInteger(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, "retryDelayMs");
  const claimLeaseMs = positiveInteger(options.claimLeaseMs ?? Math.max(DEFAULT_CLAIM_LEASE_MS, leaseMs), "claimLeaseMs");
  const maxRetryDelayMs = positiveInteger(options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS, "maxRetryDelayMs");
  const maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts");
  const instant = now.toISOString();
  // Событие нельзя получить раньше delivery lease: иначе оно могло бы быть
  // завершено, пока исход SMTP-попытки всё ещё неизвестен.
  const baseDelayMs = Math.max(retryDelayMs, leaseMs);
  const retryAt = isoAfter(now, baseDelayMs);
  // Пауза растёт вдвое с каждой попыткой доставки, но не больше предела.
  // Текущее время в шкале прохода: момент начала плюс фактически прошедшее.
  const startedAt = Date.now();
  const passTime = (): Date => new Date(now.getTime() + Math.max(0, Date.now() - startedAt));
  const deliveryRetryAt = (attempts: number): Date =>
    new Date(now.getTime() + Math.min(maxRetryDelayMs, baseDelayMs * 2 ** Math.max(0, attempts)));
  const claimUntil = now.getTime() + claimLeaseMs;
  const claimed = await repository.claim(batchSize, instant, new Date(claimUntil).toISOString());
  let outOfTime = false;
  const adapters = channelMap(channels);
  let processedEvents = 0;
  let retryEvents = 0;
  let deliveredMessages = 0;
  let failedMessages = 0;

  for (const event of claimed) {
    // Не успеваем или останавливаемся: остальные события пачки вернутся в
    // очередь сами, когда кончится аренда пачки.
    if (outOfTime) break;
    try {
      assertBusinessEvent(event);
      const commands = await planner.plan(event);
      for (const command of commands) {
        if (command.eventCode !== event.eventCode) {
          throw new Error("delivery_event_mismatch");
        }
      }
      const pending = await repository.stage(event, commands, instant);
      let eventHasFailure = false;
      // Событие повторяем не раньше самой поздней повторной доставки, иначе
      // stage её не вернёт, событие закроется и повтор потеряется.
      let eventRetryAt = new Date(retryAt);
      const noteRetry = (at: Date): void => { if (at > eventRetryAt) eventRetryAt = at; };

      for (const delivery of pending) {
        // Аренда попытки не должна пережить аренду события: иначе событие возьмут
        // снова, не увидят доставку и закроют, а она останется «отправляется».
        if (options.shouldStop?.() || passTime().getTime() + leaseMs > claimUntil) {
          outOfTime = true;
          eventHasFailure = true;
          break;
        }
        if (delivery.attempts >= maxAttempts) {
          failedMessages += 1;
          await repository.markDeliveryFailed(delivery.id, "max_attempts_exceeded", retryAt, false);
          continue;
        }
        // Аренда от фактического начала попытки, а не от начала пачки.
        const deliveryClaimed = await repository.recordDeliveryAttempt(delivery.id, instant, isoAfter(passTime(), leaseMs));
        if (!deliveryClaimed) {
          eventHasFailure = true;
          continue;
        }
        const adapter = adapters.get(delivery.channel);
        if (!adapter) {
          eventHasFailure = true;
          failedMessages += 1;
          await repository.markDeliveryFailed(
            delivery.id,
            `channel_not_registered:${delivery.channel}`,
            retryAt
          );
          continue;
        }
        let receipt: ChannelDeliveryReceipt;
        try {
          receipt = await adapter.deliver(delivery);
        } catch (error) {
          const retryAllowed = error instanceof ChannelDeliveryError
            ? error.retryAllowed
            : true;
          failedMessages += 1;
          const nextAttemptAt = deliveryRetryAt(delivery.attempts);
          // Последняя разрешённая попытка: окончательная ошибка сразу, без ожидания.
          const lastAttempt = retryAllowed && delivery.attempts + 1 >= maxAttempts;
          const willRetry = retryAllowed && !lastAttempt;
          eventHasFailure = eventHasFailure || willRetry;
          if (willRetry) noteRetry(nextAttemptAt);
          await repository.markDeliveryFailed(
            delivery.id,
            // При исчерпании попыток сохраняем и причину последней ошибки.
            (lastAttempt ? "max_attempts_exceeded:" : "")
              + (error instanceof ChannelDeliveryError ? error.diagnosticCode : "channel_delivery_failed"),
            willRetry ? nextAttemptAt.toISOString() : retryAt,
            willRetry
          );
          continue;
        }
        try {
          await repository.markDeliveryDelivered(delivery.id, instant, receipt);
          deliveredMessages += 1;
        } catch {
          // Provider уже мог принять сообщение. SMTP не поддерживает
          // idempotency key, поэтому неоднозначную попытку фиксируем как
          // терминальную и никогда не передаём adapter-у повторно.
          failedMessages += 1;
          await repository.markDeliveryFailed(
            delivery.id,
            "notification_delivery_result_recording_failed",
            retryAt,
            false
          );
        }
      }

      if (eventHasFailure) {
        await repository.markEventForRetry(event.id, "one_or_more_channels_failed", eventRetryAt.toISOString());
        retryEvents += 1;
      } else {
        await repository.markEventProcessed(event.id, instant);
        processedEvents += 1;
      }
    } catch {
      // Ошибка разбора (например, сломанный шаблон) не исправится за минуту.
      await repository.markEventForRetry(event.id, "event_planning_failed", isoAfter(now, Math.min(maxRetryDelayMs, baseDelayMs * 10)));
      retryEvents += 1;
    }
  }

  return {
    claimedEvents: claimed.length,
    processedEvents,
    retryEvents,
    deliveredMessages,
    failedMessages
  };
}

export interface OutboxSqlExecutor {
  executeSql(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`PostgreSQL вернул некорректное поле outbox.${key}`);
  }
  return value;
}

function optionalText(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function eventFromRow(row: Record<string, unknown>): BusinessEvent {
  const payload = row.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("PostgreSQL вернул некорректный payload outbox");
  }
  const eventCode = requiredText(row, "event_type");
  const aggregateType = requiredText(row, "aggregate_type");
  const event: BusinessEvent = {
    id: toDomainId(requiredText(row, "id")),
    idempotencyKey: requiredText(row, "idempotency_key"),
    eventCode: eventCode as BusinessEvent["eventCode"],
    eventVersion: Number(row.event_version),
    aggregateType: aggregateType as BusinessEvent["aggregateType"],
    aggregateId: toDomainId(requiredText(row, "aggregate_id")),
    occurredAt: toIsoDateTime(requiredText(row, "occurred_at")),
    payload: payload as Readonly<Record<string, unknown>>
  };
  assertBusinessEvent(event);
  return event;
}

function deliveryFromRow(row: Record<string, unknown>): StoredChannelDelivery {
  const recipientUserId = optionalText(row, "recipient_user_id");
  const taskId = optionalText(row, "task_id");
  const equipmentId = optionalText(row, "equipment_id");
  const reservationId = optionalText(row, "reservation_id");
  return {
    id: requiredText(row, "id"),
    outboxEventId: requiredText(row, "outbox_event_id"),
    idempotencyKey: requiredText(row, "idempotency_key"),
    eventCode: requiredText(row, "event_code") as BusinessEventCode,
    ...(recipientUserId ? { recipientUserId } : {}),
    channel: requiredText(row, "channel") as NotificationChannelCode,
    recipientAddress: requiredText(row, "recipient_address"),
    subject: typeof row.subject === "string" ? row.subject : "",
    body: requiredText(row, "body"),
    ...(taskId ? { taskId } : {}),
    ...(equipmentId ? { equipmentId } : {}),
    ...(reservationId ? { reservationId } : {}),
    attempts: Number(row.attempts)
  };
}

/** PostgreSQL adapter: каждое изменение состояния выполняется одним statement. */
export class PostgresEventOutboxRepository implements EventOutboxRepository {
  public constructor(private readonly database: OutboxSqlExecutor) {}

  public async claim(limit: number, now: string, leaseUntil: string): Promise<readonly BusinessEvent[]> {
    const result = await this.database.executeSql(
      `SELECT id::text, idempotency_key, aggregate_type, aggregate_id::text,
              event_type, event_version, payload, occurred_at
         FROM public.claim_business_events($1, $2::timestamptz, $3::timestamptz)`,
      [limit, now, leaseUntil]
    );
    // Разбираем по одному: одно некорректное событие (новый код в каталоге,
    // другая версия, кривой payload) не должно блокировать всю пачку.
    const events: BusinessEvent[] = [];
    for (const row of result.rows) {
      try {
        events.push(eventFromRow(row));
      } catch {
        const id = typeof row.id === "string" ? row.id : undefined;
        if (!id) continue;
        const retryAt = new Date(new Date(now).getTime() + 60 * 60_000).toISOString();
        await this.markEventForRetry(id, "event_unsupported_by_worker", retryAt);
      }
    }
    return events;
  }

  public async stage(
    event: BusinessEvent,
    commands: readonly ChannelDeliveryCommand[],
    now: string
  ): Promise<readonly StoredChannelDelivery[]> {
    const result = await this.database.executeSql(
      `SELECT id::text, outbox_event_id::text, idempotency_key, event_code,
              recipient_user_id::text, channel::text, recipient_address,
              subject, body, task_id::text, equipment_id::text,
              reservation_id::text, attempts
         FROM public.stage_event_notifications($1::uuid, $2::jsonb, $3::timestamptz)`,
      [String(event.id), JSON.stringify(commands), now]
    );
    return result.rows.map(deliveryFromRow);
  }

  public async recordDeliveryAttempt(deliveryId: string, now: string, leaseUntil: string): Promise<boolean> {
    const result = await this.database.executeSql(
      "SELECT public.record_notification_delivery_attempt($1::uuid, $2::timestamptz, $3::timestamptz) AS claimed",
      [deliveryId, now, leaseUntil]
    );
    return result.rows[0]?.claimed === true;
  }

  public async markDeliveryDelivered(deliveryId: string, deliveredAt: string, receipt: ChannelDeliveryReceipt): Promise<void> {
    await this.database.executeSql(
      "SELECT public.complete_notification_delivery($1::uuid, $2::timestamptz, $3)",
      [deliveryId, deliveredAt, receipt.providerMessageId ?? null]
    );
  }

  public async markDeliveryFailed(
    deliveryId: string,
    errorCode: string,
    retryAt: string,
    retryAllowed = true
  ): Promise<void> {
    await this.database.executeSql(
      "SELECT public.fail_notification_delivery($1::uuid, $2, $3::timestamptz, $4)",
      [deliveryId, errorCode, retryAt, retryAllowed]
    );
  }

  public async markEventProcessed(eventId: string, processedAt: string): Promise<void> {
    await this.database.executeSql(
      "SELECT public.complete_business_event($1::uuid, $2::timestamptz)",
      [eventId, processedAt]
    );
  }

  public async markEventForRetry(eventId: string, errorCode: string, retryAt: string): Promise<void> {
    await this.database.executeSql(
      "SELECT public.retry_business_event($1::uuid, $2, $3::timestamptz)",
      [eventId, errorCode, retryAt]
    );
  }
}
