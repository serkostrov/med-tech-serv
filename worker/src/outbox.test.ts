import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { toDomainId, toIsoDateTime, type BusinessEvent } from "./domain.js";
import {
  PostgresEventOutboxRepository,
  ChannelDeliveryError,
  channelDeliveryIdempotencyKey,
  dispatchOutboxBatch,
  type ChannelDeliveryCommand,
  type ChannelDeliveryReceipt,
  type DeliveryChannel,
  type EventDeliveryPlanner,
  type EventOutboxRepository,
  type NotificationChannelCode,
  type StoredChannelDelivery
} from "./outbox.js";
import { SmtpDeliveryChannel, type SmtpMessage, type SmtpTransport } from "./smtp.js";

const event: BusinessEvent = {
  id: toDomainId("00000000-0000-4000-8000-000000000038"),
  idempotencyKey: "task_engineer_assigned:00000000-0000-4000-8000-000000000138:1",
  eventCode: "task_engineer_assigned",
  eventVersion: 1,
  aggregateType: "task",
  aggregateId: toDomainId("00000000-0000-4000-8000-000000000138"),
  occurredAt: toIsoDateTime("2026-08-18T12:00:00.000Z"),
  payload: { engineerId: "00000000-0000-4000-8000-000000000238" }
};

interface DeliveryState extends StoredChannelDelivery {
  status: "queued" | "sending" | "delivered" | "failed";
  scheduledAt: string;
  lastError: string | null;
  retryAllowed: boolean;
}

class MemoryOutbox implements EventOutboxRepository {
  private eventStatus: "queued" | "failed" | "processed" = "queued";
  private eventAvailableAt: string = event.occurredAt;
  private readonly deliveries = new Map<string, DeliveryState>();
  public failDeliveredAckOnce = false;

  public async claim(_limit: number, now: string, leaseUntil: string): Promise<readonly BusinessEvent[]> {
    if (this.eventStatus === "processed" || this.eventAvailableAt > now) return [];
    this.eventAvailableAt = leaseUntil;
    return [event];
  }

  public async stage(
    _event: BusinessEvent,
    commands: readonly ChannelDeliveryCommand[],
    now: string
  ): Promise<readonly StoredChannelDelivery[]> {
    for (const command of commands) {
      if (!this.deliveries.has(command.idempotencyKey)) {
        this.deliveries.set(command.idempotencyKey, {
          ...command,
          id: `delivery-${this.deliveries.size + 1}`,
          outboxEventId: String(event.id),
          attempts: 0,
          status: "queued",
          scheduledAt: event.occurredAt,
          lastError: null,
          retryAllowed: true
        });
      }
    }
    for (const item of this.deliveries.values()) {
      if (item.status === "sending" && item.scheduledAt <= now) {
        this.replace({
          ...item,
          status: "failed",
          scheduledAt: now,
          lastError: "notification_delivery_lease_expired",
          retryAllowed: false
        });
      }
    }
    return [...this.deliveries.values()]
      .filter((item) => (
        (item.status === "queued" || item.status === "failed")
        && item.scheduledAt <= now
        && item.retryAllowed
      ))
      .map(({ status: _status, scheduledAt: _scheduledAt, lastError: _lastError, retryAllowed: _retryAllowed, ...item }) => ({ ...item }));
  }

  public async recordDeliveryAttempt(deliveryId: string, now: string, leaseUntil: string): Promise<boolean> {
    const item = this.byId(deliveryId);
    if ((item.status !== "queued" && item.status !== "failed") || item.scheduledAt > now) return false;
    this.replace({
      ...item,
      attempts: item.attempts + 1,
      status: "sending",
      scheduledAt: leaseUntil,
      lastError: item.lastError ?? "notification_delivery_attempt_in_progress",
      retryAllowed: true
    });
    return true;
  }

  public async markDeliveryDelivered(deliveryId: string, _deliveredAt: string, _receipt: ChannelDeliveryReceipt): Promise<void> {
    if (this.failDeliveredAckOnce) {
      this.failDeliveredAckOnce = false;
      throw new Error("synthetic database ACK failure");
    }
    const item = this.byId(deliveryId);
    this.replace({ ...item, status: "delivered", lastError: null });
  }

  public async markDeliveryFailed(
    deliveryId: string,
    errorCode: string,
    retryAt: string,
    retryAllowed = true
  ): Promise<void> {
    const item = this.byId(deliveryId);
    if (item.status !== "delivered") {
      this.replace({ ...item, status: "failed", scheduledAt: retryAt, lastError: errorCode, retryAllowed });
    }
  }

  public async markEventProcessed(_eventId: string, _processedAt: string): Promise<void> {
    this.eventStatus = "processed";
  }

  public async markEventForRetry(_eventId: string, _errorCode: string, retryAt: string): Promise<void> {
    this.eventStatus = "failed";
    this.eventAvailableAt = retryAt;
  }

  public states(): readonly DeliveryState[] {
    return [...this.deliveries.values()];
  }

  private byId(id: string): DeliveryState {
    const item = [...this.deliveries.values()].find((candidate) => candidate.id === id);
    if (!item) throw new Error("unknown delivery");
    return item;
  }

  private replace(next: DeliveryState): void {
    this.deliveries.set(next.idempotencyKey, next);
  }
}

function command(channel: NotificationChannelCode): ChannelDeliveryCommand {
  return {
    idempotencyKey: channelDeliveryIdempotencyKey(event, channel, "engineer-38"),
    eventCode: event.eventCode,
    recipientUserId: "00000000-0000-4000-8000-000000000238",
    channel,
    recipientAddress: `${channel}-recipient-test`,
    subject: "Назначена задача",
    body: "Откройте карточку задачи",
    taskId: String(event.aggregateId)
  };
}

const planner: EventDeliveryPlanner = {
  async plan() {
    return [command("email"), command("telegram")];
  }
};

class IdempotentTestChannel implements DeliveryChannel {
  public readonly receivedKeys: string[] = [];
  public readonly deliveredKeys = new Set<string>();
  public failuresRemaining = 0;

  public constructor(public readonly code: NotificationChannelCode) {}

  public async deliver(delivery: ChannelDeliveryCommand): Promise<ChannelDeliveryReceipt> {
    this.receivedKeys.push(delivery.idempotencyKey);
    if (this.deliveredKeys.has(delivery.idempotencyKey)) {
      return { providerMessageId: `${this.code}-existing` };
    }
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("synthetic adapter failure");
    }
    this.deliveredKeys.add(delivery.idempotencyKey);
    return { providerMessageId: `${this.code}-sent` };
  }
}

describe("transactional outbox dispatcher", () => {
  it("isolates one channel failure and does not repeat an already delivered channel", async () => {
    const repository = new MemoryOutbox();
    const email = new IdempotentTestChannel("email");
    const telegram = new IdempotentTestChannel("telegram");
    telegram.failuresRemaining = 1;

    const first = await dispatchOutboxBatch(
      repository,
      planner,
      [email, telegram],
      new Date("2026-08-18T12:00:00.000Z"),
      { leaseMs: 1_000, retryDelayMs: 1_000 }
    );
    assert.deepEqual(first, {
      claimedEvents: 1,
      processedEvents: 0,
      retryEvents: 1,
      deliveredMessages: 1,
      failedMessages: 1
    });
    assert.equal(repository.states().find((item) => item.channel === "email")?.status, "delivered");
    assert.equal(repository.states().find((item) => item.channel === "telegram")?.status, "failed");

    const second = await dispatchOutboxBatch(
      repository,
      planner,
      [email, telegram],
      new Date("2026-08-18T12:00:01.000Z"),
      { leaseMs: 1_000, retryDelayMs: 1_000 }
    );
    assert.equal(second.processedEvents, 1);
    assert.equal(second.deliveredMessages, 1);
    assert.equal(email.receivedKeys.length, 1, "успешный email не отправлен повторно");
    assert.equal(telegram.receivedKeys.length, 2);
    assert.equal(telegram.deliveredKeys.size, 1);
  });

  it("does not repeat SMTP when provider success cannot be persisted", async () => {
    const repository = new MemoryOutbox();
    repository.failDeliveredAckOnce = true;
    const messages: SmtpMessage[] = [];
    const transport: SmtpTransport = { async send(message) { messages.push(message); } };
    const firstWorkerEmail = new SmtpDeliveryChannel(
      { fromAddress: "service@example.test", fromName: "МедТехСервис" },
      transport
    );
    const emailOnly: EventDeliveryPlanner = { async plan() { return [command("email")]; } };

    const first = await dispatchOutboxBatch(
      repository,
      emailOnly,
      [firstWorkerEmail],
      new Date("2026-08-18T12:00:00.000Z"),
      { retryDelayMs: 1_000 }
    );
    assert.equal(repository.states()[0]?.status, "failed");
    assert.equal(repository.states()[0]?.lastError, "notification_delivery_result_recording_failed");
    assert.equal(repository.states()[0]?.retryAllowed, false);
    assert.equal(first.processedEvents, 1);
    assert.equal(first.retryEvents, 0);
    const restartedWorkerEmail = new SmtpDeliveryChannel(
      { fromAddress: "service@example.test", fromName: "МедТехСервис" },
      transport
    );
    await dispatchOutboxBatch(
      repository,
      emailOnly,
      [restartedWorkerEmail],
      new Date("2026-08-18T12:00:01.000Z"),
      { retryDelayMs: 1_000 }
    );

    assert.equal(messages.length, 1, "перезапуск worker-а не создаёт повторное SMTP-сообщение");
    assert.match(messages[0]?.messageId ?? "", /@example\.test$/u);
    assert.equal(repository.states()[0]?.status, "failed");
  });

  it("does not repeat SMTP after an attempt lease expires with an unknown outcome", async () => {
    const repository = new MemoryOutbox();
    const emailOnly: EventDeliveryPlanner = { async plan() { return [command("email")]; } };
    const firstNow = "2026-08-18T12:00:00.000Z";
    const leaseUntil = "2026-08-18T12:00:01.000Z";
    const [claimed] = await repository.claim(1, firstNow, leaseUntil);
    const [staged] = await repository.stage(claimed!, await emailOnly.plan(claimed!), firstNow);
    assert.equal(await repository.recordDeliveryAttempt(staged!.id, firstNow, leaseUntil), true);
    assert.equal(repository.states()[0]?.status, "sending");
    assert.equal(repository.states()[0]?.lastError, "notification_delivery_attempt_in_progress");

    let deliveryCalls = 0;
    const email: DeliveryChannel = {
      code: "email",
      async deliver() {
        deliveryCalls += 1;
        return { providerMessageId: "recovered@example.test" };
      }
    };
    const recovered = await dispatchOutboxBatch(
      repository,
      emailOnly,
      [email],
      new Date(leaseUntil),
      { leaseMs: 1_000, retryDelayMs: 1_000 }
    );

    assert.equal(recovered.processedEvents, 1);
    assert.equal(deliveryCalls, 0);
    assert.equal(repository.states()[0]?.lastError, "notification_delivery_lease_expired");
    assert.equal(repository.states()[0]?.retryAllowed, false);
    assert.equal(repository.states()[0]?.attempts, 1);
    assert.equal(repository.states()[0]?.status, "failed");
  });

  it("persists an unknown SMTP outcome and blocks a repeated delivery", async () => {
    const repository = new MemoryOutbox();
    let calls = 0;
    const uncertainEmail: DeliveryChannel = {
      code: "email",
      async deliver() {
        calls += 1;
        if (calls === 1) throw new ChannelDeliveryError("smtp_delivery_outcome_unknown", false);
        return { providerMessageId: "same-message@example.test" };
      }
    };
    const emailOnly: EventDeliveryPlanner = { async plan() { return [command("email")]; } };

    const first = await dispatchOutboxBatch(repository, emailOnly, [uncertainEmail], new Date("2026-08-18T12:00:00.000Z"), { retryDelayMs: 1_000 });
    assert.equal(repository.states()[0]?.status, "failed");
    assert.equal(repository.states()[0]?.lastError, "smtp_delivery_outcome_unknown");
    assert.equal(repository.states()[0]?.retryAllowed, false);
    assert.equal(first.processedEvents, 1);

    const recovered = await dispatchOutboxBatch(repository, emailOnly, [uncertainEmail], new Date("2026-08-18T12:00:01.000Z"), { retryDelayMs: 1_000 });
    assert.equal(recovered.claimedEvents, 0);
    assert.equal(repository.states()[0]?.status, "failed");
    assert.equal(calls, 1);
  });

  it("claims rows concurrently and stages channel commands conflict-safely in PostgreSQL", async () => {
    const calls: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];
    const database = {
      async executeSql(text: string, values: readonly unknown[] = []) {
        calls.push({ text, values });
        if (text.includes("claim_business_events")) {
          return { rows: [{
            id: event.id,
            idempotency_key: event.idempotencyKey,
            aggregate_type: event.aggregateType,
            aggregate_id: event.aggregateId,
            event_type: event.eventCode,
            event_version: event.eventVersion,
            payload: event.payload,
            occurred_at: new Date(event.occurredAt)
          }] };
        }
        if (text.includes("stage_event_notifications")) {
          return { rows: [{
            id: "00000000-0000-4000-8000-000000000338",
            outbox_event_id: event.id,
            idempotency_key: command("email").idempotencyKey,
            event_code: event.eventCode,
            recipient_user_id: command("email").recipientUserId,
            channel: "email",
            recipient_address: command("email").recipientAddress,
            subject: command("email").subject,
            body: command("email").body,
            task_id: event.aggregateId,
            attempts: 0
          }] };
        }
        return { rows: [] };
      }
    };
    const repository = new PostgresEventOutboxRepository(database);
    const claimed = await repository.claim(
      20,
      "2026-08-18T12:00:00.000Z",
      "2026-08-18T12:01:00.000Z"
    );
    const staged = await repository.stage(claimed[0]!, [command("email")], "2026-08-18T12:00:00.000Z");

    assert.equal(claimed[0]?.eventCode, "task_engineer_assigned");
    assert.equal(staged[0]?.channel, "email");
    assert.match(calls[0]?.text ?? "", /public\.claim_business_events\(\$1, \$2::timestamptz, \$3::timestamptz\)/u);
    assert.match(calls[1]?.text ?? "", /public\.stage_event_notifications\(\$1::uuid, \$2::jsonb, \$3::timestamptz\)/u);
  });

  it("persists the no-retry decision through the PostgreSQL adapter", async () => {
    const calls: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];
    const repository = new PostgresEventOutboxRepository({
      async executeSql(text: string, values: readonly unknown[] = []) {
        calls.push({ text, values });
        return { rows: [] };
      }
    });

    await repository.markDeliveryFailed(
      "00000000-0000-4000-8000-000000000338",
      "smtp_delivery_outcome_unknown",
      "2026-08-18T12:01:00.000Z",
      false
    );

    assert.match(calls[0]?.text ?? "", /fail_notification_delivery\(\$1::uuid, \$2, \$3::timestamptz, \$4\)/u);
    assert.deepEqual(calls[0]?.values, [
      "00000000-0000-4000-8000-000000000338",
      "smtp_delivery_outcome_unknown",
      "2026-08-18T12:01:00.000Z",
      false
    ]);
  });

  it("keeps task mutation and event insert in one PostgreSQL transaction trigger", async () => {
    const migration = await readFile(
      new URL("../../supabase/migrations/0001_init.sql", import.meta.url),
      "utf8"
    );
    assert.match(migration, /AFTER INSERT OR UPDATE OF status_code ON tasks/u);
    assert.match(migration, /PERFORM enqueue_business_event\(/u);
    assert.match(migration, /INSERT INTO integration_outbox/u);
    assert.match(migration, /ON CONFLICT \(idempotency_key\) DO NOTHING/u);
    assert.match(migration, /FOR UPDATE SKIP LOCKED/u);
    assert.match(migration, /SECURITY DEFINER/u);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION claim_business_events/u);
    assert.match(migration, /DROP TRIGGER IF EXISTS tasks_queue_rework_notification/u);
    const triggerStart = migration.indexOf("CREATE OR REPLACE FUNCTION enqueue_task_business_events");
    const triggerEnd = migration.indexOf("CREATE OR REPLACE FUNCTION", triggerStart + 1);
    assert.doesNotMatch(migration.slice(triggerStart, triggerEnd), /'email'/u);
  });
});
