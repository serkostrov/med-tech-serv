import assert from "node:assert/strict";
import { it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskBoard, boardDropDecision, tasksWord } from "./TaskBoard.js";

it("builds kanban columns from the editable status catalog and keeps task cards openable", () => {
  const html = renderToStaticMarkup(<TaskBoard
    engineers={[{ id: "engineer-1", fullName: "Инженер Тестовый" }]}
    equipment={[{ id: "equipment-1", serialNumber: "SN-1", manufacturer: "Vendor", model: "Model", status: "in_use" }]}
    onMove={async () => undefined}
    onOpen={() => undefined}
    statuses={[
      { id: "new", code: "new", name: "Новая", isActive: true, attributes: { sortOrder: 10, isTerminal: false } },
      { id: "waiting_for_parts", code: "waiting_for_parts", name: "Ждёт запчасть", isActive: true, attributes: { sortOrder: 20, isTerminal: false } }
    ]}
    tasks={[{
      id: "task-1", number: "З-1", title: "Диагностика", status: "waiting_for_parts",
      equipmentId: "equipment-1", engineerId: "engineer-1", customer: { siteName: "Площадка", address: "Адрес" },
      createdAt: "2026-08-19T09:00:00.000Z", updatedAt: "2026-08-19T09:00:00.000Z"
    }]}
  />);

  assert.match(html, /Ждёт запчасть/u);
  assert.match(html, /Диагностика/u);
  assert.match(html, /Инженер Тестовый/u);
  assert.match(html, /SN-1/u);
  assert.match(html, /draggable="true"/u);
  assert.doesNotMatch(html, /Перетащите задачу сюда/u);
  // Галочка на карточке: несколько отмеченных задач переносятся вместе.
  assert.match(html, /aria-label="Отметить задачу З-1"/u);
  assert.match(html, /type="checkbox"/u);
});

it("moves on the board only to the next step, checks review readiness and explains steps that need the card", () => {
  assert.equal(boardDropDecision({}, "assigned", "in_progress").kind, "move");
  assert.equal(boardDropDecision({ engineerId: "e-1" }, "new", "assigned").kind, "move");
  assert.equal(boardDropDecision({}, "new", "assigned").kind, "card");
  // На проверку: перенос с проверкой результата на сервере, а не переход в карточку.
  assert.equal(boardDropDecision({}, "in_progress", "under_review").kind, "check");
  assert.equal(boardDropDecision({}, "in_progress", "under_review", true).kind, "check");
  assert.equal(boardDropDecision({}, "under_review", "closed", true).kind, "no");
  assert.equal(boardDropDecision({}, "under_review", "closed").kind, "card");
  assert.equal(boardDropDecision({}, "new", "cancelled").kind, "card");
  assert.equal(boardDropDecision({}, "new", "closed").kind, "no");
  assert.equal(boardDropDecision({}, "closed", "in_progress").kind, "no");
});

it("hides completed board columns until they are explicitly shown", () => {
  const statuses = [
    { id: "new", code: "new", name: "Новая", isActive: true, attributes: { sortOrder: 10, isTerminal: false } },
    { id: "closed", code: "closed", name: "Закрыта", isActive: true, attributes: { sortOrder: 90, isTerminal: true } },
    { id: "cancelled", code: "cancelled", name: "Отменена", isActive: true, attributes: { sortOrder: 100, isTerminal: true } }
  ];
  const hidden = renderToStaticMarkup(<TaskBoard
    engineers={[]}
    equipment={[]}
    onMove={async () => undefined}
    onOpen={() => undefined}
    statuses={statuses}
    tasks={[]}
  />);
  assert.match(hidden, /Новая/u);
  assert.doesNotMatch(hidden, /Закрыта/u);
  assert.doesNotMatch(hidden, /Отменена/u);

  const shown = renderToStaticMarkup(<TaskBoard
    engineers={[]}
    equipment={[]}
    onMove={async () => undefined}
    onOpen={() => undefined}
    showCompleted
    statuses={statuses}
    tasks={[]}
  />);
  assert.match(shown, /Закрыта/u);
  assert.match(shown, /Отменена/u);
});

it("declines the task count for the board messages", () => {
  assert.equal(tasksWord(1), "задача");
  assert.equal(tasksWord(2), "задачи");
  assert.equal(tasksWord(5), "задач");
  assert.equal(tasksWord(11), "задач");
  assert.equal(tasksWord(21), "задача");
  assert.equal(tasksWord(24), "задачи");
});
