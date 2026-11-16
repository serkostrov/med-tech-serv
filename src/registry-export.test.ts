import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allRegistryRows,
  equipmentRegistrySheets,
  registryExportNote,
  inventoryRegistrySheets,
  registryFileName,
  reservationRegistrySheets,
  taskRegistrySheets
} from "./registry-export.js";
import type { EquipmentApiRecord, InventoryPartRecord, StockReservationRecord, TaskApiRecord } from "./m2-api.js";
import { XLSX_MIME } from "./xlsx.js";

/** Текст шапки листа: заголовки приходят жирными ячейками. */
function headerOf(rows: readonly (readonly unknown[])[]): readonly unknown[] {
  return rows[0] ?? [];
}

describe("выгрузка реестра приборов", () => {
  const items: EquipmentApiRecord[] = [
    {
      id: "eq-1", serialNumber: "BE49081", manufacturer: "Beckman Coulter", model: "DxH 800",
      guaranteeCategory: "Стандартная", organization: "Подпорожская МБ", site: "КДЛ",
      payer: "Подпорожская МБ", status: "in_service", statusName: "В эксплуатации",
      lastMeterReading: 12_345, notes: "Шумит помпа"
    },
    { id: "eq-2", serialNumber: "SN-2", manufacturer: "Mindray", model: "BS-240", status: "repair_needed" }
  ];

  it("отдаёт один лист со всеми столбцами реестра и закреплённой шапкой", () => {
    const [sheet] = equipmentRegistrySheets(items, { repair_needed: "Требует ремонта" });
    assert.equal(sheet?.name, "Приборы");
    assert.equal(sheet?.headerRow, 1);
    assert.equal(sheet?.rows.length, 3);
    assert.deepEqual(headerOf(sheet?.rows ?? []).slice(0, 4), ["Заводской номер", "Производитель", "Модель", "Категория гарантии"]);
    assert.deepEqual(sheet?.rows[1], [
      "BE49081", "Beckman Coulter", "DxH 800", "Стандартная", "Подпорожская МБ", "КДЛ",
      "Подпорожская МБ", "В эксплуатации", 12_345, "Шумит помпа"
    ]);
  });

  it("пустые поля прибора остаются пустыми, а статус берётся из справочника", () => {
    const [sheet] = equipmentRegistrySheets(items, { repair_needed: "Требует ремонта" });
    assert.deepEqual(sheet?.rows[2], ["SN-2", "Mindray", "BS-240", "", "", "", "", "Требует ремонта", "", ""]);
  });

  it("без справочника статусов в столбце остаётся код, а не пустота", () => {
    const [sheet] = equipmentRegistrySheets([items[1]!]);
    assert.equal(sheet?.rows[1]?.[7], "repair_needed");
  });
});

describe("выгрузка реестра задач", () => {
  const base: TaskApiRecord = {
    id: "t-1", number: "З-000123", title: "Не включается", status: "in_progress",
    workTypeCode: "repair", workModifier: "G", priority: "urgent",
    customer: { siteName: "Подпорожская МБ, КДЛ", address: "Подпорожье" },
    equipmentLabel: { serialNumber: "BE49081", model: "DxH 800", manufacturer: "Beckman Coulter" },
    engineerName: "Иванов П. А.", callDate: "2026-11-02", periodFrom: "2026-11-03", periodTo: "2026-11-07",
    visitDate: "2026-11-04", createdAt: "2026-11-02T07:00:00.000Z", updatedAt: "2026-11-04T10:00:00.000Z"
  };

  it("пишет этап, срочность, вид работ и гарантийность словами", () => {
    const [sheet] = taskRegistrySheets([base], { workTypes: new Map([["repair", "Ремонт"]]) });
    assert.equal(sheet?.name, "Задачи");
    assert.equal(sheet?.headerRow, 1);
    const row = sheet?.rows[1] ?? [];
    assert.equal(row[2], "В работе");
    assert.equal(row[3], "Срочная");
    assert.equal(row[4], "Ремонт");
    assert.equal(row[5], "Г · гарантийные работы");
    assert.equal(row[6], "Подпорожская МБ, КДЛ");
    assert.equal(row[7], "Beckman Coulter DxH 800");
    assert.equal(row[8], "BE49081");
  });

  it("даты идут настоящими датами Excel, а срочность плановой задачи — «Плановая»", () => {
    const [sheet] = taskRegistrySheets([{ ...base, priority: "planned", workModifier: undefined }]);
    const row = sheet?.rows[1] ?? [];
    assert.equal(row[3], "Плановая");
    assert.equal(row[5], "");
    assert.deepEqual(row[10], { date: "2026-11-02" });
    assert.deepEqual(row[11], { date: "2026-11-03" });
    assert.deepEqual(row[12], { date: "2026-11-07" });
    assert.deepEqual(row[13], { date: "2026-11-04" });
  });

  it("время окончания работ показывает только то, что ввёл инженер", () => {
    const withTime = taskRegistrySheets([{ ...base, completedAt: "2026-11-05T09:00:00.000Z", workFinishedAt: "2026-11-05T09:00:00.000Z" }]);
    assert.deepEqual(withTime[0]?.rows[1]?.[14], { date: "2026-11-05T09:00:00.000Z", withTime: true });
    const withoutTime = taskRegistrySheets([{ ...base, completedAt: "2026-11-05T09:00:00.000Z" }]);
    assert.deepEqual(withoutTime[0]?.rows[1]?.[14], { date: "2026-11-05T09:00:00.000Z", withTime: false });
    assert.equal(taskRegistrySheets([base])[0]?.rows[1]?.[14], "");
  });

  it("у задачи без прибора, площадки и инженера столбцы пустые, а не «undefined»", () => {
    const [sheet] = taskRegistrySheets([{
      id: "t-2", number: "З-2", title: "Прочие работы", status: "new", workTypeCode: "other", hours: 2.5,
      createdAt: "2026-11-02T07:00:00.000Z", updatedAt: "2026-11-02T07:00:00.000Z"
    }]);
    const row = sheet?.rows[1] ?? [];
    assert.deepEqual(row.slice(6, 10), ["", "", "", ""]);
    assert.equal(row[15], 2.5);
  });
});

describe("выгрузка склада", () => {
  const parts: InventoryPartRecord[] = [
    {
      id: "p-1", articleNumber: "ART-1", name: "Клапан", minimumStock: 5, isActive: true,
      onHandQuantity: 2, reservedQuantity: 1, availableQuantity: 1, withEngineersQuantity: 3,
      belowMinimum: true, notes: "Заказан"
    },
    {
      id: "p-2", articleNumber: "ART-2", name: "Шланг", minimumStock: 0, isActive: false,
      onHandQuantity: 0, reservedQuantity: 0, availableQuantity: 0, withEngineersQuantity: 0,
      belowMinimum: false
    }
  ];

  it("отдаёт остатки и подсветку минимума словами", () => {
    const [sheet] = inventoryRegistrySheets(parts);
    assert.equal(sheet?.name, "Склад");
    assert.deepEqual(sheet?.rows[1], ["ART-1", "Клапан", 2, 1, 1, 3, 5, "Да", "Да", "Заказан"]);
    assert.deepEqual(sheet?.rows[2], ["ART-2", "Шланг", 0, 0, 0, 0, 0, "", "", ""]);
  });

  it("в выгрузке склада нет ни одного столбца с ценой: цены закрыты в базе", () => {
    const [sheet] = inventoryRegistrySheets(parts);
    const header = headerOf(sheet?.rows ?? []).join(" ");
    assert.ok(!/цен|сумм|стоим|руб/iu.test(header), `в шапке склада нашлись деньги: ${header}`);
  });
});

describe("выгрузка резервов", () => {
  const reservation: StockReservationRecord = {
    id: "r-1", number: "Р-7", status: "issued", partId: "p-1", articleNumber: "ART-1",
    partName: "Клапан", condition: "N", quantity: 2, taskId: "t-1", taskNumber: "З-123",
    taskTitle: "Не включается", taskStatus: "in_progress", engineerName: "Иванов П. А.",
    issuedToName: "Петров С. С.", installMarked: false,
    steps: [
      { status: "created", changedAt: "2026-11-02T07:00:00.000Z" },
      { status: "issued", fromStatus: "warehouse_notified", changedAt: "2026-11-03T08:00:00.000Z", actorName: "Кладовщик" }
    ],
    createdAt: "2026-11-02T07:00:00.000Z", updatedAt: "2026-11-03T08:00:00.000Z"
  };

  it("пишет состояние резерва, партию и того, кому выдали", () => {
    const [sheet] = reservationRegistrySheets([reservation]);
    assert.equal(sheet?.name, "Резервы");
    const row = sheet?.rows[1] ?? [];
    assert.equal(row[0], "Р-7");
    assert.equal(row[1], "У инженера");
    assert.equal(row[5], "Н, новая");
    assert.equal(row[8], "Петров С. С.", "в выгрузке тот, кому выдали, а не инженер задачи");
    assert.equal(row[9], "");
    assert.deepEqual(row[11], { date: "2026-11-03T08:00:00.000Z", withTime: true });
  });

  it("у невыданного резерва столбец «Выдана» пуст", () => {
    const [sheet] = reservationRegistrySheets([{ ...reservation, status: "created", steps: [reservation.steps[0]!], issuedToName: undefined }]);
    const row = sheet?.rows[1] ?? [];
    assert.equal(row[8], "Иванов П. А.");
    assert.equal(row[11], "");
  });

  it("отметка об установке пишется словом", () => {
    const [sheet] = reservationRegistrySheets([{ ...reservation, status: "installed", installMarked: true }]);
    assert.equal(sheet?.rows[1]?.[9], "Да");
  });
});

describe("имя файла выгрузки", () => {
  it("содержит день по часам компании", () => {
    // 21:30 UTC это 00:30 следующего дня по Москве: имя файла берёт московский день.
    assert.equal(registryFileName("Приборы", new Date("2026-11-15T21:30:00.000Z")), "Приборы 16.11.2026.xlsx");
    assert.equal(registryFileName("Задачи", new Date("2026-11-16T09:00:00.000Z")), "Задачи 16.11.2026.xlsx");
  });

  it("расширение совпадает с типом файла, который отдаём браузеру", () => {
    assert.ok(registryFileName("Склад").endsWith(".xlsx"));
    assert.match(XLSX_MIME, /spreadsheetml\.sheet/u);
  });
});

describe("чтение всех строк реестра", () => {
  it("читает страницами, пока не соберёт всё найденное", async () => {
    const all = Array.from({ length: 7 }, (_, index) => index);
    const calls: number[] = [];
    const { rows, truncated } = await allRegistryRows(async (limit, offset) => {
      calls.push(offset);
      return { items: all.slice(offset, offset + limit), total: all.length };
    }, 3);
    assert.deepEqual(rows, all);
    assert.deepEqual(calls, [0, 3, 6]);
    assert.equal(truncated, false);
  });

  it("останавливается на пределе и говорит, что собрано не всё", async () => {
    const { rows, truncated } = await allRegistryRows(async (limit, offset) => ({
      items: Array.from({ length: limit }, (_, index) => offset + index),
      total: 10_000
    }), 100, 250);
    assert.equal(rows.length, 300, "последняя страница читается целиком и на ней чтение кончается");
    assert.equal(truncated, true);
  });

  it("реестр ровно в размер предела не считается обрезанным", async () => {
    const { rows, truncated } = await allRegistryRows(async (limit, offset) => ({
      items: Array.from({ length: Math.min(limit, 200 - offset) }, (_, index) => offset + index),
      total: 200
    }), 100, 200);
    assert.equal(rows.length, 200);
    assert.equal(truncated, false, "всё найденное в файле, предупреждать не о чем");
  });

  it("пустая страница останавливает чтение, даже если подсчёт больше", async () => {
    let calls = 0;
    const { rows, truncated } = await allRegistryRows(async () => {
      calls += 1;
      return { items: calls === 1 ? [1, 2] : [], total: 100 };
    }, 2);
    assert.deepEqual(rows, [1, 2]);
    assert.equal(calls, 2, "второй пустой ответ прекращает цикл");
    assert.equal(truncated, true, "подсчёт обещал больше строк, чем сервер отдал");
  });

  it("приписка появляется только у обрезанной выгрузки", () => {
    assert.equal(registryExportNote(false), "");
    assert.match(registryExportNote(true), /предел выгрузки/u);
  });
});
