import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClosureReview } from "./ClosureReview.js";
import type { TaskCardResponse } from "./m2-api.js";

const card: TaskCardResponse = {
  task: {
    id: "task-test-35",
    number: "З-ТЕСТ-035",
    title: "Учебная проверка закрытия",
    status: "under_review",
    workTypeCode: "repair",
    workModifier: "G",
    hours: 2.5,
    reasonCode: "wear",
    callReason: "Прибор не запускается",
    workDescription: "Выполнена диагностика и замена узла",
    recommendations: "Проверить через месяц",
    userRemarks: "Замечаний нет",
    meterReading: 1350,
    workCompleted: true,
    apparatusApproved: true,
    customerHasNoClaims: true,
    continuedInPrimary: false,
    createdAt: "2026-08-18T08:00:00.000Z",
    updatedAt: "2026-08-18T10:00:00.000Z"
  },
  engineer: { id: "engineer-test-35", fullName: "Инженер Учебный" },
  workType: { code: "repair", name: "Ремонт" },
  reason: { code: "wear", name: "Износ / естественная эксплуатация" },
  status: { code: "under_review", name: "На проверке" },
  closure: {
    taskId: "task-test-35",
    actFileId: "act-test-35",
    submittedByName: "Инженер Учебный",
    submittedAt: "2026-08-18T09:55:00.000Z",
    workCompleted: true,
    apparatusApproved: true,
    customerHasNoClaims: true,
    continuedInPrimary: false
  },
  parts: [{ id: "part-test-35", articleNumber: "TEST-PART-35", name: "Учебный клапан", quantity: 1, condition: "N" }],
  canEditParts: true,
  files: [
    { id: "act-test-35", kind: "act", originalName: "акт-тест-35.jpg", contentType: "image/jpeg", byteSize: 2048, createdAt: "2026-08-18T09:50:00.000Z" },
    { id: "photo-test-35", kind: "photo", originalName: "фото-работы-35.jpg", contentType: "image/jpeg", byteSize: 1024, createdAt: "2026-08-18T09:51:00.000Z" }
  ],
  journal: [],
  availableActions: [
    { code: "verify_closure", label: "Проверено — закрыть", targetStatus: "closed" },
    { code: "return_for_rework", label: "На доработку", targetStatus: "in_progress", requiresComment: true }
  ]
};

describe("coordinator closure review", () => {
  const render = (overrides: Partial<Parameters<typeof ClosureReview>[0]> = {}) => renderToStaticMarkup(createElement(ClosureReview, {
    card,
    busy: false,
    canClose: true,
    canReturn: true,
    onClose: async () => undefined,
    onReturn: async () => undefined,
    ...overrides
  }));

  it("shows who handed the work in, a short summary and the decision, without repeating the materials", () => {
    const markup = render();
    for (const expected of [
      "Проверка закрытия", "Инженер Учебный передал работу на проверку", "Фото акта загружено",
      "Фото и видео с выезда: 1", "Запчасти: 1", "Проверено — закрыть", "На доработку"
    ]) assert.ok(markup.includes(expected), expected);
    // Результат, файлы и запчасти показаны один раз ниже, во вкладках карточки, а не здесь.
    for (const repeated of ["акт-тест-35.jpg", "фото-работы-35.jpg", "TEST-PART-35", "Выполнена диагностика и замена узла", "Открыть акт"]) {
      assert.ok(!markup.includes(repeated), repeated);
    }
  });

  it("warns when the act photo is missing", () => {
    const markup = render({ card: { ...card, closure: undefined, files: card.files.filter((file) => file.kind !== "act") } });
    assert.match(markup, /closure-review__summary-item--missing[^>]*>Фото акта не загружено/u);
  });

  it("lets the summary open the right card tab", () => {
    const markup = render({ onShow: () => undefined });
    assert.match(markup, /<button[^>]*>Фото акта загружено<\/button>/u);
    assert.match(markup, /<button[^>]*>Запчасти: 1<\/button>/u);
  });

  it("puts the decision buttons at the top and asks for a comment only on return", () => {
    const markup = render();
    assert.ok(markup.indexOf("Проверено — закрыть") > 0);
    // Поле комментария появляется только после нажатия «На доработку».
    assert.doesNotMatch(markup, /<textarea/u);
    assert.doesNotMatch(markup, /Проверить акт/u);
  });
});
