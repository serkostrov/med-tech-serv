/**
 * Перенос данных из Excel и выгрузок 1С в реестр приборов.
 *
 * Здесь только разбор файла и сверка с базой — ни одной записи. Экран сначала
 * показывает человеку, что получилось: сколько строк прочитано, что не так в
 * каждой строке и что именно появится в базе. Записью занимается функция базы
 * import_equipment_history (миграция 0054), и только после подтверждения.
 *
 * Два вида файлов:
 *   - «история прибора» (образец заказчика): строка с названием прибора и S/N
 *     открывает блок, следующие строки — события по этому прибору. В первом
 *     столбце у блока название прибора, а у события дата; во втором — S/N у
 *     блока и клиент у события;
 *   - «приборы списком»: обычная таблица с заголовком, одна строка — один прибор.
 *
 * Ключи сопоставления берём те же, что у базы: прибор — серийный номер без
 * пробелов и регистра (generated column equipment.serial_number_normalized),
 * событие — sha256 от содержания события (equipment_history.source_key с
 * уникальным индексом по прибору). Поэтому повторная загрузка того же файла
 * ничего не удваивает.
 */
import { normalizeEquipmentSerial } from "./equipment-passport.js";
import { companyDayStart, companyToday } from "./task-dates.js";
import { readXlsxWorkbook, type XlsxCellValue, type XlsxReadSheet } from "./xlsx-read.js";

export type ImportLayout = "history-blocks" | "equipment-rows";

export type ImportIssueCode =
  | "layout_unknown"
  | "sheet_empty"
  | "serial_unknown"
  | "serial_missing"
  | "model_missing"
  | "date_missing"
  | "date_invalid"
  | "date_future"
  | "event_empty"
  | "row_unclear"
  | "duplicate_in_file"
  | "equipment_duplicate_in_file"
  | "model_not_in_catalog"
  | "model_ambiguous"
  | "number_invalid";

/** Строка файла, с которой что-то не так: где, что и что с этим делать. */
export interface ImportRowIssue {
  /** Номер строки, как его видно в Excel. 0 — замечание ко всему листу. */
  readonly row: number;
  /** Буква столбца, если дело в конкретной клетке. */
  readonly column?: string;
  readonly code: ImportIssueCode;
  readonly problem: string;
  readonly fix: string;
}

export interface ImportEquipmentRow {
  readonly row: number;
  readonly serialNumber: string;
  readonly serialKey: string;
  readonly modelName: string;
  readonly manufacturerName?: string;
  readonly siteName?: string;
  readonly payerName?: string;
  readonly notes?: string;
  readonly meterReading?: number;
}

export interface ImportHistoryRow {
  readonly row: number;
  readonly serialKey: string;
  readonly serialNumber: string;
  /** Календарная дата события: «2023-03-15». */
  readonly happenedOn: string;
  /** Момент для базы: начало дня по часам компании. */
  readonly happenedAt: string;
  readonly client: string;
  readonly workType: string;
  readonly description: string;
  readonly summary: string;
  readonly sourceKey: string;
}

export interface ImportReading {
  readonly sheet: string;
  readonly layout: ImportLayout;
  /** Сколько строк есть на листе. */
  readonly sheetRows: number;
  /** Строки заголовков и пустые: их не считаем ни данными, ни ошибками. */
  readonly serviceRows: number;
  readonly equipment: readonly ImportEquipmentRow[];
  readonly events: readonly ImportHistoryRow[];
  readonly issues: readonly ImportRowIssue[];
  readonly columns: Readonly<Record<string, string>>;
}

type ColumnRole =
  | "device" | "serial" | "date" | "client" | "workType" | "description"
  | "manufacturer" | "model" | "site" | "payer" | "notes" | "meter";

const COLUMN_ALIASES: Readonly<Record<ColumnRole, readonly RegExp[]>> = {
  device: [/^наименование прибора$/u, /^прибор$/u, /^наименование оборудования$/u],
  serial: [/^\(?s\s*\/?\s*n(\s*прибора)?\)?$/u, /^серийный номер( прибора)?$/u, /^заводской номер$/u, /^serialnumber$/u],
  date: [/^дата( работы| события| выезда)?$/u, /^date$/u],
  client: [/^(наименование )?клиента?$/u, /^заказчик$/u, /^организация$/u],
  workType: [/^вид работ(ы)?$/u, /^тип работ$/u, /^worktype$/u],
  description: [/^описание( работ| работы)?$/u, /^комментарий к работам$/u, /^description$/u],
  manufacturer: [/^производитель$/u, /^manufacturer$/u, /^бренд$/u],
  model: [/^модель( прибора)?$/u, /^model$/u],
  site: [/^площадка$/u, /^место установки$/u, /^адрес установки$/u],
  payer: [/^плательщик$/u, /^payer$/u],
  notes: [/^примечани[ея]$/u, /^комментарий$/u, /^notes$/u],
  meter: [/^показание счетчика$/u, /^счетчик$/u, /^наработка$/u]
};

/** Заголовок столбца к единому виду: «  Вид  Работ » и «вид работы» — одно и то же. */
export function normalizeHeader(value: XlsxCellValue): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е");
}

function headerRole(value: XlsxCellValue): ColumnRole | undefined {
  const header = normalizeHeader(value);
  if (!header) return undefined;
  for (const [role, patterns] of Object.entries(COLUMN_ALIASES) as readonly [ColumnRole, readonly RegExp[]][]) {
    if (patterns.some((pattern) => pattern.test(header))) return role;
  }
  return undefined;
}

/** Имя столбца Excel по индексу: 0 → A. */
export function columnLetter(index: number): string {
  let name = "";
  let current = index + 1;
  while (current > 0) {
    const rest = (current - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function isBlank(value: XlsxCellValue): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function text(value: XlsxCellValue): string {
  if (isBlank(value)) return "";
  return typeof value === "string" ? value.replace(/\r\n?/gu, "\n").trim() : String(value).trim();
}

interface HeaderMap {
  readonly rows: readonly number[];
  readonly columns: Partial<Record<ColumnRole, number>>;
  readonly layout: ImportLayout;
}

/** Строка похожа на заголовок, если все её непустые клетки — узнаваемые названия столбцов. */
function looksLikeHeader(cells: readonly XlsxCellValue[]): boolean {
  const filled = cells.filter((cell) => !isBlank(cell));
  return filled.length > 0 && filled.every((cell) => headerRole(cell) !== undefined);
}

function rolesOf(cells: readonly XlsxCellValue[]): Partial<Record<ColumnRole, number>> {
  const columns: Partial<Record<ColumnRole, number>> = {};
  cells.forEach((cell, index) => {
    const role = headerRole(cell);
    // Первое вхождение сильнее: в двухстрочном заголовке «площадка» может
    // встретиться и как клиент события, и как площадка прибора.
    if (role && columns[role] === undefined) columns[role] = index;
  });
  return columns;
}

/**
 * Ищет заголовок в первых строках листа. В выгрузках 1С он бывает двухстрочным:
 * в образце заказчика первая строка подписывает блок прибора, вторая — событие.
 */
export function detectHeader(sheet: XlsxReadSheet): HeaderMap | undefined {
  const limit = Math.min(sheet.rows.length, 20);
  for (let index = 0; index < limit; index += 1) {
    const row = sheet.rows[index];
    if (!row || !looksLikeHeader(row.cells)) continue;
    const columns = rolesOf(row.cells);
    const headerRows = [row.number];
    const next = sheet.rows[index + 1];
    if (next && looksLikeHeader(next.cells)) {
      for (const [role, column] of Object.entries(rolesOf(next.cells)) as readonly [ColumnRole, number][]) {
        if (columns[role] === undefined) columns[role] = column;
      }
      headerRows.push(next.number);
    }
    const hasEvent = columns.date !== undefined || columns.workType !== undefined;
    const hasDevice = columns.serial !== undefined && (columns.device !== undefined || columns.model !== undefined);
    if (hasEvent && columns.serial !== undefined) {
      return { rows: headerRows, columns, layout: columns.device !== undefined ? "history-blocks" : "equipment-rows" };
    }
    if (hasDevice) return { rows: headerRows, columns, layout: "equipment-rows" };
  }
  return undefined;
}

const DATE_TEXT = /^(\d{1,2})[.,/-](\d{1,2})[.,/-](\d{2,4})$/u;
const ISO_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/u;

export type DateReadResult =
  | { readonly ok: true; readonly date: string }
  | { readonly ok: false; readonly reason: "empty" | "invalid" };

function calendarDate(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  const full = year < 100 ? (year >= 70 ? 1900 + year : 2000 + year) : year;
  const moment = new Date(Date.UTC(full, month - 1, day));
  if (moment.getUTCFullYear() !== full || moment.getUTCMonth() !== month - 1 || moment.getUTCDate() !== day) {
    return undefined;
  }
  if (full < 1950 || full > 2100) return undefined;
  return moment.toISOString().slice(0, 10);
}

/**
 * Дата из клетки: «15.03.2023», «2024-03-25» (так читатель отдаёт даты Excel)
 * или число Excel, если в книге у клетки не стоял формат даты.
 * День и месяц в выгрузках 1С идут по-русски — сначала день.
 */
export function readImportDate(value: XlsxCellValue): DateReadResult {
  if (isBlank(value)) return { ok: false, reason: "empty" };
  if (typeof value === "number") {
    const MILLISECONDS_PER_DAY = 86_400_000;
    if (!Number.isFinite(value) || value < 61 || value > 2_958_465) return { ok: false, reason: "invalid" };
    const moment = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * MILLISECONDS_PER_DAY);
    return { ok: true, date: moment.toISOString().slice(0, 10) };
  }
  const source = text(value);
  const iso = ISO_TEXT.exec(source);
  if (iso) {
    const date = calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return date ? { ok: true, date } : { ok: false, reason: "invalid" };
  }
  const parts = DATE_TEXT.exec(source);
  if (!parts) return { ok: false, reason: "invalid" };
  const date = calendarDate(Number(parts[3]), Number(parts[2]), Number(parts[1]));
  return date ? { ok: true, date } : { ok: false, reason: "invalid" };
}

/** Число из клетки: «1 234,5» и «1234.5» читаются одинаково. */
export function readImportNumber(value: XlsxCellValue): number | undefined {
  if (isBlank(value)) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const compact = text(value).replace(/[\s ]/gu, "").replace(",", ".");
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(compact)) return undefined;
  const number = Number(compact);
  return Number.isFinite(number) ? number : undefined;
}

const SOURCE_KEY_VERSION = "medtech-import-1c:v1";

/**
 * Ключ события: sha256 от содержания — прибор, дата, вид и описание работ.
 * Клиент в ключ не входит: исправленное название клиента в том же файле не
 * должно добавить второе событие. Имя файла тоже не входит: та же выгрузка
 * под другим именем не удваивает историю.
 */
export async function historySourceKey(parts: {
  readonly serialKey: string;
  readonly happenedOn: string;
  readonly workType: string;
  readonly description: string;
}): Promise<string> {
  const identity = [
    SOURCE_KEY_VERSION, parts.serialKey, parts.happenedOn,
    parts.workType.replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU"),
    parts.description.replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU")
  ].join("\u001f");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const MAX_SUMMARY = 180;

function summaryOf(workType: string, description: string): string {
  const base = workType || description.split("\n")[0] || "";
  return base.length > MAX_SUMMARY ? `${base.slice(0, MAX_SUMMARY - 1)}…` : base;
}

interface MutableReading {
  readonly equipment: ImportEquipmentRow[];
  readonly events: ImportHistoryRow[];
  readonly issues: ImportRowIssue[];
  serviceRows: number;
}

function columnNames(columns: Partial<Record<ColumnRole, number>>): Readonly<Record<string, string>> {
  const named: Record<string, string> = {};
  for (const [role, index] of Object.entries(columns) as readonly [ColumnRole, number][]) {
    named[role] = columnLetter(index);
  }
  return named;
}

function cell(cells: readonly XlsxCellValue[], index: number | undefined): XlsxCellValue {
  return index === undefined ? null : (cells[index] ?? null);
}

/** Разбирает лист «история прибора»: блок прибора плюс его события. */
function readHistorySheet(sheet: XlsxReadSheet, header: HeaderMap, today: string, state: MutableReading): void {
  const columns = header.columns;
  const clientColumn = columns.client ?? columns.site;
  const headerRows = new Set(header.rows);
  const byKey = new Map<string, ImportEquipmentRow>();
  const eventKeys = new Map<string, number>();
  const pending: { readonly row: number; readonly serialKey: string; readonly serialNumber: string;
    readonly happenedOn: string; readonly client: string; readonly workType: string; readonly description: string }[] = [];
  let block: ImportEquipmentRow | undefined;

  for (const row of sheet.rows) {
    if (headerRows.has(row.number)) { state.serviceRows += 1; continue; }
    if (row.cells.every(isBlank)) { state.serviceRows += 1; continue; }
    const first = cell(row.cells, columns.device ?? columns.date);
    const second = cell(row.cells, columns.serial);
    const date = readImportDate(cell(row.cells, columns.date));
    const workType = text(cell(row.cells, columns.workType));
    const description = text(cell(row.cells, columns.description));

    // Строка-заголовок блока: в первом столбце название прибора, а не дата.
    if (!date.ok && !workType && !description && !isBlank(first)) {
      const serialNumber = text(second);
      const serialKey = normalizeEquipmentSerial(serialNumber);
      const modelName = text(first);
      if (!serialKey) {
        state.issues.push({
          row: row.number, column: columnLetter(columns.serial ?? 1), code: "serial_missing",
          problem: "В строке прибора нет серийного номера",
          fix: "Впишите S/N прибора или удалите строку"
        });
        continue;
      }
      const known = byKey.get(serialKey);
      if (known) {
        if (modelName && known.modelName && normalizeHeader(modelName) !== normalizeHeader(known.modelName)) {
          state.issues.push({
            row: row.number, column: columnLetter(columns.device ?? 0), code: "equipment_duplicate_in_file",
            problem: `Прибор ${known.serialNumber} уже был в строке ${known.row} с названием «${known.modelName}»`,
            fix: "Оставьте одно название прибора: в базу попадёт то, что встретилось первым"
          });
        }
        block = known;
        state.serviceRows += 1;
        continue;
      }
      const record: ImportEquipmentRow = {
        row: row.number, serialNumber, serialKey, modelName,
        ...(text(cell(row.cells, columns.manufacturer)) ? { manufacturerName: text(cell(row.cells, columns.manufacturer)) } : {})
      };
      if (!modelName) {
        state.issues.push({
          row: row.number, column: columnLetter(columns.device ?? 0), code: "model_missing",
          problem: `У прибора ${serialNumber} не указано название`,
          fix: "Впишите модель прибора: без неё прибор в реестре не создать"
        });
        continue;
      }
      byKey.set(serialKey, record);
      state.equipment.push(record);
      block = record;
      continue;
    }

    if (!date.ok && !workType && !description) {
      state.issues.push({
        row: row.number, code: "row_unclear",
        problem: "В строке нет ни даты события, ни названия прибора",
        fix: "Строку прибора начинайте его названием и S/N, строку события — датой"
      });
      continue;
    }
    if (!date.ok) {
      state.issues.push({
        row: row.number, column: columnLetter(columns.date ?? 0),
        code: date.reason === "empty" ? "date_missing" : "date_invalid",
        problem: date.reason === "empty" ? "В строке события нет даты" : `Дату «${text(cell(row.cells, columns.date))}» не удалось прочитать`,
        fix: "Впишите дату в виде 15.03.2023 или датой Excel"
      });
      continue;
    }
    if (date.date > today) {
      state.issues.push({
        row: row.number, column: columnLetter(columns.date ?? 0), code: "date_future",
        problem: `Дата ${date.date} позже сегодняшней`,
        fix: "Исправьте дату: события будущим числом база не принимает"
      });
      continue;
    }
    if (!workType && !description) {
      state.issues.push({
        row: row.number, code: "event_empty",
        problem: "В строке есть только дата: нечего записать в историю",
        fix: "Впишите вид работ или описание, иначе удалите строку"
      });
      continue;
    }
    if (!block) {
      state.issues.push({
        row: row.number, code: "serial_unknown",
        problem: "Непонятно, к какому прибору относится событие",
        fix: "Выше должна быть строка с названием прибора и его S/N"
      });
      continue;
    }
    const client = text(cell(row.cells, clientColumn));
    const identity = `${block.serialKey}\u001f${date.date}\u001f${normalizeHeader(workType)}\u001f${normalizeHeader(description)}`;
    const twin = eventKeys.get(identity);
    if (twin !== undefined) {
      state.issues.push({
        row: row.number, code: "duplicate_in_file",
        problem: `Строка повторяет строку ${twin}: тот же прибор, дата, вид и описание работ`,
        fix: "Если это два разных выезда, допишите, чем они отличались; иначе удалите одну строку"
      });
      continue;
    }
    eventKeys.set(identity, row.number);
    pending.push({
      row: row.number, serialKey: block.serialKey, serialNumber: block.serialNumber,
      happenedOn: date.date, client, workType, description
    });
  }

  state.events.push(...pending.map((event) => ({
    ...event,
    happenedAt: companyDayStart(event.happenedOn) ?? `${event.happenedOn}T00:00:00+03:00`,
    summary: summaryOf(event.workType, event.description),
    sourceKey: ""
  })));
}

/** Разбирает обычную таблицу приборов: одна строка — один прибор. */
function readEquipmentSheet(sheet: XlsxReadSheet, header: HeaderMap, state: MutableReading): void {
  const columns = header.columns;
  const headerRows = new Set(header.rows);
  const byKey = new Map<string, ImportEquipmentRow>();
  for (const row of sheet.rows) {
    if (headerRows.has(row.number)) { state.serviceRows += 1; continue; }
    if (row.cells.every(isBlank)) { state.serviceRows += 1; continue; }
    const serialNumber = text(cell(row.cells, columns.serial));
    const serialKey = normalizeEquipmentSerial(serialNumber);
    if (!serialKey) {
      state.issues.push({
        row: row.number, column: columnLetter(columns.serial ?? 0), code: "serial_missing",
        problem: "В строке нет серийного номера",
        fix: "Впишите S/N: по нему прибор находят в реестре"
      });
      continue;
    }
    const modelName = text(cell(row.cells, columns.model ?? columns.device));
    if (!modelName) {
      state.issues.push({
        row: row.number, column: columnLetter(columns.model ?? columns.device ?? 0), code: "model_missing",
        problem: `У прибора ${serialNumber} не указана модель`,
        fix: "Впишите модель прибора: без неё прибор в реестре не создать"
      });
      continue;
    }
    const known = byKey.get(serialKey);
    if (known) {
      state.issues.push({
        row: row.number, column: columnLetter(columns.serial ?? 0), code: "equipment_duplicate_in_file",
        problem: `Прибор ${serialNumber} уже был в строке ${known.row}`,
        fix: "Оставьте одну строку на прибор: в базу попадёт первая"
      });
      continue;
    }
    const meterSource = cell(row.cells, columns.meter);
    const meterReading = readImportNumber(meterSource);
    if (!isBlank(meterSource) && meterReading === undefined) {
      state.issues.push({
        row: row.number, column: columnLetter(columns.meter ?? 0), code: "number_invalid",
        problem: `Показание счётчика «${text(meterSource)}» не число`,
        fix: "Впишите только число, без единиц измерения"
      });
    }
    const record: ImportEquipmentRow = {
      row: row.number, serialNumber, serialKey, modelName,
      ...(text(cell(row.cells, columns.manufacturer)) ? { manufacturerName: text(cell(row.cells, columns.manufacturer)) } : {}),
      ...(text(cell(row.cells, columns.site ?? columns.client)) ? { siteName: text(cell(row.cells, columns.site ?? columns.client)) } : {}),
      ...(text(cell(row.cells, columns.payer)) ? { payerName: text(cell(row.cells, columns.payer)) } : {}),
      ...(text(cell(row.cells, columns.notes)) ? { notes: text(cell(row.cells, columns.notes)) } : {}),
      ...(meterReading !== undefined && meterReading >= 0 ? { meterReading } : {})
    };
    byKey.set(serialKey, record);
    state.equipment.push(record);
  }
}

export interface ReadImportFileOptions {
  /** Лист книги; без него берём первый подходящий. */
  readonly sheetName?: string;
  /** Сегодня по часам компании: события будущим числом база не принимает. */
  readonly today?: string;
}

/** Читает книгу и разбирает её лист; в базу ничего не пишет. */
export async function readImportFile(
  source: Uint8Array,
  options: ReadImportFileOptions = {}
): Promise<ImportReading> {
  const book = await readXlsxWorkbook(source);
  const today = options.today ?? companyToday();
  const requested = options.sheetName ? normalizeHeader(options.sheetName) : undefined;
  const candidates = requested
    ? book.sheets.filter((sheet) => normalizeHeader(sheet.name) === requested)
    : book.sheets;
  if (candidates.length === 0) throw new Error(`Лист «${options.sheetName}» в книге не найден`);
  const chosen = candidates.map((sheet) => ({ sheet, header: detectHeader(sheet) }))
    .find((item) => item.header !== undefined) ?? { sheet: candidates[0]!, header: undefined };
  const sheet = chosen.sheet;
  const state: MutableReading = { equipment: [], events: [], issues: [], serviceRows: 0 };
  if (!chosen.header) {
    state.issues.push({
      row: 0,
      code: sheet.rows.every((row) => row.cells.every(isBlank)) ? "sheet_empty" : "layout_unknown",
      problem: `На листе «${sheet.name}» не нашлись знакомые столбцы`,
      fix: "Нужна строка заголовков: «наименование прибора» и «(s/n прибора)» для истории либо «Серийный номер» и «Модель» для списка приборов"
    });
    return {
      sheet: sheet.name, layout: "equipment-rows", sheetRows: sheet.rows.length,
      serviceRows: sheet.rows.length, equipment: [], events: [], issues: state.issues, columns: {}
    };
  }
  if (chosen.header.layout === "history-blocks") {
    readHistorySheet(sheet, chosen.header, today, state);
  } else {
    readEquipmentSheet(sheet, chosen.header, state);
  }
  const events: ImportHistoryRow[] = [];
  for (const event of state.events) {
    events.push({ ...event, sourceKey: await historySourceKey(event) });
  }
  return {
    sheet: sheet.name,
    layout: chosen.header.layout,
    sheetRows: sheet.rows.length,
    serviceRows: state.serviceRows,
    equipment: state.equipment,
    events,
    issues: [...state.issues].sort((left, right) => left.row - right.row),
    columns: columnNames(chosen.header.columns)
  };
}

// ---------------------------------------------------------------------------
// Сверка с базой: пробный импорт без записи
// ---------------------------------------------------------------------------

export interface ImportModelCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly manufacturerId: string;
  readonly manufacturerName: string;
}

export interface ImportExistingEquipment {
  readonly id: string;
  readonly serialNumber: string;
  readonly modelName: string;
  readonly manufacturerName: string;
}

/** Снимок базы, по которому считается пробный импорт. Читается, но не меняется. */
export interface ImportSnapshot {
  readonly models: readonly ImportModelCatalogEntry[];
  readonly manufacturers: readonly string[];
  /** Приборы базы по серийным номерам из файла. */
  readonly equipment: readonly ImportExistingEquipment[];
  /** Уже записанные source_key событий по этим приборам. */
  readonly historyKeys: readonly string[];
}

export interface ImportPlanDifference {
  readonly field: string;
  readonly inFile: string;
  readonly inBase: string;
}

export interface ImportPlanEquipment {
  readonly row: number;
  readonly serialNumber: string;
  readonly serialKey: string;
  readonly modelName: string;
  readonly manufacturerName: string;
  /** create — прибора в базе нет; exists — есть; blocked — не хватает данных. */
  readonly action: "create" | "exists" | "blocked";
  /** Появится ли в справочнике новая модель. */
  readonly modelAction: "known" | "create" | "unknown";
  readonly differences: readonly ImportPlanDifference[];
  readonly eventsCreate: number;
  readonly eventsExisting: number;
  readonly eventsBlocked: number;
}

export interface ImportWriteEquipment {
  readonly serialNumber: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly site?: string;
  readonly payer?: string;
  readonly notes?: string;
  readonly meterReading?: number;
}

export interface ImportWriteEvent {
  readonly serialNumber: string;
  readonly sourceKey: string;
  readonly happenedAt: string;
  readonly summary: string;
  readonly client: string;
  readonly description: string;
  readonly workType: string;
}

export interface ImportPlanSummary {
  readonly sheetRows: number;
  readonly serviceRows: number;
  readonly dataRows: number;
  readonly readyRows: number;
  readonly errorRows: number;
  readonly equipmentCreate: number;
  readonly equipmentExists: number;
  readonly equipmentBlocked: number;
  readonly eventsCreate: number;
  readonly eventsExisting: number;
  readonly eventsBlocked: number;
  readonly manufacturersCreate: number;
  readonly modelsCreate: number;
}

export interface ImportPlan {
  readonly layout: ImportLayout;
  readonly sheet: string;
  readonly columns: Readonly<Record<string, string>>;
  readonly equipment: readonly ImportPlanEquipment[];
  readonly issues: readonly ImportRowIssue[];
  readonly summary: ImportPlanSummary;
  readonly write: {
    readonly equipment: readonly ImportWriteEquipment[];
    readonly events: readonly ImportWriteEvent[];
  };
}

export interface BuildImportPlanOptions {
  /**
   * Производитель, под которым заводить модели, которых нет в справочнике.
   * Человек выбирает его на экране: в файле «история прибора» производителя нет.
   */
  readonly defaultManufacturer?: string;
}

function sameName(left: string, right: string): boolean {
  return normalizeHeader(left) === normalizeHeader(right);
}

/**
 * Сверяет разобранный файл с базой и говорит, что появится, что уже есть
 * и что мешает. Ничего не пишет: это и есть пробный импорт.
 */
export function buildImportPlan(
  reading: ImportReading,
  snapshot: ImportSnapshot,
  options: BuildImportPlanOptions = {}
): ImportPlan {
  const issues: ImportRowIssue[] = [...reading.issues];
  const existing = new Map(snapshot.equipment.map((item) => [normalizeEquipmentSerial(item.serialNumber), item]));
  const knownKeys = new Set(snapshot.historyKeys);
  const eventsBySerial = new Map<string, ImportHistoryRow[]>();
  for (const event of reading.events) {
    const list = eventsBySerial.get(event.serialKey) ?? [];
    list.push(event);
    eventsBySerial.set(event.serialKey, list);
  }

  const plannedManufacturers = new Set<string>();
  const plannedModels = new Set<string>();
  const equipment: ImportPlanEquipment[] = [];
  const writeEquipment: ImportWriteEquipment[] = [];
  const writeEvents: ImportWriteEvent[] = [];

  for (const record of reading.equipment) {
    const events = eventsBySerial.get(record.serialKey) ?? [];
    const inBase = existing.get(record.serialKey);
    const sameModelName = snapshot.models.filter((model) => sameName(model.name, record.modelName));
    const byFileManufacturer = record.manufacturerName
      ? sameModelName.find((model) => sameName(model.manufacturerName, record.manufacturerName ?? ""))
      : undefined;
    let manufacturerName = record.manufacturerName ?? "";
    let modelAction: ImportPlanEquipment["modelAction"] = "unknown";

    if (byFileManufacturer) {
      manufacturerName = byFileManufacturer.manufacturerName;
      modelAction = "known";
    } else if (record.manufacturerName) {
      // Производитель указан в файле, а такой модели у него ещё нет: заведём модель.
      modelAction = "create";
    } else if (sameModelName.length === 1 && sameModelName[0]) {
      manufacturerName = sameModelName[0].manufacturerName;
      modelAction = "known";
    } else if (sameModelName.length > 1) {
      issues.push({
        row: record.row, code: "model_ambiguous",
        problem: `Модель «${record.modelName}» есть у нескольких производителей: ${sameModelName.map((model) => model.manufacturerName).join(", ")}`,
        fix: "Добавьте в файл столбец «Производитель» или выберите производителя на экране импорта"
      });
    } else if (options.defaultManufacturer) {
      manufacturerName = options.defaultManufacturer;
      modelAction = "create";
    } else if (inBase) {
      // Прибор уже в базе: его модель и производитель известны, новых не заводим.
      manufacturerName = inBase.manufacturerName;
      modelAction = "known";
    } else {
      issues.push({
        row: record.row, code: "model_not_in_catalog",
        problem: `Модели «${record.modelName}» нет в справочнике моделей`,
        fix: "Выберите производителя на экране импорта (модель заведём) либо добавьте модель в справочник заранее"
      });
    }

    const blocked = !manufacturerName;
    const differences: ImportPlanDifference[] = [];
    if (inBase && !sameName(inBase.modelName, record.modelName)) {
      differences.push({ field: "Модель", inFile: record.modelName, inBase: inBase.modelName });
    }
    if (inBase && manufacturerName && !sameName(inBase.manufacturerName, manufacturerName)) {
      differences.push({ field: "Производитель", inFile: manufacturerName, inBase: inBase.manufacturerName });
    }

    const newEvents = events.filter((event) => !knownKeys.has(event.sourceKey));
    const seenEvents = events.length - newEvents.length;
    equipment.push({
      row: record.row,
      serialNumber: record.serialNumber,
      serialKey: record.serialKey,
      modelName: record.modelName,
      manufacturerName,
      action: blocked ? "blocked" : (inBase ? "exists" : "create"),
      modelAction: inBase ? "known" : modelAction,
      differences,
      eventsCreate: blocked ? 0 : newEvents.length,
      eventsExisting: blocked ? 0 : seenEvents,
      eventsBlocked: blocked ? events.length : 0
    });
    if (blocked) continue;

    if (!inBase) {
      if (modelAction === "create") {
        plannedModels.add(`${normalizeHeader(manufacturerName)}\u001f${normalizeHeader(record.modelName)}`);
        if (!snapshot.manufacturers.some((name) => sameName(name, manufacturerName))) {
          plannedManufacturers.add(normalizeHeader(manufacturerName));
        }
      }
      writeEquipment.push({
        serialNumber: record.serialNumber,
        manufacturer: manufacturerName,
        model: record.modelName,
        ...(record.siteName ? { site: record.siteName } : {}),
        ...(record.payerName ? { payer: record.payerName } : {}),
        ...(record.notes ? { notes: record.notes } : {}),
        ...(record.meterReading !== undefined ? { meterReading: record.meterReading } : {})
      });
    } else if (modelAction === "create") {
      plannedModels.add(`${normalizeHeader(manufacturerName)}\u001f${normalizeHeader(record.modelName)}`);
      if (!snapshot.manufacturers.some((name) => sameName(name, manufacturerName))) {
        plannedManufacturers.add(normalizeHeader(manufacturerName));
      }
    }
    for (const event of newEvents) {
      writeEvents.push({
        serialNumber: record.serialNumber,
        sourceKey: event.sourceKey,
        happenedAt: event.happenedAt,
        summary: event.summary,
        client: event.client,
        description: event.description,
        workType: event.workType
      });
    }
  }

  // События приборов, которых в файле нет ни одной строкой блока.
  const plannedSerials = new Set(reading.equipment.map((record) => record.serialKey));
  for (const event of reading.events) {
    if (plannedSerials.has(event.serialKey)) continue;
    issues.push({
      row: event.row, code: "serial_unknown",
      problem: `Прибор ${event.serialNumber} не описан в файле`,
      fix: "Добавьте строку с названием прибора и его S/N выше его событий"
    });
  }

  const dataRows = reading.sheetRows - reading.serviceRows;
  const errorRows = new Set(issues.filter((issue) => issue.row > 0).map((issue) => issue.row)).size;
  const eventsCreate = equipment.reduce((total, item) => total + item.eventsCreate, 0);
  const eventsExisting = equipment.reduce((total, item) => total + item.eventsExisting, 0);
  const eventsBlocked = equipment.reduce((total, item) => total + item.eventsBlocked, 0);
  const readyEquipment = equipment.filter((item) => item.action !== "blocked").length;
  return {
    layout: reading.layout,
    sheet: reading.sheet,
    columns: reading.columns,
    equipment,
    issues: [...issues].sort((left, right) => left.row - right.row),
    summary: {
      sheetRows: reading.sheetRows,
      serviceRows: reading.serviceRows,
      dataRows,
      readyRows: readyEquipment + eventsCreate + eventsExisting,
      errorRows,
      equipmentCreate: writeEquipment.length,
      equipmentExists: equipment.filter((item) => item.action === "exists").length,
      equipmentBlocked: equipment.filter((item) => item.action === "blocked").length,
      eventsCreate,
      eventsExisting,
      eventsBlocked,
      manufacturersCreate: plannedManufacturers.size,
      modelsCreate: plannedModels.size
    },
    write: { equipment: writeEquipment, events: writeEvents }
  };
}
