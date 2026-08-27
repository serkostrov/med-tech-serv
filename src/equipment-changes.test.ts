import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyEquipmentAssignmentChange,
  formatEquipmentAssignmentChange,
  formatRussianCount,
  localDateTimeInputValue,
  localDateTimeToIso,
  type EquipmentAssignmentState
} from "./equipment-changes.js";
import type { EquipmentHistoryEvent } from "./domain/equipment-history.js";

const initial: EquipmentAssignmentState = {
  id: "equipment-1",
  siteId: "site-old",
  place: "Учебная площадка 1",
  payerId: "payer-old",
  payer: "Учебный плательщик 1",
  history: []
};

describe("операции места установки и плательщика", () => {
  it("показывает локальные поля и отправляет момент с однозначным часовым поясом", () => {
    const local = new Date(2026, 7, 18, 10, 35, 0, 0);
    assert.equal(localDateTimeInputValue(local), "2026-08-18T10:35");
    assert.equal(localDateTimeToIso("2026-08-18T10:35"), local.toISOString());
    assert.match(localDateTimeToIso("2026-08-18T10:35"), /Z$/u);
    assert.throws(() => localDateTimeToIso("2026-02-30T10:35"), /существующие/u);
  });

  it("атомарно обновляет текущее значение и сохраняет previous/new, комментарий и автора", () => {
    const changed = applyEquipmentAssignmentChange(initial, {
      kind: "site_change",
      targetId: "site-new",
      targetName: "Учебная площадка 2",
      occurredAt: "2026-08-18T10:00:00.000Z",
      comment: "Перенос после инсталляции",
      author: "Анна К.",
      id: "site-change-1"
    });
    assert.equal(changed.place, "Учебная площадка 2");
    assert.equal(initial.place, "Учебная площадка 1");
    assert.deepEqual(changed.history[0], {
      id: "site-change-1",
      equipmentId: "equipment-1",
      eventType: "site_change",
      occurredAt: "2026-08-18T10:00:00.000Z",
      summary: "Место установки: «Учебная площадка 1» → «Учебная площадка 2»",
      client: "Учебная площадка 2",
      description: "Перенос после инсталляции",
      source: { kind: "site_change", id: "site-change-1" },
      previousValue: { id: "site-old", name: "Учебная площадка 1" },
      newValue: { id: "site-new", name: "Учебная площадка 2" },
      comment: "Перенос после инсталляции",
      author: { name: "Анна К." }
    });
  });

  it("сохраняет общую обратную хронологию независимых операций", () => {
    const first = applyEquipmentAssignmentChange(initial, {
      kind: "site_change", targetId: "site-new", targetName: "Учебная площадка 2",
      occurredAt: "2026-08-18T10:00:00.000Z", comment: "Перенос", author: "Анна К."
    });
    const second = applyEquipmentAssignmentChange(first, {
      kind: "payer_change", targetId: "payer-new", targetName: "Учебный плательщик 2",
      occurredAt: "2026-08-18T11:00:00.000Z", comment: "Смена договора", author: "Анна К."
    });
    assert.deepEqual(second.history.map((event) => event.eventType), ["payer_change", "site_change"]);
  });

  it("не меняет состояние при совпадающем значении или нарушенной хронологии", () => {
    assert.throws(() => applyEquipmentAssignmentChange(initial, {
      kind: "payer_change", targetId: "payer-old", targetName: "Учебный плательщик 1",
      occurredAt: "2026-08-18T10:00:00.000Z", comment: "Без изменения", author: "Анна К."
    }), /совпадает/u);
    const changed = applyEquipmentAssignmentChange(initial, {
      kind: "payer_change", targetId: "payer-new", targetName: "Учебный плательщик 2",
      occurredAt: "2026-08-18T10:00:00.000Z", comment: "Смена договора", author: "Анна К."
    });
    assert.throws(() => applyEquipmentAssignmentChange(changed, {
      kind: "payer_change", targetId: "payer-third", targetName: "Учебный плательщик 3",
      occurredAt: "2026-08-18T09:00:00.000Z", comment: "Старая дата", author: "Анна К."
    }), /позже/u);
    assert.equal(changed.payer, "Учебный плательщик 2");
    assert.equal(changed.history.length, 1);
  });

  it("склоняет счётчик записей и не показывает пустой переход", () => {
    assert.equal(formatRussianCount(1, ["запись", "записи", "записей"]), "1 запись");
    assert.equal(formatRussianCount(2, ["запись", "записи", "записей"]), "2 записи");
    assert.equal(formatRussianCount(5, ["запись", "записи", "записей"]), "5 записей");
    assert.equal(formatRussianCount(21, ["запись", "записи", "записей"]), "21 запись");
    const initial: EquipmentHistoryEvent = {
      id: "1",
      equipmentId: "e1",
      occurredAt: "2026-08-27T08:29:00.000Z",
      eventType: "site_change",
      summary: "Место установки: «Не указано» → «Клиника №1»",
      client: "Клиника №1",
      description: "Установка места",
      source: { kind: "site_change" },
      previousValue: { name: "Не указано" },
      newValue: { name: "Клиника №1" },
      comment: "Установка места"
    };
    assert.equal(formatEquipmentAssignmentChange(initial), "Клиника №1");
    assert.equal(formatEquipmentAssignmentChange({
      ...initial,
      previousValue: { name: "Площадка А" },
      newValue: { name: "Площадка Б" }
    }), "Площадка А → Площадка Б");
  });
});
