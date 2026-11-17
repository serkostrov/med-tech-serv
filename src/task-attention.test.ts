import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attentionFilter, taskAttentionItems } from "./task-attention.js";

describe("плашка «Требуют внимания»", () => {
  it("три счётчика по порядку работы: новые, просроченные, на проверке", () => {
    const items = taskAttentionItems({ new: 3, overdue: 1, underReview: 12 }, { status: "", overdue: false, otherFilters: false });
    assert.deepEqual(items.map((item) => [item.key, item.label, item.count, item.active]), [
      ["new", "Новые", 3, false],
      ["overdue", "Просрочены", 1, false],
      ["under_review", "На проверке", 12, false]
    ]);
    assert.deepEqual(items.map((item) => item.ariaLabel), ["Новые: 3 задачи", "Просрочены: 1 задача", "На проверке: 12 задач"]);
  });

  it("счётчик открывает отбор: этап или просрочка", () => {
    assert.deepEqual(attentionFilter("new"), { status: "new", overdue: false });
    assert.deepEqual(attentionFilter("under_review"), { status: "under_review", overdue: false });
    assert.deepEqual(attentionFilter("overdue"), { status: "", overdue: true });
  });

  it("активен счётчик, по которому отобран список, и только без других отборов", () => {
    const counts = { new: 1, overdue: 2, underReview: 0 };
    const overdue = taskAttentionItems(counts, { status: "", overdue: true, otherFilters: false });
    assert.deepEqual(overdue.map((item) => item.active), [false, true, false]);
    const review = taskAttentionItems(counts, { status: "under_review", overdue: false, otherFilters: false });
    assert.deepEqual(review.map((item) => item.active), [false, false, true]);
    const withEngineer = taskAttentionItems(counts, { status: "new", overdue: false, otherFilters: true });
    assert.ok(withEngineer.every((item) => !item.active));
  });

  it("неверное число из базы не ломает подпись", () => {
    const [first] = taskAttentionItems({ new: -2, overdue: 0, underReview: 0 }, { status: "", overdue: false, otherFilters: false });
    assert.equal(first?.count, 0);
    assert.equal(first?.ariaLabel, "Новые: 0 задач");
  });
});
