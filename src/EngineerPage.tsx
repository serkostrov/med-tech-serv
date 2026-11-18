import React, { useEffect, useMemo, useState } from "react";
import { m2Api, type EngineerOverview, type StockReservationRecord, type TaskApiRecord } from "./m2-api.js";
import { EntityLink, type EngineerPageTab } from "./entity-links.js";
import { TASK_STATUS_LABELS } from "./domain/task-status.js";
import { competencyKey, competencyLabel } from "./engineer-competencies.js";
import { formatDisplayDate } from "./date-format.js";
import { formatRussianCount } from "./equipment-changes.js";
import { Button, EntityDetailToolbar, PageTabs, ResourceState, StatusBadge, toast } from "./ui.js";
import { TaskStageBoard } from "./TaskStageBoard.js";
import { EngineerCalendar } from "./EngineerCalendar.js";

/**
 * Страница инженера (встреча 18.11): «зайти и увидеть всю картину по инженеру» — задачи
 * в работе, запланированные и выполненные, его приборы, компетенции и склад, если он у него есть.
 * Всё ссылками: задача открывает задачу, прибор — карточку прибора, запчасть — её страницу.
 */

/** Группы задач на странице инженера: по этапам, сверху то, что сейчас важнее. */
export const ENGINEER_TASK_GROUPS: ReadonlyArray<{ readonly key: string; readonly title: string; readonly statuses: readonly string[]; readonly empty: string }> = [
  { key: "work", title: "В работе", statuses: ["in_progress"], empty: "Сейчас инженер ничего не делает." },
  { key: "planned", title: "Назначены и запланированы", statuses: ["assigned", "planned", "new"], empty: "Назначенных задач нет." },
  { key: "review", title: "На проверке", statuses: ["under_review"], empty: "На проверке ничего нет." },
  { key: "done", title: "Выполнены", statuses: ["closed"], empty: "Выполненных задач пока нет." }
];

export interface EngineerEquipmentRow {
  readonly equipmentId: string;
  readonly label: string;
  readonly site?: string;
  readonly total: number;
  readonly open: number;
  readonly lastDate?: string;
}

/** Приборы инженера: те, с которыми были его задачи, — сколько задач и когда последняя. */
export function engineerEquipment(tasks: readonly TaskApiRecord[]): EngineerEquipmentRow[] {
  const rows = new Map<string, { label: string; site?: string; total: number; open: number; lastDate?: string }>();
  for (const task of tasks) {
    if (!task.equipmentId || task.status === "cancelled") continue;
    const label = task.equipmentLabel
      ? [task.equipmentLabel.manufacturer, task.equipmentLabel.model, task.equipmentLabel.serialNumber ? `S/N ${task.equipmentLabel.serialNumber}` : undefined].filter(Boolean).join(" ")
      : "Прибор";
    const current = rows.get(task.equipmentId) ?? { label, total: 0, open: 0 };
    const date = task.visitDate ?? task.completedAt ?? task.periodFrom;
    rows.set(task.equipmentId, {
      ...current,
      total: current.total + 1,
      open: current.open + (task.status === "closed" ? 0 : 1),
      ...(date && (!current.lastDate || date > current.lastDate) ? { lastDate: date } : current.lastDate ? { lastDate: current.lastDate } : {})
    });
  }
  return [...rows.entries()]
    .map(([equipmentId, row]) => ({ equipmentId, ...row }))
    .sort((left, right) => right.open - left.open || (right.lastDate ?? "").localeCompare(left.lastDate ?? "") || left.label.localeCompare(right.label, "ru"));
}

/** Запчасти у инженера по позициям: одна строка на запчасть и состояние, сколько и по каким задачам. */
export function engineerStockRows(reservations: readonly StockReservationRecord[]) {
  const rows = new Map<string, { partId: string; articleNumber: string; partName: string; condition: StockReservationRecord["condition"]; quantity: number; tasks: Array<{ id: string; number: string }>; since: string }>();
  for (const item of reservations) {
    const key = `${item.partId}|${item.condition}`;
    const current = rows.get(key) ?? { partId: item.partId, articleNumber: item.articleNumber, partName: item.partName, condition: item.condition, quantity: 0, tasks: [], since: item.updatedAt };
    current.quantity += item.quantity;
    if (item.taskId && item.taskNumber && !current.tasks.some((task) => task.id === item.taskId)) current.tasks.push({ id: item.taskId, number: item.taskNumber });
    if (item.updatedAt < current.since) current.since = item.updatedAt;
    rows.set(key, current);
  }
  return [...rows.values()].sort((left, right) => left.articleNumber.localeCompare(right.articleNumber, "ru"));
}

const CONDITION_LABEL: Readonly<Record<StockReservationRecord["condition"], string>> = { G: "Г · гарантийная", N: "Н · новая", B: "Б · б/у" };
const STATUS_TONE: Readonly<Record<string, "warning" | "info" | "success" | "neutral" | "danger">> = {
  new: "warning", planned: "neutral", assigned: "warning", in_progress: "success", under_review: "info", closed: "neutral", cancelled: "neutral"
};

function equipmentText(task: TaskApiRecord): string {
  if (!task.equipmentLabel) return "—";
  return [task.equipmentLabel.model, task.equipmentLabel.serialNumber ? `S/N ${task.equipmentLabel.serialNumber}` : undefined].filter(Boolean).join(" · ");
}

export function EngineerPage({ engineerId, initialTab = "tasks", onBack, onEdit, refreshKey = 0 }: {
  readonly engineerId: string;
  readonly initialTab?: EngineerPageTab;
  readonly onBack: () => void;
  readonly onEdit?: (engineer: EngineerOverview) => void;
  /** Меняется после сохранения карточки инженера: страница перечитывает данные. */
  readonly refreshKey?: number;
}) {
  const [engineer, setEngineer] = useState<EngineerOverview | null | undefined>(undefined);
  const [tasks, setTasks] = useState<readonly TaskApiRecord[] | null>(null);
  const [tasksTotal, setTasksTotal] = useState(0);
  const [stock, setStock] = useState<readonly StockReservationRecord[] | null>(null);
  const [tab, setTab] = useState<EngineerPageTab>(initialTab);

  useEffect(() => {
    let current = true;
    void m2Api.engineers()
      .then((list) => {
        if (!current) return;
        const found = list.find((item) => item.id === engineerId) ?? null;
        setEngineer(found);
        if (found?.hasOwnStock) {
          void m2Api.engineerStock(engineerId).then((items) => { if (current) setStock(items); }).catch((loadError: unknown) => {
            if (current) setStock([]);
            toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить склад инженера");
          });
        }
      })
      .catch((loadError: unknown) => { if (current) setEngineer(null); toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить инженера"); });
    void m2Api.tasksPage({ engineerId, limit: 300, sort: "deadline_asc" })
      .then((page) => { if (current) { setTasks(page.items); setTasksTotal(page.total); } })
      .catch((loadError: unknown) => { if (current) setTasks([]); toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить задачи инженера"); });
    return () => { current = false; };
  }, [engineerId, refreshKey]);

  const groups = useMemo(() => ENGINEER_TASK_GROUPS.map((group) => {
    const items = (tasks ?? []).filter((task) => group.statuses.includes(task.status));
    // Выполненные — свежие сверху; остальные — по сроку.
    const sorted = group.key === "done"
      ? [...items].sort((left, right) => (right.completedAt ?? right.periodTo ?? "").localeCompare(left.completedAt ?? left.periodTo ?? ""))
      : items;
    return { ...group, items: sorted };
  }), [tasks]);
  const equipment = useMemo(() => engineerEquipment(tasks ?? []), [tasks]);
  const stockRows = useMemo(() => engineerStockRows(stock ?? []), [stock]);

  if (engineer === undefined) return <ResourceState description="Подождите, страница инженера сейчас откроется." status="loading" title="Загружаем инженера" />;
  if (engineer === null) return <>
    <EntityDetailToolbar backLabel="Назад" onBack={onBack} />
    <ResourceState description="Возможно, сотрудник удалён или у вас нет доступа." status="empty" title="Инженер не найден" />
  </>;

  const tabs = [
    { value: "tasks" as const, label: "Задачи", badge: tasks?.filter((task) => task.status !== "cancelled").length ?? 0 },
    // Календарь этого инженера (18.11: «почему в карточке инженера я не вижу его календарь?»).
    { value: "calendar" as const, label: "Календарь" },
    { value: "equipment" as const, label: "Приборы", badge: equipment.length },
    { value: "competencies" as const, label: "Компетенции", badge: engineer.competencies.length },
    ...(engineer.hasOwnStock ? [{ value: "stock" as const, label: "Склад", badge: stockRows.length }] : [])
  ];
  const shownTab = tabs.some((item) => item.value === tab) ? tab : "tasks";

  return <div className="engineer-page">
    <EntityDetailToolbar backLabel="Назад" onBack={onBack} />
    <header className="task-head">
      <div className="task-head__meta">
        <span className="task-head__number">Инженер</span>
        <StatusBadge tone={!engineer.isActive ? "neutral" : engineer.overdueTaskCount ? "danger" : engineer.inProgressTaskCount ? "info" : "success"}>{!engineer.isActive ? "Неактивен" : engineer.overdueTaskCount ? "Есть просрочки" : engineer.inProgressTaskCount ? "На выезде" : "Свободен"}</StatusBadge>
        {engineer.hasOwnStock ? <StatusBadge tone="info">Свой склад</StatusBadge> : null}
      </div>
      <h1>{engineer.fullName}</h1>
      {onEdit ? <div className="engineer-page__actions"><Button icon="edit" onClick={() => onEdit(engineer)} variant="secondary">Изменить карточку</Button></div> : null}
    </header>
    <PageTabs items={tabs} label="Разделы страницы инженера" onValueChange={setTab} value={shownTab} />

    {shownTab === "tasks" ? (tasks === null
      ? <ResourceState description="Подождите, задачи инженера сейчас появятся." status="loading" title="Загружаем задачи" />
      : <TaskStageBoard label={`Задачи инженера ${engineer.fullName}`} show={{}} tasks={tasks.filter((task) => task.status !== "cancelled")} />) : null}

    {shownTab === "calendar" ? <EngineerCalendar engineerId={engineer.id} key={engineer.id} /> : null}

    {shownTab === "equipment" ? <section className="task-section" aria-labelledby="engineer-equipment-title">
      <header className="task-section__head"><h3 id="engineer-equipment-title">Приборы инженера</h3></header>
      {tasks === null ? <ResourceState description="Подождите." status="loading" title="Загружаем приборы" /> : equipment.length === 0 ? <div className="task-section__empty"><p>Задач с приборами у инженера пока не было.</p></div> : <div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">Прибор</th><th className="numeric" scope="col">Задач всего</th><th className="numeric" scope="col">Открытых</th><th scope="col">Последний раз</th></tr></thead><tbody>
        {equipment.map((row) => <tr key={row.equipmentId}><td><EntityLink target={{ kind: "equipment", id: row.equipmentId }}>{row.label}</EntityLink></td><td className="numeric">{row.total}</td><td className="numeric">{row.open || "—"}</td><td>{formatDisplayDate(row.lastDate) || "—"}</td></tr>)}
      </tbody></table></div>}
    </section> : null}

    {shownTab === "competencies" ? <section className="task-section" aria-labelledby="engineer-competencies-title">
      <header className="task-section__head"><h3 id="engineer-competencies-title">Компетенции</h3>{onEdit ? <Button onClick={() => onEdit(engineer)} variant="ghost">Изменить</Button> : null}</header>
      {engineer.competencies.length === 0 ? <div className="task-section__empty"><p>Компетенции не указаны. По ним система подсказывает, кого назначить на прибор.</p></div> : <>
        <ul aria-label={`Компетенции: ${engineer.fullName}`} className="competency-tags">{engineer.competencies.map((item, index) => <li className="tag" key={`${competencyKey(item)}-${index}`}>{competencyLabel(item)}</li>)}</ul>
        
      </>}
    </section> : null}

    {shownTab === "stock" && engineer.hasOwnStock ? <section className="task-section" aria-labelledby="engineer-stock-title">
      <header className="task-section__head"><h3 id="engineer-stock-title">Склад инженера</h3></header>
      {stock === null ? <ResourceState description="Подождите." status="loading" title="Загружаем склад" /> : stockRows.length === 0 ? <div className="task-section__empty"><p>Сейчас у инженера запчастей нет. Они появятся здесь, когда склад выдаст их по резерву.</p></div> : <div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">Запчасть</th><th scope="col">Состояние</th><th className="numeric" scope="col">Количество</th><th scope="col">Для задач</th><th scope="col">У инженера с</th></tr></thead><tbody>
        {stockRows.map((row) => <tr key={`${row.partId}-${row.condition}`}>
          <td><EntityLink target={{ kind: "part", id: row.partId }}><span className="engineer-page__number">{row.articleNumber}</span> {row.partName}</EntityLink></td>
          <td>{CONDITION_LABEL[row.condition]}</td>
          <td className="numeric">{row.quantity.toLocaleString("ru-RU")}</td>
          <td>{row.tasks.length ? row.tasks.map((task, index) => <React.Fragment key={task.id}>{index ? ", " : null}<EntityLink target={{ kind: "task", id: task.id }}>{task.number}</EntityLink></React.Fragment>) : "—"}</td>
          <td>{formatDisplayDate(row.since)}</td>
        </tr>)}
      </tbody></table></div>}
    </section> : null}
  </div>;
}
