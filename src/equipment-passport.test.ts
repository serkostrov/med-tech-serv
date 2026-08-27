import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasEquipmentSerialConflict, normalizeEquipmentSerial } from "./equipment-passport.js";

describe("форма паспорта прибора", () => {
  it("нормализует S/N без учёта регистра и любых пробелов", () => {
    assert.equal(normalizeEquipmentSerial("  be 49\t081\n"), "BE49081");
  });

  it("не допускает повторный нормализованный S/N, кроме редактируемого паспорта", () => {
    const records = [{ id: "equipment-1", serial: "BE 49081" }];
    assert.equal(hasEquipmentSerialConflict(records, "be49081"), true);
    assert.equal(hasEquipmentSerialConflict(records, "be49081", "equipment-1"), false);
  });
});
