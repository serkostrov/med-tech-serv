import type { WorkingRole } from "./access.js";

export const TASK_STATUSES = [
  "planned",
  "new",
  "assigned",
  "in_progress",
  "under_review",
  "closed",
  "cancelled"
] as const;

export const TASK_STATUS_LABELS: Readonly<Record<string, string>> = {
  planned: "Запланирована",
  new: "Новая",
  assigned: "Назначена",
  in_progress: "В работе",
  under_review: "На проверке",
  closed: "Закрыта",
  cancelled: "Отменена"
};

export type TaskStatus = string;

export const TASK_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  planned: ["new", "cancelled"],
  new: ["assigned", "cancelled"],
  assigned: ["in_progress", "cancelled"],
  in_progress: ["under_review", "cancelled"],
  under_review: ["closed", "in_progress", "cancelled"],
  closed: [],
  cancelled: []
};

type TaskStatusTransitionKey = `${string}->${string}`;

function transitionKey(from: TaskStatus, to: TaskStatus): TaskStatusTransitionKey {
  return `${from}->${to}`;
}

const CANCELLATION_TRANSITIONS = [
  "planned->cancelled",
  "new->cancelled",
  "assigned->cancelled",
  "in_progress->cancelled",
  "under_review->cancelled"
] as const satisfies readonly TaskStatusTransitionKey[];

export const TASK_STATUS_ROLE_TRANSITIONS: Readonly<Record<WorkingRole, readonly TaskStatusTransitionKey[]>> = {
  coordinator: [
    "planned->new",
    "new->assigned",
    "under_review->closed",
    "under_review->in_progress",
    ...CANCELLATION_TRANSITIONS
  ],
  engineer: ["assigned->in_progress", "in_progress->under_review"],
  warehouse: [],
  initiator: [],
  customer: [],
  supervisor: [
    "planned->new",
    "new->assigned",
    "assigned->in_progress",
    "in_progress->under_review",
    "under_review->closed",
    "under_review->in_progress",
    ...CANCELLATION_TRANSITIONS
  ],
  admin: [
    "planned->new",
    "new->assigned",
    "under_review->closed",
    "under_review->in_progress",
    ...CANCELLATION_TRANSITIONS
  ]
};

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,63}$/u.test(value);
}

export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  return isTaskStatus(from) && isTaskStatus(to) && from !== to;
}

export function canTransitionTaskStatusForRole(
  role: WorkingRole,
  from: TaskStatus,
  to: TaskStatus
): boolean {
  if (!canTransitionTaskStatus(from, to)) return false;
  if (role === "coordinator" || role === "supervisor" || role === "admin") return true;
  return TASK_STATUS_ROLE_TRANSITIONS[role].includes(transitionKey(from, to));
}
