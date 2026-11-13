import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { invoicedTaskIds, tasksAvailableForInvoice } from "./invoice-tasks.js";
import { M2ApiClient } from "./m2-api.js";

const tasks = [{ id: "t1", number: "З-000001" }, { id: "t2", number: "З-000002" }, { id: "t3", number: "З-000003" }, { id: "t4", number: "З-000004" }];

describe("задачи для нового счёта", () => {
  it("не предлагает задачи из черновика, выставленного и переданного в 1С счёта", () => {
    const available = tasksAvailableForInvoice(tasks, [
      { status: "draft", taskIds: ["t1"] },
      { status: "issued", taskIds: ["t2"] },
      { status: "transferred_to_1c", taskIds: ["t3"] }
    ]);
    assert.deepEqual(available.map((task) => task.id), ["t4"]);
  });

  it("отменённый счёт задачу освобождает", () => {
    assert.deepEqual(tasksAvailableForInvoice(tasks, [{ status: "cancelled", taskIds: ["t1", "t2"] }]).map((task) => task.id), ["t1", "t2", "t3", "t4"]);
  });

  it("задача в отменённом и действующем счёте занята", () => {
    const invoices = [{ status: "cancelled", taskIds: ["t1"] }, { status: "draft", taskIds: ["t1"] }];
    assert.equal(invoicedTaskIds(invoices).has("t1"), true);
    assert.deepEqual(tasksAvailableForInvoice(tasks, invoices).map((task) => task.id), ["t2", "t3", "t4"]);
  });

  it("без счетов предлагает все закрытые задачи в прежнем порядке", () => {
    assert.deepEqual(tasksAvailableForInvoice(tasks, []), tasks);
  });

  it("окно нового счёта показывает только задачи без действующего счёта", async () => {
    const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    assert.match(app, /const invoiceableTasks = tasksAvailableForInvoice\(tasks, invoices\)/u);
    assert.match(app, /className="workflow-task-picker" role="group">\{invoiceableTasks\.map\(/u);
    assert.doesNotMatch(app, /className="workflow-task-picker" role="group">\{tasks\.map\(/u);
    assert.match(app, /Задачи, которые уже есть в счёте, здесь не показаны\./u);
  });

  it("счёт не удаляют, а отменяют: кнопка у черновика и выставленного счёта, с подтверждением", async () => {
    const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
    assert.match(app, /invoice\.status === "draft" \|\| invoice\.status === "issued" \? <div className="table-actions"><Button[^>]*onClick=\{\(\) => setCancelling\(invoice\)\}[^>]*>Отменить счёт<\/Button>/u);
    assert.match(app, /<ConfirmationDialog cancelLabel="Не отменять" confirmLabel="Отменить счёт"[\s\S]{0,400}await m2Api\.cancelInvoice\(cancelling\.id\); toast\.success/u);
    // Перечитывание после отмены не мешает закрыть окно: его ошибка уходит отдельным сообщением.
    assert.match(app, /toast\.success\(`Счёт \$\{cancelling\.number\} отменён`\); void reloadInvoiceTasks\(\)\.catch/u);
    // При открытии окна перечитываются только счета и закрытые задачи.
    assert.match(app, /setFormOpen\(true\);\s*\/\/[^\n]*\n\s*void reloadInvoiceTasks\(\)/u);
    assert.match(app, /m2Api\.hasPermission\("finance\.write"\)\.then\(setCanCancelInvoices\)/u);
  });
});

describe("отмена счёта", () => {
  function fakeClient(rows: unknown[]) {
    const calls: { table: string; update?: unknown; filters: string[] }[] = [];
    const client = {
      from(table: string) {
        const call: { table: string; update?: unknown; filters: string[] } = { table, filters: [] };
        calls.push(call);
        const builder: Record<string, unknown> = {};
        Object.assign(builder, {
          update: (patch: unknown) => { call.update = patch; return builder; },
          eq: (column: string, value: unknown) => { call.filters.push(`${column}=${String(value)}`); return builder; },
          in: (column: string, values: readonly unknown[]) => { call.filters.push(`${column} in ${values.join(",")}`); return builder; },
          select: () => builder,
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve({ data: rows, error: null }).then(resolve, reject)
        });
        return builder;
      }
    };
    return { client: client as never, calls };
  }

  it("переводит в «Отменён» только черновик или выставленный счёт", async () => {
    const { client, calls } = fakeClient([{ id: "inv-1" }]);
    await new M2ApiClient(client).cancelInvoice("inv-1");
    assert.deepEqual(calls, [{ table: "invoices", update: { status: "cancelled" }, filters: ["id=inv-1", "status in draft,issued"] }]);
  });

  it("если счёт уже отменили или передали в 1С, говорит об этом", async () => {
    const { client } = fakeClient([]);
    await assert.rejects(new M2ApiClient(client).cancelInvoice("inv-2"), /Счёт не отменён: его уже отменили или передали в 1С/u);
  });
});
