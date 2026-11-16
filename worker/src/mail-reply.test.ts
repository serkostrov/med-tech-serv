import assert from "node:assert/strict";
import { test } from "node:test";
import { processIncomingMail, type IncomingMail } from "./mail-intake.js";
import { sendTaskMailReplies } from "./mail-reply.js";
import { ChannelDeliveryError, type OutboxSqlExecutor } from "./outbox.js";
import { smtpMessageData, type SmtpMessage } from "./smtp.js";

function fakeDatabase(handler: (text: string, values: readonly unknown[]) => Record<string, unknown>[]) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const database: OutboxSqlExecutor = {
    async executeSql(text, values = []) {
      calls.push({ text, values });
      return { rows: handler(text, values) };
    }
  };
  return { database, calls };
}

const CLIENT_REPLY: IncomingMail = {
  messageId: "<client-2@clinic.example>",
  inReplyTo: "<reply-5f1@medtechservice>",
  references: ["<client-1@clinic.example>", "<reply-5f1@medtechservice>"],
  from: "kdl@clinic.example",
  subject: "Re: Ошибка температуры инкубатора",
  text: "Спасибо, ждём инженера в среду.",
  receivedAt: new Date("2026-11-12T07:00:00Z"),
  raw: new TextEncoder().encode("raw"),
  attachments: [{ fileName: "после-ремонта.jpg", contentType: "image/jpeg", data: new Uint8Array([1, 2]) }]
};

test("ответ клиента ложится в переписку задачи: файлы сохранены, заявка не разбирается", async () => {
  const { database, calls } = fakeDatabase((text) => text.includes("ingest_mail_message")
    ? [{ id: "22222222-2222-2222-2222-222222222222", created: true, needs_parse: false, has_files: false, is_reply: true }]
    : []);
  const stored: string[] = [];
  const files = { async put(mailId: string, fileName: string) { stored.push(fileName); return `mail/${mailId}/${stored.length}.bin`; } };
  const outcome = await processIncomingMail(CLIENT_REPLY, database, files, { async parse() { throw new Error("нейросеть не нужна"); } });
  assert.equal(outcome, "reply");
  // Письмо и вложение в хранилище, их база сама отдаст файлам задачи.
  assert.deepEqual(stored, ["message.eml", "после-ремонта.jpg"]);
  assert.ok(calls.some((call) => call.text.includes("set_mail_attachments")));
  assert.ok(!calls.some((call) => call.text.includes("set_mail_parse_result")), "ответ клиента как заявку не разбираем");
  assert.ok(!calls.some((call) => call.text.includes("find_equipment_by_serial")));
  // Заголовки цепочки уходят в базу: по ним письмо и находит свою задачу.
  const ingest = calls[0]!;
  assert.equal(ingest.values[1], "<reply-5f1@medtechservice>");
  assert.deepEqual(ingest.values[2], ["<client-1@clinic.example>", "<reply-5f1@medtechservice>"]);
});

test("повтор ответа клиента второй раз не обрабатывается", async () => {
  const { database, calls } = fakeDatabase((text) => text.includes("ingest_mail_message")
    ? [{ id: "22222222-2222-2222-2222-222222222222", created: false, needs_parse: false, has_files: true, is_reply: true }]
    : []);
  let uploads = 0;
  const outcome = await processIncomingMail(CLIENT_REPLY, database, { async put() { uploads += 1; return "k"; } }, undefined);
  assert.equal(outcome, "duplicate");
  assert.equal(uploads, 0);
  assert.equal(calls.length, 1);
});

test("вложения ответа клиента догружаются, если хранилище было недоступно", async () => {
  // Прошлый проход письмо завёл, но файлы не сохранил: has_files = false, created = false.
  const { database, calls } = fakeDatabase((text) => text.includes("ingest_mail_message")
    ? [{ id: "22222222-2222-2222-2222-222222222222", created: false, needs_parse: false, has_files: false, is_reply: true }]
    : []);
  const stored: string[] = [];
  const outcome = await processIncomingMail(CLIENT_REPLY, database, {
    async put(mailId: string, fileName: string) { stored.push(fileName); return `mail/${mailId}/${stored.length}.bin`; }
  }, undefined);
  assert.equal(outcome, "reply");
  assert.deepEqual(stored, ["message.eml", "после-ремонта.jpg"]);
  assert.ok(calls.some((call) => call.text.includes("set_mail_attachments")));
});

test("ответ координатора уходит с заголовками цепочки и отмечается отправленным", async () => {
  const { database, calls } = fakeDatabase((text) => text.includes("claim_task_mail_replies")
    ? [{
        id: "33333333-3333-3333-3333-333333333333",
        to_address: "kdl@clinic.example",
        subject: "Re: Ошибка температуры инкубатора",
        body: "Здравствуйте!\nИнженер приедет в среду.",
        message_id: "reply-33333333@medtechservice",
        in_reply_to: "<client-1@clinic.example>",
        reference_ids: ["<client-1@clinic.example>", "<reply-5f1@medtechservice>", "не message-id"],
        task_number: "З-000012"
      }]
    : []);
  const sent: Array<Omit<SmtpMessage, "fromAddress" | "fromName">> = [];
  const result = await sendTaskMailReplies(database, { async send(message) { sent.push(message); } });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(sent[0]!.toAddress, "kdl@clinic.example");
  assert.equal(sent[0]!.inReplyTo, "<client-1@clinic.example>");
  // Мусор в цепочке отбрасывается, остальное уходит по порядку.
  assert.deepEqual(sent[0]!.references, ["<client-1@clinic.example>", "<reply-5f1@medtechservice>"]);
  // Ответ координатора — не автоответ: почтовая программа клиента может на него ответить.
  assert.equal(sent[0]!.autoSubmitted, undefined);
  assert.ok(calls.some((call) => call.text.includes("mark_task_mail_reply_sent")));
  assert.ok(!calls.some((call) => call.text.includes("fail_task_mail_reply")));
});

test("ошибка отправки ответа сохраняется кодом, без текста SMTP", async () => {
  const { database, calls } = fakeDatabase((text) => text.includes("claim_task_mail_replies")
    ? [{
        id: "44444444-4444-4444-4444-444444444444",
        to_address: "kdl@clinic.example",
        subject: "Re: x",
        body: "текст",
        message_id: "reply-44444444@medtechservice",
        in_reply_to: null,
        reference_ids: null,
        task_number: "З-000013"
      }]
    : []);
  const result = await sendTaskMailReplies(database, {
    async send() { throw Object.assign(new Error("550 5.1.1 kdl@clinic.example rejected"), { diagnosticCode: "smtp_recipient_rejected" }); }
  });
  assert.deepEqual(result, { sent: 0, failed: 1 });
  const fail = calls.find((call) => call.text.includes("fail_task_mail_reply"))!;
  // Третьим идёт признак повтора: отказ получателя повторять бессмысленно.
  assert.deepEqual(fail.values, ["44444444-4444-4444-4444-444444444444", "smtp_recipient_rejected", false]);
  assert.ok(!calls.some((call) => call.text.includes("mark_task_mail_reply_sent")));
  // Письмо без цепочки всё равно уходит: заголовки необязательны.
  assert.ok(fail.values.every((value) => !String(value).includes("550")));
});

test("временный сбой почты возвращает ответ в очередь, неизвестная ошибка — нет", async () => {
  const reply = {
    id: "55555555-5555-5555-5555-555555555555",
    to_address: "kdl@clinic.example", subject: "Re: x", body: "текст",
    message_id: "reply-55555555@medtechservice", in_reply_to: null, reference_ids: null, task_number: "З-000014"
  };
  const attempt = async (thrown: unknown) => {
    const { database, calls } = fakeDatabase((text) => (text.includes("claim_task_mail_replies") ? [reply] : []));
    await sendTaskMailReplies(database, { async send() { throw thrown; } });
    return calls.find((call) => call.text.includes("fail_task_mail_reply"))!.values;
  };
  // Почтовый сервер не ответил: служба повторит сама, координатору писать заново не нужно.
  assert.deepEqual(await attempt(new ChannelDeliveryError("smtp_connection_failed", true)), [reply.id, "smtp_connection_failed", true]);
  // Исход неизвестен (связь оборвалась после передачи): повтор дал бы клиенту два письма.
  assert.deepEqual(await attempt(new ChannelDeliveryError("smtp_delivery_outcome_unknown", false)), [reply.id, "smtp_delivery_outcome_unknown", false]);
  // Незнакомая ошибка: код из словаря экрана, а не «Error».
  assert.deepEqual(await attempt(new Error("что-то пошло не так")), [reply.id, "channel_delivery_failed", false]);
});

test("SMTP: References несёт всю переписку, чужой заголовок не подставить", () => {
  const base = { messageId: "reply-1@medtechservice", fromAddress: "service@mts.test", fromName: "МедТехСервис", toAddress: "kdl@clinic.example", subject: "Re: Ошибка", body: "текст" };
  const data = smtpMessageData({
    ...base,
    inReplyTo: "<reply-5f1@medtechservice>",
    references: ["<client-1@clinic.example>", "<reply-5f1@medtechservice>"]
  });
  assert.match(data, /\r\nIn-Reply-To: <reply-5f1@medtechservice>\r\n/u);
  // Длинная переписка переносится по строкам, как требует формат письма.
  assert.match(data, /\r\nReferences: <client-1@clinic\.example>\r\n <reply-5f1@medtechservice>\r\n/u);
  // Без цепочки поведение прежнее: в References одно письмо из In-Reply-To.
  assert.match(smtpMessageData({ ...base, inReplyTo: "<a@b>" }), /\r\nReferences: <a@b>\r\n/u);
  assert.throws(() => smtpMessageData({ ...base, references: ["<a@b>\r\nBcc: z@z.ru"] }));
  assert.throws(() => smtpMessageData({ ...base, references: ["без скобок@b"] }));
});
