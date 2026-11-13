import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskCard } from "./App.js";
import type { TaskCardResponse } from "./m2-api.js";

describe("task part card", () => {
  it("shows every position with quantity and the customer act condition", () => {
    const card: TaskCardResponse = {
      task: {
        id: "task-test-33",
        number: "З-ТЕСТ-033",
        title: "Учебная замена узлов",
        status: "in_progress",
        createdAt: "2026-08-18T09:00:00.000Z",
        updatedAt: "2026-08-18T10:00:00.000Z"
      },
      status: { code: "in_progress", name: "В работе" },
      parts: [
        { id: "part-test-a", articleNumber: "TEST-PART-A", name: "Учебный клапан", quantity: 2, condition: "G" },
        { id: "part-test-b", articleNumber: "TEST-PART-B", name: "Учебный датчик", quantity: 1.5, condition: "B" }
      ],
      canEditParts: true,
      files: [],
      journal: [],
      availableActions: []
    };
    const markup = renderToStaticMarkup(createElement(TaskCard, {
      card,
      initialTab: "parts",
      onBack: () => undefined,
      onChanged: async () => undefined,
      onOpenRelated: async () => undefined
    }));

    for (const expected of [
      "Запчасти", "TEST-PART-A", "Учебный клапан", "Г, гарантийная",
      "TEST-PART-B", "Учебный датчик", "1.5", "Б, б/у", "Добавить запчасть", "Изменить список"
    ]) {
      assert.ok(markup.includes(expected), expected);
    }
  });

  it("показывает собранные складом позиции и не выдаёт их reservation_id за «тот самый резерв»", () => {
    const card: TaskCardResponse = {
      task: {
        id: "task-test-34",
        number: "З-ТЕСТ-034",
        title: "Учебная замена по резерву",
        status: "under_review",
        createdAt: "2026-11-10T09:00:00.000Z",
        updatedAt: "2026-11-12T10:00:00.000Z"
      },
      status: { code: "under_review", name: "На проверке" },
      parts: [
        { id: "part-test-c", articleNumber: "TEST-PART-C", name: "Учебная лампа", quantity: 3, condition: "N", reservationId: "r1" },
        { id: "part-test-d", articleNumber: "TEST-PART-D", name: "Учебный предохранитель", quantity: 1, condition: "N" }
      ],
      canEditParts: false,
      files: [],
      journal: [],
      availableActions: []
    };
    const markup = renderToStaticMarkup(createElement(TaskCard, {
      card,
      initialTab: "parts",
      onBack: () => undefined,
      onChanged: async () => undefined,
      onOpenRelated: async () => undefined
    }));

    assert.ok(markup.includes("Резерв со склада"), "раздел резерва");
    assert.ok(markup.includes("TEST-PART-C"), "позиция из резерва");
    assert.ok(markup.includes("TEST-PART-D"), "позиция из списка");
    // Номер резерва в строке произвольный: пока резервы не загружены, подписи «установлена» нет.
    assert.equal(markup.includes("установлена"), false);
    assert.equal(markup.includes("r1"), false);
    // Позиции из резерва руками не правят: кнопки изменения списка у них нет.
    assert.equal(markup.includes("Изменить список"), false);
  });
});
