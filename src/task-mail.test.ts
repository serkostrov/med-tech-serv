import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  MAX_TASK_MAIL_REPLY,
  taskMailAttachmentFile,
  taskMailAuthor,
  taskMailReplyAddress,
  taskMailReplyLost,
  taskMailReplyPending,
  taskMailReplyRefusal,
  taskMailReplyStatus
} from "./task-mail.js";
import type { TaskMailMessage } from "./types.js";

const letter: TaskMailMessage = {
  id: "m1",
  direction: "incoming",
  author: "Смирнова А. В. <a.smirnova@gkb1.example>",
  subject: "Срочно: XN-1000 не берёт пробу",
  body: "Анализатор не берёт пробу",
  occurredAt: "2026-11-11T05:31:00.000Z",
  status: "converted",
  attachments: [{ fileId: "f1", fileName: "ошибка.jpg", contentType: "image/jpeg", byteSize: 288_000, storageKey: "mail/m1/error.jpg" }]
};

const reply = (status: string, error?: string): TaskMailMessage => ({
  id: "r1",
  direction: "outgoing",
  author: "Морозова Елена Владимировна",
  recipient: "a.smirnova@gkb1.example",
  subject: "Re: Срочно: XN-1000 не берёт пробу",
  body: "Инженер приедет в среду",
  occurredAt: "2026-11-11T06:06:00.000Z",
  status,
  ...(error ? { error } : {}),
  attachments: []
});

describe("переписка с клиентом в карточке задачи", () => {
  it("не пускает пустой и слишком длинный ответ, как проверка в базе", () => {
    assert.equal(taskMailReplyRefusal("   \n  "), "Напишите текст ответа клиенту");
    assert.equal(taskMailReplyRefusal(""), "Напишите текст ответа клиенту");
    assert.equal(taskMailReplyRefusal("Инженер приедет в среду"), null);
    assert.equal(taskMailReplyRefusal("я".repeat(MAX_TASK_MAIL_REPLY)), null);
    assert.match(String(taskMailReplyRefusal("я".repeat(MAX_TASK_MAIL_REPLY + 1))), /сократите текст/u);
    // Символы считаем как база (char_length): эмодзи не съедает лимит вдвое быстрее.
    assert.equal(taskMailReplyRefusal("🙂".repeat(MAX_TASK_MAIL_REPLY)), null);
  });

  it("разбирает отправителя письма на имя и адрес", () => {
    assert.deepEqual(taskMailAuthor("Смирнова А. В. <a.smirnova@gkb1.example>"), { name: "Смирнова А. В.", address: "a.smirnova@gkb1.example" });
    assert.deepEqual(taskMailAuthor("\"Лаборатория\" <lab@x.example>"), { name: "Лаборатория", address: "lab@x.example" });
    assert.deepEqual(taskMailAuthor("<lab@x.example>"), { name: "lab@x.example", address: "lab@x.example" });
    assert.deepEqual(taskMailAuthor("lab@x.example"), { name: "lab@x.example", address: "lab@x.example" });
    assert.deepEqual(taskMailAuthor("Морозова Елена Владимировна"), { name: "Морозова Елена Владимировна" });
    assert.deepEqual(taskMailAuthor("  "), { name: "Неизвестный отправитель" });
  });

  it("говорит, что стало с ответом координатора", () => {
    assert.equal(taskMailReplyStatus(letter), undefined);
    assert.equal(taskMailReplyStatus(reply("queued")), "В очереди на отправку");
    assert.equal(taskMailReplyStatus(reply("sending")), "Отправляется");
    assert.equal(taskMailReplyStatus(reply("sent")), "Отправлено клиенту");
    assert.equal(taskMailReplyStatus(reply("failed", "smtp_recipient_rejected")), "Не отправлено: smtp_recipient_rejected");
    // Код ошибки переводит словарь экрана: координатор читает причину по-русски.
    assert.equal(
      taskMailReplyStatus(reply("failed", "smtp_recipient_rejected"), () => "почтовый сервер не знает такого адреса"),
      "Не отправлено: почтовый сервер не знает такого адреса"
    );
    assert.equal(taskMailReplyStatus(reply("failed")), "Не отправлено");
    assert.equal(taskMailReplyPending(reply("sent")), false);
    assert.equal(taskMailReplyPending(reply("queued")), true);
    assert.equal(taskMailReplyPending(letter), false);
  });

  it("называет адрес, на который уйдёт ответ", () => {
    assert.equal(taskMailReplyAddress([letter, reply("sent")]), "a.smirnova@gkb1.example");
    // Отвечаем на последнее письмо клиента, как и база.
    const second: TaskMailMessage = { ...letter, id: "m2", author: "lab@gkb1.example", occurredAt: "2026-11-12T05:00:00.000Z" };
    assert.equal(taskMailReplyAddress([letter, reply("sent"), second]), "lab@gkb1.example");
    assert.equal(taskMailReplyAddress([reply("sent")]), undefined);
    assert.equal(taskMailReplyAddress([]), undefined);
  });

  it("отличает ответ, который служба ещё повторит, от потерянного", () => {
    assert.equal(taskMailReplyLost(reply("failed", "smtp_recipient_rejected")), true);
    assert.equal(taskMailReplyLost(reply("queued", "smtp_connection_failed")), false);
    assert.equal(taskMailReplyLost(letter), false);
    // Ответ вернулся в очередь после сбоя: координатор видит, что писать заново не нужно.
    assert.equal(
      taskMailReplyStatus(reply("queued", "smtp_connection_failed"), () => "почтовый сервер недоступен"),
      "В очереди на отправку, прошлая попытка не удалась: почтовый сервер недоступен"
    );
    assert.equal(taskMailReplyStatus(reply("queued")), "В очереди на отправку");
  });

  it("показывает вложение письма обычным файлом задачи", () => {
    const file = taskMailAttachmentFile(letter, letter.attachments[0]!);
    assert.equal(file.id, "f1");
    assert.equal(file.kind, "mail_attachment");
    assert.equal(file.originalName, "ошибка.jpg");
    assert.equal(file.byteSize, 288_000);
    assert.equal(file.storageKey, "mail/m1/error.jpg");
    assert.equal(file.createdAt, letter.occurredAt);
    // Вложение, которое ещё не стало файлом задачи: плитка всё равно рисуется.
    const pending = taskMailAttachmentFile(letter, { fileName: "скан.pdf", contentType: "application/pdf", byteSize: 0 });
    assert.equal(pending.id, "m1-скан.pdf");
    assert.equal(pending.storageKey, undefined);
  });
});

describe("карточка задачи берёт переписку и права из базы", () => {
  // Отрисовку переписки проверяет task-mail.test.tsx; здесь — проводка карточки,
  // которую иначе видно только в браузере.
  it("грузит переписку задачи и спрашивает право на ответ у базы", async () => {
    const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    assert.match(app, /m2Api\.taskMailThread\(task\.id\)/u);
    // Право на ответ не вычисляется по роли на экране.
    assert.match(app, /m2Api\.canReplyTaskMail\(task\.id\)/u);
    assert.doesNotMatch(app, /canReplyMail = .*permissions/u);
    // Вкладка появляется только у задач с письмом, и из раздела «Письма» карточка
    // открывается сразу на ней.
    assert.match(app, /label: "Письмо клиента", badge: mailThread\.length/u);
    assert.match(app, /initialTab=\{openOnMailTab \? "mail" : "overview"\}/u);
  });
});
