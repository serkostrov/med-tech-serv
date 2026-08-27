import { canonicalRole, hasPermission, type StoredRole } from "./access.js";
import { canTransitionTaskStatusForRole, type TaskStatus } from "./task-status.js";

export const TASK_ACTION_CODES = [
  "activate",
  "assign",
  "accept",
  "submit_for_review",
  "verify_closure",
  "close",
  "return_for_rework",
  "cancel"
] as const;

export type TaskActionCode = (typeof TASK_ACTION_CODES)[number];

export interface AvailableTaskAction {
  readonly code: TaskActionCode;
  readonly label: string;
  readonly targetStatus?: TaskStatus;
  readonly requiresComment?: boolean;
}

export interface TaskActionContext {
  readonly hasClosure?: boolean;
  readonly closureVerified?: boolean;
}

export function availableTaskActions(
  storedRole: StoredRole | string,
  status: TaskStatus,
  context: TaskActionContext = {}
): readonly AvailableTaskAction[] {
  const role = canonicalRole(storedRole);
  const actions: AvailableTaskAction[] = [];

  if (status === "planned" && canTransitionTaskStatusForRole(role, status, "new")) {
    actions.push({ code: "activate", label: "Отметить как новую", targetStatus: "new" });
  }
  if (status === "new" && hasPermission(storedRole, "tasks.assign")
    && canTransitionTaskStatusForRole(role, status, "assigned")) {
    actions.push({ code: "assign", label: "Назначить инженера", targetStatus: "assigned" });
  }
  if (hasPermission(storedRole, "tasks.accept") && status === "assigned"
    && canTransitionTaskStatusForRole(role, status, "in_progress")) {
    actions.push({ code: "accept", label: "Принять задачу", targetStatus: "in_progress" });
  }
  if (hasPermission(storedRole, "tasks.close") && status === "in_progress" && context.hasClosure
    && canTransitionTaskStatusForRole(role, status, "under_review")) {
    actions.push({ code: "submit_for_review", label: "Передать на проверку", targetStatus: "under_review" });
  }
  if (status === "under_review" && context.hasClosure && !context.closureVerified
    && hasPermission(storedRole, "tasks.review")) {
    actions.push({
      code: "verify_closure",
      label: "Проверено — закрыть",
      targetStatus: "closed"
    });
  }
  if (status === "under_review" && context.closureVerified
    && canTransitionTaskStatusForRole(role, status, "closed")) {
    actions.push({ code: "close", label: "Проверено — закрыть", targetStatus: "closed" });
  }
  if (status === "under_review" && canTransitionTaskStatusForRole(role, status, "in_progress")) {
    actions.push({
      code: "return_for_rework",
      label: "На доработку",
      targetStatus: "in_progress",
      requiresComment: true
    });
  }
  if (status !== "closed" && status !== "cancelled"
    && canTransitionTaskStatusForRole(role, status, "cancelled")) {
    actions.push({ code: "cancel", label: "Отменить задачу", targetStatus: "cancelled", requiresComment: true });
  }
  return actions;
}
