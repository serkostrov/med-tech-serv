import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOW_STOCK_FACTOR, STOCK_GROUPS, inventoryStockGroup } from "./InventoryBoard.js";

/** Позиция склада так, как её отдаёт представление inventory_part_registry. */
function part(onHand: number, reserved: number, minimum: number) {
  const available = onHand - reserved;
  return { onHandQuantity: onHand, availableQuantity: available, minimumStock: minimum, belowMinimum: available < minimum };
}

describe("доска склада", () => {
  it("колонки идут по тревожности: пусто, ниже минимума, заканчивается, в норме", () => {
    assert.deepEqual(STOCK_GROUPS.map((group) => group.id), ["out", "below", "low", "normal"]);
  });

  it("разносит позиции по состоянию запаса", () => {
    assert.equal(inventoryStockGroup(part(0, 0, 4)), "out");
    // Остаток есть, но весь в резерве: доступного нет, и это «ниже минимума», а не «нет на складе».
    assert.equal(inventoryStockGroup(part(2, 2, 4)), "below");
    assert.equal(inventoryStockGroup(part(3, 0, 4)), "below");
    // Минимум 4: «заканчивается», пока доступного не больше 6 (минимум плюс половина).
    assert.equal(inventoryStockGroup(part(4, 0, 4)), "low");
    assert.equal(inventoryStockGroup(part(6, 0, 4)), "low");
    assert.equal(inventoryStockGroup(part(7, 0, 4)), "normal");
    assert.equal(LOW_STOCK_FACTOR, 1.5);
  });

  it("без заданного минимума позиция либо пустая, либо в норме", () => {
    assert.equal(inventoryStockGroup(part(0, 0, 0)), "out");
    assert.equal(inventoryStockGroup(part(1, 0, 0)), "normal");
    assert.equal(inventoryStockGroup(part(1, 1, 0)), "normal");
    assert.equal(inventoryStockGroup(part(100, 0, 0)), "normal");
  });
});
