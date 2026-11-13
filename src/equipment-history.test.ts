import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EquipmentHistoryEvent } from "./domain/equipment-history.js";
import { addManualEquipmentHistory, equipmentHistoryDescription, equipmentHistoryPartText } from "./equipment-history.js";

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
  it("замена запчасти называет артикул, наименование, количество и состояние", () => {
    assert.equal(
      equipmentHistoryPartText({ part: { articleNumber: "AU-LAMP-12V20W", name: "Лампа галогеновая 12 В 20 Вт", quantity: 2, condition: "G" } }),
      "AU-LAMP-12V20W Лампа галогеновая 12 В 20 Вт, 2 шт., Г, гарантийная"
    );
    assert.equal(
      equipmentHistoryPartText({ part: { articleNumber: "UNI-TUBE-SIL", name: "Трубка силиконовая", quantity: 1.5, condition: "N" } }),
      "UNI-TUBE-SIL Трубка силиконовая, 1,5 шт., Н, новая"
    );
    // У старых событий подробностей нет: тогда в карточке остаётся прежний заголовок.
    assert.equal(equipmentHistoryPartText({}), undefined);
  });

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
