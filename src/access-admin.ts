/** Правила формы «Сотрудники и роли», которые не должны зависеть от порядка строк в списке. */

export interface EmployeeRoleSource {
  readonly accessRoleKey?: string;
  readonly role?: string;
}

/**
 * Какая роль стоит в форме при открытии.
 *
 * У нового сотрудника — никакая: раньше подставлялась «первая активная роль из списка»,
 * а список отсортирован по алфавиту, где первым идёт «Главный администратор». Администратор
 * заполнял ФИО, почту и пароль, не смотрел на поле «Роль» — и новый человек получал полные
 * права на всю систему. Роль — главное решение в этой форме, её выбирают руками.
 * У существующего сотрудника — его собственная роль.
 */
export function initialEmployeeRoleKey(employee?: EmployeeRoleSource): string {
  return employee?.accessRoleKey ?? employee?.role ?? "";
}

/** Почему вход этому сотруднику отключать нельзя: подпись в строке и полная причина. */
export interface EmployeeDisableBlock {
  /** Короткая подпись под ФИО в списке. */
  readonly note: string;
  /** Целая фраза: что нельзя и что делать вместо этого. */
  readonly reason: string;
}

export interface DisableCandidate {
  readonly id: string;
  readonly isActive: boolean;
  /** Базовая роль сотрудника. */
  readonly role?: string;
}

/**
 * Можно ли отключить вход сотруднику, и если нет — почему.
 *
 * Запрет держит база (миграция 0035), экран его повторяет, чтобы сказать об этом до
 * подтверждения, а не сырой ошибкой после. Раньше кнопка «Отключить» рисовалась у всех:
 * администратор выключал себе вход одним нажатием, а про последнего администратора
 * узнавал из сообщения базы уже после того, как подтвердил отключение.
 */
export function employeeDisableBlock(
  employee: DisableCandidate,
  viewer: { readonly id: string; readonly activeAdminCount: number }
): EmployeeDisableBlock | null {
  if (!employee.isActive) return null;
  if (employee.id === viewer.id) {
    return {
      note: "это вы",
      reason: "Себе вход отключать нельзя: вы сразу потеряете доступ к системе. Попросите другого администратора"
    };
  }
  if (employee.role === "admin" && viewer.activeAdminCount <= 1) {
    return {
      note: "последний администратор",
      reason: "Это последний администратор: без него некому вести учётные записи, роли и настройки. Сначала добавьте второго администратора и включите ему вход"
    };
  }
  return null;
}

/**
 * Можно ли менять роль этому сотруднику.
 *
 * Свою роль не меняют: права считаются по ней, поэтому назначить себе роль послабее —
 * та же потеря доступа, что и выключенный вход. Запрет держит база (миграция 0035).
 */
export function canChangeEmployeeRole(employeeId: string, viewerId: string): boolean {
  return employeeId !== viewerId;
}

/**
 * Можно ли менять права этой роли.
 *
 * Свою роль человек не правит: сняв с неё «Изменение сотрудников», он теряет доступ
 * к учётным записям, а матрица прав сохраняется как «удалить все и записать заново» —
 * после первого запроса прав уже нет, и второй не разрешат, роль осталась бы пустой.
 * Запрет держит база (миграция 0035). Название роли правится по-прежнему.
 */
export function canChangeRolePermissions(roleKey: string, viewerRoleKey: string | undefined): boolean {
  return roleKey !== viewerRoleKey;
}

/** Сколько администраторов сейчас могут войти: по этому числу решается запрет выше. */
export function activeAdminCount(employees: readonly DisableCandidate[]): number {
  return employees.filter((employee) => employee.isActive && employee.role === "admin").length;
}
