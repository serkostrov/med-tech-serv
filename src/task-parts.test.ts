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
      initialTab: "materials",
      onBack: () => undefined,
      onChanged: async () => undefined,
      onOpenRelated: async () => undefined
    }));

    for (const expected of [
      "Запчасти", "TEST-PART-A · Учебный клапан", "2 шт. · Г · гарантийная",
      "TEST-PART-B · Учебный датчик", "1.5 шт. · Б · б/у", "Добавить", "Изменить"
    ]) {
      assert.ok(markup.includes(expected), expected);
    }
  });
});
