/**
 * Выгрузка реестров в Excel: приборы, задачи, склад и резервы. ТЗ требует выгрузку
 * «везде», а она была только в отчёте за период и на вкладке «У инженеров».
 *
 * Файл собирает тот же генератор, что и отчёт (buildXlsxCompressed из xlsx.ts):
 * один формат, одни даты по часам компании, своего формата здесь нет.
 *
 * Денег в реестрах нет ни в одной строке: цена прихода партии закрыта от ролей API
 * на уровне базы (миграция 0040), а суммы счетов живут в финансовом контуре. Поэтому
 * эти выгрузки одинаковы для инженера, кладовщика и руководителя — скрывать нечего.
 * Если в реестре когда-нибудь появится сумма, её столбец нужно закрыть правом
 * `finance.read`, как лист «Затраты» в отчёте.
 */
import type { EquipmentApiRecord, InventoryPartRecord, StockReservationRecord, TaskApiRecord } from "./m2-api.js";
import { TASK_STATUS_LABELS } from "./domain/task-status.js";
import { RESERVATION_CONDITION_LABELS, RESERVATION_STATUS_LABELS, reservationEngineerName } from "./reservations.js";
import { companyDateText } from "./task-dates.js";
import { XLSX_MIME, buildXlsxCompressed, type XlsxCell, type XlsxSheet } from "./xlsx.js";

/** Справочник «код → название»: виды работ, этапы, статусы приборов. */
export type NameByCode = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

function lookup(source: NameByCode | undefined, code: string): string | undefined {
  const found = source instanceof Map ? source.get(code) : (source as Readonly<Record<string, string>> | undefined)?.[code];
  return found || undefined;
}

/** Название по коду: из справочника, а без него — сам код, чтобы строка не опустела. */
function nameOf(source: NameByCode | undefined, code: string | undefined): string {
  if (!code) return "";
  return lookup(source, code) ?? code;
}

/** Этап задачи: из справочника базы, иначе из общего списка интерфейса, иначе код. */
function taskStatusName(source: NameByCode | undefined, code: string): string {
  return lookup(source, code) ?? TASK_STATUS_LABELS[code] ?? code;
}

/** Имя файла с сегодняшним днём по часам компании: «Приборы 16.11.2026.xlsx». */
export function registryFileName(title: string, now: Date = new Date()): string {
  return `${title} ${companyDateText(now.toISOString())}.xlsx`;
}

const EQUIPMENT_HEADER = [
  "Заводской номер", "Производитель", "Модель", "Категория гарантии",
  "Организация", "Площадка", "Плательщик", "Статус", "Показание счётчика", "Примечания"
];

/** Лист «Приборы»: реестр приборов в том виде, в каком он на экране. */
export function equipmentRegistrySheets(items: readonly EquipmentApiRecord[], statuses?: NameByCode): readonly XlsxSheet[] {
  const rows: XlsxCell[][] = items.map((item) => [
    item.serialNumber,
    item.manufacturer,
    item.model,
    item.guaranteeCategory ?? "",
    item.organization ?? "",
    item.site ?? "",
    item.payer ?? "",
    item.statusName ?? nameOf(statuses, item.status),
    item.lastMeterReading ?? "",
    item.notes ?? ""
  ]);
  return [{
    name: "Приборы",
    rows: [EQUIPMENT_HEADER, ...rows],
    headerRow: 1,
    widths: [20, 24, 28, 22, 28, 30, 28, 18, 18, 40]
  }];
}

const TASK_HEADER = [
  "Номер", "Название", "Этап", "Срочность", "Вид работ", "Гарантийность",
  "Площадка", "Прибор", "Заводской номер", "Инженер",
  "Дата вызова", "Срок с", "Срок по", "Дата выезда", "Окончание работ", "Часы"
];

/** «Г» и «Н» в реестре пишем так же, как в акте и отчёте. */
function modifierLabel(modifier: TaskApiRecord["workModifier"]): string {
  if (modifier === "G") return "Г · гарантийные работы";
  if (modifier === "N") return "Н · вина пользователя";
  return "";
}

/** Прибор одной строкой: производитель, модель. Заводской номер идёт отдельным столбцом. */
function equipmentLabelText(label: TaskApiRecord["equipmentLabel"]): string {
  if (!label) return "";
  return [label.manufacturer, label.model].filter(Boolean).join(" ");
}

/** Лист «Задачи»: реестр задач с фильтрами в шапке. */
export function taskRegistrySheets(
  items: readonly TaskApiRecord[],
  references: { readonly workTypes?: NameByCode; readonly statuses?: NameByCode } = {}
): readonly XlsxSheet[] {
  const rows: XlsxCell[][] = items.map((task) => [
    task.number,
    task.title,
    taskStatusName(references.statuses, task.status),
    task.priority === "urgent" ? "Срочная" : "Плановая",
    nameOf(references.workTypes, task.workTypeCode),
    modifierLabel(task.workModifier),
    task.customer?.siteName ?? "",
    equipmentLabelText(task.equipmentLabel),
    task.equipmentLabel?.serialNumber ?? "",
    task.engineerName ?? "",
    task.callDate ? { date: task.callDate.slice(0, 10) } : "",
    task.periodFrom ? { date: task.periodFrom.slice(0, 10) } : "",
    task.periodTo ? { date: task.periodTo.slice(0, 10) } : "",
    task.visitDate ? { date: task.visitDate.slice(0, 10) } : "",
    // Время окончания — только если инженер его ввёл: иначе дата окончания это полдень
    // дня выезда, и время в выгрузке было бы придуманным. То же правило, что в отчёте.
    task.completedAt ? { date: task.completedAt, withTime: Boolean(task.workFinishedAt) } : "",
    task.hours ?? ""
  ]);
  return [{
    name: "Задачи",
    rows: [TASK_HEADER, ...rows],
    headerRow: 1,
    widths: [12, 40, 14, 11, 24, 24, 30, 26, 18, 26, 13, 11, 11, 13, 17, 8]
  }];
}

const INVENTORY_HEADER = [
  "Артикул", "Наименование", "На складе", "В резерве", "Доступно",
  "У инженеров", "Минимальный остаток", "Ниже минимума", "В работе", "Примечания"
];

/** Лист «Склад»: остатки номенклатуры. Цен здесь нет — они закрыты в базе. */
export function inventoryRegistrySheets(items: readonly InventoryPartRecord[]): readonly XlsxSheet[] {
  const rows: XlsxCell[][] = items.map((item) => [
    item.articleNumber,
    item.name,
    item.onHandQuantity,
    item.reservedQuantity,
    item.availableQuantity,
    item.withEngineersQuantity,
    item.minimumStock,
    item.belowMinimum ? "Да" : "",
    item.isActive ? "Да" : "",
    item.notes ?? ""
  ]);
  return [{
    name: "Склад",
    rows: [INVENTORY_HEADER, ...rows],
    headerRow: 1,
    widths: [20, 40, 12, 12, 12, 14, 20, 15, 10, 40]
  }];
}

const RESERVATION_HEADER = [
  "Резерв", "Состояние резерва", "Артикул", "Наименование", "Количество", "Состояние партии",
  "Задача", "Название задачи", "Инженер", "Установлена", "Создан", "Выдана", "Изменён"
];

/**
 * Когда запчасть выдали инженеру. В отличие от reservationIssuedAt (вкладка «У инженеров»,
 * где выданы все) здесь нет подмены последним изменением: невыданный резерв в реестре
 * должен быть без даты выдачи, а не с датой, которая к выдаче не относится.
 */
function issuedAt(reservation: StockReservationRecord): string | undefined {
  return [...reservation.steps].reverse().find((step) => step.status === "issued")?.changedAt;
}

/** Лист «Резервы»: цепочка резервов запчастей целиком, как в реестре. */
export function reservationRegistrySheets(items: readonly StockReservationRecord[]): readonly XlsxSheet[] {
  const rows: XlsxCell[][] = items.map((item) => {
    const issued = issuedAt(item);
    return [
      item.number,
      RESERVATION_STATUS_LABELS[item.status],
      item.articleNumber,
      item.partName,
      item.quantity,
      RESERVATION_CONDITION_LABELS[item.condition],
      item.taskNumber ?? "",
      item.taskTitle ?? "",
      reservationEngineerName(item) ?? "",
      item.installMarked ? "Да" : "",
      { date: item.createdAt, withTime: true },
      issued ? { date: issued, withTime: true } : "",
      { date: item.updatedAt, withTime: true }
    ];
  });
  return [{
    name: "Резервы",
    rows: [RESERVATION_HEADER, ...rows],
    headerRow: 1,
    widths: [12, 20, 20, 40, 12, 22, 12, 40, 26, 14, 17, 17, 17]
  }];
}

/** Предел выгрузки: случайный отбор на всю базу не должен положить браузер. */
export const REGISTRY_EXPORT_MAX_ROWS = 20_000;

/**
 * Приписка к сообщению о выгрузке, когда строк столько, что сработал предел: человек
 * должен знать, что файл неполный, а не думать, что в реестре ровно столько записей.
 */
export function registryExportNote(rows: number, maxRows = REGISTRY_EXPORT_MAX_ROWS): string {
  return rows >= maxRows ? ". Это предел выгрузки, уточните отбор — в реестре их больше" : "";
}

/**
 * Все строки реестра под текущим отбором, а не только открытая страница: выгрузка
 * должна совпадать с тем, что реестр нашёл. Читаем страницами, как отдаёт сервер.
 * Последняя страница дочитывается целиком, поэтому строк бывает чуть больше предела —
 * обрывать её на середине значило бы отдать неполную страницу без предупреждения.
 */
export async function allRegistryRows<Item>(
  load: (limit: number, offset: number) => Promise<{ readonly items: readonly Item[]; readonly total: number }>,
  pageSize = 500,
  maxRows = REGISTRY_EXPORT_MAX_ROWS
): Promise<readonly Item[]> {
  const rows: Item[] = [];
  let total = 0;
  do {
    const page = await load(pageSize, rows.length);
    total = page.total;
    // Сервер отдал пустую страницу: дальше читать нечего, даже если total больше.
    // Иначе цикл крутился бы до предела на подсчёте, который разошёлся со строками.
    if (page.items.length === 0) break;
    rows.push(...page.items);
  } while (rows.length < Math.min(total, maxRows));
  return rows;
}

export function registryWorkbook(sheets: readonly XlsxSheet[]): Promise<Uint8Array> {
  return buildXlsxCompressed(sheets);
}

/**
 * Отдать собранный файл браузеру. Один путь для всех выгрузок: ссылка на объект,
 * клик по ней и освобождение памяти спустя полминуты, чтобы файл успел сохраниться.
 */
export async function downloadWorkbook(sheets: readonly XlsxSheet[], fileName: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([(await registryWorkbook(sheets)) as BlobPart], { type: XLSX_MIME }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
