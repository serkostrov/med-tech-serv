import React, { useEffect, useMemo, useState, type FormEvent } from "react";
import type { AccessRoleResponse } from "./types.js";
import { PERMISSION_LABELS, type Permission, type WorkingRole } from "./domain/access.js";
import { activeAdminCount, canChangeEmployeeRole, canChangeRolePermissions, employeeDisableBlock, initialEmployeeRoleKey, permissionsForBaseRole, roleDisableText } from "./access-admin.js";
import { m2Api, type AccessUserRecord } from "./m2-api.js";
import { RegistryPagination, usePageSize } from "./RegistryPagination.js";
import { NotificationChannelsField } from "./NotificationChannels.js";
import { changedPreferences, preferenceMatrix, type NotificationPreferenceMatrix } from "./notification-channels.js";
import { toTechnicalCode } from "./slug.js";
import { AutoTextarea, Button, ConfirmationDialog, DialogForm, EntityDetailToolbar, IconButton, PageIntro, PageTabs, ResourceState, StatusBadge, Select, toast } from "./ui.js";

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

const permissionLabels = PERMISSION_LABELS;

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
  const { pageSize: usersPageSize, setPageSize: setUsersPageSize } = usePageSize("staff");
  const [usersPageIndex, setUsersPageIndex] = useState(0);
  // Кто смотрит список: себе вход не отключают, и кнопки «Отключить» у своей строки нет.
  const [viewerId, setViewerId] = useState("");
  // Роль, по которой считаются права самого вошедшего: её он не правит и не отключает.
  const [viewerRoleKey, setViewerRoleKey] = useState<string | undefined>(undefined);
  const [roleEditor, setRoleEditor] = useState<RoleEditor | null>(null);
  const [userEditor, setUserEditor] = useState<UserEditor | null>(null);
  const [pendingState, setPendingState] = useState<PendingState | null>(null);
  const [rolePermissions, setRolePermissions] = useState<readonly Permission[]>([]);
  // Тип роли в окне: от него подставляются права новой роли. Подробная сетка прав — по кнопке.
  const [roleBase, setRoleBase] = useState<string>("coordinator");
  const [userRoleKey, setUserRoleKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const editedRole = roleEditor?.mode === "edit" ? roles.find((role) => role.key === roleEditor.key) : undefined;
  const editedUser = userEditor?.mode === "edit" ? users.find((user) => user.id === userEditor.id) : undefined;
  // Каналы уведомлений сотрудника (ТЗ, блок 5): грузим при открытии карточки, сохраняем вместе с ней.
  const [userChannels, setUserChannels] = useState<{ readonly userId: string; readonly initial: NotificationPreferenceMatrix; readonly current: NotificationPreferenceMatrix } | null>(null);
  useEffect(() => {
    setUserChannels(null);
    if (userEditor?.mode !== "edit") return undefined;
    let alive = true;
    const userId = userEditor.id;
    m2Api.notificationPreferences(userId)
      .then((rows) => { if (alive) { const matrix = preferenceMatrix(rows); setUserChannels({ userId, initial: matrix, current: matrix }); } })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [userEditor]);
  const selectedUserRole = roles.find((role) => role.key === userRoleKey);
  // Сотрудники постранично (18.11), как письма и инженеры.
  const usersPageShown = Math.min(usersPageIndex, Math.max(0, Math.ceil(users.length / usersPageSize) - 1));
  const usersPage = users.slice(usersPageShown * usersPageSize, (usersPageShown + 1) * usersPageSize);
  const adminCount = activeAdminCount(users.map((user) => ({ id: user.id, isActive: user.isActive, role: user.role })));
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
      const [roleResponse, userResponse, session] = await Promise.all([m2Api.accessRoles(), m2Api.accessUsers(), m2Api.session()]);
      setRoles(roleResponse.items); setPermissions(roleResponse.permissions); setUsers(userResponse); setViewerId(session.id); setViewerRoleKey(session.accessRoleKey ?? session.role);
    } catch (loadError) {
      toast.error(errorMessage(loadError), { title: "Список не загрузился" });
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const openRole = (role?: AccessRoleResponse) => {
    setFormError(null);
    setRoleBase(role?.baseRole ?? "coordinator");
    // Новая роль сразу получает права встроенной роли своего типа: пустая роль ничего не увидит.
    setRolePermissions(role?.permissions ?? permissionsForBaseRole(roles, "coordinator"));
    setRoleEditor(role ? { mode: "edit", key: role.key } : { mode: "create" });
  };
  const openUser = (user?: AccessUserRecord) => {
    setFormError(null);
    // Роль нового сотрудника не подставляем: раньше здесь оказывался «Главный администратор».
    setUserRoleKey(initialEmployeeRoleKey(user));
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
      if (userEditor.mode === "create") {
        const created = await m2Api.createAccessUser({ ...common, password: String(data.get("password") ?? "") });
        // Встреча 18.11: «когда инженера создаём — отмечаем галочку, есть у него склад или нет».
        if (selectedUserRole?.baseRole === "engineer" && data.get("hasOwnStock") === "on") await m2Api.updateEngineer(created.id, { hasOwnStock: true });
      }
      else {
        await m2Api.updateAccessUser(userEditor.id, common);
        if (userChannels?.userId === userEditor.id) await m2Api.saveNotificationPreferences(userEditor.id, changedPreferences(userChannels.initial, userChannels.current));
      }
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

  // Роль — своей страницей, а не окном (вторая встреча 18.11: «в попапе неудобно»): название
  // и тип сверху, все права сразу галочками по разделам, «Сохранить» справа сверху.
  if (roleEditor !== null) return <form className="role-page" key={roleEditor.mode === "edit" ? roleEditor.key : "new-role"} onSubmit={saveRole}>
    <EntityDetailToolbar actions={<Button busy={saving} type="submit">{editedRole ? "Сохранить роль" : "Создать роль"}</Button>} backLabel="К ролям" onBack={() => { setRoleEditor(null); setFormError(null); }} />
    <header className="task-head"><h1>{editedRole ? editedRole.name : "Новая роль"}</h1></header>
    {formError ? <div className="form-error" role="alert">{formError}</div> : null}
    <section className="card role-page__card">
      <div className="dialog-form role-page__fields"><label>Название<input defaultValue={editedRole?.name} name="name" required /></label><label>Тип роли<Select disabled={editedRole?.builtIn} name="baseRole" onChange={(event) => { const next = event.target.value; setRoleBase(next); if (!editedRole) setRolePermissions(permissionsForBaseRole(roles, next)); }} value={roleBase}>{Object.entries(baseRoleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>{!editedRole ? <small>Права подставятся как у роли «{baseRoleLabels[roleBase as WorkingRole] ?? roleBase}»</small> : null}</label></div>
      {editedRole && !editedRole.builtIn && canChangeRolePermissions(editedRole.key, viewerRoleKey) ? <div className="role-page__reset"><Button onClick={() => setRolePermissions(permissionsForBaseRole(roles, roleBase))} variant="ghost">Вернуть права типа роли</Button></div> : null}
    </section>
    <section className="card role-page__card">
      <fieldset className="permission-matrix" disabled={editedRole ? !canChangeRolePermissions(editedRole.key, viewerRoleKey) : false}><legend>Что можно делать</legend>{editedRole && !canChangeRolePermissions(editedRole.key, viewerRoleKey) ? <p className="dialog-form-grid__wide">Права своей роли менять нельзя: так можно остаться без доступа к системе. Попросите другого администратора.</p> : null}{permissionGroups.map(([group, items]) => <section key={group}><h3>{permissionGroupLabels[group] ?? group}</h3>{items.map((permission) => <label key={permission}><input checked={rolePermissions.includes(permission)} onChange={() => togglePermission(permission)} type="checkbox" /><span>{permissionLabels[permission]}</span></label>)}</section>)}</fieldset>
    </section>
  </form>;

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
    {!loading && tab === "roles" ? <section aria-label="Роли" className="card card--table">{roles.length === 0 ? <ResourceState description="Добавьте роль, чтобы назначать её сотрудникам." status="empty" title="Ролей пока нет" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Роль</th><th>Тип</th><th>Права</th><th>Статус</th><th aria-label="Действия" /></tr></thead><tbody>{roles.map((role) => <tr key={role.key}><td><button className="entity-link" onClick={() => openRole(role)} title="Открыть роль" type="button"><strong>{role.name}</strong></button>{role.key === viewerRoleKey ? <small>ваша роль</small> : null}{role.builtIn ? <small>системная</small> : null}</td><td>{baseRoleLabels[role.baseRole]}</td><td>{role.permissions.length}</td><td>{role.isActive ? null : <StatusBadge tone="neutral">Отключена</StatusBadge>}</td><td><div className="table-actions"><IconButton icon="edit" label="Изменить роль" onClick={() => openRole(role)} />{role.key !== "admin" && canChangeRolePermissions(role.key, viewerRoleKey) ? <IconButton icon={role.isActive ? "disable" : "enable"} label={role.isActive ? "Отключить" : "Включить"} onClick={() => setPendingState({ kind: "role", id: role.key, label: role.name, isActive: role.isActive })} /> : null}</div></td></tr>)}</tbody></table></div>}</section> : null}
    {!loading && tab === "users" ? <section aria-label="Сотрудники" className="card card--table">{users.length === 0 ? <ResourceState description="Добавьте человека, чтобы он мог войти в систему." status="empty" title="Сотрудников пока нет" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Сотрудник</th><th>E-mail</th><th>Роль</th><th>Статус</th><th aria-label="Действия" /></tr></thead><tbody>{usersPage.map((user) => {
      // Запрет держит база (миграция 0035); здесь о нём говорят до подтверждения, а не после.
      const disableBlock = employeeDisableBlock(user, { id: viewerId, activeAdminCount: adminCount });
      return <tr key={user.id}><td><strong>{user.fullName}</strong>{disableBlock ? <small title={disableBlock.reason}>{disableBlock.note}</small> : null}</td><td>{user.email}</td><td>{roles.find((role) => role.key === (user.accessRoleKey ?? user.role))?.name ?? baseRoleLabels[user.role as WorkingRole] ?? "—"}</td><td>{user.isActive ? null : <StatusBadge tone="neutral">Отключён</StatusBadge>}</td><td><div className="table-actions"><IconButton icon="edit" label="Изменить" onClick={() => openUser(user)} />{disableBlock ? null : <IconButton icon={user.isActive ? "disable" : "enable"} label={user.isActive ? "Отключить" : "Включить"} onClick={() => setPendingState({ kind: "user", id: user.id, label: user.fullName, isActive: user.isActive })} />}</div></td></tr>;
    })}</tbody></table></div>}{users.length ? <RegistryPagination alwaysShow ariaLabel="Страницы сотрудников" onPageChange={setUsersPageIndex} onPageSizeChange={(size) => { setUsersPageSize(size); setUsersPageIndex(0); }} pageIndex={usersPageShown} pageSize={usersPageSize} total={users.length} /> : null}</section> : null}

    <DialogForm busy={saving} description={editedUser ? "Имя, почта и роль обновятся сразу." : "Сотрудник сможет войти с временным паролем и назначенной ролью."} error={formError} key={userEditor?.mode === "edit" ? userEditor.id : "new-user"} onOpenChange={(open) => { if (!open) { setUserEditor(null); setFormError(null); } }} onSubmit={saveUser} open={userEditor !== null} submitLabel={editedUser ? "Сохранить изменения" : "Добавить сотрудника"} title={editedUser ? "Изменить сотрудника" : "Новый сотрудник"}>
      <div className="dialog-form-grid"><label className="dialog-form-grid__wide">ФИО<input defaultValue={editedUser?.fullName} name="fullName" required /></label><label>E-mail<input autoComplete="username" defaultValue={editedUser?.email} name="email" readOnly={Boolean(editedUser)} required title={editedUser ? "Почту для входа сейчас меняют через администратора Supabase" : undefined} type="email" /></label>{!editedUser ? <label>Временный пароль<input autoComplete="new-password" minLength={8} name="password" required type="password" /></label> : null}<label className="dialog-form-grid__wide">Роль<Select disabled={editedUser ? !canChangeEmployeeRole(editedUser.id, viewerId) : false} onChange={(event) => setUserRoleKey(event.target.value)} required title={editedUser && !canChangeEmployeeRole(editedUser.id, viewerId) ? "Себе роль менять нельзя: так можно остаться без нужных прав. Попросите другого администратора" : undefined} value={userRoleKey}><option value="">Не выбрана</option>{roles.filter((role) => role.isActive || role.key === userRoleKey).map((role) => <option key={role.key} value={role.key}>{role.name}</option>)}</Select>{editedUser && !canChangeEmployeeRole(editedUser.id, viewerId) ? <small>Себе роль менять нельзя: попросите другого администратора</small> : null}</label><label className="dialog-form-grid__wide">Telegram, номер чата<input defaultValue={editedUser?.telegramChatId ?? ""} inputMode="numeric" name="telegramChatId" pattern="-?[0-9]{1,20}" placeholder="Сотрудник пишет боту /start и получает номер" title="Только цифры" /></label>{selectedUserRole?.baseRole === "customer" ? <label className="dialog-form-grid__wide">Организации, каждая с новой строки<AutoTextarea name="organizationIds" required rows={3} /></label> : null}{selectedUserRole?.baseRole === "engineer" && !editedUser
        ? <label className="field-check dialog-form-grid__wide engineer-own-stock"><input name="hasOwnStock" type="checkbox" /><span><strong>Есть свой склад</strong></span></label> : null}</div>
      {editedUser && userChannels ? <NotificationChannelsField matrix={userChannels.current} onChange={(current) => setUserChannels((state) => (state ? { ...state, current } : state))} role={selectedUserRole?.baseRole ?? editedUser.role} telegramLinked={Boolean(editedUser.telegramChatId)} /> : null}
    </DialogForm>
    <ConfirmationDialog confirmLabel={pendingState?.isActive ? "Отключить" : "Включить"} description={pendingState ? (pendingState.kind === "role" && pendingState.isActive ? roleDisableText(pendingState.label, pendingState.id, users) : `${pendingState.label}: сразу повлияет на вход и доступ к разделам.`) : ""} onConfirm={changeState} onOpenChange={(open) => { if (!open) setPendingState(null); }} open={pendingState !== null} title={pendingState?.isActive ? "Отключить доступ?" : "Включить доступ?"} tone={pendingState?.isActive ? "danger" : "primary"} />
  </>;
}
