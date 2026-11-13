/** Счёт с его задачами: достаточно статуса и списка задач. */
export interface InvoiceTaskLinks {
  readonly status: string;
  readonly taskIds: readonly string[];
}

/**
 * Задачи, которые уже есть в действующем (не отменённом) счёте. Одна задача входит
 * только в один такой счёт; отменённый счёт задачу освобождает. Та же проверка есть
 * в базе (миграция 0024).
 */
export function invoicedTaskIds(invoices: readonly InvoiceTaskLinks[]): ReadonlySet<string> {
  return new Set(invoices.filter((invoice) => invoice.status !== "cancelled").flatMap((invoice) => invoice.taskIds));
}

/** Закрытые задачи, по которым можно выставить новый счёт: без действующего счёта. */
export function tasksAvailableForInvoice<T extends { readonly id: string }>(tasks: readonly T[], invoices: readonly InvoiceTaskLinks[]): readonly T[] {
  const invoiced = invoicedTaskIds(invoices);
  return tasks.filter((task) => !invoiced.has(task.id));
}
