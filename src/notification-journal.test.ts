import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notificationTemplateProblem, canReadWholeNotificationJournal, visibleNotificationJournal } from "./notification-journal.js";

const journal = [
  { id: "n1", recipientUserId: undefined, recipientAddress: "a.smirnova@gkb1.example" },
  { id: "n2", recipientUserId: "u-sup", recipientAddress: "a.belov@mts.example" },
  { id: "n3", recipientUserId: "u-eng", recipientAddress: "418236501" },
  { id: "n4", recipientUserId: "u-eng2", recipientAddress: "529847130" }
];

describe("журнал уведомлений", () => {
  it("инженеру оставляет только адресованное ему", () => {
    const visible = visibleNotificationJournal(journal, {
      id: "u-eng",
      permissions: ["tasks.read", "tasks.read_own", "equipment.read", "notifications.read"]
    });
    assert.deepEqual(visible.map((item) => item.id), ["n3"]);
  });

  it("не открывает журнал целиком тому, кому выдали только «Все задачи»", () => {
    assert.equal(canReadWholeNotificationJournal(["tasks.read_all", "notifications.read"]), false);
    const visible = visibleNotificationJournal(journal, {
      id: "u-eng",
      permissions: ["tasks.read_all", "notifications.read"]
    });
    assert.deepEqual(visible.map((item) => item.id), ["n3"]);
  });

  it("координатору и администратору отдаёт весь журнал", () => {
    assert.equal(canReadWholeNotificationJournal(["notifications.read", "audit.read"]), true);
    assert.equal(canReadWholeNotificationJournal(["notifications.read", "notification_settings.write"]), true);
    assert.equal(visibleNotificationJournal(journal, { id: "u-coord", permissions: ["audit.read"] }).length, 4);
  });

  it("без прав вовсе ничего чужого не показывает", () => {
    assert.equal(canReadWholeNotificationJournal(undefined), false);
    assert.deepEqual(visibleNotificationJournal(journal, { id: "u-nobody" }), []);
  });
});

describe("шаблон письма проверяется до сохранения (аудит 17.11, № 50)", () => {
  const allowed = ["taskNumber", "taskTitle"];
  it("без темы не сохраняется", () => {
    assert.match(notificationTemplateProblem({ subject: " ", body: "Текст", allowedVariables: allowed }), /тему письма/u);
  });
  it("неизвестное поле называется по имени", () => {
    assert.equal(notificationTemplateProblem({ subject: "Задача {{taskNumber}}", body: "Привет {{foo}} и {{ taskTitle }}", allowedVariables: allowed }),
      "Таких полей система не знает: {{foo}}. Их получатель увидит как есть. Можно вставить: {{taskNumber}}, {{taskTitle}}");
  });
  it("знакомые поля проходят", () => {
    assert.equal(notificationTemplateProblem({ subject: "Задача {{taskNumber}}", body: "{{taskTitle}}", allowedVariables: allowed }), "");
  });
});

