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
