import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { mapEquipment, mapTask, M2ApiError, publicApiErrorMessage } from "./m2-api.js";

describe("Supabase row mapping", () => {
  it("maps equipment passport fields from nested relations", () => {
    const equipment = mapEquipment({
      id: "eq-1",
      serial_number: "SN-1",
      status_code: "in_use",
      manufacturer_id: "m-1",
      model_id: "model-1",
      current_site_id: "site-1",
      manufacturer: { id: "m-1", name: "Mindray" },
      model: { id: "model-1", name: "BC-6800" },
      status: { code: "in_use", name: "В эксплуатации" },
      site: { id: "site-1", name: "Клиника", organization: { name: "МедТех" } }
    });
    assert.equal(equipment.serialNumber, "SN-1");
    assert.equal(equipment.manufacturer, "Mindray");
    assert.equal(equipment.model, "BC-6800");
    assert.equal(equipment.site, "Клиника");
    assert.equal(equipment.organization, "МедТех");
    assert.equal(equipment.statusName, "В эксплуатации");
  });

  it("marks an open task overdue after the period end", () => {
    const task = mapTask({
      id: "task-1",
      number: "З-000001",
      title: "Диагностика",
      status_code: "assigned",
      deadline_from: "2020-01-01",
      deadline_to: "2020-01-02",
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
      site: { name: "Клиника", address: "Москва" }
    });
    assert.equal(task.isOverdue, true);
    assert.equal(task.customer?.siteName, "Клиника");
  });

  it("maps initiator and client contacts from the customers directory", () => {
    const task = mapTask({
      id: "task-2",
      number: "З-000002",
      title: "Ремонт",
      status_code: "new",
      site_contact_id: "contact-client",
      initiator_contact_id: "contact-initiator",
      initiator_name: "Петров Пётр",
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
      site: { name: "Клиника", address: "Москва" },
      contact: { full_name: "Иванов Иван", phone: "+7", email: "a@b.c" },
      initiator_contact: { full_name: "Петров Пётр" }
    });
    assert.equal(task.siteContactId, "contact-client");
    assert.equal(task.customer?.contactFullName, "Иванов Иван");
    assert.equal(task.initiatorContactId, "contact-initiator");
    assert.equal(task.initiatorName, "Петров Пётр");
    assert.equal(task.initiator?.fullName, "Петров Пётр");
  });

  it("keeps M2ApiError status for UI notices", () => {
    const error = new M2ApiError(409, "Прибор с таким S/N уже существует");
    assert.equal(error.status, 409);
    assert.equal(error.message, "Прибор с таким S/N уже существует");
  });

  it("does not show PostgREST relationship errors to the operator", () => {
    assert.match(
      publicApiErrorMessage("Could not embed because more than one relationship was found for 'tasks' and 'payers'"),
      /связанные данные/u
    );
    assert.match(
      publicApiErrorMessage("Could not embed because more than one relationship was found for 'maintenance_plans' and 'users'"),
      /связанные данные/u
    );
    assert.equal(publicApiErrorMessage("Плательщик задачи не найден"), "Плательщик задачи не найден");
    assert.equal(
      publicApiErrorMessage("new row violates check constraint \"tasks_core_relations_required\""),
      "У прибора должны быть указаны площадка и плательщик."
    );
    assert.equal(
      publicApiErrorMessage("new row violates check constraint \"tasks_execution_period_required\""),
      "Укажите период выполнения: даты «с» и «по»."
    );
    assert.equal(
      publicApiErrorMessage("Для замены плательщика задачи обязательны автор и причина"),
      "У прибора уже есть плательщик. Чтобы выбрать другого, укажите причину смены."
    );
    assert.match(publicApiErrorMessage("invalid input syntax for type uuid"), /фильтра/u);
    assert.match(publicApiErrorMessage("invalid input syntax for type uuid: \"Beckman Coulter\""), /фильтра/u);
    assert.match(publicApiErrorMessage("Signups not allowed for this instance"), /Публичная регистрация/u);
    assert.match(publicApiErrorMessage("User already registered"), /e-mail уже есть/u);
    assert.match(publicApiErrorMessage("Could not find the function public.create_access_user"), /обновить схему/u);
  });

  it("hard-deletes only rows that are replaced on save, never business records", async () => {
    // Задачи, приборы, счета, площадки, плательщики и сотрудники база через API не удаляет (0024):
    // их отменяют или отключают. Удаляются только строки, которые пересохраняются целиком.
    const source = await readFile(new URL("./m2-api.ts", import.meta.url), "utf8");
    const deleted = [...source.matchAll(/from\("([a-z_]+)"\)\.delete\(\)/gu)].map((match) => match[1]).sort();
    assert.deepEqual(deleted, ["access_role_permissions", "maintenance_plans", "site_payers", "task_parts"]);
    assert.match(source, /public async removeSite\(id: string\)[^\n]*\n\s*return \{ mode: "deactivated", after: await this\.updateSite\(id, \{ isActive: false \}\) \};/u);
    assert.match(source, /public async removeContact\([^\n]*\n\s*return \{ mode: "deactivated", after: await this\.updateContact\(siteId, contactId, \{ isActive: false \}\) \};/u);
    assert.match(source, /public async removePayer\(id: string\)[^\n]*\n\s*return this\.updatePayer\(id, \{ isActive: false \}\);/u);
  });

  it("creates employees through a privileged RPC instead of public signup", async () => {
    const source = await readFile(new URL("./m2-api.ts", import.meta.url), "utf8");
    assert.match(source, /rpc\("create_access_user"/u);
    assert.doesNotMatch(source, /auth\.signUp/u);
  });

  it("hints PostgREST embeds when a table has more than one FK to the same parent", async () => {
    const source = await readFile(new URL("./m2-api.ts", import.meta.url), "utf8");
    assert.match(source, /payer:payers!payer_id\(name\)/u);
    assert.match(source, /payer:payers!payer_id\(id, name, requisites\)/u);
    assert.match(source, /engineer:users!assigned_engineer_id\(full_name\)/u);
    assert.match(source, /payer:payers!current_payer_id\(id, name\)/u);
    assert.match(source, /author:users!created_by\(full_name\)/u);
    assert.doesNotMatch(source, /payer:payers\(/u);
    assert.doesNotMatch(source, /engineer:users\(/u);
  });

  it("resolves equipment filters by id or name and does not crash on bad uuid", async () => {
    const source = await readFile(new URL("./m2-api.ts", import.meta.url), "utf8");
    assert.match(source, /resolveFilterId\("manufacturers"/u);
    assert.match(source, /normalizeFilterValue/u);
    assert.match(source, /isFilterUuid/u);
    assert.match(source, /escapeIlikePattern/u);
    assert.match(source, /invalid input syntax for type uuid\|22P02/u);
    assert.match(source, /return paged\(\[\], 0, limit, offset\)/u);
  });
});
