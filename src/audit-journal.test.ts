import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  JOURNAL_PERMISSION,
  auditActionCodesForSearch,
  auditActionLabel,
  auditActorLabel,
  auditChangeLines,
  auditChangeSummary,
  auditEntityLabel,
  auditFieldLabel,
  auditPlaceLabel,
  auditEntityTitle,
  auditValueText,
  canReadJournals,
  loginFailureLabel,
  loginFailureReason,
  loginOutcomeText,
  loginWhoHint,
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

  it("показывает статусы словами того объекта, у которого они стоят", () => {
    // «issued» у счёта — выставлен, у резерва — выдан: перевод зависит от объекта.
    assert.equal(auditValueText("issued", "status", "invoice"), "Выставлен");
    assert.equal(auditValueText("issued", "status", "warehouse"), "Выдан");
    assert.equal(auditValueText("under_review", "status_code", "task"), "На проверке");
    assert.equal(auditValueText("failed", "status", "integration"), "Ошибка");
    // Незнакомый код и поля не про статус остаются как есть.
    assert.equal(auditValueText("своё", "status", "invoice"), "своё");
    assert.equal(auditValueText("issued", "notes", "invoice"), "issued");
    assert.equal(auditValueText("issued"), "issued");
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

  it("не выдаёт правку без видимых изменений за изменение всех полей", () => {
    // Поменялось только вырезанное поле (сумма, цена, реквизиты): снимки совпали,
    // changed_fields пуст. Показывать весь снимок нельзя — вышел бы список полей,
    // где «было» и «стало» одинаковые.
    const lines = auditChangeLines({
      changedFields: [],
      beforeData: { status: "draft", payer_name: "ГКБ № 1" },
      afterData: { status: "draft", payer_name: "ГКБ № 1" }
    });
    assert.deepEqual(lines, []);
    assert.equal(auditChangeSummary({
      changedFields: [],
      beforeData: { status: "draft" },
      afterData: { status: "draft" }
    }), "");
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

  it("у входа показывает сотрудника, а у попытки — набранный адрес", () => {
    // Удачный вход подтвердила служба входа: там сотрудник настоящий.
    assert.equal(loginWhoText({ success: true, userName: "Белов Андрей", login: "a.belov@mts.example" }), "Белов Андрей");
    assert.equal(loginWhoHint({ success: true, userName: "Белов Андрей", login: "a.belov@mts.example" }), "a.belov@mts.example");
    assert.equal(loginWhoText({ success: true }), "Неизвестный вход");
    // Неудачную попытку записывает экран входа: набрать чужой адрес может кто угодно,
    // поэтому сначала адрес, а имя сотрудника — подсказкой.
    assert.equal(loginWhoText({ success: false, userName: "Белов Андрей", login: "a.belov@mts.example" }), "a.belov@mts.example");
    assert.equal(loginWhoHint({ success: false, userName: "Белов Андрей", login: "a.belov@mts.example" }), "адрес сотрудника: Белов Андрей");
    assert.equal(loginWhoText({ success: false, login: "кто-то@example.com" }), "кто-то@example.com");
    assert.equal(loginWhoHint({ success: false, login: "кто-то@example.com" }), "");
    assert.equal(loginWhoText({ success: false }), "Адрес не набран");
  });

  it("ищет действия журнала и по русскому названию, и по коду", () => {
    assert.deepEqual(auditActionCodesForSearch("Изменено"), ["updated"]);
    assert.deepEqual(auditActionCodesForSearch("статус"), ["status_changed", "status_transition"]);
    assert.deepEqual(auditActionCodesForSearch("updated"), ["updated"]);
    assert.deepEqual(auditActionCodesForSearch("  "), []);
    assert.deepEqual(auditActionCodesForSearch("З-001258"), []);
    // Одна-две буквы входят почти в каждое название: по ним журнал не фильтруется.
    assert.deepEqual(auditActionCodesForSearch("о"), []);
    assert.deepEqual(auditActionCodesForSearch("из"), []);
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

describe("журнал: значения словами (аудит 17.11, № 74)", () => {
  it("деньги, даты, срочность, состояние, события и каналы — по-человечески", () => {
    assert.equal(auditValueText(125000, "total_amount", "invoice"), "125\u00a0000,00\u00a0₽");
    assert.equal(auditValueText("138500.5", "total_amount", "invoice"), "138\u00a0500,50\u00a0₽");
    assert.equal(auditValueText("2026-11-18", "deadline_to", "task"), "18.11.2026");
    assert.equal(auditValueText("2026-11-18T06:30:00Z", "visit_date", "task"), "18.11.2026 09:30");
    assert.equal(auditValueText("planned", "priority", "task"), "Плановая");
    assert.equal(auditValueText("G", "part_condition", "warehouse"), "Г · гарантийная");
    assert.equal(auditValueText("requested", "status", "warehouse"), "Заказан");
    assert.equal(auditValueText("task_engineer_assigned", "event_code", "integration"), "Инженер назначен");
    assert.equal(auditValueText("email", "channel", "integration"), "Почта");
    assert.equal(auditValueText(6.5, "hours", "task"), "6,5");
    assert.equal(auditValueText(["repair", "installation"], "extra_work_type_codes", "task"), "repair, installation");
  });

  it("в «Где» номер или название записи, а не внутренний код", () => {
    assert.equal(auditEntityTitle({ afterData: { id: "u-eng4", full_name: "Иванов Пётр" } }), "Иванов Пётр");
    assert.equal(auditEntityTitle({ beforeData: { number: "СЧ-000042" }, afterData: { total_amount: 1 } }), "СЧ-000042");
    assert.equal(auditEntityTitle({ afterData: { id: "n9" } }), "");
  });
});

