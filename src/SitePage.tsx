import React, { useEffect, useMemo, useState } from "react";
import { m2Api, type EquipmentApiRecord, type TaskApiRecord } from "./m2-api.js";
import type { SiteOption } from "./customer-selection.js";
import { EntityLink } from "./entity-links.js";
import { TASK_STATUS_LABELS } from "./domain/task-status.js";
import { formatDisplayDate } from "./date-format.js";
import { formatRussianCount } from "./equipment-changes.js";
import { formatSitePersonDetails, sitePeople } from "./site-people.js";
import { EntityDetailToolbar, PageTabs, ResourceState, StatusBadge, toast } from "./ui.js";
import { TaskStageBoard } from "./TaskStageBoard.js";

/**
 * Страница клиента — площадки (встреча 18.11: «зашли и видим всё: её заказы, все её контакты,
 * все приборы»). Задачи по площадке, приборы на ней, люди с телефонами и реквизитами.
 * Открывается по названию площадки в задаче, в списке задач, в карточке прибора и в «Клиентах».
 */
export type SitePageTab = "tasks" | "equipment" | "people";

const OPEN_STATUSES = new Set(["planned", "new", "assigned", "in_progress", "under_review"]);
const STATUS_TONE: Readonly<Record<string, "warning" | "info" | "success" | "neutral" | "danger">> = {
  new: "warning", planned: "neutral", assigned: "warning", in_progress: "success", under_review: "info", closed: "neutral", cancelled: "neutral"
};

/** Задачи площадки: открытые сверху по сроку, закрытые ниже — свежие первыми. */
export function siteTaskGroups(tasks: readonly TaskApiRecord[]) {
  const open = tasks.filter((task) => OPEN_STATUSES.has(task.status))
    .sort((left, right) => (left.periodTo ?? "9999").localeCompare(right.periodTo ?? "9999"));
  const closed = tasks.filter((task) => !OPEN_STATUSES.has(task.status) && task.status !== "cancelled")
    .sort((left, right) => (right.completedAt ?? right.periodTo ?? "").localeCompare(left.completedAt ?? left.periodTo ?? ""));
  return { open, closed };
}

function equipmentText(task: TaskApiRecord): string {
  if (!task.equipmentLabel) return "Прибор";
  return [task.equipmentLabel.model, task.equipmentLabel.serialNumber ? `S/N ${task.equipmentLabel.serialNumber}` : undefined].filter(Boolean).join(" · ");
}

function TaskRows({ tasks, done }: { readonly tasks: readonly TaskApiRecord[]; readonly done: boolean }) {
  return <div className="table-scroll"><table className="data-table engineer-page__table"><thead><tr><th scope="col">Задача</th><th scope="col">Прибор</th><th scope="col">Инженер</th><th scope="col">{done ? "Выполнена" : "Срок"}</th><th scope="col">Этап</th></tr></thead><tbody>
    {tasks.map((task) => <tr key={task.id}>
      <td><EntityLink className="engineer-page__task" target={{ kind: "task", id: task.id }}><span className="engineer-page__number">{task.number}</span><strong>{task.title}</strong></EntityLink></td>
      <td>{task.equipmentId ? <EntityLink target={{ kind: "equipment", id: task.equipmentId }}>{equipmentText(task)}</EntityLink> : "—"}</td>
      <td>{task.engineerId ? <EntityLink target={{ kind: "engineer", id: task.engineerId }}>{task.engineerName ?? "Инженер"}</EntityLink> : <span className="muted">не назначен</span>}</td>
      <td className="cell-date">{done ? formatDisplayDate(task.completedAt ?? task.visitDate) || "—" : <>{task.periodTo ? `до ${formatDisplayDate(task.periodTo)}` : "—"}{task.isOverdue ? <small className="danger-text"> · просрочена</small> : null}</>}</td>
      <td><StatusBadge tone={STATUS_TONE[task.status] ?? "neutral"}>{TASK_STATUS_LABELS[task.status] ?? task.status}</StatusBadge></td>
    </tr>)}
  </tbody></table></div>;
}

export function SitePage({ siteId, initialTab = "tasks", onBack }: {
  readonly siteId: string;
  readonly initialTab?: SitePageTab;
  readonly onBack: () => void;
}) {
  const [site, setSite] = useState<SiteOption | null | undefined>(undefined);
  const [tasks, setTasks] = useState<readonly TaskApiRecord[] | null>(null);
  const [tasksTotal, setTasksTotal] = useState(0);
  const [equipment, setEquipment] = useState<readonly EquipmentApiRecord[] | null>(null);
  const [equipmentTotal, setEquipmentTotal] = useState(0);
  const [tab, setTab] = useState<SitePageTab>(initialTab);

  useEffect(() => {
    let current = true;
    void m2Api.listSites(true)
      .then((sites) => { if (current) setSite(sites.find((item) => item.id === siteId) ?? null); })
      .catch((loadError: unknown) => { if (current) setSite(null); toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить клиента"); });
    void m2Api.tasksPage({ siteId, limit: 300, sort: "updated_desc" })
      .then((page) => { if (current) { setTasks(page.items); setTasksTotal(page.total); } })
      .catch((loadError: unknown) => { if (current) setTasks([]); toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить задачи клиента"); });
    void m2Api.equipmentPage({ site: siteId, limit: 200 })
      .then((page) => { if (current) { setEquipment(page.items); setEquipmentTotal(page.total); } })
      .catch((loadError: unknown) => { if (current) setEquipment([]); toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить приборы клиента"); });
    return () => { current = false; };
  }, [siteId]);

  const groups = useMemo(() => siteTaskGroups(tasks ?? []), [tasks]);
  const people = useMemo(() => site ? sitePeople(site) : [], [site]);

  if (site === undefined) return <ResourceState description="Подождите, страница клиента сейчас откроется." status="loading" title="Загружаем клиента" />;
  if (site === null) return <>
    <EntityDetailToolbar backLabel="Назад" onBack={onBack} />
    <ResourceState description="Возможно, площадку удалили или у вас нет к ней доступа." status="empty" title="Клиент не найден" />
  </>;

  const tabs = [
    { value: "tasks" as const, label: "Заявки", badge: groups.open.length + groups.closed.length },
    { value: "equipment" as const, label: "Приборы", badge: equipmentTotal },
    { value: "people" as const, label: "Люди и реквизиты", badge: people.filter((person) => person.isActive).length }
  ];
  return <div className="engineer-page site-page">
    <EntityDetailToolbar backLabel="Назад" onBack={onBack} />
    <header className="task-head">
      <div className="task-head__meta">
        <span className="task-head__number">Клиент</span>
        <StatusBadge tone="info">{site.type === "medical_facility" ? "Медучреждение" : "Компания группы"}</StatusBadge>
        {site.isActive ? null : <StatusBadge tone="neutral">Отключена</StatusBadge>}
      </div>
      <h1>{site.name}</h1>
      <p>{site.address || "Адрес не указан"}{site.notes ? ` · ${site.notes}` : ""}</p>
    </header>
    <PageTabs items={tabs} label="Разделы страницы клиента" onValueChange={setTab} value={tab} />

    {tab === "tasks" ? (tasks === null
      ? <ResourceState description="Подождите." status="loading" title="Загружаем заявки" />
      : <TaskStageBoard label={`Заявки клиента ${site.name}`} show={{ engineer: true }} tasks={tasks.filter((task) => task.status !== "cancelled")} />) : null}

    {tab === "equipment" ? <section className="task-section" aria-labelledby="site-equipment">
      <header className="task-section__head"><h3 id="site-equipment">Приборы на площадке</h3><span className="muted">{formatRussianCount(equipmentTotal, ["прибор", "прибора", "приборов"])}</span></header>
      {equipment === null ? <ResourceState description="Подождите." status="loading" title="Загружаем приборы" /> : equipment.length === 0 ? <div className="task-section__empty"><p>Приборов на этой площадке нет.</p></div> : <div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">Прибор</th><th scope="col">S/N</th><th scope="col">Статус</th><th scope="col">Плательщик</th></tr></thead><tbody>
        {equipment.map((device) => <tr key={device.id}>
          <td><EntityLink target={{ kind: "equipment", id: device.id }}>{[device.manufacturer, device.model].filter(Boolean).join(" ")}</EntityLink></td>
          <td>{device.serialNumber}</td>
          <td>{device.statusName ?? device.status}</td>
          <td>{device.payer ?? "—"}</td>
        </tr>)}
      </tbody></table></div>}
    </section> : null}

    {tab === "people" ? <section className="task-section" aria-labelledby="site-people">
      <header className="task-section__head"><h3 id="site-people">Люди и реквизиты</h3><span className="muted">меняются в разделе «Клиенты»</span></header>
      {people.length === 0 ? <div className="task-section__empty"><p>Людей у площадки пока нет.</p></div> : <ul className="site-page__people">
        {people.map((person) => <li className={person.isActive ? undefined : "is-inactive"} key={person.key}>
          <strong>{person.fullName}{person.isPrimary ? <small> · основной контакт</small> : null}{person.isActive ? null : <small> · отключён</small>}</strong>
          <span>{formatSitePersonDetails(person)}</span>
        </li>)}
      </ul>}
    </section> : null}
  </div>;
}
