export const WORKING_ROLES = [
  "coordinator",
  "engineer",
  "warehouse",
  "initiator",
  "customer",
  "supervisor",
  "admin"
] as const;

export type WorkingRole = (typeof WORKING_ROLES)[number];

export const PERMISSIONS = [
  "tasks.read",
  "tasks.read_own",
  "tasks.read_all",
  "tasks.read_organization",
  "tasks.write",
  "tasks.write_own",
  "tasks.create",
  "tasks.assign",
  "tasks.accept",
  "tasks.close",
  "tasks.review",
  "files.read",
  "files.write",
  "equipment.read",
  "equipment.write",
  "warehouse.read",
  "warehouse.write",
  "notifications.read",
  "finance.read",
  "finance.write",
  "payer.override",
  "contracts.write",
  "references.read",
  "references.write",
  "reports.read",
  "users.read",
  "users.write",
  "roles.write",
  "notification_settings.write",
  "price.read",
  "price.write",
  "audit.read"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Права по-русски: галочки роли и записи журнала доступа (0076) называют их одинаково. */
export const PERMISSION_LABELS: Readonly<Record<Permission, string>> = {
  "tasks.read": "Просмотр задач", "tasks.read_own": "Свои задачи", "tasks.read_all": "Все задачи", "tasks.read_organization": "Задачи организаций",
  "tasks.write": "Изменение задач", "tasks.write_own": "Изменение своих задач", "tasks.create": "Создание задач", "tasks.assign": "Назначение инженеров",
  "tasks.accept": "Принятие задач", "tasks.close": "Закрытие задач", "tasks.review": "Проверка закрытия",
  "files.read": "Просмотр файлов", "files.write": "Загрузка файлов", "equipment.read": "Просмотр приборов", "equipment.write": "Изменение приборов",
  "warehouse.read": "Просмотр склада", "warehouse.write": "Складские операции", "notifications.read": "Просмотр уведомлений",
  "finance.read": "Просмотр счетов", "finance.write": "Изменение счетов", "payer.override": "Смена плательщика в счёте", "contracts.write": "Изменение договоров",
  "references.read": "Просмотр справочников", "references.write": "Изменение справочников", "reports.read": "Просмотр отчётов",
  "users.read": "Просмотр сотрудников", "users.write": "Изменение сотрудников", "roles.write": "Управление ролями",
  "notification_settings.write": "Настройка писем", "price.read": "Просмотр прайса", "price.write": "Изменение прайса", "audit.read": "Просмотр журнала"
};

/** Названия встроенных ролей доступа (access_roles из 0001 и системный администратор демо). */
export const BUILTIN_ROLE_LABELS: Readonly<Record<string, string>> = {
  admin: "Главный администратор", sysadmin: "Системный администратор", coordinator: "Координатор", engineer: "Инженер",
  warehouse: "Кладовщик", initiator: "Инициатор", customer: "Заказчик", supervisor: "Руководитель"
};

/** Тип роли (base_role) по-русски. */
export const BASE_ROLE_LABELS: Readonly<Record<string, string>> = {
  admin: "Администратор", coordinator: "Координатор", engineer: "Инженер", warehouse: "Кладовщик",
  initiator: "Инициатор", customer: "Заказчик", supervisor: "Руководитель", manager: "Инициатор"
};

/** `manager` оставлен для старых записей и нормализуется в инициатора. */
export const STORED_ROLES = [...WORKING_ROLES, "manager"] as const;
export type StoredRole = (typeof STORED_ROLES)[number];

const ROLE_PERMISSIONS: Readonly<Record<WorkingRole, readonly Permission[]>> = {
  coordinator: [
    "tasks.read", "tasks.read_all", "tasks.write", "tasks.create", "tasks.assign", "tasks.review",
    "files.read", "files.write", "equipment.read", "equipment.write", "warehouse.read", "warehouse.write",
    "notifications.read", "finance.read", "finance.write", "payer.override", "contracts.write",
    "references.read", "references.write", "reports.read", "audit.read"
  ],
  engineer: [
    "tasks.read", "tasks.read_own", "tasks.write_own", "tasks.accept", "tasks.close",
    "files.read", "files.write", "equipment.read", "warehouse.read", "notifications.read"
  ],
  warehouse: ["warehouse.read", "warehouse.write", "notifications.read"],
  initiator: [
    "tasks.read", "tasks.read_own", "tasks.write_own", "tasks.create",
    "files.read", "files.write", "notifications.read"
  ],
  customer: ["tasks.read", "tasks.read_organization", "files.read"],
  supervisor: [
    "tasks.read", "tasks.read_all", "tasks.write", "tasks.create", "tasks.assign", "tasks.accept",
    "tasks.close", "tasks.review", "files.read", "files.write", "equipment.read", "equipment.write",
    "warehouse.read", "warehouse.write", "notifications.read", "finance.read", "finance.write",
    "payer.override", "contracts.write", "references.read", "references.write", "reports.read", "audit.read"
  ],
  admin: PERMISSIONS
};

export function canonicalRole(role: string): WorkingRole {
  if (role === "manager") return "initiator";
  return (WORKING_ROLES as readonly string[]).includes(role) ? role as WorkingRole : "initiator";
}

export function hasPermission(role: string, permission: Permission): boolean {
  return ROLE_PERMISSIONS[canonicalRole(role)].includes(permission);
}
