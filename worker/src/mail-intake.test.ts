import assert from "node:assert/strict";
import { test } from "node:test";
import { draftFromAiJson, aiMailParserFromEnv } from "./ai-parser.js";
import { sendMailAutoreplies } from "./mail-autoreply.js";
import { processIncomingMail, toIncomingMail, type IncomingMail } from "./mail-intake.js";
import type { OutboxSqlExecutor } from "./outbox.js";
import { smtpMessageData } from "./smtp.js";
import { supabaseMailFileStore } from "./storage-upload.js";

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

const EML = [
  "Message-ID: <abc-1@client.example>",
  "From: =?UTF-8?B?0JvQsNCx0L7RgNCw0YLQvtGA0LjRjw==?= <lab@client.example>",
  "To: service@example.test",
  "Subject: =?UTF-8?B?0JfQsNGP0LLQutCwINC90LAg0YDQtdC80L7QvdGC?=",
  "Date: Tue, 10 Nov 2026 09:00:00 +0300",
  "MIME-Version: 1.0",
  "Content-Type: multipart/mixed; boundary=\"b1\"",
  "",
  "--b1",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: 8bit",
  "",
  "Клиент: Подпорожская МБ",
  "Оборудование: Mindray BS-620",
  "S/N: BJ1-58000885",
  "Описание неисправности: не включается",
  "",
  "--b1",
  "Content-Type: application/pdf; name=\"акт.pdf\"",
  "Content-Disposition: attachment; filename=\"=?UTF-8?B?0LDQutGCLnBkZg==?=\"",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("%PDF-1.4 test").toString("base64"),
  "--b1--",
  ""
].join("\r\n");

test("письмо из ящика разбирается: отправитель, тема, текст, вложение", async () => {
  const mail = await toIncomingMail(new TextEncoder().encode(EML), new Date());
  assert.equal(mail.messageId, "<abc-1@client.example>");
  assert.equal(mail.from, "lab@client.example");
  assert.equal(mail.subject, "Заявка на ремонт");
  assert.match(mail.text, /BJ1-58000885/u);
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0]!.fileName, "акт.pdf");
});

test("новое письмо: файлы в хранилище, черновик, прибор найден по S/N", async () => {
  const mail = await toIncomingMail(new TextEncoder().encode(EML), new Date());
  const { database, calls } = fakeDatabase((text) => {
    if (text.includes("ingest_mail_message")) return [{ id: "11111111-1111-1111-1111-111111111111", created: true, needs_parse: true, has_files: false }];
    if (text.includes("find_equipment_by_serial")) return [{ id: "eq-1", serial_number: "BJ1-58000885", model: "BS-620", manufacturer: "Mindray", site_name: "Лаборатория" }];
    return [];
  });
  const stored: string[] = [];
  const files = { async put(mailId: string, fileName: string) { stored.push(fileName); return `mail/${mailId}/${stored.length}.bin`; } };
  const outcome = await processIncomingMail(mail, database, files, undefined);
  assert.equal(outcome, "parsed");
  assert.deepEqual(stored, ["message.eml", "акт.pdf"]);
  const parse = calls.find((call) => call.text.includes("set_mail_parse_result"))!;
  const payload = JSON.parse(String(parse.values[1]));
  assert.equal(payload.equipmentFound, true);
  assert.equal(payload.equipmentId, "eq-1");
  assert.equal(payload.client, "Подпорожская МБ");
  assert.equal(payload.lowConfidence, false);
  assert.ok(Number(parse.values[2]) >= 0.8);
});

test("повтор того же письма ничего не загружает и не разбирает", async () => {
  const mail = await toIncomingMail(new TextEncoder().encode(EML), new Date());
  const { database, calls } = fakeDatabase((text) => (text.includes("ingest_mail_message") ? [{ id: "x", created: false, needs_parse: false, has_files: true }] : []));
  let uploads = 0;
  const outcome = await processIncomingMail(mail, database, { async put() { uploads += 1; return "k"; } }, undefined);
  assert.equal(outcome, "duplicate");
  assert.equal(uploads, 0);
  assert.equal(calls.length, 1);
});

test("прибор не найден: уверенность снижается, ошибка нейросети не мешает", async () => {
  const mail: IncomingMail = { messageId: "<m2@x>", references: [], from: "a@x.ru", subject: "S/N ZZ-1", text: "Клиент: Больница\nS/N: ZZ-12345\nне печатает", receivedAt: new Date(), raw: new Uint8Array(), attachments: [] };
  const { database, calls } = fakeDatabase((text) => (text.includes("ingest_mail_message") ? [{ id: "m2", created: true, needs_parse: true, has_files: false }] : []));
  const outcome = await processIncomingMail(mail, database, undefined, { async parse() { throw new Error("down"); } });
  assert.equal(outcome, "parsed");
  const parse = calls.find((call) => call.text.includes("set_mail_parse_result"))!;
  assert.equal(JSON.parse(String(parse.values[1])).equipmentFound, false);
  assert.ok(Number(parse.values[2]) <= 0.6);
});

test("сбой хранилища: письмо всё равно разобрано, отметка о файлах", async () => {
  const mail = await toIncomingMail(new TextEncoder().encode(EML), new Date());
  const { database, calls } = fakeDatabase((text) => (text.includes("ingest_mail_message") ? [{ id: "m3", created: true, needs_parse: true, has_files: false }] : []));
  const outcome = await processIncomingMail(mail, database, { async put() { throw new Error("storage_upload_500"); } }, undefined);
  assert.equal(outcome, "parsed");
  const parse = calls.find((call) => call.text.includes("set_mail_parse_result"))!;
  assert.equal(JSON.parse(String(parse.values[1])).filesFailed, true);
});

test("оборванный разбор доделывается, файлы второй раз не грузятся", async () => {
  const mail = await toIncomingMail(new TextEncoder().encode(EML), new Date());
  const { database, calls } = fakeDatabase((text) => (text.includes("ingest_mail_message") ? [{ id: "m4", created: false, needs_parse: true, has_files: true }] : []));
  let uploads = 0;
  const outcome = await processIncomingMail(mail, database, { async put() { uploads += 1; return "k"; } }, undefined);
  assert.equal(outcome, "parsed");
  assert.equal(uploads, 0);
  assert.ok(calls.some((call) => call.text.includes("set_mail_parse_result")));
});

test("нулевой байт и письмо без Message-ID не ломают приём", async () => {
  const raw = ["From: a@x.ru", "To: b@y.ru", "Subject: S/N A-1 \u0000x", "Date: Tue, 10 Nov 2026 09:00:00 +0300", "Content-Type: text/plain; charset=UTF-8", "", "text \u0000 here", ""].join("\r\n").replace(/\\u0000/gu, "\u0000");
  const mail = await toIncomingMail(new TextEncoder().encode(raw), new Date());
  assert.ok(!mail.text.includes("\u0000") && !mail.subject.includes("\u0000"));
  assert.match(mail.messageId, /^<no-id-[0-9a-f]{32}@medtechservice>$/u);
  const again = await toIncomingMail(new TextEncoder().encode(raw), new Date(0));
  assert.equal(again.messageId, mail.messageId);
});

test("автоответы и «нет на месте» заявками не считаются", async () => {
  const raw = ["From: a@x.ru", "To: b@y.ru", "Subject: Нет на месте", "Auto-Submitted: auto-replied", "Message-ID: <ooo@x.ru>", "", "в отпуске", ""].join("\r\n");
  const mail = await toIncomingMail(new TextEncoder().encode(raw), new Date());
  const { database, calls } = fakeDatabase(() => []);
  assert.equal(await processIncomingMail(mail, database, undefined, undefined), "skipped");
  assert.equal(calls.length, 0);
});

test("автоответ: номер заявки, ответ в ту же переписку, ошибка сохраняется", async () => {
  const { database, calls } = fakeDatabase((text) => text.includes("claim_mail_autoreplies")
    ? [
        { id: "a1", sender: "lab@client.example", subject: "Заявка на ремонт", external_message_id: "<abc-1@client.example>", task_number: "З-000007", task_title: "Ремонт BS-620" },
        { id: "a2", sender: "bad", subject: "x", external_message_id: "no-id", task_number: "З-000008", task_title: "x" },
        { id: "a3", sender: "ok@client.example", subject: "y", external_message_id: "<no id with spaces>", task_number: "З-000009", task_title: "y" }
      ]
    : []);
  const sent: Array<Record<string, unknown>> = [];
  const result = await sendMailAutoreplies(database, { async send(message) {
    if (message.toAddress === "bad") throw Object.assign(new Error("x"), { diagnosticCode: "smtp_invalid_address" });
    sent.push(message as unknown as Record<string, unknown>);
  } });
  assert.deepEqual(result, { sent: 2, failed: 1 });
  assert.equal(sent[0]!.inReplyTo, "<abc-1@client.example>");
  assert.equal(sent[1]!.inReplyTo, undefined);
  assert.equal(sent[0]!.autoSubmitted, true);
  assert.match(String(sent[0]!.body), /З-000007/u);
  assert.match(String(sent[0]!.subject), /^Re: Заявка на ремонт/u);
  const fail = calls.find((call) => call.text.includes("fail_mail_autoreply"))!;
  assert.deepEqual(fail.values, ["a2", "smtp_invalid_address"]);
});

test("SMTP: заголовки ответа есть, подмена заголовков через In-Reply-To невозможна", () => {
  const base = { messageId: "r1@x.ru", fromAddress: "s@x.ru", fromName: "МТС", toAddress: "c@x.ru", subject: "Re: x", body: "b" };
  const data = smtpMessageData({ ...base, inReplyTo: "<abc@y>" });
  assert.match(data, /\r\nIn-Reply-To: <abc@y>\r\nReferences: <abc@y>\r\n/u);
  assert.throws(() => smtpMessageData({ ...base, inReplyTo: "<a>\r\nBcc: z@z.ru" }));
});

test("ответ нейросети: только известные поля, null не подставляется", () => {
  const parsed = draftFromAiJson({ client: "Больница №1", serialNumber: "null", contactPhone: " +7 900 ", extra: "x", confidence: 3 });
  assert.deepEqual(parsed?.draft, { client: "Больница №1", contactPhone: "+7 900" });
  assert.equal(parsed?.confidence, 1);
  assert.equal(aiMailParserFromEnv({}), undefined);
  assert.throws(() => aiMailParserFromEnv({ AI_PROVIDER: "yandex" }));
});

test("YandexGPT: запрос с ключом и разбор JSON из ответа", async () => {
  let request: { url: string; headers: Record<string, string>; body: string } | undefined;
  const parser = aiMailParserFromEnv({ AI_PROVIDER: "yandex", YANDEX_API_KEY: "k", YANDEX_FOLDER_ID: "f" }, async (url, init) => {
    request = { url, headers: init.headers, body: init.body };
    return { status: 200, async json() { return { result: { alternatives: [{ message: { text: "```json\n{\"client\":\"ГБ\",\"serialNumber\":\"A-1\",\"confidence\":0.9}\n```" } }] } }; } };
  })!;
  const result = await parser.parse("тема", "текст");
  assert.equal(request?.headers.Authorization, "Api-Key k");
  assert.match(request!.body, /gpt:\/\/f\/yandexgpt-lite/u);
  assert.equal(result?.draft.serialNumber, "A-1");
});

test("хранилище: ключ без кириллицы, ключ сервиса в заголовке", async () => {
  let url = "";
  const store = supabaseMailFileStore({ SUPABASE_URL: "http://localhost:8000/", SUPABASE_SERVICE_ROLE_KEY: "svc" }, async (target, init) => {
    url = target;
    assert.equal(init.headers.Authorization, "Bearer svc");
    return { status: 200, async text() { return ""; } };
  })!;
  const key = await store.put("m1", "Акт работ.PDF", "application/pdf", new Uint8Array([1]));
  assert.match(key, /^mail\/m1\/[0-9a-f-]{36}\.pdf$/u);
  assert.equal(url, `http://localhost:8000/storage/v1/object/medtech-files/${key}`);
  assert.equal(supabaseMailFileStore({}), undefined);
});
