import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UNCATEGORIZED_KEY,
  buildEquipmentFolderTree,
  equipmentTreeCategories,
  equipmentTreeManufacturers,
  equipmentTreeModelNames,
  equipmentTreeSerials,
  filterEquipmentFolderTree,
  toEquipmentTreeModels
} from "./equipment-tree.js";

const models = toEquipmentTreeModels([
  { id: "m1", name: "DxH 690T", isActive: true, attributes: { manufacturerId: "man-a", category: "Гематология" } },
  { id: "m2", name: "AU 5800", isActive: true, attributes: { manufacturerId: "man-a", category: "Биохимия" } },
  { id: "m3", name: "XN-1000", isActive: true, attributes: { manufacturerId: "man-b", category: "Гематология" } },
  { id: "m4", name: "Старый", isActive: false, attributes: { manufacturerId: "man-b", category: "" } }
]);

const manufacturers = [
  { id: "man-a", name: "Beckman Coulter", isActive: true },
  { id: "man-b", name: "Sysmex", isActive: true }
];

const units = [
  { id: "e1", serialNumber: "SN-1", modelId: "m1", manufacturerId: "man-a", site: "Клиника", status: "in_use", statusName: "В эксплуатации" },
  { id: "e2", serialNumber: "SN-2", modelId: "m1", manufacturerId: "man-a", status: "in_use" },
  { id: "e3", serialNumber: "SN-9", modelId: "m3", manufacturerId: "man-b", status: "storage" }
];

describe("ветвление приборов", () => {
  it("собирает категории и считает приборы, а не модели", () => {
    const categories = equipmentTreeCategories(models, units);
    assert.deepEqual(categories.map((item) => item.label), ["Биохимия", "Гематология"]);
    assert.equal(categories.find((item) => item.label === "Гематология")?.count, 3);
    assert.equal(categories.find((item) => item.label === "Биохимия")?.count, 0);
  });

  it("после категории показывает только её производителей", () => {
    const hematology = equipmentTreeCategories(models, units).find((item) => item.label === "Гематология");
    const items = equipmentTreeManufacturers(models, manufacturers, hematology?.id, units);
    assert.deepEqual(items.map((item) => item.label), ["Beckman Coulter", "Sysmex"]);
    assert.equal(items[0]?.count, 2);
    assert.equal(items[1]?.count, 1);
  });

  it("после производителя показывает названия и считает серийники", () => {
    const hematology = equipmentTreeCategories(models, units).find((item) => item.label === "Гематология");
    const names = equipmentTreeModelNames(models, hematology?.id, "man-a", units);
    assert.equal(names.length, 1);
    assert.equal(names[0]?.label, "DxH 690T");
    assert.equal(names[0]?.count, 2);
  });

  it("после названия показывает серийные номера", () => {
    const serials = equipmentTreeSerials(units, "m1");
    assert.deepEqual(serials.map((item) => item.label), ["SN-1", "SN-2"]);
    assert.match(serials[0]?.meta ?? "", /Клиника/u);
  });

  it("относит модели без категории в отдельную группу", () => {
    const withEmpty = toEquipmentTreeModels([
      { id: "x", name: "X", isActive: true, attributes: { manufacturerId: "man-a", category: "  " } }
    ]);
    assert.equal(withEmpty[0]?.categoryKey, UNCATEGORIZED_KEY);
    assert.equal(equipmentTreeCategories(withEmpty, [])[0]?.label, "Без категории");
  });

  it("строит папки категория → производитель → название → S/N", () => {
    const tree = buildEquipmentFolderTree(models, manufacturers, units, {
      e1: { manufacturer: "Beckman Coulter", model: "DxH 690T" },
      e2: { manufacturer: "Beckman Coulter", model: "DxH 690T" },
      e3: { manufacturer: "Sysmex", model: "XN-1000" }
    });
    const hematology = tree.find((item) => item.label === "Гематология");
    assert.ok(hematology);
    assert.equal(hematology?.count, 3);
    const beckman = hematology?.children?.find((item) => item.label === "Beckman Coulter");
    assert.equal(beckman?.children?.[0]?.label, "DxH 690T");
    assert.deepEqual(beckman?.children?.[0]?.children?.map((item) => item.label), ["SN-1", "SN-2"]);
  });

  it("показывает папки справочника даже без приборов с S/N", () => {
    const tree = buildEquipmentFolderTree(models, manufacturers, []);
    const biochemistry = tree.find((item) => item.label === "Биохимия");
    assert.ok(biochemistry);
    assert.equal(biochemistry?.count, 0);
    const beckman = biochemistry?.children?.find((item) => item.label === "Beckman Coulter");
    assert.equal(beckman?.children?.[0]?.label, "AU 5800");
    assert.equal(beckman?.children?.[0]?.count, 0);
    assert.equal(beckman?.children?.[0]?.meta, "нет S/N");
    assert.deepEqual(beckman?.children?.[0]?.children, []);
  });

  it("при поиске оставляет только подходящие ветки", () => {
    const tree = buildEquipmentFolderTree(models, manufacturers, units, {
      e1: { manufacturer: "Beckman Coulter", model: "DxH 690T" },
      e2: { manufacturer: "Beckman Coulter", model: "DxH 690T" },
      e3: { manufacturer: "Sysmex", model: "XN-1000" }
    });
    const bySerial = filterEquipmentFolderTree(tree, "SN-9");
    assert.equal(bySerial.length, 1);
    assert.equal(bySerial[0]?.children?.[0]?.children?.[0]?.children?.[0]?.label, "SN-9");

    const byManufacturer = filterEquipmentFolderTree(tree, "beckman");
    const hematologyBranch = byManufacturer.find((item) => item.label === "Гематология");
    const beckman = hematologyBranch?.children?.find((item) => item.label === "Beckman Coulter");
    assert.equal(beckman?.children?.[0]?.label, "DxH 690T");
    assert.equal(beckman?.children?.[0]?.children?.length, 2);
  });
});
