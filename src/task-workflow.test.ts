import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { M2ApiClient, bulkAssignMode } from "./m2-api.js";

/** Поддельный клиент Supabase: каждый запрос к таблице записывает цепочку вызовов и отдаёт заданный ответ. */
function fakeClient(answer: (table: string, calls: unknown[][]) => { data?: unknown; error?: { message: string } | null; count?: number }) {
  const log: { table: string; calls: unknown[][] }[] = [];
  const client = {
    from: (table: string) => {
      const entry = { table, calls: [] as unknown[][] };
      log.push(entry);
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "update", "insert", "eq", "in", "order", "limit", "maybeSingle", "single"]) {
        chain[method] = (...args: unknown[]) => { entry.calls.push([method, ...args]); return chain; };
      }
      chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null, ...answer(table, entry.calls) }).then(resolve, reject);
      return chain;
    }
  };
  return { client: client as never, log };
}

describe("этапы задачи и массовые операции", () => {
  it("массовое назначение: новую назначает, у начатых меняет только инженера, сданные и закрытые не трогает", () => {
    assert.equal(bulkAssignMode("new"), "assign");
    assert.equal(bulkAssignMode("planned"), "engineer_only");
    assert.equal(bulkAssignMode("assigned"), "engineer_only");
    assert.equal(bulkAssignMode("in_progress"), "engineer_only");
    assert.equal(bulkAssignMode("under_review"), "refuse");
    assert.equal(bulkAssignMode("closed"), "refuse");
    assert.equal(bulkAssignMode("cancelled"), "refuse");
  });

  it("массовое назначение не возвращает закрытую задачу в «Назначена» и не сбивает этап задачи в работе", async () => {
    const states = [
      { id: "t1", status_code: "new", number: "З-1" },
      { id: "t2", status_code: "closed", number: "З-2" },
      { id: "t3", status_code: "in_progress", number: "З-3" }
    ];
    const { client, log } = fakeClient((table, calls) => table === "tasks" && calls.some((call) => call[0] === "in") ? { data: states } : { data: null });
    const api = new M2ApiClient(client);
    // Карточку задачи после назначения не грузим: здесь важны только записи в tasks.
    (api as unknown as { loadTask: () => Promise<unknown> }).loadTask = async () => ({});
    const report = await api.bulkAssignTasks(["t1", "t2", "t3", "t4"], "eng-1");
    assert.deepEqual(report.succeededTaskIds, ["t1", "t3"]);
    assert.deepEqual(report.failures.map((item) => [item.taskId, item.code]), [["t2", "invalid_status"], ["t4", "not_found"]]);
    assert.match(report.failures[0]?.error ?? "", /З-2: задача закрыта, инженера не меняем/u);
    const updates = log.filter((entry) => entry.calls.some((call) => call[0] === "update")).map((entry) => {
      const update = entry.calls.find((call) => call[0] === "update")?.[1];
      const id = entry.calls.find((call) => call[0] === "eq")?.[2];
      return [id, update];
    });
    assert.deepEqual(updates, [["t1", { engineer_id: "eng-1", status_code: "assigned" }], ["t3", { engineer_id: "eng-1" }]]);
  });

  it("массовая смена срока не трогает закрытые и отменённые задачи", async () => {
    const states = [{ id: "t1", status_code: "assigned", number: "З-1" }, { id: "t2", status_code: "cancelled", number: "З-2" }];
    const { client, log } = fakeClient((table, calls) => calls.some((call) => call[0] === "in") ? { data: states } : { data: null });
    const report = await new M2ApiClient(client).bulkChangeTaskPeriod(["t1", "t2"], "2026-12-01", "2026-12-05");
    assert.deepEqual(report.succeededTaskIds, ["t1"]);
    assert.match(report.failures[0]?.error ?? "", /З-2: задача отменена, срок не меняем/u);
    assert.equal(log.filter((entry) => entry.calls.some((call) => call[0] === "update")).length, 1);
  });

  it("перед переносом на проверку считает фото с выезда", async () => {
    const { client, log } = fakeClient((table) => table === "files" ? { data: null, count: 2 } : table === "tasks"
      ? { data: { call_reason: "Не включается", work_description: "Заменён блок" } } : { data: { task_id: "t1" } });
    const readiness = await new M2ApiClient(client).taskReviewReadiness("t1");
    assert.deepEqual(readiness, { hasClosure: true, resultFilled: true, photoCount: 2 });
    const files = log.find((entry) => entry.table === "files");
    assert.deepEqual(files?.calls.filter((call) => call[0] === "eq"), [["eq", "task_id", "t1"], ["eq", "kind", "photo"]]);
  });

  it("результат работ сохраняет дату выезда и время начала и окончания работ", async () => {
    const { client, log } = fakeClient(() => ({ data: null }));
    const api = new M2ApiClient(client);
    (api as unknown as { taskCard: () => Promise<unknown> }).taskCard = async () => ({});
    await api.updateTaskResult("t1", {
      callReason: "Не включается", workDescription: "Заменён блок", recommendations: "", userRemarks: "",
      workCompleted: true, apparatusApproved: true, customerHasNoClaims: true, continuedInPrimary: false,
      visitDate: "2026-11-13", workStartedAt: "2026-11-13T06:30:00.000Z", workFinishedAt: "2026-11-13T09:00:00.000Z"
    });
    const update = log.find((entry) => entry.table === "tasks")?.calls.find((call) => call[0] === "update")?.[1] as Record<string, unknown>;
    assert.equal(update.visit_date, "2026-11-13");
    assert.equal(update.work_started_at, "2026-11-13T06:30:00.000Z");
    assert.equal(update.work_finished_at, "2026-11-13T09:00:00.000Z");
  });
});
