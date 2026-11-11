import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toDomainId, toIsoDateTime, type BusinessEvent } from "./domain.js";
import { PostgresEmailEventDeliveryPlanner } from "./email-planner.js";
import {
  ChannelDeliveryError,
  dispatchOutboxBatch,
  PostgresEventOutboxRepository,
  type ChannelDeliveryCommand,
  type ChannelDeliveryReceipt,
  type EventOutboxRepository,
  type StoredChannelDelivery
} from "./outbox.js";

const event: BusinessEvent = {
  id: toDomainId("00000000-0000-4000-8000-000000000010"),
  idempotencyKey: "task_engineer_assigned:t:1",
  eventCode: "task_engineer_assigned",
  eventVersion: 1,
  aggregateType: "task",
  aggregateId: toDomainId("00000000-0000-4000-8000-000000000011"),
  occurredAt: toIsoDateTime("2026-11-11T10:00:00.000Z"),
  payload: {}
};

const command: ChannelDeliveryCommand = {
  idempotencyKey: "task_engineer_assigned:t:1:email:u",
  eventCode: "task_engineer_assigned",
  channel: "email",
  recipientAddress: "eng@clinic.ru",
  subject: "Тема",
  body: "Текст"
};

/** Репозиторий в памяти: одна доставка с заданным числом прошлых попыток. */
class OneDeliveryRepository implements EventOutboxRepository {
  public failed: Array<{ code: string; retryAt: string; retryAllowed: boolean }> = [];
  public eventRetryAt: string | undefined;
  public processed = false;
  public constructor(private readonly attempts: number) {}
  public async claim(): Promise<readonly BusinessEvent[]> { return [event]; }
  public async stage(): Promise<readonly StoredChannelDelivery[]> {
    return [{ ...command, id: "d1", outboxEventId: String(event.id), attempts: this.attempts }];
  }
  public async recordDeliveryAttempt(): Promise<boolean> { return true; }
  public async markDeliveryDelivered(): Promise<void> {}
  public async markDeliveryFailed(_id: string, code: string, retryAt: string, retryAllowed = true): Promise<void> {
    this.failed.push({ code, retryAt, retryAllowed });
  }
  public async markEventProcessed(): Promise<void> { this.processed = true; }
  public async markEventForRetry(_id: string, _code: string, retryAt: string): Promise<void> { this.eventRetryAt = retryAt; }
}

const failingChannel = {
  code: "email" as const,
  async deliver(): Promise<ChannelDeliveryReceipt> { throw new ChannelDeliveryError("smtp_temporary_failure"); }
};
const planner = { plan: async () => [command] };
const now = new Date("2026-11-11T10:00:00.000Z");

describe("надёжность очереди", () => {
  it("пауза между повторами растёт, событие ждёт самую позднюю доставку", async () => {
    const repository = new OneDeliveryRepository(3);
    await dispatchOutboxBatch(repository, planner, [failingChannel], now, { leaseMs: 60_000, retryDelayMs: 60_000 });
    const expected = new Date(now.getTime() + 60_000 * 2 ** 3).toISOString();
    assert.equal(repository.failed[0]?.retryAt, expected);
    assert.equal(repository.eventRetryAt, expected);
    assert.equal(repository.processed, false);
  });

  it("после предела попыток доставка окончательно неудачна, событие закрывается", async () => {
    const repository = new OneDeliveryRepository(12);
    let called = false;
    const channel = { code: "email" as const, async deliver(): Promise<ChannelDeliveryReceipt> { called = true; return {}; } };
    await dispatchOutboxBatch(repository, planner, [channel], now, { maxAttempts: 12 });
    assert.equal(called, false);
    assert.deepEqual(repository.failed.map((item) => [item.code, item.retryAllowed]), [["max_attempts_exceeded", false]]);
    assert.equal(repository.processed, true);
  });

  it("постоянный отказ не повторяется и не держит событие", async () => {
    const repository = new OneDeliveryRepository(0);
    const rejecting = { code: "email" as const, async deliver(): Promise<ChannelDeliveryReceipt> { throw new ChannelDeliveryError("smtp_recipient_rejected", false); } };
    await dispatchOutboxBatch(repository, planner, [rejecting], now);
    assert.equal(repository.failed[0]?.retryAllowed, false);
    assert.equal(repository.processed, true);
  });

  it("некорректное событие откладывается отдельно и не блокирует пачку", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const repository = new PostgresEventOutboxRepository({
      executeSql: async (text, values) => {
        calls.push({ text, ...(values ? { values } : {}) });
        if (text.includes("claim_business_events")) {
          return {
            rows: [
              { id: "00000000-0000-4000-8000-000000000020", idempotency_key: "x:1", aggregate_type: "task", aggregate_id: "00000000-0000-4000-8000-000000000021", event_type: "task_comment_added", event_version: 1, payload: {}, occurred_at: "2026-11-11T10:00:00.000Z" },
              { id: "00000000-0000-4000-8000-000000000022", idempotency_key: "y:1", aggregate_type: "task", aggregate_id: "00000000-0000-4000-8000-000000000023", event_type: "task_engineer_assigned", event_version: 1, payload: {}, occurred_at: "2026-11-11T10:00:00.000Z" }
            ]
          };
        }
        return { rows: [] };
      }
    });
    const events = await repository.claim(50, now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
    assert.deepEqual(events.map((item) => item.eventCode), ["task_engineer_assigned"]);
    const retry = calls.find((call) => call.text.includes("retry_business_event"));
    assert.equal(retry?.values?.[0], "00000000-0000-4000-8000-000000000020");
    assert.equal(retry?.values?.[1], "event_unsupported_by_worker");
  });

  it("неверный e-mail попадает в журнал окончательной ошибкой, а не пропадает молча", async () => {
    const planner = new PostgresEmailEventDeliveryPlanner({
      executeSql: async () => ({
        rows: [
          { recipient_user_id: "u1", recipient_address: "petrov @clinic", recipient_name: "Петров", subject_template: "Тема", body_template: "Текст", allowed_variables: [], task_id: "t1", variables: {} },
          { recipient_user_id: "u2", recipient_address: " ivanov@clinic.ru ", recipient_name: "Иванов", subject_template: "Тема", body_template: "Текст", allowed_variables: [], task_id: "t1", variables: {} }
        ]
      })
    }, "https://crm.example.ru");
    const commands = await planner.plan(event);
    assert.deepEqual(commands.map((item) => item.recipientAddress), ["petrov @clinic", "ivanov@clinic.ru"]);
    const { SmtpDeliveryChannel } = await import("./smtp.js");
    const channel = new SmtpDeliveryChannel({ fromAddress: "service@clinic.ru", fromName: "МедТехСервис" }, { send: async (message) => {
      const { smtpMessageData } = await import("./smtp.js");
      smtpMessageData(message);
    } });
    await assert.rejects(channel.deliver(commands[0]!), (error: unknown) =>
      error instanceof ChannelDeliveryError && error.diagnosticCode === "smtp_invalid_address" && !error.retryAllowed);
  });

  it("последняя разрешённая попытка сразу становится окончательной ошибкой", async () => {
    const repository = new OneDeliveryRepository(11);
    await dispatchOutboxBatch(repository, planner, [failingChannel], now, { maxAttempts: 12 });
    assert.deepEqual(repository.failed.map((item) => [item.code, item.retryAllowed]), [["max_attempts_exceeded:smtp_temporary_failure", false]]);
    assert.equal(repository.processed, true);
  });

  it("не начинает попытку, если её аренда переживёт аренду события", async () => {
    const repository = new OneDeliveryRepository(0);
    let called = false;
    const channel = { code: "email" as const, async deliver(): Promise<ChannelDeliveryReceipt> { called = true; return {}; } };
    await dispatchOutboxBatch(repository, planner, [channel], now, { leaseMs: 60_000, claimLeaseMs: 30_000 });
    assert.equal(called, false);
    assert.equal(repository.processed, false);
    assert.ok(repository.eventRetryAt);
  });

  it("при остановке службы новые попытки не начинаются", async () => {
    const repository = new OneDeliveryRepository(0);
    let called = false;
    const channel = { code: "email" as const, async deliver(): Promise<ChannelDeliveryReceipt> { called = true; return {}; } };
    await dispatchOutboxBatch(repository, planner, [channel], now, { shouldStop: () => true });
    assert.equal(called, false);
    assert.equal(repository.processed, false);
  });
});
