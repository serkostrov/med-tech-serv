import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_EQUIPMENT_REGISTRY_FILTERS, filterEquipmentRegistry } from "./equipment-registry.js";

const equipment = [
  {
    serial: "BE49081",
    model: "DxH-800",
    manufacturer: "Beckman Coulter",
    organization: "Учебная организация Север",
    place: "Учебная площадка 12",
    payer: "Учебный плательщик А",
    status: "В эксплуатации"
  },
  {
    serial: "SYNTHETIC-002",
    model: "DxH-800",
    manufacturer: "Beckman Coulter",
    organization: "Учебная организация Север",
    place: "Учебная площадка 12",
    payer: "Учебный плательщик Б",
    status: "В эксплуатации"
  },
  {
    serial: "SYNTHETIC-003",
    model: "BS-620",
    manufacturer: "Mindray",
    organization: "Учебная организация Юг",
    place: "Учебная площадка 7",
    payer: "Учебный плательщик А",
    status: "В ремонте"
  }
] as const;

describe("equipment registry", () => {
  it("finds BE49081 by S/N and an equipment by organization words", () => {
    assert.deepEqual(filterEquipmentRegistry(equipment, {
      ...EMPTY_EQUIPMENT_REGISTRY_FILTERS,
      search: "BE49081"
    }).map((item) => item.serial), ["BE49081"]);
    assert.equal(filterEquipmentRegistry(equipment, {
      ...EMPTY_EQUIPMENT_REGISTRY_FILTERS,
      search: "организация Север"
    }).length, 2);
  });

  it("combines manufacturer, status, site and payer filters", () => {
    const result = filterEquipmentRegistry(equipment, {
      search: "DxH",
      manufacturer: "Beckman Coulter",
      status: "В эксплуатации",
      site: "Учебная площадка 12",
      payer: "Учебный плательщик А"
    });
    assert.deepEqual(result.map((item) => item.serial), ["BE49081"]);
  });
});
