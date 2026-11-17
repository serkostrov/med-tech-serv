import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { equipmentSpendEmptyText, equipmentSpendLines, equipmentSpendRange } from "./equipment-spend.js";

describe("затраты в карточке прибора", () => {
  it("период: этот год до сегодня, прошлый год целиком, всё время без границ", () => {
    assert.deepEqual(equipmentSpendRange("this_year", "2026-11-17"), { from: "2026-01-01", to: "2026-11-17" });
    assert.deepEqual(equipmentSpendRange("last_year", "2026-11-17"), { from: "2025-01-01", to: "2025-12-31" });
    assert.deepEqual(equipmentSpendRange("all_time", "2026-11-17"), {});
  });

  it("подписи: итог, работы и запчасти, по скольким счетам и задачам", () => {
    const lines = equipmentSpendLines({ taskCount: 4, invoiceCount: 3, workAmount: 10_000, partsAmount: 2_345.5, totalAmount: 12_345.5 });
    // Деньги с неразрывными пробелами: сумма не переносится посередине.
    const plain = (value: string | undefined) => value?.replace(/\u00a0/gu, " ");
    assert.equal(plain(lines?.total), "12 345,50 ₽");
    assert.equal(plain(lines?.split), "Работы 10 000,00 ₽ · запчасти 2 345,50 ₽");
    assert.equal(lines?.basis, "По 3 счетам и 4 задачам");
    assert.equal(equipmentSpendLines({ taskCount: 1, invoiceCount: 1, workAmount: 1, partsAmount: 0, totalAmount: 1 })?.basis, "По 1 счёту и 1 задаче");
  });

  it("без счетов — пояснение вместо нулей", () => {
    assert.equal(equipmentSpendLines({ taskCount: 0, invoiceCount: 0, workAmount: 0, partsAmount: 0, totalAmount: 0 }), null);
    assert.equal(equipmentSpendEmptyText("this_year"), "В этом году счетов по прибору нет");
    assert.equal(equipmentSpendEmptyText("all_time"), "Счетов по прибору ещё не было");
  });
});
