import assert from "node:assert/strict";
import { it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskBoard } from "./TaskBoard.js";

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
  assert.match(html, /Изменить статус задачи З-1/u);
  assert.match(html, /draggable="true"/u);
  assert.match(html, /Перетащите задачу сюда/u);
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
