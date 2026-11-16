import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  MAX_TASK_MAIL_REPLY,
  taskMailAttachmentFile,
  taskMailAuthor,
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

describe("карточка задачи показывает письмо клиента", () => {
  it("держит вкладку переписки, форму ответа и права из базы", async () => {
    const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    // Вкладка появляется только у задач с письмом.
    assert.match(app, /label: "Письмо клиента", badge: mailThread\.length/u);
    assert.match(app, /m2Api\.taskMailThread\(task\.id\)/u);
    // Право на ответ спрашиваем у базы, а не вычисляем по роли на экране.
    assert.match(app, /m2Api\.canReplyTaskMail\(task\.id\)/u);
    assert.match(app, /m2Api\.sendTaskMailReply\(task\.id, body\)/u);
    // Вложения письма рисует обычная галерея файлов задачи.
    assert.match(app, /<FileGallery files=\{files\} showKind=\{false\} \/>/u);
    // Из раздела «Письма» задача открывается сразу на переписке.
    assert.match(app, /initialTab=\{openOnMailTab \? "mail" : "overview"\}/u);
  });
});
