import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EquipmentHistoryEvent } from "./domain/equipment-history.js";
import { addManualEquipmentHistory, equipmentHistoryDescription } from "./equipment-history.js";

const recent: EquipmentHistoryEvent = {
  id: "task-recent",
  equipmentId: "equipment-1",
  occurredAt: "2026-08-18T10:00:00.000Z",
  eventType: "task",
  summary: "Недавняя задача",
  client: "Учебный клиент",
  description: "Проверка",
  source: { kind: "task", id: "task-1" }
};

describe("лента истории прибора", () => {
  it("ставит ручное старое событие на место в хронологии и показывает пустое описание безопасно", () => {
    const history = addManualEquipmentHistory([recent], "equipment-1", {
      id: "manual-old",
      occurredAt: "2017-03-01T09:00:00.000Z",
      summary: "Архивная запись",
      client: "Архивный учебный клиент",
      description: "",
      author: "Координатор"
    });
    assert.deepEqual(history.map((event) => event.id), ["task-recent", "manual-old"]);
    assert.equal(history[1]?.client, "Архивный учебный клиент");
    assert.equal(equipmentHistoryDescription(history[1]!), "Описание не указано");
    assert.equal(history[1]?.description, "");
  });
});
