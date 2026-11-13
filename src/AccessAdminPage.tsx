import React, { useEffect, useMemo, useState, type FormEvent } from "react";
import type { AccessRoleResponse } from "./types.js";
import type { Permission, WorkingRole } from "./domain/access.js";
import { m2Api, type AccessUserRecord } from "./m2-api.js";
import { toTechnicalCode } from "./slug.js";
import { AutoTextarea, Button, CardHeader, ConfirmationDialog, DialogForm, IconButton, PageIntro, PageTabs, ResourceState, StatusBadge, Select, toast } from "./ui.js";

const baseRoleLabels: Readonly<Record<WorkingRole, string>> = {
  admin: "Администратор", coordinator: "Координатор", engineer: "Инженер", warehouse: "Кладовщик",
  initiator: "Инициатор", customer: "Заказчик", supervisor: "Руководитель"
};

const permissionGroupLabels: Readonly<Record<string, string>> = {
  tasks: "Задачи",
  files: "Файлы",
  equipment: "Приборы",
  warehouse: "Склад",
  notifications: "Уведомления",
  finance: "Счета",
  payer: "Плательщик",
  contracts: "Договоры",
  references: "Справочники",
  reports: "Отчёты",
  users: "Сотрудники",
  roles: "Роли",
  notification_settings: "Письма",
  price: "Прайс",
  audit: "Журнал"
};

const permissionLabels: Readonly<Record<Permission, string>> = {
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

type RoleEditor = { readonly mode: "create" } | { readonly mode: "edit"; readonly key: string };
type UserEditor = { readonly mode: "create" } | { readonly mode: "edit"; readonly id: string };
type PendingState = { readonly kind: "role" | "user"; readonly id: string; readonly label: string; readonly isActive: boolean };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Не получилось сохранить";
}

export function AccessAdminPage() {
  const [tab, setTab] = useState<"roles" | "users">("roles");
  const [roles, setRoles] = useState<readonly AccessRoleResponse[]>([]);
  const [permissions, setPermissions] = useState<readonly Permission[]>([]);
  const [users, setUsers] = useState<readonly AccessUserRecord[]>([]);
  const [roleEditor, setRoleEditor] = useState<RoleEditor | null>(null);
  const [userEditor, setUserEditor] = useState<UserEditor | null>(null);
  const [pendingState, setPendingState] = useState<PendingState | null>(null);
  const [rolePermissions, setRolePermissions] = useState<readonly Permission[]>([]);
  const [userRoleKey, setUserRoleKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const editedRole = roleEditor?.mode === "edit" ? roles.find((role) => role.key === roleEditor.key) : undefined;
  const editedUser = userEditor?.mode === "edit" ? users.find((user) => user.id === userEditor.id) : undefined;
  const selectedUserRole = roles.find((role) => role.key === userRoleKey);
  const permissionGroups = useMemo(() => {
    const groups = new Map<string, Permission[]>();
    for (const permission of permissions) {
      const key = permission.split(".", 1)[0] ?? "other";
      groups.set(key, [...(groups.get(key) ?? []), permission]);
    }
    return [...groups.entries()];
  }, [permissions]);

  const load = async () => {
    setLoading(true);
    try {
      const [roleResponse, userResponse] = await Promise.all([m2Api.accessRoles(), m2Api.accessUsers()]);
      setRoles(roleResponse.items); setPermissions(roleResponse.permissions); setUsers(userResponse);
    } catch (loadError) {
      toast.error(errorMessage(loadError), { title: "Список не загрузился" });
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const openRole = (role?: AccessRoleResponse) => {
    setFormError(null);
    setRolePermissions(role?.permissions ?? []);
    setRoleEditor(role ? { mode: "edit", key: role.key } : { mode: "create" });
  };
  const openUser = (user?: AccessUserRecord) => {
    setFormError(null);
    setUserRoleKey(user?.accessRoleKey ?? user?.role ?? roles.find((role) => role.isActive)?.key ?? "");
    setUserEditor(user ? { mode: "edit", id: user.id } : { mode: "create" });
  };
  const togglePermission = (permission: Permission) => setRolePermissions((current) => current.includes(permission)
    ? current.filter((item) => item !== permission) : [...current, permission]);

  const saveRole = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!roleEditor) return;
    const data = new FormData(event.currentTarget);
    setSaving(true); setFormError(null);
    try {
      const input = { name: String(data.get("name") ?? "").trim(), baseRole: String(data.get("baseRole") ?? ""), permissions: rolePermissions };
      if (roleEditor.mode === "create") await m2Api.createAccessRole({ ...input, key: toTechnicalCode(input.name, roles.map((role) => role.key), "role") });
      else await m2Api.updateAccessRole(roleEditor.key, input);
      await load(); setRoleEditor(null);
    } catch (saveError) {
      const message = errorMessage(saveError);
      setFormError(message);
      toast.error(message);
    } finally { setSaving(false); }
  };

  const saveUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!userEditor) return;
    const data = new FormData(event.currentTarget);
    setSaving(true); setFormError(null);
    try {
      const organizationIds = String(data.get("organizationIds") ?? "").split(/[\s,]+/u).map((value) => value.trim()).filter(Boolean);
      const common = {
        fullName: String(data.get("fullName") ?? "").trim(),
        email: String(data.get("email") ?? "").trim(),
        accessRoleKey: userRoleKey,
        // Номер чата отправляем, только если его поменяли в форме: сотрудник мог вписать свой
        // в «Моём профиле» после того, как форма открылась, старое значение его бы затёрло.
        ...((): { telegramChatId?: string } => {
          const telegramChatId = String(data.get("telegramChatId") ?? "").trim();
          return userEditor.mode === "create" || telegramChatId !== (editedUser?.telegramChatId ?? "") ? { telegramChatId } : {};
        })(),
        ...(selectedUserRole ? { role: selectedUserRole.baseRole } : {}),
        ...(selectedUserRole?.baseRole === "customer" ? { organizationIds } : {})
      };
      if (userEditor.mode === "create") await m2Api.createAccessUser({ ...common, password: String(data.get("password") ?? "") });
      else await m2Api.updateAccessUser(userEditor.id, common);
      await load(); setUserEditor(null);
    } catch (saveError) {
      const message = errorMessage(saveError);
      setFormError(message);
      toast.error(message);
    } finally { setSaving(false); }
  };

  const changeState = async () => {
    if (!pendingState) return;
    try {
      if (pendingState.kind === "role") await m2Api.updateAccessRole(pendingState.id, { isActive: !pendingState.isActive });
      else await m2Api.updateAccessUser(pendingState.id, { isActive: !pendingState.isActive });
      await load(); setPendingState(null);
    } catch (stateError) {
      toast.error(errorMessage(stateError));
      throw stateError;
    }
  };

  return <>
    <PageIntro
      actions={tab === "users"
        ? <Button icon="plus" onClick={() => openUser()}>Добавить сотрудника</Button>
        : <Button icon="plus" onClick={() => openRole()}>Добавить роль</Button>}
      description="Кто входит в систему и какие разделы ему открыты."
      title="Сотрудники и роли"
    />
    <PageTabs label="Сотрудники и роли" items={[{ value: "roles", label: "Роли", badge: roles.filter((role) => role.isActive).length }, { value: "users", label: "Сотрудники", badge: users.filter((user) => user.isActive).length }]} onValueChange={setTab} value={tab} />
    {loading && roles.length === 0 ? <ResourceState description="Подождите, сотрудники и роли сейчас появятся." status="loading" title="Загружаем доступ" /> : null}
    {!loading && tab === "roles" ? <section className="card card--table"><CardHeader meta={`Активных: ${roles.filter((role) => role.isActive).length} из ${roles.length}`} title="Роли" />{roles.length === 0 ? <ResourceState description="Добавьте роль, чтобы назначать её сотрудникам." status="empty" title="Ролей пока нет" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Роль</th><th>Тип</th><th>Права</th><th>Статус</th><th aria-label="Действия" /></tr></thead><tbody>{roles.map((role) => <tr key={role.key}><td><strong>{role.name}</strong>{role.builtIn ? <small>системная</small> : null}</td><td>{baseRoleLabels[role.baseRole]}</td><td>{role.permissions.length}</td><td><StatusBadge tone={role.isActive ? "success" : "neutral"}>{role.isActive ? "Активна" : "Неактивна"}</StatusBadge></td><td><div className="table-actions"><IconButton icon="edit" label="Изменить роль" onClick={() => openRole(role)} />{role.key !== "admin" ? <IconButton icon={role.isActive ? "disable" : "enable"} label={role.isActive ? "Отключить" : "Включить"} onClick={() => setPendingState({ kind: "role", id: role.key, label: role.name, isActive: role.isActive })} /> : null}</div></td></tr>)}</tbody></table></div>}</section> : null}
    {!loading && tab === "users" ? <section className="card card--table"><CardHeader meta={`Активных: ${users.filter((user) => user.isActive).length} из ${users.length}`} title="Сотрудники" />{users.length === 0 ? <ResourceState description="Добавьте человека, чтобы он мог войти в систему." status="empty" title="Сотрудников пока нет" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Сотрудник</th><th>E-mail</th><th>Роль</th><th>Статус</th><th aria-label="Действия" /></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><strong>{user.fullName}</strong></td><td>{user.email}</td><td>{roles.find((role) => role.key === (user.accessRoleKey ?? user.role))?.name ?? baseRoleLabels[user.role as WorkingRole] ?? "—"}</td><td><StatusBadge tone={user.isActive ? "success" : "neutral"}>{user.isActive ? "Активен" : "Неактивен"}</StatusBadge></td><td><div className="table-actions"><IconButton icon="edit" label="Изменить" onClick={() => openUser(user)} /><IconButton icon={user.isActive ? "disable" : "enable"} label={user.isActive ? "Отключить" : "Включить"} onClick={() => setPendingState({ kind: "user", id: user.id, label: user.fullName, isActive: user.isActive })} /></div></td></tr>)}</tbody></table></div>}</section> : null}

    <DialogForm busy={saving} description={editedRole ? "Название и права применятся сразу." : "Новая роль появится в списке и её можно будет назначить сотруднику."} error={formError} key={roleEditor?.mode === "edit" ? roleEditor.key : "new-role"} onOpenChange={(open) => { if (!open) { setRoleEditor(null); setFormError(null); } }} onSubmit={saveRole} open={roleEditor !== null} size="lg" submitLabel={editedRole ? "Сохранить роль" : "Создать роль"} title={editedRole ? "Изменить роль" : "Новая роль"}>
      <div className="dialog-form-grid"><label className="dialog-form-grid__wide">Название<input defaultValue={editedRole?.name} name="name" required /></label><label>Тип роли<Select defaultValue={editedRole?.baseRole ?? "coordinator"} disabled={editedRole?.builtIn} name="baseRole">{Object.entries(baseRoleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></label></div>
      <fieldset className="permission-matrix"><legend>Что можно делать</legend>{permissionGroups.map(([group, items]) => <section key={group}><h3>{permissionGroupLabels[group] ?? group}</h3>{items.map((permission) => <label key={permission}><input checked={rolePermissions.includes(permission)} onChange={() => togglePermission(permission)} type="checkbox" /><span>{permissionLabels[permission]}</span></label>)}</section>)}</fieldset>
    </DialogForm>
    <DialogForm busy={saving} description={editedUser ? "Имя, почта и роль обновятся сразу." : "Сотрудник сможет войти с временным паролем и назначенной ролью."} error={formError} key={userEditor?.mode === "edit" ? userEditor.id : "new-user"} onOpenChange={(open) => { if (!open) { setUserEditor(null); setFormError(null); } }} onSubmit={saveUser} open={userEditor !== null} submitLabel={editedUser ? "Сохранить изменения" : "Добавить сотрудника"} title={editedUser ? "Изменить сотрудника" : "Новый сотрудник"}>
      <div className="dialog-form-grid"><label className="dialog-form-grid__wide">ФИО<input defaultValue={editedUser?.fullName} name="fullName" required /></label><label>E-mail<input autoComplete="username" defaultValue={editedUser?.email} name="email" readOnly={Boolean(editedUser)} required title={editedUser ? "Почту для входа сейчас меняют через администратора Supabase" : undefined} type="email" /></label>{!editedUser ? <label>Временный пароль<input autoComplete="new-password" minLength={8} name="password" required type="password" /></label> : null}<label className="dialog-form-grid__wide">Роль<Select onChange={(event) => setUserRoleKey(event.target.value)} required value={userRoleKey}><option value="">Не выбрана</option>{roles.filter((role) => role.isActive || role.key === userRoleKey).map((role) => <option key={role.key} value={role.key}>{role.name}</option>)}</Select></label><label className="dialog-form-grid__wide">Telegram, номер чата<input defaultValue={editedUser?.telegramChatId ?? ""} inputMode="numeric" name="telegramChatId" pattern="-?[0-9]{1,20}" placeholder="Сотрудник пишет боту /start и получает номер" title="Только цифры" /></label>{selectedUserRole?.baseRole === "customer" ? <label className="dialog-form-grid__wide">Организации, каждая с новой строки<AutoTextarea name="organizationIds" required rows={3} /></label> : null}</div>
    </DialogForm>
    <ConfirmationDialog confirmLabel={pendingState?.isActive ? "Отключить" : "Включить"} description={pendingState ? `${pendingState.label}: сразу повлияет на вход и доступ к разделам.` : ""} onConfirm={changeState} onOpenChange={(open) => { if (!open) setPendingState(null); }} open={pendingState !== null} title={pendingState?.isActive ? "Отключить доступ?" : "Включить доступ?"} tone={pendingState?.isActive ? "danger" : "primary"} />
  </>;
}
