import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { equipmentOptionMeta, equipmentOptionTitle, filterEquipmentOptions } from "./equipment-options.js";
import type { EquipmentApiRecord } from "./m2-api.js";

const device = (id: string, model: string, serialNumber: string, site?: string, payer?: string): EquipmentApiRecord => ({
  id, manufacturer: model.split(" ")[0]!, model: model.split(" ").slice(1).join(" "), serialNumber, status: "in_use",
  ...(site ? { site } : {}), ...(payer ? { payer } : {})
});

const items = [
  device("a", "Sysmex XN-1000", "13562", "ГКБ № 1, КДЛ", "ГБУЗ ГКБ № 1"),
  device("b", "Beckman AU 480", "123", "ТЕСТ", "Тестовый человек"),
  device("c", "Mindray BC-6800", "TC-7A001284", "Медицинский центр «Здоровье»"),
  device("d", "Beckman DxH 800", "AW39114", "ГКБ № 1, КДЛ")
];

describe("выбор прибора списком", () => {
  it("без поиска показывает все приборы по площадкам, внутри по модели", () => {
    assert.deepEqual(filterEquipmentOptions(items, "").items.map((item) => item.id), ["d", "a", "c", "b"]);
  });

  it("находит по любому слову: модели, номеру, площадке, плательщику", () => {
    assert.deepEqual(filterEquipmentOptions(items, "beckman").items.map((item) => item.id), ["d", "b"]);
    assert.deepEqual(filterEquipmentOptions(items, "кдл xn").items.map((item) => item.id), ["a"]);
    assert.deepEqual(filterEquipmentOptions(items, "тестовый").items.map((item) => item.id), ["b"]);
  });

  it("номер находится без дефисов и пробелов", () => {
    assert.deepEqual(filterEquipmentOptions(items, "tc7a001").items.map((item) => item.id), ["c"]);
    assert.deepEqual(filterEquipmentOptions(items, "7A 0012").items.map((item) => item.id), ["c"]);
  });

  it("показывает не больше лимита и говорит, сколько всего", () => {
    const many = Array.from({ length: 130 }, (_, index) => device(`m${index}`, "Sysmex XN-550", String(1000 + index), "Площадка"));
    const result = filterEquipmentOptions(many, "", 100);
    assert.equal(result.items.length, 100);
    assert.equal(result.total, 130);
  });

  it("подписи строки: модель сверху, номер, площадка и плательщик снизу", () => {
    assert.equal(equipmentOptionTitle(items[1]!), "Beckman AU 480");
    assert.equal(equipmentOptionMeta(items[1]!), "S/N 123 · ТЕСТ · Тестовый человек");
    assert.equal(equipmentOptionMeta(device("x", "Mindray BS-800M", "BY-1")), "S/N BY-1 · площадка не указана");
  });
});
