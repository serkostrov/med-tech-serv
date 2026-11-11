import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkAct } from "./WorkAct.js";
import { TaskCard } from "./App.js";
import type { TaskCardResponse } from "./m2-api.js";
import { MEDTECHSERVICE_REQUISITES, buildWorkAct } from "./work-act.js";

function card() {
  return {
    task: {
      number: "З-ТЕСТ-032",
      contractId: "contract-test-32",
      contractNumber: "Д-ТЕСТ-032",
      callDate: "2026-08-01T00:00:00.000Z",
      visitDate: "2026-08-02T00:00:00.000Z",
      completedAt: "2026-08-03T12:00:00.000Z",
      workStartedAt: "2026-08-02T09:30:00.000Z",
      workFinishedAt: "2026-08-02T11:45:00.000Z",
      meterReading: 731,
      workModifier: "G" as const,
      callReason: "Не запускается",
      workDescription: "Выполнена диагностика и замена узла",
      recommendations: "Провести контроль через месяц",
      userRemarks: "Замечаний нет",
      workCompleted: true,
      apparatusApproved: true,
      customerHasNoClaims: true,
      continuedInPrimary: false,
      customer: {
        siteName: "Учебная площадка",
        address: "Учебный адрес",
        contactFullName: "Тестовый Заказчик",
        contactPhone: "+7 000 000-00-00"
      }
    },
    equipment: {
      manufacturer: "Учебный производитель",
      model: "Модель-32",
      serialNumber: "TEST-SN-32",
      lastMeterReading: 700
    },
    engineer: { fullName: "Резервный Инженер" },
    workType: { name: "Ремонт" },
    closure: {
      submittedByName: "Сервисов Сергей Сергеевич",
      workCompleted: true,
      apparatusApproved: true,
      customerHasNoClaims: true,
      continuedInPrimary: false
    },
    parts: [
      { articleNumber: "TEST-PART-1", name: "Учебный узел", quantity: 2, condition: "N" as const },
      { articleNumber: "TEST-PART-2", name: "Бывший в употреблении узел", quantity: 1, condition: "B" as const }
    ]
  };
}

describe("work act model and print view", () => {
  it("fills the customer template fields from the task snapshot", () => {
    const act = buildWorkAct(card());

    assert.deepEqual(act.company, MEDTECHSERVICE_REQUISITES);
    assert.equal(act.number, "З-ТЕСТ-032");
    assert.equal(act.contractNumber, "Д-ТЕСТ-032");
    assert.deepEqual(act.customer, {
      name: "Учебная площадка",
      address: "Учебный адрес",
      contactFullName: "Тестовый Заказчик",
      contactPhone: "+7 000 000-00-00"
    });
    assert.deepEqual(act.equipment, [{
      name: "Учебный производитель Модель-32",
      serialNumber: "TEST-SN-32",
      meterReading: 731
    }]);
    assert.deepEqual(act.works, [{ name: "Ремонт", modifier: "G" }]);
    assert.deepEqual(act.parts, [
      { articleNumber: "TEST-PART-1", name: "Учебный узел", quantity: 2, condition: "N" },
      { articleNumber: "TEST-PART-2", name: "Бывший в употреблении узел", quantity: 1, condition: "B" }
    ]);
    assert.deepEqual(act.marks, {
      workCompleted: true,
      apparatusApproved: true,
      customerHasNoClaims: true,
      continuedInPrimary: false
    });
    assert.equal(act.customerParty.fullName, "Тестовый Заказчик");
    assert.equal(act.contractorParty.position, "Сервисный инженер");
    assert.equal(act.contractorParty.fullName, "Сервисов Сергей Сергеевич");
  });

  it("supports several equipment and work rows in one act", () => {
    const act = buildWorkAct(card(), {
      equipment: [
        { name: "Прибор А", serialNumber: "TEST-A", meterReading: 10 },
        { name: "Прибор Б", serialNumber: "TEST-B", meterReading: 20 }
      ],
      works: [
        { name: "Диагностика" },
        { name: "Прочие работы", modifier: "N", hours: 2.5 }
      ]
    });

    assert.equal(act.equipment.length, 2);
    assert.equal(act.equipment[1]?.serialNumber, "TEST-B");
    assert.equal(act.works.length, 2);
    assert.equal(act.works[1]?.hours, 2.5);
  });

  it("exposes equipment and work row controls on the product task-card path", () => {
    const source = card();
    const productCard = {
      ...source,
      task: {
        ...source.task,
        id: "task-test-32",
        title: "Синтетическая работа",
        status: "closed",
        priority: "planned",
        equipmentId: "equipment-test-32",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-03T12:00:00.000Z"
      },
      equipment: {
        ...source.equipment,
        id: "equipment-test-32",
        status: "in_use",
        site: "Учебная площадка"
      },
      parts: source.parts.map((part, index) => ({ ...part, id: `part-${index + 1}` })),
      status: { code: "closed", name: "Закрыта" },
      availableActions: [],
      files: [],
      journal: [],
      canEditParts: false
    } as unknown as TaskCardResponse;
    const markup = renderToStaticMarkup(createElement(TaskCard, {
      card: productCard,
      initialTab: "result",
      onBack: () => undefined,
      onChanged: async () => undefined,
      onOpenRelated: async () => undefined
    }));

    // Строки печатной формы правятся из печатного вида («Строки акта»), в карточке только вход в него.
    assert.match(markup, /Акт для печати/u);
    assert.doesNotMatch(markup, /\+ Добавить прибор/u);
  });

  it("renders signatures, name decoding, seal places and the service engineer role", () => {
    const markup = renderToStaticMarkup(createElement(WorkAct, { act: buildWorkAct(card()), onBack: () => undefined }));

    for (const expected of [
      "Акт выполненных работ", "Договор № Д-ТЕСТ-032", "ООО «МедТехСервис»", "ИНН 7806410615",
      "От Заказчика", "От Исполнителя", "Сервисный инженер", "Сервисов Сергей Сергеевич",
      "(Подпись)", "(Расшифровка)", "М.П.", "Г/Н/Б"
    ]) {
      assert.match(markup, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    }
  });
});
