import assert from "node:assert/strict";
import { createElement } from "react";
import { describe, it } from "node:test";
import { collectSelectOptions } from "./select.js";

describe("collectSelectOptions", () => {
  it("uses explicit option value for filters (id, not label)", () => {
    const id = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
    const options = collectSelectOptions([
      createElement("option", { value: "" }, "Все производители"),
      createElement("option", { key: id, value: id }, "Beckman Coulter")
    ]);
    assert.deepEqual(options, [
      { value: "", label: "Все производители" },
      { value: id, label: "Beckman Coulter" }
    ]);
  });

  it("falls back to key when value is omitted, stripping React key prefixes", () => {
    const id = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
    const options = collectSelectOptions([
      createElement("option", { key: `.$${id}` }, "Beckman Coulter")
    ]);
    assert.equal(options[0]?.value, id);
    assert.equal(options[0]?.label, "Beckman Coulter");
  });

  it("falls back to label only when neither value nor distinct key exist", () => {
    const options = collectSelectOptions([
      createElement("option", null, "Beckman Coulter")
    ]);
    assert.equal(options[0]?.value, "Beckman Coulter");
  });
});
