import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidInn, isValidKpp, requisitesRefusal } from "./requisites.js";

describe("ИНН", () => {
  it("принимает настоящие номера организаций и предпринимателей", () => {
    // Номера из демо-данных и справочника плательщиков.
    assert.equal(isValidInn("7736012343"), true);
    assert.equal(isValidInn("526012874410"), true);
    assert.equal(isValidInn(" 7736012343 "), true);
  });

  it("не принимает буквы, знаки и неверную длину", () => {
    for (const value of ["abc!!", "", "   ", "773601234", "77360123401", "7736o12343", "77 36012343"]) {
      assert.equal(isValidInn(value), false, `должно быть отклонено: «${value}»`);
    }
  });

  it("ловит опечатку в одной цифре по контрольной цифре", () => {
    assert.equal(isValidInn("7736012340"), false);
    assert.equal(isValidInn("526012874411"), false);
  });
});

describe("КПП", () => {
  it("принимает девять знаков в принятом формате", () => {
    assert.equal(isValidKpp("773601001"), true);
    assert.equal(isValidKpp("7736AB001"), true);
  });

  it("не принимает короткие, длинные и строчные", () => {
    for (const value of ["12", "", "77360100", "7736010011", "7736ab001", "77-601001"]) {
      assert.equal(isValidKpp(value), false, `должно быть отклонено: «${value}»`);
    }
  });
});

describe("реквизиты человека площадки", () => {
  it("человек без реквизитов проходит: у него только телефон", () => {
    assert.equal(requisitesRefusal({}), null);
    assert.equal(requisitesRefusal({ inn: "", kpp: "" }), null);
  });

  it("случай из аудита отклоняется с понятным текстом", () => {
    assert.match(requisitesRefusal({ inn: "abc!!", kpp: "12" }) ?? "", /ИНН «abc!!» не похож на настоящий/u);
    assert.match(requisitesRefusal({ kpp: "12" }) ?? "", /КПП «12» не похож на настоящий/u);
  });

  it("КПП без ИНН не принимается", () => {
    assert.match(requisitesRefusal({ kpp: "773601001" }) ?? "", /КПП без ИНН не бывает/u);
  });

  it("верные реквизитами плательщика проходят", () => {
    assert.equal(requisitesRefusal({ inn: "7736012343", kpp: "773601001" }), null);
  });
});
