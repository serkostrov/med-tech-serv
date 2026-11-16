import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { ReferenceCatalogDescriptor, ReferenceCatalogValue } from "./m2-api.js";
import { isSelectedReference, referenceAttributeText, referenceAttributesSummary, referenceValueName } from "./reference-display.js";

const modelFields: ReferenceCatalogDescriptor["fields"] = [
  { key: "manufacturerId", label: "Производитель", type: "reference", required: true, referenceCatalog: "manufacturers" },
  { key: "category", label: "Категория", type: "text" },
  { key: "sortOrder", label: "Порядок", type: "integer" }
];

function manufacturer(id: string, name: string, isActive = true): ReferenceCatalogValue {
  return { id, name, isActive, attributes: {} };
}

const related = {
  manufacturers: [
    manufacturer("m-bc", "Beckman Coulter"),
    // На стенде идентификатор записи длинный и служебный — показывать его нельзя тем более.
    manufacturer("3f2a7c10-0d6b-4e4a-9a77-0f9f2f2b61aa", "Roche Diagnostics"),
    manufacturer("m-mindray", "Mindray", false)
  ]
};

describe("справочники: на экране названия, а не коды", () => {
  it("находит название по идентификатору и по коду записи", () => {
    assert.equal(referenceValueName("manufacturers", "m-bc", related), "Beckman Coulter");
    assert.equal(referenceValueName("manufacturers", "3f2a7c10-0d6b-4e4a-9a77-0f9f2f2b61aa", related), "Roche Diagnostics");
    assert.equal(referenceValueName("manufacturers", "нет-такого", related), undefined);
    assert.equal(referenceValueName("payers", "m-bc", related), undefined);
  });

  it("название видно и у скрытого производителя", () => {
    assert.equal(referenceValueName("manufacturers", "m-mindray", related), "Mindray");
  });

  it("вместо кода привязки подставляет название", () => {
    assert.equal(referenceAttributeText(modelFields[0], "m-bc", related), "Beckman Coulter");
    // Пока справочник не загрузился, лучше прочерк, чем служебный код.
    assert.equal(referenceAttributeText(modelFields[0], "m-bc", {}), "—");
    assert.equal(referenceAttributeText(modelFields[1], "Биохимические анализаторы", related), "Биохимические анализаторы");
    assert.equal(referenceAttributeText(undefined, true, related), "да");
    assert.equal(referenceAttributeText(undefined, false, related), "нет");
    assert.equal(referenceAttributeText(undefined, null, related), "—");
  });

  it("строка «Параметры» модели прибора читается по-человечески (находка 29)", () => {
    const summary = referenceAttributesSummary(
      modelFields,
      { manufacturerId: "m-bc", category: "Биохимические анализаторы", sortOrder: 10 },
      related
    );
    assert.equal(summary, "Производитель: Beckman Coulter · Категория: Биохимические анализаторы");
    assert.doesNotMatch(summary, /m-bc/u);
  });

  it("битая привязка видна, а незагруженный справочник просто молчит", () => {
    // Справочник загружен, записи в нём нет — об этом нужно сказать, а не спрятать строку.
    assert.equal(referenceAttributeText(modelFields[0], "нет-такого", related), "запись не найдена");
    // Справочник ещё не пришёл: показывать нечего, но и код показывать нельзя.
    assert.equal(referenceAttributeText(modelFields[0], "нет-такого", {}), "—");
    assert.match(referenceAttributesSummary(modelFields, { manufacturerId: "удалённый" }, related), /запись не найдена/u);
  });

  it("выбранную запись узнаёт и по идентификатору, и по коду", () => {
    const value = { id: "3f2a7c10", code: "m-bc", name: "Beckman Coulter", isActive: false, attributes: {} };
    assert.equal(isSelectedReference(value, "3f2a7c10"), true);
    assert.equal(isSelectedReference(value, "m-bc"), true);
    assert.equal(isSelectedReference(value, "другое"), false);
    assert.equal(isSelectedReference(value, ""), false);
    assert.equal(isSelectedReference(value, null), false);
    assert.equal(isSelectedReference(value, undefined), false);
  });

  it("пустые параметры не превращаются в «null» и не занимают место", () => {
    assert.equal(referenceAttributesSummary(modelFields, { manufacturerId: "m-bc", category: null }, related), "Производитель: Beckman Coulter");
    assert.equal(referenceAttributesSummary(modelFields, { sortOrder: 10 }, related), "—");
  });

  it("в списке справочников рисуется общий помощник, а не сырые атрибуты (находка 29)", async () => {
    const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    assert.match(app, /referenceAttributesSummary\(selected\.fields, record\.attributes, relatedValues\)/u);
    assert.doesNotMatch(app, /Object\.entries\(record\.attributes\)/u);
  });

  it("в прайсе код вида работ отделён от названия и читается как код (находка 26)", async () => {
    const [price, css] = await Promise.all([
      readFile(new URL("./PricePage.tsx", import.meta.url), "utf8"),
      readFile(new URL("./styles.css", import.meta.url), "utf8")
    ]);
    // Код остаётся для сверки со складом и бухгалтерией, но отдельной плашкой.
    assert.match(price, /<small>\{line\.guaranteeCategoryName\}<\/small><code className="price-code"/u);
    assert.doesNotMatch(price, /\{line\.guaranteeCategoryName\} · \{line\.workTypeCode\}/u);
    assert.match(css, /\.price-code\s*\{[^}]*font-family:\s*ui-monospace/su);
  });
});
