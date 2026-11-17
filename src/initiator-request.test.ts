import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestPeriod, requestProblem, requestStageHint, requestTitle } from "./initiator-request.js";

describe("заявка инициатора", () => {
  it("срок по срочности: срочная — до завтра, плановая — неделя; «выполнить до» важнее", () => {
    assert.deepEqual(requestPeriod("urgent", "2026-11-17"), { from: "2026-11-17", to: "2026-11-18" });
    assert.deepEqual(requestPeriod("planned", "2026-11-30"), { from: "2026-11-30", to: "2026-12-07" });
    assert.deepEqual(requestPeriod("planned", "2026-11-17", "2026-11-25"), { from: "2026-11-17", to: "2026-11-25" });
    assert.deepEqual(requestPeriod("urgent", "2026-11-17", "2026-11-10"), { from: "2026-11-17", to: "2026-11-18" });
  });

  it("название задачи: что сделать, прибор и S/N", () => {
    assert.equal(requestTitle("Ремонт", { manufacturer: "Beckman Coulter", model: "AU 480", serialNumber: "123" }), "Ремонт: Beckman Coulter AU 480, S/N 123");
    assert.equal(requestTitle("Диагностика", { serialNumber: "X-1" }), "Диагностика: S/N X-1");
  });

  it("без прибора, вида работ и описания заявку не отправить", () => {
    const base = { equipmentId: "e1", workTypeCode: "repair", description: "Не проходит калибровка", today: "2026-11-17" };
    assert.equal(requestProblem(base), undefined);
    assert.equal(requestProblem({ ...base, equipmentId: undefined }), "Найдите прибор по заводскому номеру (S/N)");
    assert.equal(requestProblem({ ...base, workTypeCode: undefined }), "Выберите, что нужно сделать");
    assert.equal(requestProblem({ ...base, description: " " }), "Опишите неисправность или что нужно сделать");
    assert.equal(requestProblem({ ...base, until: "2026-11-01" }), "Дата «выполнить до» уже прошла: укажите 17.11.2026 или позже");
  });

  it("этап заявки словами для инициатора", () => {
    assert.equal(requestStageHint("new"), "Заявка принята, координатор назначит инженера");
    assert.equal(requestStageHint("assigned", "Иванов П. А."), "Назначен инженер: Иванов П. А.");
    assert.equal(requestStageHint("under_review"), "Работы выполнены, координатор проверяет акт");
  });
});
