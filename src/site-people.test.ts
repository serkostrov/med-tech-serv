import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SiteOption } from "./customer-selection.js";
import { sitePeople } from "./site-people.js";

const site: SiteOption = {
  id: "site-1",
  name: "Тестовая площадка",
  address: "Адрес 1",
  type: "medical_facility",
  isActive: true,
  contacts: [
    {
      id: "c1",
      fullName: "Тест ФИО",
      phone: "+79999999999",
      isPrimary: true,
      isActive: true,
      payerId: "p1",
      inn: "123"
    }
  ],
  payers: [
    { id: "p1", name: "Тест ФИО", inn: "123", isActive: true },
    { id: "p2", name: "Отдельный плательщик", isActive: true }
  ]
};

describe("site people", () => {
  it("merges linked contact and payer into one person", () => {
    const people = sitePeople(site);
    assert.equal(people.length, 2);
    assert.equal(people[0]?.fullName, "Тест ФИО");
    assert.equal(people[0]?.contactId, "c1");
    assert.equal(people[0]?.payerId, "p1");
    assert.equal(people[0]?.phone, "+79999999999");
    assert.equal(people[0]?.inn, "123");
    assert.equal(people[1]?.fullName, "Отдельный плательщик");
    assert.equal(people[1]?.payerId, "p2");
  });
});
