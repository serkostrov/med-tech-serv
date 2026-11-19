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
  { key: "planned", title: "Запланирована", color: "#8a9aa3" },
  { key: "new", title: "Новая", color: "#e07a2e" },
  { key: "assigned", title: "Назначена", color: "#d4a017" },
  { key: "in_progress", title: "В работе", color: "#1f8a52" },
  { key: "under_review", title: "На проверке", color: "#2f86c4" },
  { key: "closed", title: "Выполнена", color: "#b42332" },
  { key: "cancelled", title: "Отменена", color: "#8a9aa3" }
];

/** Колонки доски: основные этапы всегда, «Запланирована», «Новая» и «Отменена» — если в них есть задачи. */
export function taskStageColumns(tasks: readonly TaskApiRecord[]): readonly StatusBoardColumn[] {
  const always = new Set(["assigned", "in_progress", "under_review", "closed"]);
  return STAGES.filter((stage) => always.has(stage.key) || tasks.some((task) => task.status === stage.key));
}

export function TaskStageBoard({ tasks, label, show, onOpen }: {
  readonly tasks: readonly TaskApiRecord[];
  readonly label: string;
  /** Своё открытие карточки (у инициатора — его карточка заявки); по умолчанию — задача по ссылке. */
  readonly onOpen?: (task: TaskApiRecord) => void;
  /** Что писать под названием: прибор (на странице инженера и клиента) и инженера (у клиента). */
  readonly show: { readonly engineer?: boolean };
}) {
  const nav = useEntityNav();
  const sorted = [...tasks].sort((left, right) => left.status === "closed" && right.status === "closed"
    ? (right.completedAt ?? "").localeCompare(left.completedAt ?? "")
    : (left.periodTo ?? "9999").localeCompare(right.periodTo ?? "9999"));
  return <StatusBoard<TaskApiRecord>
    columns={taskStageColumns(tasks)}
    emptyText="Пусто"
    itemKey={(task) => task.id}
    label={label}
    load={async (status, offset, limit) => localStatusPage(sorted, (task) => task.status === status, offset, limit)}
    onOpen={(task) => onOpen ? onOpen(task) : nav?.open({ kind: "task", id: task.id })}
    queryKey={tasks.map((task) => `${task.id}:${task.status}`).join(",")}
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
