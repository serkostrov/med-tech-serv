import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getDefaultView,
  getRoleNavigation,
  hasNavigationItem,
  taskIdFromPathname,
  taskPathname
} from "./navigation.js";

describe("web process navigation", () => {
  it("keeps navigation scoped to the selected working role", async () => {
    assert.deepEqual(
      getRoleNavigation("engineer").map((item) => item.id),
      ["tasks", "equipment", "notifications"]
    );
    assert.equal(hasNavigationItem("engineer", "finance"), false);
    assert.equal(hasNavigationItem("warehouse", "finance"), false);
    assert.equal(hasNavigationItem("coordinator", "finance"), true);
    assert.equal(hasNavigationItem("coordinator", "maintenance"), true);
    assert.equal(hasNavigationItem("engineer", "maintenance"), false);
    assert.deepEqual(getRoleNavigation("admin").map((item) => item.id), [
      "tasks", "equipment", "maintenance", "engineers", "warehouse", "reservations",
      "customers", "finance", "price", "reports", "notifications", "references", "import", "access"
    ]);
    assert.equal(hasNavigationItem("admin", "tasks"), true);
  });

  it("keeps the coordinator sidebar aligned with the approved demo structure", () => {
    assert.deepEqual(
      getRoleNavigation("coordinator").map((item) => item.label),
      ["Задачи", "Приборы", "План ТО", "Инженеры", "Склад", "Резервы", "Клиенты", "Счета", "Прайс", "Отчёты", "Уведомления", "Справочники", "Импорт"]
    );
    // Перенос данных из 1С — дело того, кто заводит приборы: инженеру и кладовщику раздел не нужен.
    assert.equal(hasNavigationItem("coordinator", "import"), true);
    assert.equal(hasNavigationItem("engineer", "import"), false);
    assert.equal(hasNavigationItem("warehouse", "import"), false);
    // Резервы координатор открывает тем же окном, что и кладовщик; действия в нём — по warehouse.write.
    assert.equal(hasNavigationItem("coordinator", "reservations"), true);
    assert.equal(hasNavigationItem("engineer", "reservations"), false);
    // Прайс ведёт руководитель, счета выставляет координатор: раздел офисный, в поле и на складе он не нужен.
    assert.equal(hasNavigationItem("coordinator", "price"), true);
    assert.equal(hasNavigationItem("engineer", "price"), false);
    assert.equal(hasNavigationItem("warehouse", "price"), false);
  });

  it("shows the warehouse workflow without office-only sections", () => {
    assert.deepEqual(
      getRoleNavigation("warehouse").map((item) => item.id),
      ["warehouse", "reservations", "notifications"]
    );
    assert.equal(hasNavigationItem("warehouse", "reports"), false);
  });

  it("round-trips the task-card pathname used in e-mail links", () => {
    const taskId = "00000000-0000-4000-8000-000000000139";
    assert.equal(taskPathname(taskId), `/tasks/${taskId}`);
    assert.equal(taskIdFromPathname(`/tasks/${taskId}`), taskId);
    assert.equal(taskIdFromPathname("/tasks"), undefined);
    assert.equal(taskIdFromPathname("/tasks/not-a-task/files"), undefined);
  });
});
