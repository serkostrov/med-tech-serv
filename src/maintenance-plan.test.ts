import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { MAINTENANCE_MONTHS, canGenerateTask, formatMaintenancePeriod, generationSummary, maintenancePlanStatusLabel, periodHasTask, periodLocked, planDrafts } from "./MaintenancePlan.js";
import type { MaintenancePlanPeriodResponse } from "./types.js";
import { M2ApiClient, publicApiErrorMessage } from "./m2-api.js";

describe("maintenance plan presentation", () => {
  it("uses all calendar months and Russian task-plan statuses", () => {
    assert.equal(MAINTENANCE_MONTHS.length, 12);
    assert.equal(MAINTENANCE_MONTHS[0], "Янв");
    assert.equal(MAINTENANCE_MONTHS[11], "Дек");
    assert.equal(maintenancePlanStatusLabel.planned, "Запланировано");
    assert.equal(maintenancePlanStatusLabel.generated, "Задача создана");
  });

  it("shows both years for a crossing maintenance period", () => {
    const label = formatMaintenancePeriod("2026-12-20", "2027-01-05");
    assert.match(label, /2026/u);
    assert.match(label, /2027/u);
  });

  it("asks for the device first and uses full period field labels", async () => {
    const source = await readFile(new URL("./MaintenancePlan.tsx", import.meta.url), "utf8");
    assert.match(source, /Сначала выберите прибор/u);
    assert.match(source, /Начало\s+<DatePicker/u);
    assert.match(source, /Окончание\s+<DatePicker/u);
    assert.match(source, /Удалить период/u);
    assert.match(source, /MAX_ANNUAL_MAINTENANCE_PERIODS/u);
  });

  it("uses the shared card header for the schedule", async () => {
    const [source, css] = await Promise.all([
      readFile(new URL("./MaintenancePlan.tsx", import.meta.url), "utf8"),
      readFile(new URL("./styles.css", import.meta.url), "utf8")
    ]);
    assert.match(source, /<CardHeader/u);
    assert.match(source, /title=\{`График на \$\{year\} год`\}/u);
    assert.doesNotMatch(source, /maintenance-section-heading/u);
    assert.doesNotMatch(css, /\.maintenance-section-heading\s*\{/u);
    assert.match(css, /\.maintenance-toolbar\s+\.page-tabs:last-child\s*\{[^}]*margin-left:\s*auto/su);
  });
});

interface Call {
  readonly table?: string;
  readonly rpc?: string;
  readonly args?: unknown;
  readonly ops: unknown[][];
}

type Response = { data?: unknown; error?: { message: string; code?: string } | null; count?: number };

/** Поддельный Supabase: записывает запросы, ответ выбирает по таблице и цепочке вызовов. */
function fakeSupabase(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const chain = (call: Call) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "not", "is", "order", "range", "update", "delete", "insert", "maybeSingle", "single"]) {
      builder[method] = (...args: unknown[]) => { call.ops.push([method, ...args]); return builder; };
    }
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve().then(() => ({ data: null, error: null, count: null, ...answer(call) })).then(resolve, reject);
    return builder;
  };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: "actor-1" } } } }) },
    from: (table: string) => { const call: Call = { table, ops: [] }; calls.push(call); return chain(call); },
    rpc: (fn: string, args: unknown) => {
      const call: Call = { rpc: fn, args, ops: [] };
      calls.push(call);
      return Promise.resolve({ data: null, error: null, ...answer(call) });
    }
  };
  return { client: client as never, calls };
}

const op = (call: Call | undefined, name: string) => call?.ops.find((item) => item[0] === name);
const ops = (call: Call | undefined, name: string) => call?.ops.filter((item) => item[0] === name) ?? [];

const planRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, equipment_id: "eq-1", plan_year: 2027, period_no: 1, period_from: "2027-03-01", period_to: "2027-03-10", status: "planned",
  equipment: { serial_number: "SN-1", manufacturer: { name: "Mindray" }, model: { name: "BC-6800" }, site: { id: "site-1", name: "Клиника", organization_id: "org-1", organization: { name: "Больница" } } },
  ...extra
});

/** Ответы для генерации: периоды плана, прибор с площадкой и плательщиком, вставка и чтение задачи. */
function generationAnswer(periods: readonly Record<string, unknown>[], existing: readonly Record<string, unknown>[] = [], insertError?: string) {
  let taskNo = 0;
  return (call: Call): Response => {
    if (call.table === "maintenance_plans" && op(call, "select")) return { data: periods, count: periods.length };
    if (call.table === "maintenance_plans" && op(call, "update")) return {};
    if (call.table === "tasks" && op(call, "in")) return { data: existing };
    if (call.table === "equipment") return { data: { id: "eq-1", serial_number: "SN-1", current_site_id: "site-1", current_payer_id: "payer-1" } };
    if (call.table === "tasks" && op(call, "insert")) {
      if (insertError) return { error: { message: insertError, code: "23514" } };
      taskNo += 1;
      return { data: { id: `task-${taskNo}` } };
    }
    // Повторная проверка после ошибки: задачи по периоду нет.
    if (call.table === "tasks" && op(call, "maybeSingle") && ops(call, "eq")[0]?.[1] === "maintenance_plan_id") return { data: null };
    if (call.table === "tasks" && op(call, "maybeSingle")) {
      const id = String(ops(call, "eq")[0]?.[2] ?? "");
      return { data: { id, number: "З-1", title: "ТО 2027", status_code: "planned", created_at: "2026-11-13T00:00:00Z", updated_at: "2026-11-13T00:00:00Z" } };
    }
    return {};
  };
}

describe("план ТО: задачи по плану", () => {
  it("создаёт задачи «Запланированными», с инженером из плана, и отмечает период", async () => {
    const { client, calls } = fakeSupabase(generationAnswer([
      { id: "p-1", equipment_id: "eq-1", period_from: "2027-03-01", period_to: "2027-03-10", assigned_engineer_id: "eng-1", status: "planned" },
      { id: "p-2", equipment_id: "eq-1", period_from: "2027-09-01", period_to: "2027-09-10", assigned_engineer_id: null, status: "planned" }
    ]));
    const result = await new M2ApiClient(client).generateMaintenanceTasks(2027);
    assert.deepEqual(result.created, [{ planId: "p-1", taskId: "task-1" }, { planId: "p-2", taskId: "task-2" }]);
    assert.equal(result.requestedCount, 2);
    const inserts = calls.filter((call) => call.table === "tasks" && op(call, "insert")).map((call) => op(call, "insert")?.[1] as Record<string, unknown>);
    assert.deepEqual(inserts.map((row) => [row.status_code, row.engineer_id, row.is_maintenance_plan, row.maintenance_plan_id, row.deadline_from]), [
      ["planned", "eng-1", true, "p-1", "2027-03-01"],
      ["planned", null, true, "p-2", "2027-09-01"]
    ]);
    const marks = calls.filter((call) => call.table === "maintenance_plans" && op(call, "update"));
    assert.equal(marks.length, 2);
    assert.deepEqual(ops(marks[0], "eq"), [["eq", "id", "p-1"], ["eq", "status", "planned"]]);
    assert.equal((op(marks[0], "update")?.[1] as Record<string, unknown>).status, "generated");
  });

  it("без выбранных строк берёт все периоды года на сервере, а не список id в адресе", async () => {
    const { client, calls } = fakeSupabase(generationAnswer([]));
    await new M2ApiClient(client).generateMaintenanceTasks(2027);
    const read = calls.find((call) => call.table === "maintenance_plans");
    assert.equal(op(read, "in"), undefined);
    assert.ok(op(read, "range"), "периоды читаются страницами");
    assert.deepEqual(ops(read, "eq"), [["eq", "plan_year", 2027], ["eq", "status", "planned"]]);
  });

  it("выбранные строки отправляет частями по 100 id", async () => {
    const { client, calls } = fakeSupabase(generationAnswer([]));
    await new M2ApiClient(client).generateMaintenanceTasks(2027, Array.from({ length: 250 }, (_, index) => `p-${index}`));
    const reads = calls.filter((call) => call.table === "maintenance_plans");
    assert.deepEqual(reads.map((call) => (op(call, "in")?.[2] as unknown[]).length), [100, 100, 50]);
  });

  it("существующую задачу не дублирует и чинит отметку периода", async () => {
    const { client, calls } = fakeSupabase(generationAnswer(
      [{ id: "p-1", equipment_id: "eq-1", period_from: "2027-03-01", period_to: "2027-03-10", status: "planned" }],
      [{ id: "task-old", maintenance_plan_id: "p-1" }]
    ));
    const result = await new M2ApiClient(client).generateMaintenanceTasks(2027);
    assert.deepEqual(result.existing, [{ planId: "p-1", taskId: "task-old" }]);
    assert.equal(result.created.length, 0);
    assert.ok(!calls.some((call) => call.table === "tasks" && op(call, "insert")));
    // Уже созданные задачи ищутся одним запросом на часть периодов.
    assert.deepEqual(op(calls.find((call) => call.table === "tasks" && op(call, "in")), "in"), ["in", "maintenance_plan_id", ["p-1"]]);
    assert.ok(calls.some((call) => call.table === "maintenance_plans" && op(call, "update")));
  });

  it("ошибку создания пишет в итог по-русски и период не отмечает", async () => {
    const { client, calls } = fakeSupabase(generationAnswer(
      [{ id: "p-1", equipment_id: "eq-1", period_from: "2027-03-01", period_to: "2027-03-10", assigned_engineer_id: "eng-off", status: "planned" }],
      [],
      "Задачу можно назначить только активному инженеру"
    ));
    const result = await new M2ApiClient(client).generateMaintenanceTasks(2027);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]?.error ?? "", /активному инженеру/u);
    assert.ok(!calls.some((call) => call.table === "maintenance_plans" && op(call, "update")));
    assert.match(generationSummary(result).text, /Не создано: 1 — Задачу можно назначить только активному инженеру/u);
  });

  it("задачу, которую только что создал другой координатор, считает «уже была»", async () => {
    let lookups = 0;
    const base = generationAnswer(
      [{ id: "p-1", equipment_id: "eq-1", period_from: "2027-03-01", period_to: "2027-03-10", status: "planned" }],
      [],
      "duplicate key value violates unique constraint \"tasks_maintenance_plan_once_uq\""
    );
    const { client } = fakeSupabase((call) => {
      if (call.table === "tasks" && op(call, "maybeSingle") && ops(call, "eq")[0]?.[1] === "maintenance_plan_id") {
        lookups += 1;
        return { data: { id: "task-other" } };
      }
      return base(call);
    });
    const result = await new M2ApiClient(client).generateMaintenanceTasks(2027);
    assert.deepEqual(result.existing, [{ planId: "p-1", taskId: "task-other" }]);
    assert.equal(result.failures.length, 0);
    assert.equal(lookups, 1);
  });

  it("выключенный в справочнике этап называет по-русски", () => {
    assert.equal(
      publicApiErrorMessage("Статус задачи не активен: planned"),
      "Этап «Запланировано» выключен в справочнике статусов задач. Включите его в «Справочниках»."
    );
  });

  it("обычная задача создаётся без статуса: база ставит «Новая»", async () => {
    const { client, calls } = fakeSupabase(generationAnswer([]));
    await new M2ApiClient(client).createTask({ title: "Ремонт", equipmentId: "eq-1", statusCode: "planned", periodFrom: "2027-01-01", periodTo: "2027-01-02" });
    const insert = op(calls.find((call) => call.table === "tasks" && op(call, "insert")), "insert")?.[1] as Record<string, unknown>;
    assert.equal("status_code" in insert, false);
  });
});

describe("план ТО: чтение и сохранение", () => {
  it("читает весь год страницами и знает, по каким периодам есть задача", async () => {
    const first = Array.from({ length: 1000 }, (_, index) => planRow(`p-${index}`));
    const second = Array.from({ length: 500 }, (_, index) => planRow(`q-${index}`, index === 0 ? { status: "generated", generated_task: [{ id: "task-9" }] } : {}));
    const { client, calls } = fakeSupabase((call) => {
      const range = op(call, "range");
      return range?.[1] === 0 ? { data: first, count: 1500 } : { data: second };
    });
    const plan = await new M2ApiClient(client).maintenancePlans(2027, "equipment");
    assert.equal(plan.items.length, 1500);
    assert.deepEqual(calls.map((call) => op(call, "range")?.slice(1)), [[0, 999], [1000, 1999]]);
    assert.match(String(op(calls[0], "select")?.[1]), /generated_task:tasks!task_maintenance_plan_equipment_fk\(id\)/u);
    assert.deepEqual(ops(calls[0], "order").map((item) => item[1]), ["period_from", "id"]);
    const withTask = plan.items.filter((item) => item.generatedTaskId);
    assert.deepEqual(withTask.map((item) => item.generatedTaskId), ["task-9"]);
    assert.equal(plan.items.filter(periodHasTask).length, 1);
  });

  it("если база не знает связи с задачами, план всё равно открывается", async () => {
    const { client, calls } = fakeSupabase((call) => /generated_task/u.test(String(op(call, "select")?.[1]))
      ? { error: { message: "Could not find a relationship between 'maintenance_plans' and 'tasks' in the schema cache", code: "PGRST200" } }
      : { data: [planRow("p-1", { status: "generated" })], count: 1 });
    const plan = await new M2ApiClient(client).maintenancePlans(2027, "equipment");
    assert.equal(plan.items.length, 1);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(String(op(calls[1], "select")?.[1]), /generated_task/u);
    // Без связи задача видна по отметке периода.
    assert.equal(plan.items.filter(periodHasTask).length, 1);
  });

  it("прочие ошибки чтения не прячет", async () => {
    const { client, calls } = fakeSupabase(() => ({ error: { message: "permission denied for table maintenance_plans", code: "42501" } }));
    await assert.rejects(new M2ApiClient(client).maintenancePlans(2027, "equipment"), /Недостаточно прав/u);
    assert.equal(calls.length, 1);
  });

  it("сохраняет план одной функцией базы, периоды по датам", async () => {
    const { client, calls } = fakeSupabase((call) => call.rpc ? {} : { data: [], count: 0 });
    await new M2ApiClient(client).replaceMaintenancePlan({
      equipmentId: "eq-1",
      year: 2027,
      periods: [
        { periodFrom: "2027-09-01", periodTo: "2027-09-10", assignedEngineerId: "eng-1", comment: " осень " },
        { periodFrom: "2027-03-01", periodTo: "2027-03-10" }
      ]
    });
    assert.deepEqual(calls[0], {
      rpc: "replace_maintenance_plan",
      args: {
        p_equipment_id: "eq-1",
        p_year: 2027,
        p_periods: [
          { periodFrom: "2027-03-01", periodTo: "2027-03-10", assignedEngineerId: null, comment: null },
          { periodFrom: "2027-09-01", periodTo: "2027-09-10", assignedEngineerId: "eng-1", comment: "осень" }
        ]
      },
      ops: []
    });
    assert.ok(!calls.some((call) => call.table === "maintenance_plans" && (op(call, "delete") || op(call, "insert"))), "нет отдельных удаления и вставки");
  });

  it("неверный план в базу не отправляет", async () => {
    const { client, calls } = fakeSupabase(() => ({}));
    await assert.rejects(new M2ApiClient(client).replaceMaintenancePlan({
      equipmentId: "eq-1", year: 2027,
      periods: [{ periodFrom: "2027-04-01", periodTo: "2027-04-20" }, { periodFrom: "2027-04-10", periodTo: "2027-04-30" }]
    }), /не должны пересекаться/u);
    assert.equal(calls.length, 0);
  });

  it("пока базу не обновили, сохраняет как раньше: удаление и вставка", async () => {
    const { client, calls } = fakeSupabase((call) => call.rpc
      ? { error: { message: "Could not find the function public.replace_maintenance_plan(p_equipment_id, p_periods, p_year)", code: "PGRST202" } }
      : { data: [], count: 0 });
    await new M2ApiClient(client).replaceMaintenancePlan({ equipmentId: "eq-1", year: 2027, periods: [{ periodFrom: "2027-09-01", periodTo: "2027-09-10" }, { periodFrom: "2027-03-01", periodTo: "2027-03-10" }] });
    const removal = calls.find((call) => call.table === "maintenance_plans" && op(call, "delete"));
    const insert = calls.find((call) => call.table === "maintenance_plans" && op(call, "insert"));
    assert.deepEqual(ops(removal, "eq"), [["eq", "equipment_id", "eq-1"], ["eq", "plan_year", 2027]]);
    assert.deepEqual((op(insert, "insert")?.[1] as Record<string, unknown>[]).map((row) => [row.period_no, row.period_from, row.created_by]), [[1, "2027-03-01", "actor-1"], [2, "2027-09-01", "actor-1"]]);
  });

  it("про период с задачей говорит понятно, а не про внешний ключ", () => {
    assert.match(
      publicApiErrorMessage("update or delete on table \"maintenance_plans\" violates foreign key constraint \"task_maintenance_plan_equipment_fk\" on table \"tasks\""),
      /уже созданы задачи из плана/u
    );
  });
});

describe("план ТО: экран", () => {
  it("прибор выбирается поиском, как в новой задаче, без создания прибора", async () => {
    const source = await readFile(new URL("./MaintenancePlan.tsx", import.meta.url), "utf8");
    assert.match(source, /<EquipmentFolderPicker allowCreate=\{false\}/u);
    assert.doesNotMatch(source, /equipment\.map\(\(item\) => \(\s*<option/u);
    assert.doesNotMatch(source, /listEquipment\(\)/u);
    assert.match(source, /Сменить/u);
  });

  it("счётчик созданных задач считает периоды с задачей, выбрать можно только периоды без задачи", () => {
    assert.ok(periodHasTask({ generatedTaskId: "task-1", status: "planned" }));
    assert.ok(periodHasTask({ status: "generated" }));
    assert.ok(!periodHasTask({ status: "planned" }));
    assert.ok(canGenerateTask({ status: "planned" }));
    // Задача есть, а отметка периода не записалась: второй раз не предлагаем.
    assert.ok(!canGenerateTask({ generatedTaskId: "task-1", status: "planned" }));
    assert.ok(!canGenerateTask({ status: "generated" }));
  });

  it("итог генерации говорит, где искать задачи", () => {
    assert.deepEqual(generationSummary({ created: [1, 2], existing: [], failures: [] }), {
      tone: "success", text: "Создано задач: 2. Они на доске в колонке «Запланировано» и станут новыми к началу периода ТО."
    });
    assert.equal(generationSummary({ created: [], existing: [1], failures: [] }).text, "Новых задач нет: по выбранным периодам задачи уже созданы.");
  });

  it("черновик окна: периоды по датам, с задачей и закрытые — только для просмотра", () => {
    const period = (id: string, periodFrom: string, extra: Partial<MaintenancePlanPeriodResponse> = {}): MaintenancePlanPeriodResponse => ({
      id, equipmentId: "eq-1", year: 2027, periodNo: 1, periodFrom, periodTo: periodFrom.replace(/-\d\d$/u, "-10"), status: "planned",
      equipment: { serialNumber: "SN-1", manufacturer: "Mindray", model: "BC-6800" },
      timeline: { leftPercent: 0, widthPercent: 1, visibleFrom: periodFrom, visibleTo: periodFrom, crossesYearBoundary: false },
      ...extra
    });
    const { drafts, nextKey } = planDrafts([
      period("oct", "2027-10-01", { periodNo: 1, comment: "осень" }),
      period("jun", "2027-06-01", { periodNo: 2, status: "generated", generatedTaskId: "t-1", assignedEngineerId: "e-1", assignedEngineerName: "Иванов" }),
      period("feb", "2027-02-01", { periodNo: 3, status: "cancelled" }),
      period("mar", "2027-03-01", { periodNo: 4, generatedTaskId: "t-2" })
    ], 10);
    assert.deepEqual(drafts.map((item) => [item.key, item.periodFrom, item.locked, item.lockLabel]), [
      [10, "2027-02-01", true, "Отменено"],
      [11, "2027-03-01", true, "Задача создана"],
      [12, "2027-06-01", true, "Задача создана"],
      [13, "2027-10-01", false, undefined]
    ]);
    assert.equal(nextKey, 14);
    assert.equal(drafts[2]?.engineerName, "Иванов");
    assert.equal(drafts[3]?.comment, "осень");
    // То же правило, что в базе: не «Запланировано» или есть задача.
    assert.ok(periodLocked({ status: "cancelled" }));
    assert.ok(periodLocked({ status: "planned", generatedTaskId: "t-1" }));
    assert.ok(!periodLocked({ status: "planned" }));
  });

  it("периоды с задачей в окне без полей и без «удалить», номер ТО по датам", async () => {
    const source = await readFile(new URL("./MaintenancePlan.tsx", import.meta.url), "utf8");
    assert.match(source, /planDrafts\(existing, nextPeriodKey\)/u);
    assert.match(source, /period\.locked \? \(/u);
    assert.match(source, /period\.lockLabel \?\? maintenancePlanStatusLabel\.generated/u);
    assert.match(source, /Остальные периоды можно менять и добавлять новые/u);
    assert.match(source, /item\.key !== key \|\| item\.locked/u);
    assert.match(source, /`ТО № \$\{index \+ 1\}`/u);
    assert.doesNotMatch(source, /item\.periodNo/u);
    assert.doesNotMatch(source, /в колонке «Новая»/u);
  });

  it("пока выбирают другой прибор, план старого не сохранить", async () => {
    const [source, picker] = await Promise.all([
      readFile(new URL("./MaintenancePlan.tsx", import.meta.url), "utf8"),
      readFile(new URL("./EquipmentFolderPicker.tsx", import.meta.url), "utf8")
    ]);
    assert.match(source, /submitDisabled=\{!equipmentId \|\| pickingDevice\}/u);
    assert.match(source, /equipmentId && !pickingDevice \?/u);
    assert.match(source, /Не менять прибор/u);
    // Enter в поиске прибора не отправляет окно, даже когда список пуст или грузится.
    assert.match(picker, /if \(event\.key === "Enter"\) \{[^}]*?event\.preventDefault\(\);\s*if \(open && activeDevice\)/su);
  });
});
