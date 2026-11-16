import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertReferenceValueCanBeHidden, canHideReferenceValue, referenceEditPayload } from "./reference-edit.js";

describe("reference edit payload", () => {
  it("keeps numeric, reference and boolean attributes in an edit", () => {
    assert.deepEqual(referenceEditPayload("  Категория  ", {
      warrantyMonths: 12,
      warrantyPercent: 100,
      manufacturerId: "manufacturer-1",
      sortOrder: 20,
      requiresHours: true,
      isTerminal: false
    }), {
      name: "Категория",
      attributes: {
        warrantyMonths: 12,
        warrantyPercent: 100,
        manufacturerId: "manufacturer-1",
        sortOrder: 20,
        requiresHours: true,
        isTerminal: false
      }
    });
  });
});

describe("встроенные значения справочника", () => {
  it("не предлагает скрыть встроенный этап «Закрыта»", () => {
    assert.equal(canHideReferenceValue({ name: "Закрыта", isBuiltin: true }), false);
    assert.throws(() => assertReferenceValueCanBeHidden({ name: "Закрыта", isBuiltin: true }), /Закрыта.*встроенное значение/u);
  });

  it("обычное значение справочника скрывается как раньше", () => {
    assert.equal(canHideReferenceValue({ name: "Ждёт запчасть", isBuiltin: false }), true);
    assert.equal(canHideReferenceValue({ name: "cobas e 411" }), true);
    assert.doesNotThrow(() => assertReferenceValueCanBeHidden({ name: "Ждёт запчасть" }));
  });
});
