import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeAdminCount, canChangeEmployeeRole, canChangeRolePermissions, employeeDisableBlock, initialEmployeeRoleKey } from "./access-admin.js";

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

describe("отключение входа сотруднику", () => {
  const me = { id: "u-admin", isActive: true, role: "admin" };
  const secondAdmin = { id: "u-admin2", isActive: true, role: "admin" };
  const engineer = { id: "u-eng", isActive: true, role: "engineer" };

  it("себе вход отключить нельзя", () => {
    const block = employeeDisableBlock(me, { id: "u-admin", activeAdminCount: 2 });
    assert.equal(block?.note, "это вы");
    assert.match(block?.reason ?? "", /Себе вход отключать нельзя/u);
  });

  it("последнего администратора отключить нельзя, и сказано об этом заранее", () => {
    const block = employeeDisableBlock(secondAdmin, { id: "u-sysadmin", activeAdminCount: 1 });
    assert.equal(block?.note, "последний администратор");
    assert.match(block?.reason ?? "", /Сначала добавьте второго администратора/u);
  });

  it("чужой вход отключается как раньше", () => {
    assert.equal(employeeDisableBlock(engineer, { id: "u-admin", activeAdminCount: 1 }), null);
    assert.equal(employeeDisableBlock(secondAdmin, { id: "u-admin", activeAdminCount: 2 }), null);
  });

  it("у отключённого сотрудника запрета нет: его включают обратно", () => {
    assert.equal(employeeDisableBlock({ id: "u-admin", isActive: false, role: "admin" }, { id: "u-admin", activeAdminCount: 0 }), null);
  });

  it("считает только тех администраторов, кто может войти", () => {
    assert.equal(activeAdminCount([me, secondAdmin, engineer, { id: "u-off", isActive: false, role: "admin" }]), 2);
  });
});

describe("смена роли сотруднику", () => {
  it("себе роль менять нельзя: иначе можно остаться без прав", () => {
    assert.equal(canChangeEmployeeRole("u-admin", "u-admin"), false);
  });

  it("чужую роль меняют как раньше", () => {
    assert.equal(canChangeEmployeeRole("u-eng", "u-admin"), true);
  });
});

describe("права роли", () => {
  it("свою роль не правят: так теряют доступ к учётным записям", () => {
    assert.equal(canChangeRolePermissions("admin", "admin"), false);
  });

  it("чужие роли правятся как раньше", () => {
    assert.equal(canChangeRolePermissions("engineer", "admin"), true);
    assert.equal(canChangeRolePermissions("admin", undefined), true);
  });
});
