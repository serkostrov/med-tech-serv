export type AppRole = "admin" | "coordinator" | "engineer" | "warehouse";

export type NavigationId =
  | "tasks"
  | "maintenance"
  | "equipment"
  | "engineers"
  | "warehouse"
  | "customers"
  | "notifications"
  | "reports"
  | "references"
  | "finance"
  | "reservations"
  | "inventory"
  | "handoff"
  | "access";

export type NavigationIcon =
  | "tasks"
  | "maintenance"
  | "equipment"
  | "engineers"
  | "warehouse"
  | "customers"
  | "notifications"
  | "reports"
  | "references"
  | "finance"
  | "reservations"
  | "inventory"
  | "handoff"
  | "shield";

export interface NavigationItem {
  readonly id: NavigationId;
  readonly label: string;
  readonly description: string;
  readonly group: string;
  readonly icon: NavigationIcon;
  readonly badge?: string;
}

export const roleLabels: Readonly<Record<AppRole, string>> = {
  admin: "Администратор",
  coordinator: "Координатор",
  engineer: "Инженер",
  warehouse: "Кладовщик"
};

export const roleDescriptions: Readonly<Record<AppRole, string>> = {
  admin: "Все разделы и сотрудники",
  coordinator: "Заявки, приборы и склад",
  engineer: "Ваши выезды и приборы",
  warehouse: "Запчасти и остатки"
};

/**
 * Представление меню в UI. Серверная политика доступа остаётся источником
 * истины и не заменяется скрытием разделов на клиенте.
 */
const coordinatorNavigation: readonly NavigationItem[] = [
  { id: "tasks", label: "Задачи", description: "Заявки на ремонт и обслуживание", group: "Работа", icon: "tasks" },
  { id: "equipment", label: "Приборы", description: "Паспорта и история обслуживания", group: "Работа", icon: "equipment" },
  { id: "maintenance", label: "План ТО", description: "Когда обслуживать приборы", group: "Работа", icon: "maintenance" },
  { id: "engineers", label: "Инженеры", description: "Кто свободен и у кого просрочки", group: "Работа", icon: "engineers" },
  { id: "warehouse", label: "Склад", description: "Запчасти и остатки", group: "Работа", icon: "warehouse" },
  { id: "customers", label: "Клиенты", description: "Площадки, контакты и плательщики", group: "Контроль", icon: "customers" },
  { id: "finance", label: "Счета", description: "Выставить счёт по закрытым задачам", group: "Контроль", icon: "finance" },
  { id: "reports", label: "Отчёты", description: "Сводка по задачам за период", group: "Контроль", icon: "reports" },
  { id: "notifications", label: "Уведомления", description: "Письма клиентам и сотрудникам", group: "Контроль", icon: "notifications" },
  { id: "references", label: "Справочники", description: "Виды работ, статусы и модели приборов", group: "Настройки", icon: "references" }
];

const roleNavigation: Readonly<Record<AppRole, readonly NavigationItem[]>> = {
  admin: [
    ...coordinatorNavigation,
    { id: "access", label: "Сотрудники", description: "Кто входит в систему и что может делать", group: "Настройки", icon: "shield" }
  ],
  coordinator: coordinatorNavigation,
  engineer: [
    { id: "tasks", label: "Мои задачи", description: "Выезды, адреса и сроки", group: "Работа", icon: "tasks" },
    { id: "equipment", label: "Мои приборы", description: "Оборудование на ваших заявках", group: "Работа", icon: "equipment" },
    { id: "notifications", label: "Уведомления", description: "Назначения и статусы заявок", group: "Работа", icon: "notifications" }
  ],
  warehouse: [
    { id: "warehouse", label: "Склад", description: "Запчасти и остатки", group: "Работа", icon: "warehouse" },
    { id: "notifications", label: "Уведомления", description: "События по складу", group: "Работа", icon: "notifications" }
  ]
};

export function getRoleNavigation(role: AppRole): readonly NavigationItem[] {
  return roleNavigation[role];
}

export function hasNavigationItem(role: AppRole, id: NavigationId): boolean {
  return getRoleNavigation(role).some((item) => item.id === id);
}

export function getDefaultView(role: AppRole): NavigationId {
  return role === "warehouse" ? "warehouse" : "tasks";
}

/** Разбирает публичный URL карточки из e-mail; остальные пути не маскирует под задачу. */
export function taskIdFromPathname(pathname: string): string | undefined {
  const match = /^\/tasks\/([^/]+)\/?$/u.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    const taskId = decodeURIComponent(match[1]);
    return taskId && !taskId.includes("/") ? taskId : undefined;
  } catch {
    return undefined;
  }
}

export function taskPathname(taskId: string): string {
  const normalized = taskId.trim();
  if (!normalized) throw new Error("Для ссылки нужен идентификатор задачи");
  return `/tasks/${encodeURIComponent(normalized)}`;
}
