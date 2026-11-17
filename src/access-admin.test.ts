import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeAdminCount, canChangeEmployeeRole, canChangeRolePermissions, employeeDisableBlock, initialEmployeeRoleKey, permissionsForBaseRole, permissionSummary, roleDisableText } from "./access-admin.js";

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

describe("отключение роли называет, кто потеряет вход (аудит 17.11, № 90)", () => {
  const employees = [
    { fullName: "Соколов Денис Олегович", isActive: true, role: "admin", accessRoleKey: "sysadmin" },
    { fullName: "Морозова Елена", isActive: true, role: "coordinator", accessRoleKey: "coordinator" },
    { fullName: "Петров Иван", isActive: true, role: "coordinator", accessRoleKey: "coordinator" },
    { fullName: "Уволенный", isActive: false, role: "coordinator", accessRoleKey: "coordinator" }
  ];
  it("имя единственного сотрудника роли", () => {
    assert.equal(roleDisableText("Системный администратор", "sysadmin", employees),
      "Системный администратор: Соколов Денис Олегович сразу потеряет вход. Если доступ нужен, сначала переведите сотрудника на другую роль в «Сотрудниках».");
  });
  it("число и имена, неактивных не считает", () => {
    assert.match(roleDisableText("Координатор", "coordinator", employees), /^Координатор: 2 сотрудника сразу потеряют вход — Морозова Елена, Петров Иван\./u);
  });
  it("роль без людей", () => {
    assert.match(roleDisableText("Склад", "warehouse", employees), /никто вход не потеряет/u);
  });
});


describe("окно роли: права по типу и коротко", () => {
  const roles = [
    { key: "coordinator", baseRole: "coordinator", builtIn: true, permissions: ["tasks.read", "tasks.assign"] },
    { key: "initiator", baseRole: "initiator", builtIn: true, permissions: ["tasks.read_own", "tasks.create"] },
    { key: "senior-coord", baseRole: "coordinator", builtIn: false, permissions: ["tasks.read"] }
  ];

  it("новая роль получает права встроенной роли того же типа", () => {
    assert.deepEqual(permissionsForBaseRole(roles, "initiator"), ["tasks.read_own", "tasks.create"]);
    assert.deepEqual(permissionsForBaseRole(roles, "coordinator"), ["tasks.read", "tasks.assign"]);
    assert.deepEqual(permissionsForBaseRole(roles, "customer"), []);
  });

  it("права коротко: строка на раздел, пустые разделы не показываются", () => {
    const groups = [["tasks", ["tasks.read", "tasks.create", "tasks.assign"]], ["finance", ["finance.read"]]] as const;
    const labels = { "tasks.read": "Просмотр задач", "tasks.create": "Создание задач", "tasks.assign": "Назначение инженеров", "finance.read": "Просмотр счетов" };
    assert.deepEqual(permissionSummary(["tasks.read", "tasks.assign"], groups, { tasks: "Задачи", finance: "Счета" }, labels), [
      { group: "Задачи", text: "Просмотр задач, назначение инженеров" }
    ]);
  });
});
