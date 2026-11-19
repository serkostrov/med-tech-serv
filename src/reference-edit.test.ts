import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertReferenceValueCanBeHidden, canHideReferenceValue, duplicateModelRefusal, referenceEditPayload } from "./reference-edit.js";

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

describe("встроенные значения справочника", () => {
  it("не предлагает скрыть встроенный этап «Закрыта»", () => {
    assert.equal(canHideReferenceValue({ name: "Закрыта", isBuiltin: true }), false);
    assert.throws(() => assertReferenceValueCanBeHidden({ name: "Закрыта", isBuiltin: true }), /Закрыта.*встроенное значение/u);
  });

  it("обычное значение справочника скрывается как раньше", () => {
    assert.equal(canHideReferenceValue({ name: "Ждёт запчасть", isBuiltin: false }), true);
    assert.equal(canHideReferenceValue({ name: "cobas e 411" }), true);
    assert.doesNotThrow(() => assertReferenceValueCanBeHidden({ name: "Ждёт запчасть" }));
  });
});

describe("дубль модели прибора", () => {
  const models = [
    { id: "mdl-au680", name: "AU 680", isActive: true, attributes: { manufacturerId: "m-bc" } },
    { id: "mdl-xn1000", name: "XN-1000", isActive: true, attributes: { manufacturerId: "m-sysmex" } },
    { id: "mdl-old", name: "cobas e 411", isActive: false, attributes: { manufacturerId: "m-roche" } }
  ];

  it("случай из аудита: вторая «AU 680» у Beckman Coulter не заводится", () => {
    const refusal = duplicateModelRefusal({ name: "AU 680", manufacturerId: "m-bc" }, models, "Beckman Coulter");
    assert.match(refusal ?? "", /Модель «AU 680» у производителя «Beckman Coulter» уже есть/u);
  });

  it("регистр и пробелы различием не считаются", () => {
    assert.notEqual(duplicateModelRefusal({ name: "  au 680 ", manufacturerId: "m-bc" }, models), null);
  });

  it("у другого производителя такое же название разрешено", () => {
    assert.equal(duplicateModelRefusal({ name: "AU 680", manufacturerId: "m-sysmex" }, models), null);
  });

  it("правка самой записи дублем не считается", () => {
    assert.equal(duplicateModelRefusal({ id: "mdl-au680", name: "AU 680", manufacturerId: "m-bc" }, models), null);
  });

  it("скрытая запись тоже ловится и подсказывает, что её можно вернуть", () => {
    const refusal = duplicateModelRefusal({ name: "cobas e 411", manufacturerId: "m-roche" }, models, "Roche");
    assert.match(refusal ?? "", /скрыта: верните её кнопкой «Показать»/u);
  });

  it("без производителя и без названия проверка молчит: о них говорят другие поля", () => {
    assert.equal(duplicateModelRefusal({ name: "AU 680", manufacturerId: null }, models), null);
    assert.equal(duplicateModelRefusal({ name: "   ", manufacturerId: "m-bc" }, models), null);
  });
});

describe("удаление вида работ (вторая встреча 18.11, 0075)", () => {
  it("удалять может только руководитель и администратор, как и в базе", async () => {
    const { canDeleteWorkTypes } = await import("./reference-edit.js");
    assert.equal(canDeleteWorkTypes("supervisor"), true);
    assert.equal(canDeleteWorkTypes("admin"), true);
    assert.equal(canDeleteWorkTypes("coordinator"), false);
    assert.equal(canDeleteWorkTypes(undefined), false);
  });

  it("база удаляет только неиспользованный вид работ и сама чистит его цены", async () => {
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(new URL("../supabase/migrations/0075_delete_work_type.sql", import.meta.url), "utf8");
    for (const table of ["tasks", "maintenance_plans", "invoice_items", "quote_items"]) assert.match(sql, new RegExp(`FROM public\\.${table}`, "u"));
    assert.match(sql, /extra_work_type_codes/u);
    assert.match(sql, /DROP POLICY IF EXISTS role_delete ON public\.work_types/u);
    assert.match(sql, /можно только скрыть/u);
  });
});
