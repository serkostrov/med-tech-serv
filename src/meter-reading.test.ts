import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { meterReadingRefusal } from "./meter-reading.js";

describe("показание счётчика", () => {
  it("случай из аудита: 1 при последнем 152 300 не принимается", () => {
    assert.match(meterReadingRefusal(1, 152_300) ?? "", /меньше предыдущего \(152\s300\)/u);
  });

  it("равное и большее принимаются", () => {
    assert.equal(meterReadingRefusal(152_300, 152_300), null);
    assert.equal(meterReadingRefusal(152_301, 152_300), null);
  });

  it("у прибора без показаний принимается любое неотрицательное", () => {
    assert.equal(meterReadingRefusal(1, undefined), null);
    assert.equal(meterReadingRefusal(0, undefined), null);
  });

  it("отрицательное не принимается", () => {
    assert.match(meterReadingRefusal(-5, undefined) ?? "", /не может быть отрицательным/u);
  });

  it("пустое поле проверку проходит: показание необязательно", () => {
    assert.equal(meterReadingRefusal(undefined, 152_300), null);
    assert.equal(meterReadingRefusal(Number.NaN, 152_300), null);
  });
});
