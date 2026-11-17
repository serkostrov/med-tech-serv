import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBoard, localStatusPage } from "./StatusBoard.js";
import { maintenanceMonthColumns, maintenanceMonthIndex } from "./MaintenancePlan.js";

describe("доска по статусам", () => {
  it("рисует все колонки; колонка вне отбора бледная и подписана", () => {
    const html = renderToStaticMarkup(<StatusBoard<{ id: string }>
      columns={[{ key: "draft", title: "Черновик", color: "#e07a2e" }, { key: "issued", title: "Выставлен", color: "#7c5cc4", outside: true }]}
      itemKey={(item) => item.id}
      label="Доска счетов"
      load={async () => ({ items: [], total: 0 })}
      onOpen={() => undefined}
      queryKey="1"
      renderCard={(item) => item.id}
    />);
    assert.match(html, /Черновик/u);
    assert.match(html, /Выставлен/u);
    assert.match(html, /task-board__column--outside/u);
    assert.match(html, /Не входит в отбор/u);
    assert.match(html, /--stage-color:#e07a2e/u);
  });

  it("локальный список режется на страницы колонки", () => {
    const items = [{ s: "a" }, { s: "b" }, { s: "a" }, { s: "a" }];
    const first = localStatusPage(items, (item) => item.s === "a", 0, 2);
    assert.equal(first.total, 3);
    assert.equal(first.items.length, 2);
    assert.equal(localStatusPage(items, (item) => item.s === "a", 2, 2).items.length, 1);
  });
});

describe("план ТО по месяцам", () => {
  it("период лежит в колонке месяца начала", () => {
    assert.equal(maintenanceMonthIndex("2026-01-10"), 0);
    assert.equal(maintenanceMonthIndex("2026-11-30"), 10);
  });
  it("двенадцать колонок, текущий месяц выделен, прошедшие серые", () => {
    const columns = maintenanceMonthColumns(2026, new Date(2026, 10, 17));
    assert.equal(columns.length, 12);
    assert.equal(columns[10]?.title, "Ноябрь");
    assert.equal(columns[0]?.title, "Январь");
    assert.equal(columns[10]?.color, "#e07a2e");
    assert.equal(columns[0]?.color, "#8a9aa3");
    assert.equal(columns[11]?.color, "#2f86c4");
    assert.ok(maintenanceMonthColumns(2027, new Date(2026, 10, 17)).every((column) => column.color === "#2f86c4"));
  });
});
