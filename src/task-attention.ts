/**
 * Плашка «Требуют внимания» над задачами (ТЗ, блок 1): новые, просроченные, на проверке.
 * Счётчик нажимается и открывает список этих задач. Расчёт чистый, без React.
 */
import { formatRussianCount } from "./equipment-changes.js";

export interface TaskAttentionCounts {
  readonly new: number;
  readonly overdue: number;
  readonly underReview: number;
}

export type TaskAttentionKey = "new" | "overdue" | "under_review";

export interface TaskAttentionItem {
  readonly key: TaskAttentionKey;
  readonly label: string;
  readonly count: number;
  /** Подпись для экранного диктора: «Новые: 3 задачи». */
  readonly ariaLabel: string;
  /** Список уже отобран по этому счётчику. */
  readonly active: boolean;
}

/** Какой отбор списка у счётчика: этап или просрочка. */
export function attentionFilter(key: TaskAttentionKey): { readonly status: string; readonly overdue: boolean } {
  if (key === "overdue") return { status: "", overdue: true };
  return { status: key, overdue: false };
}

/**
 * Три счётчика по порядку работы координатора: сначала новые (назначить инженера),
 * затем просроченные, затем на проверке (принять акт). Активен тот, по которому
 * отобран список, и только если других отборов нет.
 */
export function taskAttentionItems(
  counts: TaskAttentionCounts,
  applied: { readonly status: string; readonly overdue: boolean; readonly otherFilters: boolean }
): readonly TaskAttentionItem[] {
  const items: ReadonlyArray<{ readonly key: TaskAttentionKey; readonly label: string; readonly count: number }> = [
    { key: "new", label: "Новые", count: counts.new },
    { key: "overdue", label: "Просрочены", count: counts.overdue },
    { key: "under_review", label: "На проверке", count: counts.underReview }
  ];
  return items.map((item) => {
    const filter = attentionFilter(item.key);
    const count = Math.max(0, Math.trunc(item.count));
    return {
      ...item,
      count,
      ariaLabel: `${item.label}: ${formatRussianCount(count, ["задача", "задачи", "задач"])}`,
      active: !applied.otherFilters && applied.status === filter.status && applied.overdue === filter.overdue
    };
  });
}
