import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nameRepeats } from "./name-repeats.js";

describe("повтор названия организации", () => {
  it("организация повторяет площадку — вторую строку не показываем", () => {
    assert.equal(nameRepeats("ГБУЗ НО «НОКБ им. Н. А. Семашко»", "НОКБ им. Н. А. Семашко, КДЛ"), true);
    assert.equal(nameRepeats("ГБУЗ «ГКБ № 1 им. Н. И. Пирогова ДЗМ»", "ГБУЗ «ГКБ № 1 им. Н. И. Пирогова ДЗМ»"), true);
    assert.equal(nameRepeats("ГБУЗ «ГКБ № 1 им. Н. И. Пирогова ДЗМ»", "ГКБ № 1 им. Н. И. Пирогова, КДЛ"), true);
  });
  it("другое юрлицо остаётся видно", () => {
    assert.equal(nameRepeats("ООО «МЦ „Здоровье“»", "Медицинский центр «Здоровье», лаборатория"), false);
    assert.equal(nameRepeats("ООО «МедТехСервис»", "ГКБ № 1, КДЛ"), false);
  });
  it("пусто — не повтор", () => {
    assert.equal(nameRepeats(undefined, "ГКБ"), false);
    assert.equal(nameRepeats("ГКБ", ""), false);
  });
});
