import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { referenceEditPayload } from "./reference-edit.js";

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
