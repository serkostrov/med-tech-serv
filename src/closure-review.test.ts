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
  it("shows the act, attachments, parts, reason and every closure field", () => {
    const markup = renderToStaticMarkup(createElement(ClosureReview, {
      card,
      busy: false,
      canClose: true,
      canReturn: true,
      onOpenAct: () => undefined,
      onClose: async () => undefined,
      onReturn: async () => undefined
    }));

    for (const expected of [
      "Проверка закрытия", "Открыть акт", "акт-тест-35.jpg", "Фото, видео и документы", "фото-работы-35.jpg",
      "Использованные запчасти", "TEST-PART-35", "Н, новая", "Износ / естественная эксплуатация",
      "Прибор не запускается", "Выполнена диагностика и замена узла", "Проверить через месяц", "Замечаний нет",
      "Показание счётчика", "1350", "Работы выполнены полностью", "Аппарат исправен и допущен",
      "Заказчик претензий не имеет", "Продолжение первичной заявки", "Проверено — закрыть", "На доработку"
    ]) assert.ok(markup.includes(expected), expected);
  });

  it("puts the decision buttons at the top and asks for a comment only on return", () => {
    const markup = renderToStaticMarkup(createElement(ClosureReview, {
      card,
      busy: false,
      canClose: true,
      canReturn: true,
      onOpenAct: () => undefined,
      onClose: async () => undefined,
      onReturn: async () => undefined
    }));
    // Кнопки решения стоят в шапке, раньше полей акта.
    assert.ok(markup.indexOf("Проверено — закрыть") < markup.indexOf("Причина вызова"));
    // Поле комментария появляется только после нажатия «На доработку».
    assert.doesNotMatch(markup, /<textarea/u);
    assert.doesNotMatch(markup, /Проверить акт/u);
    // Фото показываются превью, если есть ссылка.
    const withUrl = renderToStaticMarkup(createElement(ClosureReview, {
      card: { ...card, files: card.files.map((file) => ({ ...file, url: `https://files.test/${file.id}` })) },
      busy: false, canClose: true, canReturn: true,
      onOpenAct: () => undefined, onClose: async () => undefined, onReturn: async () => undefined
    }));
    assert.match(withUrl, /<img[^>]*src="https:\/\/files\.test\/photo-test-35"/u);
  });
});
