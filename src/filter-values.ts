/**
 * Фильтр с несколькими значениями (встреча 18.11: «чтобы можно было несколько выбирать —
 * виды работ, инженеров, площадки»). В отборе он хранится одной строкой через запятую:
 * «repair,installation». Так старые места, где фильтр — одно значение (переход из отчёта,
 * ссылка из карточки прибора), работают без изменений: одно значение — это список из одного.
 */
export function filterValues(value: string | undefined | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

export function joinFilterValues(values: readonly string[]): string {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].join(",");
}

/** Значение входит в отбор: пустой отбор пропускает всё. */
export function matchesFilter(selected: string | undefined | null, value: string | undefined | null): boolean {
  const list = filterValues(selected);
  return list.length === 0 || (value !== undefined && value !== null && list.includes(value));
}

/** Подпись выбранного: «Все», «Ремонт», «Ремонт, ТО», «Ремонт и ещё 2». */
export function filterSummary(selected: readonly string[], labelOf: (value: string) => string, empty = "Все"): string {
  if (selected.length === 0) return empty;
  const labels = selected.map(labelOf);
  if (labels.length <= 2) return labels.join(", ");
  return `${labels[0]} и ещё ${labels.length - 1}`;
}
