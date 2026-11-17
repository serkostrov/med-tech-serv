import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { humanValue, renderNotificationTemplate } from "./domain.js";

describe("подстановка в шаблон уведомления", () => {
  it("дату из базы пишет по-русски, а не «2026-11-16»", () => {
    assert.equal(humanValue("2026-11-16"), "16.11.2026");
    assert.equal(humanValue("З-000004"), "З-000004");
    assert.equal(humanValue("10"), "10");
  });

  it("в тексте назначения срок читается по-человечески", () => {
    const rendered = renderNotificationTemplate({
      subjectTemplate: "По задаче {{taskNumber}} назначен инженер",
      bodyTemplate: "Период выполнения: {{periodFrom}} — {{periodTo}}.",
      allowedVariables: ["taskNumber", "periodFrom", "periodTo"]
    }, { taskNumber: "З-000004", periodFrom: "2026-11-16", periodTo: "2026-11-17" });
    assert.equal(rendered.body, "Период выполнения: 16.11.2026 — 17.11.2026.");
  });
});
