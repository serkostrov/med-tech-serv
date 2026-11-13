import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { M2ApiClient, type StockReservationRecord } from "./m2-api.js";
import { daysWithEngineer, installedReservationNumbers, lastReservationStep, reservationStepText, reservationsByEngineer } from "./reservations.js";
import { engineerReservationsSheets } from "./reservation-export.js";

type Answer = { data?: unknown; error?: { message: string; code?: string } | null; count?: number };

/**
 * Поддельный клиент Supabase: запоминает цепочку вызовов к каждой таблице и вызовы функций
 * базы (как rpc:имя_функции) и отдаёт ответ, который вернёт answer.
 */
function fakeClient(answer: (table: string, calls: unknown[][]) => Answer = () => ({})) {
  const log: { table: string; calls: unknown[][] }[] = [];
  const client = {
    from: (table: string) => {
      const entry = { table, calls: [] as unknown[][] };
      log.push(entry);
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "update", "insert", "delete", "eq", "in", "is", "not", "order", "limit", "maybeSingle", "single"]) {
        chain[method] = (...args: unknown[]) => { entry.calls.push([method, ...args]); return chain; };
      }
      chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null, ...answer(table, entry.calls) }).then(resolve, reject);
      return chain;
    },
    rpc: (fn: string, args: unknown) => {
      const entry = { table: `rpc:${fn}`, calls: [["rpc", fn, args]] };
      log.push(entry);
      return Promise.resolve({ data: null, error: null, ...answer(entry.table, entry.calls) });
    }
  };
  return { client: client as never, log };
}

const RESERVATION_ROW = {
  id: "r1", number: "Р-000012", status: "issued", part_id: "p1", part_condition: "N", quantity: 2, task_id: "t1", install_marked: true,
  created_at: "2026-11-10T06:00:00.000Z", updated_at: "2026-11-12T06:00:00.000Z",
  part: { article_number: "AU-LAMP", name: "Лампа галогеновая" },
  task: { number: "З-000123", title: "Замена лампы", status_code: "in_progress", engineer: { full_name: "Иванов Пётр Алексеевич" } },
  issued: { full_name: "Иванов Пётр Алексеевич" },
  // Намеренно вперемешку: шаги должны выстроиться по времени.
  stock_reservation_history: [
    { from_status: "warehouse_notified", to_status: "issued", changed_at: "2026-11-12T06:00:00.000Z", changed_by: "u-wh", changer: { full_name: "Никитина Ольга Павловна" } },
    { from_status: null, to_status: "created", changed_at: "2026-11-10T06:00:00.000Z", changed_by: "u-coord", changer: { full_name: "Морозова Елена Владимировна" } },
    { from_status: "created", to_status: "warehouse_notified", changed_at: "2026-11-11T06:00:00.000Z", changed_by: "u-wh", changer: { full_name: "Никитина Ольга Павловна" } }
  ]
};

/** Резерв для проверки группировки: только то, что нужно вкладке «У инженеров». */
function record(input: Partial<StockReservationRecord> & Pick<StockReservationRecord, "id" | "number">): StockReservationRecord {
  return {
    status: "issued", partId: "p1", articleNumber: "AU-LAMP", partName: "Лампа", condition: "N", quantity: 1,
    installMarked: false, steps: [], createdAt: "2026-11-01T06:00:00.000Z", updatedAt: "2026-11-01T06:00:00.000Z", ...input
  };
}

const issuedStep = (changedAt: string) => ({ status: "issued" as const, fromStatus: "warehouse_notified" as const, changedAt, actorName: "Никитина Ольга Павловна" });

describe("резерв запчастей под задачу", () => {
  it("создаёт резерв функцией базы и возвращает её номер", async () => {
    const { client, log } = fakeClient((table) => table === "rpc:create_task_part_reservation" ? { data: [{ id: "r1", number: "Р-000012" }] } : {});
    const created = await new M2ApiClient(client).createTaskPartReservation("t1", { partId: "p1", condition: "G", quantity: 2 });
    assert.deepEqual(created, { id: "r1", number: "Р-000012" });
    assert.deepEqual(log[0]?.calls[0], ["rpc", "create_task_part_reservation", { p_task_id: "t1", p_part_id: "p1", p_condition: "G", p_quantity: 2 }]);
  });

  it("показывает сообщение базы об остатке как есть, а до миграции говорит про обновление", async () => {
    const short = fakeClient(() => ({ error: { message: "На складе доступно 1 шт. этой запчасти в состоянии Н, а нужно 2" } }));
    await assert.rejects(
      new M2ApiClient(short.client).createTaskPartReservation("t1", { partId: "p1", condition: "N", quantity: 2 }),
      /На складе доступно 1 шт\. этой запчасти в состоянии Н, а нужно 2/u
    );
    const missing = fakeClient(() => ({ error: { message: "Could not find the function public.create_task_part_reservation", code: "PGRST202" } }));
    await assert.rejects(
      new M2ApiClient(missing.client).createTaskPartReservation("t1", { partId: "p1", condition: "N", quantity: 1 }),
      /заработает после обновления базы на сервере/u
    );
    // Количество проверяем до обращения к базе: пустой запрос серверу не нужен.
    const empty = fakeClient();
    await assert.rejects(new M2ApiClient(empty.client).createTaskPartReservation("t1", { partId: "p1", condition: "N", quantity: 0 }), /больше нуля/u);
    assert.equal(empty.log.length, 0);
  });

  it("отметки об установке уходят одним списком идентификаторов резервов", async () => {
    const { client, log } = fakeClient();
    await new M2ApiClient(client).setTaskPartsInstalled("t1", ["r1", "r2"]);
    assert.deepEqual(log[0]?.calls[0], ["rpc", "set_task_parts_installed", { p_task_id: "t1", p_reservation_ids: ["r1", "r2"] }]);
    const missing = fakeClient(() => ({ error: { message: "Could not find the function public.set_task_parts_installed", code: "PGRST202" } }));
    await assert.rejects(new M2ApiClient(missing.client).setTaskPartsInstalled("t1", []), /заработают после обновления базы на сервере/u);
  });

  it("резервы задачи приходят с шагами по порядку: кто и когда", async () => {
    const { client, log } = fakeClient(() => ({ data: [RESERVATION_ROW] }));
    const [reservation] = await new M2ApiClient(client).taskReservations("t1");
    const entry = log[0];
    assert.equal(entry?.table, "stock_reservations");
    assert.deepEqual(entry?.calls.find((call) => call[0] === "eq"), ["eq", "task_id", "t1"]);
    assert.match(String(entry?.calls[0]?.[1]), /stock_reservation_history\(from_status, to_status, changed_at, changed_by, changer:users!changed_by\(full_name\)\)/u);
    assert.deepEqual(reservation?.steps.map((step) => [step.status, step.actorName]), [
      ["created", "Морозова Елена Владимировна"],
      ["warehouse_notified", "Никитина Ольга Павловна"],
      ["issued", "Никитина Ольга Павловна"]
    ]);
    assert.equal(reservation?.installMarked, true);
    assert.equal(lastReservationStep(reservation!)?.status, "issued");
    assert.equal(reservationStepText(lastReservationStep(reservation!)!), "У инженера · Никитина Ольга Павловна · 12.11.2026 09:00");
  });

  it("если историю встроить не удалось, резервы читаются без шагов, а не с ошибкой", async () => {
    let attempt = 0;
    const { client, log } = fakeClient(() => {
      attempt += 1;
      return attempt === 1
        ? { error: { message: "Could not find a relationship between 'stock_reservations' and 'stock_reservation_history'" } }
        : { data: [{ ...RESERVATION_ROW, stock_reservation_history: undefined }] };
    });
    const [reservation] = await new M2ApiClient(client).taskReservations("t1");
    assert.deepEqual(reservation?.steps, []);
    assert.equal(reservation?.number, "Р-000012");
    assert.equal(log.length, 2);
  });

  it("пока в базе нет install_marked, резервы читаются без отметки, но с шагами", async () => {
    let attempt = 0;
    const { client, log } = fakeClient(() => {
      attempt += 1;
      return attempt === 1
        ? { error: { message: 'column stock_reservations.install_marked does not exist' } }
        : { data: [{ ...RESERVATION_ROW, install_marked: undefined }] };
    });
    const api = new M2ApiClient(client);
    const [reservation] = await api.taskReservations("t1");
    assert.equal(reservation?.installMarked, false);
    // Отметку убрали, а историю оставили: шаги по-прежнему на месте.
    assert.equal(reservation?.steps.length, 3);
    assert.match(String(log[0]?.calls[0]?.[1]), /install_marked/u);
    assert.doesNotMatch(String(log[1]?.calls[0]?.[1]), /install_marked/u);
    assert.match(String(log[1]?.calls[0]?.[1]), /stock_reservation_history\(/u);
    // Второй запрос уже знает, что колонки нет: лишней попытки не будет.
    await api.taskReservations("t1");
    assert.equal(log.length, 3);
  });

  it("список резервов склада тоже отдаёт шаги", async () => {
    const { client, log } = fakeClient(() => ({ data: [RESERVATION_ROW] }));
    const [reservation] = await new M2ApiClient(client).stockReservations("active");
    assert.match(String(log[0]?.calls[0]?.[1]), /stock_reservation_history\(/u);
    assert.equal(reservation?.steps.length, 3);
  });

  it("список запчастей задачи не трогает строки из резерва", async () => {
    const { client, log } = fakeClient((table, calls) => {
      if (table === "parts") return { data: [{ id: "p1", article_number: "AU-LAMP" }] };
      if (table === "task_parts" && calls.some((call) => call[0] === "not")) return { data: [{ position: 0 }, { position: 1 }] };
      return {};
    });
    const api = new M2ApiClient(client);
    (api as unknown as { taskCard: () => Promise<unknown> }).taskCard = async () => ({ parts: [] });
    await api.replaceTaskParts("t1", [{ articleNumber: "AU-LAMP", name: "Лампа", quantity: 1, condition: "N" }]);
    const removal = log.find((entry) => entry.calls.some((call) => call[0] === "delete"));
    assert.deepEqual(removal?.calls.find((call) => call[0] === "is"), ["is", "reservation_id", null]);
    const insert = log.find((entry) => entry.calls.some((call) => call[0] === "insert"))?.calls.find((call) => call[0] === "insert")?.[1] as { position: number }[];
    assert.deepEqual(insert.map((row) => row.position), [2]);
  });

  it("пока столбца резерва нет в базе, список запчастей работает как раньше", async () => {
    const { client, log } = fakeClient((table, calls) => {
      if (table === "parts") return { data: [{ id: "p1", article_number: "AU-LAMP" }] };
      if (table === "task_parts" && calls.some((call) => call[0] === "not")) {
        return { error: { message: "column task_parts.reservation_id does not exist" } };
      }
      return {};
    });
    const api = new M2ApiClient(client);
    (api as unknown as { taskCard: () => Promise<unknown> }).taskCard = async () => ({ parts: [] });
    await api.replaceTaskParts("t1", [{ articleNumber: "AU-LAMP", name: "Лампа", quantity: 1, condition: "N" }]);
    const removal = log.find((entry) => entry.calls.some((call) => call[0] === "delete"));
    assert.equal(removal?.calls.some((call) => call[0] === "is"), false);
    const insert = log.find((entry) => entry.calls.some((call) => call[0] === "insert"))?.calls.find((call) => call[0] === "insert")?.[1] as { position: number }[];
    assert.deepEqual(insert.map((row) => row.position), [0]);
  });
});

describe("запчасти у инженеров", () => {
  const now = Date.parse("2026-11-20T09:00:00.000Z");

  it("считает дни от шага выдачи, а без шагов — от последнего изменения", () => {
    assert.equal(daysWithEngineer(record({ id: "r1", number: "Р-1", steps: [issuedStep("2026-11-17T09:00:00.000Z")] }), now), 3);
    // Выдали меньше суток назад: ещё ноль дней, а не «один день».
    assert.equal(daysWithEngineer(record({ id: "r2", number: "Р-2", steps: [issuedStep("2026-11-20T08:00:00.000Z")] }), now), 0);
    assert.equal(daysWithEngineer(record({ id: "r3", number: "Р-3", updatedAt: "2026-11-05T09:00:00.000Z" }), now), 15);
  });

  it("группирует выданное по инженерам: сначала тот, у кого запчасть висит дольше всех", () => {
    const groups = reservationsByEngineer([
      record({ id: "r1", number: "Р-000001", issuedToName: "Иванов Пётр", steps: [issuedStep("2026-11-18T09:00:00.000Z")] }),
      record({ id: "r2", number: "Р-000002", issuedToName: "Иванов Пётр", steps: [issuedStep("2026-11-10T09:00:00.000Z")] }),
      record({ id: "r3", number: "Р-000003", engineerName: "Петров Сергей", steps: [issuedStep("2026-11-19T09:00:00.000Z")] }),
      record({ id: "r4", number: "Р-000004", status: "created", issuedToName: "Иванов Пётр" }),
      record({ id: "r5", number: "Р-000005", status: "installed", issuedToName: "Петров Сергей" })
    ], now);
    assert.deepEqual(groups.map((group) => [group.engineerName, group.items.length, group.oldestDays]), [
      ["Иванов Пётр", 2, 10],
      ["Петров Сергей", 1, 1]
    ]);
    // Внутри инженера сверху тоже самая старая запчасть.
    assert.deepEqual(groups[0]?.items.map((item) => item.reservation.number), ["Р-000002", "Р-000001"]);
    // Невыданные резервы в список не попадают: они ещё на складе или уже закрыты.
    assert.equal(groups.some((group) => group.items.some((item) => item.reservation.status !== "issued")), false);
  });

  it("подпись «установлена» собирает все отмеченные резервы одной запчасти и состояния", () => {
    const marked = (id: string, number: string, extra: Partial<StockReservationRecord> = {}) => record({
      id, number, articleNumber: "UNI-FUSE-5A", condition: "B", installMarked: true, ...extra
    });
    const reservations = [
      marked("r1", "Р-000012"),
      marked("r2", "Р-000013"),
      // Та же запчасть, но другое состояние и без отметки: в подпись не попадают.
      marked("r3", "Р-000014", { condition: "N" }),
      record({ id: "r4", number: "Р-000015", articleNumber: "UNI-FUSE-5A", condition: "B" })
    ];
    const part = { articleNumber: "UNI-FUSE-5A", condition: "B" as const, reservationId: "r2" };
    assert.deepEqual(installedReservationNumbers(part, reservations), ["Р-000012", "Р-000013"]);
    // Позиция, которую завели руками, к резервам отношения не имеет.
    assert.deepEqual(installedReservationNumbers({ ...part, reservationId: undefined }, reservations), []);
  });

  it("в Excel уходит строка на каждую выданную запчасть с днями у инженера", () => {
    const [sheet] = engineerReservationsSheets([
      record({ id: "r1", number: "Р-000001", issuedToName: "Иванов Пётр", taskNumber: "З-000123", taskTitle: "Замена лампы", condition: "G", quantity: 2, steps: [issuedStep("2026-11-17T09:00:00.000Z")] })
    ], now);
    assert.equal(sheet?.name, "У инженеров");
    assert.deepEqual(sheet?.rows[0], ["Инженер", "Резерв", "Артикул", "Наименование", "Количество", "Состояние", "Задача", "Выдана", "Дней у инженера"]);
    assert.deepEqual(sheet?.rows[1], [
      "Иванов Пётр", "Р-000001", "AU-LAMP", "Лампа", 2, "Г, гарантийная", "З-000123 · Замена лампы",
      { date: "2026-11-17T09:00:00.000Z", withTime: true }, 3
    ]);
  });
});
