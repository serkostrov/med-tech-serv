import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toTechnicalCode } from "./slug.js";

describe("technical codes", () => {
  it("builds a latin slug from a russian name", () => {
    assert.equal(toTechnicalCode("Аппликация: постановка методик"), "applikaciya_postanovka_metodik");
    assert.equal(toTechnicalCode("ТО"), "to");
  });

  it("keeps codes unique against the current list", () => {
    assert.equal(toTechnicalCode("Ремонт", ["remont"]), "remont_2");
  });

  it("starts with a letter when the name is numeric", () => {
    assert.match(toTechnicalCode("12"), /^[a-z]/u);
  });
});
