import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toDomainId, toIsoDateTime, type BusinessEvent } from "./domain.js";
import { ChannelDeliveryError, type ChannelDeliveryCommand } from "./outbox.js";
import { CompositeEventDeliveryPlanner, DryRunDeliveryChannel, maskAddress } from "./runtime.js";
import {
  PostgresTelegramEventDeliveryPlanner,
  TelegramChatIdResponder,
  TelegramClient,
  TelegramDeliveryChannel,
  telegramConfiguration,
  telegramText,
  type FetchLike
} from "./telegram.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc";
const config = { botToken: TOKEN, apiBaseUrl: "https://api.telegram.org", timeoutMs: 5_000 };

const command: ChannelDeliveryCommand = {
  idempotencyKey: "task_engineer_assigned:t1:1:telegram:u1",
  eventCode: "task_engineer_assigned",
  recipientUserId: "u1",
  channel: "telegram",
  recipientAddress: "123456789",
  subject: "По задаче MTS-1 назначен инженер",
  body: "Текст",
  taskId: "t1"
};

const event: BusinessEvent = {
  id: toDomainId("00000000-0000-4000-8000-000000000001"),
  idempotencyKey: "task_engineer_assigned:t1:1",
  eventCode: "task_engineer_assigned",
  eventVersion: 1,
  aggregateType: "task",
  aggregateId: toDomainId("00000000-0000-4000-8000-000000000002"),
  occurredAt: toIsoDateTime("2026-11-11T10:00:00.000Z"),
  payload: {}
};

function fakeFetch(status: number, body: unknown, calls: Array<{ url: string; body: unknown }> = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status, json: async () => body };
  };
}

async function deliveryError(promise: Promise<unknown>): Promise<ChannelDeliveryError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ChannelDeliveryError);
    return error;
  }
  assert.fail("ожидалась ошибка доставки");
}

describe("Telegram", () => {
  it("отправляет сообщение в чат и возвращает идентификатор", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const channel = new TelegramDeliveryChannel(new TelegramClient(config, fakeFetch(200, { ok: true, result: { message_id: 77 } }, calls)));
    const receipt = await channel.deliver(command);
    assert.equal(receipt.providerMessageId, "telegram:123456789:77");
    assert.equal(calls[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    assert.deepEqual(calls[0]?.body, {
      chat_id: "123456789",
      text: "По задаче MTS-1 назначен инженер\n\nТекст",
      disable_web_page_preview: true
    });
  });

  it("временные сбои повторяет, отказ чата не повторяет", async () => {
    const temporary = await deliveryError(new TelegramDeliveryChannel(new TelegramClient(config, fakeFetch(429, { ok: false }))).deliver(command));
    assert.equal(temporary.diagnosticCode, "telegram_temporary_failure");
    assert.equal(temporary.retryAllowed, true);
    const blocked = await deliveryError(new TelegramDeliveryChannel(new TelegramClient(config, fakeFetch(403, { ok: false }))).deliver(command));
    assert.equal(blocked.diagnosticCode, "telegram_chat_rejected");
    assert.equal(blocked.retryAllowed, false);
    const token = await deliveryError(new TelegramDeliveryChannel(new TelegramClient(config, fakeFetch(401, { ok: false }))).deliver(command));
    assert.equal(token.diagnosticCode, "telegram_bot_token_rejected");
  });

  it("сетевую ошибку отдаёт без текста и токена", async () => {
    const failing: FetchLike = async () => { throw Object.assign(new Error(`connect failed bot${TOKEN}`), { cause: { code: "ECONNREFUSED" } }); };
    const error = await deliveryError(new TelegramDeliveryChannel(new TelegramClient(config, failing)).deliver(command));
    assert.equal(error.diagnosticCode, "telegram_connection_failed");
    assert.equal(error.retryAllowed, true);
    assert.ok(!error.message.includes(TOKEN));
  });

  it("таймаут подключения повторяет: сообщение точно не ушло", async () => {
    const connectTimeout: FetchLike = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }); };
    const error = await deliveryError(new TelegramDeliveryChannel(new TelegramClient(config, connectTimeout)).deliver(command));
    assert.equal(error.diagnosticCode, "telegram_connection_failed");
    assert.equal(error.retryAllowed, true);
  });

  it("таймаут после отправки не повторяет, чтобы не было дубля", async () => {
    const aborted: FetchLike = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
    const error = await deliveryError(new TelegramDeliveryChannel(new TelegramClient(config, aborted)).deliver(command));
    assert.equal(error.diagnosticCode, "telegram_delivery_outcome_unknown");
    assert.equal(error.retryAllowed, false);
  });

  it("не отправляет на неверный номер чата", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const channel = new TelegramDeliveryChannel(new TelegramClient(config, fakeFetch(200, { ok: true }, calls)));
    const error = await deliveryError(channel.deliver({ ...command, recipientAddress: "@username" }));
    assert.equal(error.diagnosticCode, "telegram_invalid_chat_id");
    assert.equal(calls.length, 0);
  });

  it("обрезает слишком длинный текст до лимита Telegram", () => {
    const text = telegramText("Тема", "я".repeat(5_000));
    assert.equal(text.length, 4096);
    assert.ok(text.endsWith("…"));
  });

  it("проверяет настройки бота", () => {
    assert.throws(() => telegramConfiguration({}), /TELEGRAM_BOT_TOKEN is required/u);
    assert.throws(() => telegramConfiguration({ TELEGRAM_BOT_TOKEN: "плохой" }), /invalid format/u);
    assert.throws(() => telegramConfiguration({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE_URL: "http://evil.example" }), /https/u);
    assert.equal(telegramConfiguration({ TELEGRAM_BOT_TOKEN: TOKEN }).apiBaseUrl, "https://api.telegram.org");
  });

  it("планировщик строит сообщения по шаблону и пропускает неверные номера чатов", async () => {
    const queries: string[] = [];
    const planner = new PostgresTelegramEventDeliveryPlanner({
      executeSql: async (text) => {
        queries.push(text);
        return {
          rows: [
            {
              recipient_user_id: "u1", recipient_address: " 123456789 ", recipient_name: "Иван",
              subject_template: "По задаче {{taskNumber}} назначен инженер",
              body_template: "{{recipientName}}, ссылка {{taskUrl}}",
              allowed_variables: ["taskNumber", "recipientName", "taskUrl"],
              task_id: "t1", variables: { taskNumber: "MTS-1", recipientName: "Иван" }
            },
            {
              recipient_user_id: "u2", recipient_address: "не номер", recipient_name: "Пётр",
              subject_template: "", body_template: "x", allowed_variables: [], task_id: "t1", variables: {}
            }
          ]
        };
      }
    }, "https://crm.example.ru/");
    const commands = await planner.plan(event);
    assert.match(queries[0] ?? "", /load_telegram_event_plan\(\$1::uuid\)/u);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.recipientAddress, "123456789");
    assert.equal(commands[0]?.subject, "По задаче MTS-1 назначен инженер");
    assert.equal(commands[0]?.body, "Иван, ссылка https://crm.example.ru/tasks/t1");
    assert.equal(commands[0]?.idempotencyKey, "task_engineer_assigned:t1:1:telegram:u1");
  });

  it("бот отвечает номером чата только на /start в личке", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let first = true;
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith("/getUpdates") && first) {
        first = false;
        return {
          status: 200,
          json: async () => ({
            ok: true,
            result: [
              { update_id: 10, message: { text: "/start", chat: { id: 555, type: "private" } } },
              { update_id: 11, message: { text: "привет", chat: { id: 556, type: "private" } } },
              { update_id: 12, message: { text: "/start", chat: { id: -100, type: "group" } } }
            ]
          })
        };
      }
      return { status: 200, json: async () => ({ ok: true, result: [] }) };
    };
    const responder = new TelegramChatIdResponder(new TelegramClient(config, fetchImpl));
    assert.equal(await responder.poll(), 1);
    const reply = calls.find((call) => call.url.endsWith("/sendMessage"));
    assert.equal((reply?.body as { chat_id: number }).chat_id, 555);
    assert.match((reply?.body as { text: string }).text, /555/u);
    await responder.poll();
    const secondPoll = calls.filter((call) => call.url.endsWith("/getUpdates"))[1];
    assert.equal((secondPoll?.body as { offset: number }).offset, 13);
  });
});

describe("служба", () => {
  it("пробный режим ничего не отправляет и прячет адрес", async () => {
    const lines: string[] = [];
    const channel = new DryRunDeliveryChannel("email", (line) => lines.push(line));
    const receipt = await channel.deliver({ ...command, channel: "email", recipientAddress: "ivanov@clinic.ru" });
    assert.match(receipt.providerMessageId ?? "", /^dry-run:/u);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]?.includes("ivanov@"));
    assert.equal(maskAddress("email", "ivanov@clinic.ru"), "i***@clinic.ru");
    assert.equal(maskAddress("telegram", "123456789"), "12***");
  });

  it("объединяет планы каналов", async () => {
    const planner = new CompositeEventDeliveryPlanner([
      { plan: async () => [{ ...command, channel: "email", recipientAddress: "a@b.ru" }] },
      { plan: async () => [command] }
    ]);
    const commands = await planner.plan(event);
    assert.deepEqual(commands.map((item) => item.channel), ["email", "telegram"]);
  });
});
