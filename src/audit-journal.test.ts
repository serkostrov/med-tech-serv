import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  JOURNAL_PERMISSION,
  auditActionLabel,
  auditActorLabel,
  auditChangeLines,
  auditChangeSummary,
  auditEntityLabel,
  auditFieldLabel,
  auditPlaceLabel,
  auditValueText,
  canReadJournals,
  loginFailureLabel,
  loginFailureReason,
  loginOutcomeText,
  loginWhoText
} from "./audit-journal.js";

describe("журналы: кому они видны", () => {
  it("открываются правом «Просмотр аудита» и ничем больше", () => {
    assert.equal(JOURNAL_PERMISSION, "audit.read");
    assert.equal(canReadJournals(["audit.read"]), true);
    assert.equal(canReadJournals(["tasks.read_all", "finance.read", "users.read"]), false);
    assert.equal(canReadJournals([]), false);
    assert.equal(canReadJournals(undefined), false);
  });
});

describe("журнал изменений", () => {
  it("называет действие, объект и место правки по-русски", () => {
    assert.equal(auditActionLabel("updated"), "Изменено");
    assert.equal(auditActionLabel("status_changed"), "Статус изменён");
    // Незнакомое действие показываем как есть: лучше код, чем «неизвестно».
    assert.equal(auditActionLabel("перенесено_вручную"), "перенесено_вручную");
    assert.equal(auditEntityLabel("task"), "Задача");
    assert.equal(auditEntityLabel("нечто"), "нечто");
    assert.equal(auditPlaceLabel({ entityType: "task", tableName: "task_status_history" }), "История статусов задачи");
    assert.equal(auditPlaceLabel({ entityType: "invoice" }), "Счёт");
    assert.equal(auditFieldLabel("deadline_to"), "Срок по");
    assert.equal(auditFieldLabel("своё_поле"), "своё_поле");
  });

  it("подписывает автора, которого больше нет в CRM, и служебные записи", () => {
    assert.equal(auditActorLabel({ actorName: "Белов Андрей", actorType: "user" }), "Белов Андрей");
    assert.equal(auditActorLabel({ actorType: "system" }), "Система");
    assert.equal(auditActorLabel({ actorType: "anonymous" }), "Без входа");
    assert.equal(auditActorLabel({ actorType: "user" }), "Сотрудник удалён из CRM");
  });

  it("показывает значения полей так, чтобы их можно было прочитать", () => {
    assert.equal(auditValueText(null), "не задано");
    assert.equal(auditValueText(""), "не задано");
    assert.equal(auditValueText(undefined), "не задано");
    assert.equal(auditValueText(true), "да");
    assert.equal(auditValueText(false), "нет");
    assert.equal(auditValueText(12), "12");
    assert.equal(auditValueText({ inn: "7701" }), '{"inn":"7701"}');
    assert.equal(auditValueText("а".repeat(250)).endsWith("…"), true);
    assert.equal(auditValueText("а".repeat(250)).length, 201);
  });

  it("сравнивает снимки по изменённым полям", () => {
    const lines = auditChangeLines({
      changedFields: ["title", "status_code"],
      beforeData: { title: "Ремонт", status_code: "new", id: "1" },
      afterData: { title: "Ремонт УЗИ", status_code: "assigned", id: "1" }
    });
    assert.deepEqual(lines, [
      { field: "title", label: "Название", before: "Ремонт", after: "Ремонт УЗИ" },
      { field: "status_code", label: "Статус", before: "new", after: "assigned" }
    ]);
    assert.equal(auditChangeSummary({
      changedFields: ["title", "status_code"],
      beforeData: { title: "Ремонт", status_code: "new" },
      afterData: { title: "Ремонт УЗИ", status_code: "assigned" }
    }), "Название, Статус");
  });

  it("не выдумывает поля, которых в снимке нет", () => {
    // Денежные поля вырезаются при записи (audit_sanitize_jsonb) или по праву
    // смотрящего (0057): в changed_fields они быть могут, а в снимке — нет.
    const lines = auditChangeLines({
      changedFields: ["total_amount", "status"],
      beforeData: { status: "draft" },
      afterData: { status: "issued" }
    });
    assert.deepEqual(lines.map((line) => line.field), ["status"]);
  });

  it("берёт поля из снимка, когда список изменённых пуст (создание записи)", () => {
    const lines = auditChangeLines({
      changedFields: [],
      afterData: { title: "Новая задача", created_at: "2026-01-01", id: "7" }
    });
    assert.deepEqual(lines, [{ field: "title", label: "Название", before: "не задано", after: "Новая задача" }]);
  });

  it("сжимает длинный список полей в подпись строки", () => {
    const summary = auditChangeSummary({
      changedFields: ["title", "status_code", "notes", "priority", "engineer_id"],
      beforeData: { title: "a", status_code: "a", notes: "a", priority: "a", engineer_id: "a" },
      afterData: { title: "b", status_code: "b", notes: "b", priority: "b", engineer_id: "b" }
    });
    assert.equal(summary, "Название, Статус, Заметки и ещё 2");
  });
});

describe("журнал входов", () => {
  it("называет исход входа по-русски", () => {
    assert.equal(loginOutcomeText({ success: true }), "Вход выполнен");
    assert.equal(loginOutcomeText({ success: false, failureReason: "invalid_credentials" }), "Неверный e-mail или пароль");
    assert.equal(loginOutcomeText({ success: false }), "Причина неизвестна");
    assert.equal(loginFailureLabel("too_many_attempts"), "Слишком много попыток");
    assert.equal(loginFailureLabel("свой_код"), "свой_код");
  });

  it("показывает, кто входил: имя, иначе набранный адрес", () => {
    assert.equal(loginWhoText({ userName: "Белов Андрей", login: "a.belov@mts.example" }), "Белов Андрей");
    assert.equal(loginWhoText({ login: "кто-то@example.com" }), "кто-то@example.com");
    assert.equal(loginWhoText({}), "Неизвестный вход");
  });

  it("превращает ошибку входа в короткий код причины, не передавая её текст в журнал", () => {
    assert.equal(loginFailureReason({ status: 400, message: "Invalid login credentials" }), "invalid_credentials");
    assert.equal(loginFailureReason({ status: 400, message: "Email not confirmed" }), "email_not_confirmed");
    assert.equal(loginFailureReason({ status: 429, message: "Request rate limit reached" }), "too_many_attempts");
    assert.equal(loginFailureReason({ status: 403, message: "User is banned" }), "user_disabled");
    assert.equal(loginFailureReason({ status: 503, message: "upstream error" }), "service_unavailable");
    assert.equal(loginFailureReason({ message: "Failed to fetch" }), "service_unavailable");
    assert.equal(loginFailureReason(undefined), "service_unavailable");
    // Код из списка, разрешённого базой (0058): свободного текста в журнал не уходит.
    const allowed = ["invalid_credentials", "email_not_confirmed", "user_disabled", "too_many_attempts", "service_unavailable", "unknown"];
    for (const error of [{ status: 418, message: "чайник" }, { status: 400 }, { status: 401, message: "" }]) {
      assert.equal(allowed.includes(loginFailureReason(error)), true);
    }
  });
});

describe("журналы: что уходит в базу", () => {
  it("пароль в журнал входов не передаётся", async () => {
    const api = await readFile(new URL("./m2-api.ts", import.meta.url), "utf8");
    const call = /record_failed_login[^)]*\)/u.exec(api)?.[0] ?? "";
    assert.match(call, /p_login/u);
    assert.match(call, /p_reason/u);
    assert.doesNotMatch(call, /password/u);
    // Неудачную попытку пишет сам экран входа: GoTrue её не сохраняет.
    assert.match(api, /recordFailedLogin\(email, loginFailureReason\(error\)\)/u);
  });

  it("журналы читаются постранично и отбираются в базе", async () => {
    const api = await readFile(new URL("./m2-api.ts", import.meta.url), "utf8");
    assert.match(api, /from\("audit_log_journal"\)[\s\S]{0,200}count: "exact"/u);
    assert.match(api, /\.range\(offset, offset \+ limit - 1\)/u);
    assert.match(api, /rpc\("login_journal", \{/u);
    assert.match(api, /p_limit: limit/u);
    const page = await readFile(new URL("./JournalsPage.tsx", import.meta.url), "utf8");
    assert.match(page, /RegistryPagination/u);
    // Экран не обещает денег, которых в журнале нет.
    assert.match(page, /Суммы, цены и реквизиты в журнал не пишутся/u);
  });
});
