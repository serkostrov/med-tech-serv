import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCustomerSelection, type PayerOption, type SiteOption } from "./customer-selection.js";

const sites: readonly SiteOption[] = [
  {
    id: "site-medical",
    name: "Учебное медучреждение",
    address: "г. Тестовый, ул. Лабораторная, д. 1",
    type: "medical_facility",
    isActive: true,
    contacts: [
      { id: "contact-one", fullName: "Мария Тестова", phone: "+7 000 000-00-01", email: "maria@example.test", isPrimary: true, isActive: true },
      { id: "contact-two", fullName: "Павел Тестов", phone: "+7 000 000-00-02", email: "pavel@example.test", isPrimary: false, isActive: true }
    ],
    payers: []
  },
  {
    id: "site-group",
    name: "Учебная компания группы",
    address: "г. Тестовый, пр. Учебный, д. 2",
    type: "group_company",
    isActive: true,
    contacts: [],
    payers: []
  }
];

const payers: readonly PayerOption[] = [
  { id: "payer-independent", name: "Самостоятельный учебный плательщик", isActive: true }
];

describe("customer selection forms", () => {
  it("uses the selected contact and independent payer in the task and act snapshot", () => {
    const snapshot = resolveCustomerSelection(sites, payers, {
      siteId: "site-medical",
      contactId: "contact-two",
      payerId: "payer-independent"
    });
    assert.equal(snapshot.siteName, "Учебное медучреждение");
    assert.equal(snapshot.contactName, "Павел Тестов");
    assert.equal(snapshot.payerName, "Самостоятельный учебный плательщик");
  });

  it("supports a group company without a contact or payer", () => {
    const snapshot = resolveCustomerSelection(sites, payers, { siteId: "site-group" });
    assert.equal(snapshot.address, "г. Тестовый, пр. Учебный, д. 2");
    assert.equal(snapshot.contactName, undefined);
    assert.equal(snapshot.payerName, undefined);
  });

  it("rejects a contact from another site", () => {
    assert.throws(
      () => resolveCustomerSelection(sites, payers, { siteId: "site-group", contactId: "contact-one" }),
      /не относится/u
    );
  });
});
