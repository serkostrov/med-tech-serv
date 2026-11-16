import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initialEmployeeRoleKey } from "./access-admin.js";

describe("роль в форме сотрудника", () => {
  it("у нового сотрудника роль не выбрана", () => {
    assert.equal(initialEmployeeRoleKey(), "");
    assert.equal(initialEmployeeRoleKey(undefined), "");
  });

  it("у существующего сотрудника стоит его роль", () => {
    assert.equal(initialEmployeeRoleKey({ accessRoleKey: "engineer", role: "engineer" }), "engineer");
    assert.equal(initialEmployeeRoleKey({ accessRoleKey: "senior_engineer", role: "engineer" }), "senior_engineer");
  });

  it("без своей роли доступа берёт базовую роль сотрудника", () => {
    assert.equal(initialEmployeeRoleKey({ role: "warehouse" }), "warehouse");
  });
});
