import assert from "node:assert/strict";
import test from "node:test";
import { buildXlsx } from "./xlsx.js";
import {
  buildImportPlan,
  columnLetter,
  historySourceKey,
  issueSeverity,
  readImportDate,
  readImportFile,
  readImportNumber,
  type ImportSnapshot
} from "./import-1c.js";
import { CUSTOMER_SAMPLE_PATH, customerSampleWorkbook } from "./import-sample.test-helper.js";

/** Справочник моделей стенда: ровно то, что заводит миграция 0001. */
const CATALOG: ImportSnapshot = {
  manufacturers: [{ name: "Beckman Coulter", isActive: true }, { name: "Mindray", isActive: true }],
  sites: ["Мариинская больница", "ГП № 87"],
  payers: ["МедТехСервис"],
  models: [
    { id: "m-dxh800", name: "DxH-800", manufacturerId: "bc", manufacturerName: "Beckman Coulter", isActive: true },
    { id: "m-au480", name: "AU 480", manufacturerId: "bc", manufacturerName: "Beckman Coulter", isActive: true },
    { id: "m-bs620", name: "BS-620", manufacturerId: "mr", manufacturerName: "Mindray", isActive: true }
  ],
  equipment: [],
  historyKeys: []
};

const EMPTY_BASE: ImportSnapshot = { manufacturers: [], models: [], sites: [], payers: [], equipment: [], historyKeys: [] };

test("дата из клетки: по-русски день впереди, число Excel тоже дата", () => {
  assert.deepEqual(readImportDate("15.03.2023"), { ok: true, date: "2023-03-15" });
  assert.deepEqual(readImportDate("2024-03-25"), { ok: true, date: "2024-03-25" });
  assert.deepEqual(readImportDate("1.9.24"), { ok: true, date: "2024-09-01" });
  assert.deepEqual(readImportDate(45376), { ok: true, date: "2024-03-25" });
  assert.deepEqual(readImportDate(null), { ok: false, reason: "empty" });
  assert.deepEqual(readImportDate("31.02.2024"), { ok: false, reason: "invalid" });
  assert.deepEqual(readImportDate("вчера"), { ok: false, reason: "invalid" });
  assert.deepEqual(readImportDate(5), { ok: false, reason: "invalid" });
});

test("число из клетки: пробелы и запятая не мешают", () => {
  assert.equal(readImportNumber("1 234,5"), 1234.5);
  assert.equal(readImportNumber(42), 42);
  assert.equal(readImportNumber("12 шт"), undefined);
  assert.equal(readImportNumber(""), undefined);
});

test("имя столбца по индексу", () => {
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(3), "D");
  assert.equal(columnLetter(26), "AA");
});

test("ключ события не зависит от клиента, регистра и лишних пробелов", async () => {
  const base = { serialKey: "BE49081", happenedOn: "2023-03-15", workType: "Инсталляция", description: "инстал" };
  const key = await historySourceKey(base);
  assert.match(key, /^[0-9a-f]{64}$/u);
  assert.equal(await historySourceKey({ ...base, workType: " инсталляция " }), key);
  assert.notEqual(await historySourceKey({ ...base, happenedOn: "2023-03-16" }), key);
  assert.notEqual(await historySourceKey({ ...base, serialKey: "BE49082" }), key);
  assert.notEqual(await historySourceKey({ ...base, description: "инстал." }), key);
});

test("образец заказчика: 1 прибор, 15 событий, ни одной ошибки", async (t) => {
  const sample = await customerSampleWorkbook();
  if (!sample) { t.skip(`нет образца заказчика: ${CUSTOMER_SAMPLE_PATH.pathname}`); return; }
  const reading = await readImportFile(sample, { today: "2026-11-16" });
  assert.equal(reading.layout, "history-blocks");
  assert.equal(reading.sheet, "Лист1");
  assert.equal(reading.sheetRows, 19);
  // Две строки заголовков и одна пустая.
  assert.equal(reading.serviceRows, 3);
  assert.deepEqual(reading.columns, { device: "A", serial: "B", workType: "C", description: "D", date: "A", client: "B" });
  assert.deepEqual(reading.issues, []);
  assert.equal(reading.equipment.length, 1);
  assert.deepEqual(reading.equipment[0], {
    row: 7, serialNumber: "BE49081", serialKey: "BE49081", modelName: "DxH-800"
  });
  assert.equal(reading.events.length, 15);
  const first = reading.events[0];
  assert.equal(first?.row, 8);
  assert.equal(first?.happenedOn, "2023-03-15");
  // Начало дня по часам компании: 15 марта в Петербурге, а не в UTC.
  assert.equal(first?.happenedAt, "2023-03-14T21:00:00.000Z");
  assert.equal(first?.workType, "Инсталляция");
  assert.equal(first?.summary, "Инсталляция");
  assert.equal(first?.serialNumber, "BE49081");
  // Дата числом Excel в строке 14 прочитана как 25 марта 2024.
  assert.equal(reading.events.find((event) => event.row === 14)?.happenedOn, "2024-03-25");
  // Клиент у прибора по ходу истории меняется: снимок берём из строки события.
  assert.equal(reading.events.find((event) => event.row === 14)?.client, "МЕДИКАЛ ГРУПП ООО");
  assert.equal(reading.events.at(-1)?.client, "ГП № 87");
  // Описание с переводами строк сохраняется целиком, а в заголовок события идёт вид работ.
  const multiline = reading.events.find((event) => event.row === 17);
  assert.match(String(multiline?.description), /^диагностика прибора\nтрубка BSV/u);
  assert.equal(multiline?.summary, "Выезд аппликатора");
  // Ключи событий все разные: 15 строк — 15 ключей.
  assert.equal(new Set(reading.events.map((event) => event.sourceKey)).size, 15);
});

test("образец заказчика: пробный импорт на справочник стенда", async (t) => {
  const sample = await customerSampleWorkbook();
  if (!sample) { t.skip(`нет образца заказчика: ${CUSTOMER_SAMPLE_PATH.pathname}`); return; }
  const reading = await readImportFile(sample, { today: "2026-11-16" });
  const plan = buildImportPlan(reading, CATALOG);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.summary.equipmentCreate, 1);
  assert.equal(plan.summary.equipmentExists, 0);
  assert.equal(plan.summary.eventsCreate, 15);
  assert.equal(plan.summary.eventsExisting, 0);
  assert.equal(plan.summary.modelsCreate, 0);
  assert.equal(plan.summary.manufacturersCreate, 0);
  assert.equal(plan.summary.readyRows, 16);
  assert.equal(plan.summary.errorRows, 0);
  // Производитель взялся из справочника моделей: в файле его нет.
  assert.equal(plan.equipment[0]?.manufacturerName, "Beckman Coulter");
  assert.equal(plan.equipment[0]?.action, "create");
  assert.equal(plan.equipment[0]?.modelAction, "known");
  assert.equal(plan.write.equipment.length, 1);
  assert.equal(plan.write.events.length, 15);
  assert.equal(plan.write.equipment[0]?.model, "DxH-800");
  assert.ok(plan.write.events.every((event) => /^[0-9a-f]{64}$/u.test(event.sourceKey)));
});

test("образец заказчика: модели нет в справочнике — прибор и его история ждут производителя", async (t) => {
  const sample = await customerSampleWorkbook();
  if (!sample) { t.skip(`нет образца заказчика: ${CUSTOMER_SAMPLE_PATH.pathname}`); return; }
  const reading = await readImportFile(sample, { today: "2026-11-16" });
  const plan = buildImportPlan(reading, EMPTY_BASE);
  assert.equal(plan.summary.equipmentBlocked, 1);
  assert.equal(plan.summary.eventsBlocked, 15);
  assert.equal(plan.write.equipment.length, 0);
  assert.equal(plan.write.events.length, 0);
  assert.equal(plan.issues.length, 1);
  assert.equal(plan.issues[0]?.code, "model_not_in_catalog");
  assert.equal(plan.issues[0]?.row, 7);
  assert.match(String(plan.issues[0]?.fix), /Выберите производителя/u);
  // С выбранным производителем всё встаёт на место: заведём и производителя, и модель.
  const withChoice = buildImportPlan(reading, EMPTY_BASE, { defaultManufacturer: "Beckman Coulter" });
  assert.deepEqual(withChoice.issues, []);
  assert.equal(withChoice.summary.manufacturersCreate, 1);
  assert.equal(withChoice.summary.modelsCreate, 1);
  assert.equal(withChoice.summary.equipmentCreate, 1);
  assert.equal(withChoice.summary.eventsCreate, 15);
});

test("образец заказчика: вторая загрузка того же файла ничего не добавляет", async (t) => {
  const sample = await customerSampleWorkbook();
  if (!sample) { t.skip(`нет образца заказчика: ${CUSTOMER_SAMPLE_PATH.pathname}`); return; }
  const reading = await readImportFile(sample, { today: "2026-11-16" });
  const afterFirst: ImportSnapshot = {
    ...CATALOG,
    equipment: [{ id: "eq-1", serialNumber: "BE49081", modelName: "DxH-800", manufacturerName: "Beckman Coulter" }],
    historyKeys: reading.events.map((event) => event.sourceKey)
  };
  const plan = buildImportPlan(reading, afterFirst);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.summary.equipmentCreate, 0);
  assert.equal(plan.summary.equipmentExists, 1);
  assert.equal(plan.summary.eventsCreate, 0);
  assert.equal(plan.summary.eventsExisting, 15);
  assert.equal(plan.write.equipment.length, 0);
  assert.equal(plan.write.events.length, 0);
  // Тот же файл, прочитанный заново: ключи событий не зависят от порядка чтения.
  const again = await readImportFile(sample, { today: "2026-11-16" });
  assert.deepEqual(again.events.map((event) => event.sourceKey), reading.events.map((event) => event.sourceKey));
});

test("серийный номер прибора в базе найдётся при другом регистре и пробелах", async () => {
  const source = buildXlsx([{
    name: "Лист1",
    rows: [
      ["наименование прибора", "(s/n прибора)", "вид работ", "описание работ"],
      ["дата", "Наименование клиента", null, null],
      ["DxH-800", "be 49 081", null, null],
      ["15.03.2023", "Клиника", "Ремонт", "замена иглы"]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  assert.equal(reading.equipment[0]?.serialKey, "BE49081");
  const plan = buildImportPlan(reading, {
    ...CATALOG,
    equipment: [{ id: "eq-1", serialNumber: "BE49081", modelName: "DxH-800", manufacturerName: "Beckman Coulter" }]
  });
  assert.equal(plan.summary.equipmentExists, 1);
  assert.equal(plan.summary.equipmentCreate, 0);
  assert.equal(plan.summary.eventsCreate, 1);
});

test("ошибки показываются по строкам, а не одной фразой", async () => {
  const source = buildXlsx([{
    name: "Лист1",
    rows: [
      ["наименование прибора", "(s/n прибора)", "вид работ", "описание работ"],
      ["дата", "Наименование клиента", null, null],
      ["15.03.2023", "Клиника", "Ремонт", "событие до строки прибора"],
      ["DxH-800", "BE49081", null, null],
      ["не дата", "Клиника", "Ремонт", "дата не читается"],
      [null, "Клиника", "Ремонт", "даты нет совсем"],
      ["01.01.2099", "Клиника", "Ремонт", "дата из будущего"],
      ["15.03.2023", "Клиника", null, null],
      ["16.03.2023", "Клиника", "Ремонт", "замена иглы"],
      ["16.03.2023", "Другая клиника", "ремонт", "Замена иглы"],
      ["AU 480", null, null, null]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  const plan = buildImportPlan(reading, CATALOG);
  assert.deepEqual(plan.issues.map((issue) => [issue.row, issue.code]), [
    [3, "serial_unknown"],
    [5, "date_invalid"],
    [6, "date_missing"],
    [7, "date_future"],
    [8, "event_empty"],
    [10, "duplicate_in_file"],
    [11, "serial_missing"]
  ]);
  // У каждой строки сказано, что не так и что делать.
  assert.ok(plan.issues.every((issue) => issue.problem.length > 0 && issue.fix.length > 0));
  assert.match(String(plan.issues.find((issue) => issue.row === 10)?.problem), /повторяет строку 9/u);
  // Повтор строки — предупреждение: данные уже перенесены строкой 9.
  assert.deepEqual(plan.issues.filter((issue) => issueSeverity(issue.code) === "warning").map((issue) => issue.row), [10]);
  assert.equal(plan.summary.errorRows, 6);
  assert.equal(plan.summary.warningRows, 1);
  assert.equal(plan.summary.eventsCreate, 1);
  assert.equal(plan.summary.equipmentCreate, 1);
});

test("приборы списком: обычная таблица с заголовком", async () => {
  const source = buildXlsx([{
    name: "Приборы",
    rows: [
      ["Серийный номер", "Производитель", "Модель", "Площадка", "Плательщик", "Показание счётчика", "Примечание"],
      ["BE49081", "Beckman Coulter", "DxH-800", "Мариинская больница", "МедТехСервис", "1 200", "из 1С"],
      ["BE49081", "Beckman Coulter", "DxH-800", null, null, null, null],
      ["BE49090", "Beckman Coulter", "DxH-9000", "Неизвестная больница", "Нет такого плательщика", "много", null],
      [null, "Mindray", "BS-620", null, null, null, null]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  assert.equal(reading.layout, "equipment-rows");
  assert.equal(reading.equipment.length, 2);
  assert.deepEqual(reading.equipment[0], {
    row: 2, serialNumber: "BE49081", serialKey: "BE49081", modelName: "DxH-800",
    manufacturerName: "Beckman Coulter", siteName: "Мариинская больница",
    payerName: "МедТехСервис", notes: "из 1С", meterReading: 1200
  });
  const plan = buildImportPlan(reading, CATALOG);
  assert.deepEqual(plan.issues.map((issue) => [issue.row, issue.code]), [
    [3, "equipment_duplicate_in_file"],
    [4, "number_invalid"],
    [4, "site_not_found"],
    [4, "payer_not_found"],
    [5, "serial_missing"]
  ]);
  // Площадки и плательщика из файла нет в справочниках: прибор создаём без них.
  assert.equal(plan.write.equipment[1]?.site, undefined);
  assert.equal(plan.write.equipment[1]?.payer, undefined);
  assert.equal(plan.summary.errorRows, 1);
  assert.equal(plan.summary.warningRows, 2);
  assert.equal(plan.summary.equipmentCreate, 2);
  assert.equal(plan.summary.modelsCreate, 1);
  assert.equal(plan.summary.manufacturersCreate, 0);
  assert.equal(plan.write.equipment[0]?.site, "Мариинская больница");
  assert.equal(plan.write.equipment[0]?.meterReading, 1200);
});

test("непонятный файл: отказ словами, а не нулевой отчёт", async () => {
  const source = buildXlsx([{ name: "Лист1", rows: [["Январь", "Февраль"], [1, 2]] }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  assert.equal(reading.issues.length, 1);
  assert.equal(reading.issues[0]?.code, "layout_unknown");
  assert.match(String(reading.issues[0]?.fix), /наименование прибора/u);
  const plan = buildImportPlan(reading, CATALOG);
  assert.equal(plan.write.equipment.length, 0);
  assert.equal(plan.write.events.length, 0);
});

test("модель у двух производителей: импорт просит уточнить, а не угадывает", async () => {
  const source = buildXlsx([{
    name: "Лист1",
    rows: [
      ["наименование прибора", "(s/n прибора)", "вид работ", "описание работ"],
      ["дата", "Наименование клиента", null, null],
      ["Общая модель", "BE49081", null, null],
      ["15.03.2023", "Клиника", "Ремонт", "замена иглы"]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  const plan = buildImportPlan(reading, {
    ...CATALOG,
    models: [
      { id: "m-1", name: "Общая модель", manufacturerId: "bc", manufacturerName: "Beckman Coulter", isActive: true },
      { id: "m-2", name: "Общая модель", manufacturerId: "mr", manufacturerName: "Mindray", isActive: true }
    ]
  });
  assert.equal(plan.issues[0]?.code, "model_ambiguous");
  assert.match(String(plan.issues[0]?.problem), /Beckman Coulter, Mindray/u);
  assert.equal(plan.summary.equipmentBlocked, 1);
  assert.equal(plan.summary.eventsBlocked, 1);
});

test("строка без даты и без прибора: клиент во втором столбце не станет серийным номером", async () => {
  const source = buildXlsx([{
    name: "Лист1",
    rows: [
      ["наименование прибора", "(s/n прибора)", "вид работ", "описание работ"],
      ["дата", "Наименование клиента", null, null],
      ["DxH-800", "BE49081", null, null],
      [null, "ГП № 87", null, null],
      ["16.03.2023", "ГП № 87", "Ремонт", "замена иглы"]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  assert.deepEqual(reading.issues.map((issue) => [issue.row, issue.code]), [[4, "row_unclear"]]);
  assert.equal(reading.equipment.length, 1);
  assert.equal(reading.equipment[0]?.serialKey, "BE49081");
  assert.equal(reading.events.length, 1);
});

test("подзаголовки и повторные заголовки не превращаются в приборы", async () => {
  const source = buildXlsx([{
    name: "Лист1",
    rows: [
      ["наименование прибора", "(s/n прибора)", "вид работ", "описание работ"],
      ["дата", "Наименование клиента", null, null],
      ["март 2023", "ООО «Ромашка»", null, null],
      ["DxH-800", "BE49081", null, null],
      ["15.03.2023", "Клиника", "Ремонт", "замена иглы"],
      ["наименование прибора", "(s/n прибора)", "вид работ", "описание работ"],
      ["дата", "Наименование клиента", null, null],
      ["DxH-800", "BE49082", null, null],
      ["16.03.2023", "Клиника", "Ремонт", "замена иглы"]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  // Строка с периодом и клиентом прибором не становится, и про неё сказано.
  assert.deepEqual(reading.issues.map((issue) => [issue.row, issue.code]), [[3, "row_unclear"]]);
  assert.deepEqual(reading.equipment.map((item) => item.serialNumber), ["BE49081", "BE49082"]);
  assert.deepEqual(reading.events.map((event) => `${event.row}:${event.serialNumber}`), ["5:BE49081", "9:BE49082"]);
  const plan = buildImportPlan(reading, CATALOG);
  assert.equal(plan.write.equipment.length, 2);
  assert.equal(plan.write.events.length, 2);
});

test("плоская таблица работ: одна строка — прибор и его событие", async () => {
  const source = buildXlsx([{
    name: "Работы",
    rows: [
      ["Серийный номер", "Модель", "Дата", "Вид работ", "Описание работ", "Инженер"],
      ["BE49081", "DxH-800", "15.03.2023", "Ремонт", "замена иглы", "Петров"],
      ["BE49081", "DxH-800", "16.03.2023", "Выезд ТО", null, "Петров"],
      ["BE49082", "DxH-800", "17.03.2023", "Ремонт", "замена насоса", "Петров"]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  assert.equal(reading.layout, "equipment-rows");
  // Лишний столбец «Инженер» заголовок находить не мешает.
  assert.deepEqual(reading.issues, []);
  assert.deepEqual(reading.equipment.map((item) => item.serialNumber), ["BE49081", "BE49082"]);
  assert.equal(reading.events.length, 3);
  assert.equal(reading.events[1]?.workType, "Выезд ТО");
  const plan = buildImportPlan(reading, CATALOG);
  assert.equal(plan.summary.equipmentCreate, 2);
  assert.equal(plan.summary.eventsCreate, 3);
});

test("скрытая модель справочника: отказ до записи, а не после", async () => {
  const source = buildXlsx([{
    name: "Лист1",
    rows: [
      ["наименование прибора", "(s/n прибора)", "вид работ", "описание работ"],
      ["дата", "Наименование клиента", null, null],
      ["BS-620", "BE49081", null, null],
      ["15.03.2023", "Клиника", "Ремонт", "замена иглы"]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  const plan = buildImportPlan(reading, {
    ...CATALOG,
    models: CATALOG.models.map((model) => model.name === "BS-620" ? { ...model, isActive: false } : model)
  });
  assert.deepEqual(plan.issues.map((issue) => issue.code), ["model_hidden"]);
  assert.match(String(plan.issues[0]?.fix), /Показать/u);
  assert.equal(plan.write.equipment.length, 0);
  assert.equal(plan.summary.equipmentBlocked, 1);
});

test("прибор уже в реестре: его история переносится, даже если модель спорная", async () => {
  const source = buildXlsx([{
    name: "Лист1",
    rows: [
      ["наименование прибора", "(s/n прибора)", "вид работ", "описание работ"],
      ["дата", "Наименование клиента", null, null],
      ["Общая модель", "BE49081", null, null],
      ["15.03.2023", "Клиника", "Ремонт", "замена иглы"]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  const plan = buildImportPlan(reading, {
    ...CATALOG,
    models: [
      { id: "m-1", name: "Общая модель", manufacturerId: "bc", manufacturerName: "Beckman Coulter", isActive: true },
      { id: "m-2", name: "Общая модель", manufacturerId: "mr", manufacturerName: "Mindray", isActive: true }
    ],
    equipment: [{ id: "eq-1", serialNumber: "BE49081", modelName: "DxH-800", manufacturerName: "Beckman Coulter" }]
  });
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.summary.equipmentExists, 1);
  assert.equal(plan.summary.eventsCreate, 1);
  assert.equal(plan.summary.modelsCreate, 0);
  // Расхождение показываем честно: в файле другое название модели.
  assert.deepEqual(plan.equipment[0]?.differences, [
    { field: "Модель", inFile: "Общая модель", inBase: "DxH-800" }
  ]);
});

test("выбранный производитель разводит одинаковые названия моделей", async () => {
  const source = buildXlsx([{
    name: "Лист1",
    rows: [
      ["наименование прибора", "(s/n прибора)", "вид работ", "описание работ"],
      ["дата", "Наименование клиента", null, null],
      ["Общая модель", "BE49099", null, null],
      ["15.03.2023", "Клиника", "Ремонт", "замена иглы"]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  const base: ImportSnapshot = {
    ...CATALOG,
    models: [
      { id: "m-1", name: "Общая модель", manufacturerId: "bc", manufacturerName: "Beckman Coulter", isActive: true },
      { id: "m-2", name: "Общая модель", manufacturerId: "mr", manufacturerName: "Mindray", isActive: true }
    ]
  };
  assert.equal(buildImportPlan(reading, base).issues[0]?.code, "model_ambiguous");
  const chosen = buildImportPlan(reading, base, { defaultManufacturer: "Mindray" });
  assert.deepEqual(chosen.issues, []);
  assert.equal(chosen.equipment[0]?.manufacturerName, "Mindray");
  assert.equal(chosen.summary.modelsCreate, 0);
  assert.equal(chosen.write.equipment[0]?.manufacturer, "Mindray");
});

test("площадка с одинаковым названием у двух организаций не привязывается молча", async () => {
  const source = buildXlsx([{
    name: "Приборы",
    rows: [
      ["Серийный номер", "Производитель", "Модель", "Площадка"],
      ["BE49081", "Beckman Coulter", "DxH-800", "Поликлиника № 1"]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  const plan = buildImportPlan(reading, {
    ...CATALOG,
    sites: ["Поликлиника № 1", "Поликлиника № 1"]
  });
  assert.deepEqual(plan.issues.map((issue) => issue.code), ["site_ambiguous"]);
  assert.equal(plan.write.equipment[0]?.site, undefined);
  assert.equal(plan.summary.equipmentCreate, 1);
});

test("непонятная строка обрывает блок: события не садятся на прежний прибор", async () => {
  const source = buildXlsx([{
    name: "Лист1",
    rows: [
      ["наименование прибора", "(s/n прибора)", "вид работ", "описание работ"],
      ["дата", "Наименование клиента", null, null],
      ["DxH-800", "BE49081", null, null],
      ["15.03.2023", "Клиника", "Ремонт", "замена иглы"],
      ["ГП № 87", "ООО «Ромашка»", null, null],
      ["16.03.2023", "Клиника", "Ремонт", "замена насоса"]
    ]
  }]);
  const reading = await readImportFile(source, { today: "2026-11-16" });
  assert.deepEqual(reading.issues.map((issue) => [issue.row, issue.code]), [
    [5, "row_unclear"],
    [6, "serial_unknown"]
  ]);
  // Второе событие не досталось прибору BE49081.
  assert.deepEqual(reading.events.map((event) => `${event.row}:${event.serialNumber}`), ["4:BE49081"]);
});
