import React from "react";
import type { TaskApiRecord } from "./m2-api.js";
import { StatusBoard, localStatusPage, type StatusBoardColumn } from "./StatusBoard.js";
import { useEntityNav } from "./entity-links.js";
import { formatDisplayDate } from "./date-format.js";

/**
 * Задачи инженера или клиента доской по этапам (18.11: «пускай задачи у него будут в виде
 * канбан-доски — что в работе, назначено, на проверке, выполнено»). Цвета колонок те же,
 * что на доске задач. Карточка открывает задачу.
 */
const STAGES: readonly StatusBoardColumn[] = [
  { key: "planned", title: "Запланирована", color: "var(--stage-planned)" },
  { key: "new", title: "Новая", color: "var(--stage-new)" },
  { key: "assigned", title: "Назначена", color: "var(--stage-assigned)" },
  { key: "in_progress", title: "В работе", color: "var(--stage-in_progress)" },
  { key: "under_review", title: "На проверке", color: "var(--stage-under_review)" },
  { key: "closed", title: "Выполнена", color: "var(--stage-closed)" },
  { key: "cancelled", title: "Отменена", color: "var(--stage-cancelled)" }
];

/** Закрытые и отменённые — завершённые задачи: по умолчанию их не показываем ни в одном списке задач. */
export function isOpenTask(task: Pick<TaskApiRecord, "status">): boolean {
  return task.status !== "closed" && task.status !== "cancelled";
}

/**
 * Переключатель «Закрытые и отменённые», как на доске задач (встреча 19.11: «в карточке прибора все задачи —
 * только активные, а закрытые и отменённые — когда включили тумблер»). Один вид во всех списках задач.
 */
export function CompletedTasksToggle({ value, onChange }: { readonly value: boolean; readonly onChange: (next: boolean) => void }) {
  return <button aria-pressed={value} className={`toggle-chip${value ? " toggle-chip--on" : ""}`} onClick={() => onChange(!value)} type="button">Закрытые и отменённые</button>;
}

/**
 * Колонки доски: основные этапы всегда, «Запланирована» и «Новая» — если в них есть задачи.
 * «Выполнена» и «Отменена» — только с переключателем «Закрытые и отменённые».
 */
export function taskStageColumns(tasks: readonly TaskApiRecord[], showCompleted = false): readonly StatusBoardColumn[] {
  const always = new Set(["assigned", "in_progress", "under_review", ...(showCompleted ? ["closed"] : [])]);
  return STAGES.filter((stage) => (showCompleted || (stage.key !== "closed" && stage.key !== "cancelled"))
    && (always.has(stage.key) || tasks.some((task) => task.status === stage.key)));
}

export function TaskStageBoard({ tasks, label, show, onOpen, showCompleted = false }: {
  readonly tasks: readonly TaskApiRecord[];
  /** Колонки «Выполнена» и «Отменена» (переключатель «Закрытые и отменённые» над доской). */
  readonly showCompleted?: boolean;
  readonly label: string;
  /** Своё открытие карточки (у инициатора — его карточка заявки); по умолчанию — задача по ссылке. */
  readonly onOpen?: (task: TaskApiRecord) => void;
  /** Что писать под названием: прибор (на странице инженера и клиента) и инженера (у клиента). */
  readonly show: { readonly engineer?: boolean };
}) {
  const nav = useEntityNav();
  const shown = showCompleted ? tasks : tasks.filter(isOpenTask);
  const sorted = [...shown].sort((left, right) => left.status === "closed" && right.status === "closed"
    ? (right.completedAt ?? "").localeCompare(left.completedAt ?? "")
    : (left.periodTo ?? "9999").localeCompare(right.periodTo ?? "9999"));
  return <StatusBoard<TaskApiRecord>
    columns={taskStageColumns(shown, showCompleted)}
    emptyText="Пусто"
    itemKey={(task) => task.id}
    label={label}
    load={async (status, offset, limit) => localStatusPage(sorted, (task) => task.status === status, offset, limit)}
    onOpen={(task) => onOpen ? onOpen(task) : nav?.open({ kind: "task", id: task.id })}
    queryKey={shown.map((task) => `${task.id}:${task.status}`).join(",")}
    renderCard={(task) => <>
      <span className="task-board-card__top">{task.number}{task.priority === "urgent" ? <i>Срочно</i> : null}</span>
      <strong>{task.title}</strong>
      <small>{[task.equipmentLabel ? `${task.equipmentLabel.model ?? "Прибор"} · ${task.equipmentLabel.serialNumber}` : null, show.engineer ? task.engineerName ?? "Не назначен" : null].filter(Boolean).join(" · ")}</small>
      <span className="task-board-card__foot">
        <span className={`task-board-card__due${task.isOverdue ? " task-board-card__due--late" : ""}`}>{task.status === "closed" ? formatDisplayDate(task.completedAt ?? task.visitDate) || "выполнена" : task.isOverdue ? "просрочена" : task.periodTo ? `до ${formatDisplayDate(task.periodTo)}` : "без срока"}</span>
      </span>
    </>}
  />;
}
