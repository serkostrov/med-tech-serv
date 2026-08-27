import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { availableTaskActions } from "./task-actions.js";

const codes = (
  role: Parameters<typeof availableTaskActions>[0],
  status: Parameters<typeof availableTaskActions>[1],
  context: Parameters<typeof availableTaskActions>[2] = {}
) => availableTaskActions(role, status, context).map((item) => item.code);

describe("available task actions", () => {
  it("returns only coordinator actions valid for the current status", () => {
    assert.deepEqual(codes("coordinator", "new"), ["assign", "cancel"]);
    assert.deepEqual(codes("coordinator", "assigned"), ["cancel"]);
    assert.deepEqual(codes("coordinator", "under_review", { hasClosure: true }), [
      "verify_closure", "return_for_rework", "cancel"
    ]);
    assert.deepEqual(availableTaskActions("coordinator", "under_review", { hasClosure: true })[0], {
      code: "verify_closure", label: "Проверено — закрыть", targetStatus: "closed"
    });
    assert.deepEqual(codes("coordinator", "under_review", { hasClosure: true, closureVerified: true }), [
      "close", "return_for_rework", "cancel"
    ]);
    assert.deepEqual(codes("coordinator", "closed"), []);
  });

  it("does not leak coordinator actions to other roles", () => {
    assert.deepEqual(codes("engineer", "new"), []);
    assert.deepEqual(codes("engineer", "assigned"), ["accept"]);
    assert.deepEqual(codes("engineer", "in_progress"), []);
    assert.deepEqual(codes("engineer", "in_progress", { hasClosure: true }), ["submit_for_review"]);
    assert.deepEqual(codes("warehouse", "new"), []);
    assert.deepEqual(codes("admin", "assigned"), ["accept", "cancel"]);
    assert.deepEqual(codes("admin", "in_progress", { hasClosure: true }), ["submit_for_review", "cancel"]);
    assert.deepEqual(codes("admin", "under_review", { hasClosure: true, closureVerified: true }), [
      "close", "return_for_rework", "cancel"
    ]);
  });
});
