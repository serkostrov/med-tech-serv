import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENGINEER_TASK_GROUPS, engineerEquipment, engineerStockRows } from "./EngineerPage.js";
import { partUsageByEquipment } from "./InventoryPartCard.js";
import { maintenanceRowDetails } from "./MaintenancePlan.js";
import type { StockReservationRecord, TaskApiRecord } from "./m2-api.js";

const task = (id: string, status: string, equipmentId?: string, visitDate?: string): TaskApiRecord => ({
  id, number: `З-${id}`, title: id, status, ...(equipmentId ? { equipmentId, equipmentLabel: { serialNumber: `SN-${equipmentId}`, model: "XN-1000", manufacturer: "Sysmex" } } : {}), ...(visitDate ? { visitDate } : {})
} as TaskApiRecord);

describe("страница инженера", () => {
  it("задачи по этапам: в работе, назначены, на проверке, выполнены", () => {
    assert.deepEqual(ENGINEER_TASK_GROUPS.map((group) => group.title), ["В работе", "Назначены и запланированы", "На проверке", "Выполнены"]);
    assert.ok(ENGINEER_TASK_GROUPS.every((group) => !group.statuses.includes("cancelled")));
  });
  it("приборы инженера: открытые задачи сверху, отменённые не считаются", () => {
    const rows = engineerEquipment([task("1", "closed", "a", "2026-10-01"), task("2", "in_progress", "b"), task("3", "closed", "a", "2026-11-01"), task("4", "cancelled", "c"), task("5", "new")]);
    assert.deepEqual(rows.map((row) => row.equipmentId), ["b", "a"]);
    assert.equal(rows[1]!.total, 2);
    assert.equal(rows[1]!.lastDate, "2026-11-01");
    assert.match(rows[0]!.label, /Sysmex XN-1000 S\/N SN-b/);
  });
  it("склад инженера: одна строка на запчасть и состояние, задачи без повторов", () => {
    const reservation = (partId: string, condition: "G" | "N" | "B", quantity: number, taskId: string): StockReservationRecord => ({ id: `${partId}${taskId}${condition}`, number: "Р-1", status: "issued", partId, articleNumber: partId.toUpperCase(), partName: partId, condition, quantity, taskId, taskNumber: `З-${taskId}`, installMarked: false, steps: [], createdAt: "2026-11-01", updatedAt: "2026-11-02" });
    const rows = engineerStockRows([reservation("a", "N", 1, "t1"), reservation("a", "N", 2, "t2"), reservation("a", "B", 1, "t1"), reservation("b", "N", 1, "t1")]);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.quantity, 3);
    assert.deepEqual(rows[0]!.tasks.map((item) => item.number), ["З-t1", "З-t2"]);
  });
});

describe("запчасть и прибор", () => {
  it("приборы запчасти: выдано и установлено по прибору, последняя задача", () => {
    const rows = partUsageByEquipment([
      { partId: "p", articleNumber: "A", partName: "A", quantity: 1, condition: "N", status: "installed", taskId: "t1", taskNumber: "З-1", equipmentId: "e1", equipmentLabel: "XN", date: "2026-10-01" },
      { partId: "p", articleNumber: "A", partName: "A", quantity: 2, condition: "N", status: "issued", taskId: "t2", taskNumber: "З-2", equipmentId: "e1", equipmentLabel: "XN", date: "2026-11-01" }
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.issued, 3);
    assert.equal(rows[0]!.installed, 1);
    assert.equal(rows[0]!.lastTaskNumber, "З-2");
  });
  it("план ТО по инженерам не повторяет ФИО инженера в строке", () => {
    const item = { periodFrom: "2026-03-10", periodTo: "2026-03-21", assignedEngineerName: "Иванов Пётр", organization: "ГКБ № 1" };
    assert.doesNotMatch(maintenanceRowDetails(item, "engineer"), /Иванов/);
    assert.match(maintenanceRowDetails(item, "engineer"), /ГКБ № 1/);
    assert.match(maintenanceRowDetails(item, "organization"), /Иванов Пётр/);
  });
});
