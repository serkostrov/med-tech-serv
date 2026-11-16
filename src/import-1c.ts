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
 *   - «приборы списком»: обычная таблица с заголовком, одна строка — один прибор;
 *     если в ней есть столбец даты, строка даёт ещё и событие истории этого прибора
 *     (так 1С выгружает работы списком).
 *
 * Ключи сопоставления берём те же, что у базы: прибор — серийный номер без
 * пробелов и регистра (generated column equipment.serial_number_normalized),
 * событие — sha256 от содержания события (equipment_history.source_key с
 * уникальным индексом по прибору). Поэтому повторная загрузка того же файла
 * ничего не удваивает.
 *
 * Куда что ложится (поле файла → колонка базы):
 *   серийный номер      → equipment.serial_number
 *   название прибора    → equipment_models.name (производитель — из справочника
 *                         моделей либо выбран человеком на экране)
 *   производитель       → manufacturers.name
 *   площадка            → equipment.current_site_id, если площадка есть в sites
 *   плательщик          → equipment.current_payer_id, если он есть в payers
 *   примечание          → equipment.notes
 *   показание счётчика  → equipment.last_meter_reading
 *   дата события        → equipment_history.happened_at (начало дня по Москве)
 *   вид работ           → equipment_history.summary и details.workType
 *   описание работ      → equipment_history.details.description
 *   клиент события      → equipment_history.details.client (снимком, как в ленте)
 *
 * Чего в файлах нет и что остаётся пустым: статус прибора (встаёт «В эксплуатации»),
 * категория гарантии, договор, план ТО, задачи, счета и файлы прибора. Переноса
 * площадки во времени (equipment_site_history) импорт не делает: её пишут только
 * триггеры при смене места установки.
 */
import { companyDayStart, companyToday } from "./task-dates.js";
import { excelSerialToDateText, readXlsxWorkbook, type XlsxCellValue, type XlsxReadSheet } from "./xlsx-read.js";

export type ImportLayout = "history-blocks" | "equipment-rows";

export type ImportIssueCode =
  | "layout_unknown"
  | "sheet_empty"
  | "sheet_skipped"
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
  | "model_hidden"
  | "manufacturer_hidden"
  | "site_ambiguous"
  | "site_not_found"
  | "payer_not_found"
  | "number_invalid";

/**
 * Замечание либо не пускает строку в базу («error»), либо только предупреждает
 * («warning»): строка перенесётся, но человек должен знать, с какой оговоркой.
 */
export type ImportIssueSeverity = "error" | "warning";

const WARNING_CODES: readonly ImportIssueCode[] = [
  "sheet_skipped", "duplicate_in_file", "equipment_duplicate_in_file", "number_invalid",
  "site_not_found", "site_ambiguous", "payer_not_found"
];

export function issueSeverity(code: ImportIssueCode): ImportIssueSeverity {
  return WARNING_CODES.includes(code) ? "warning" : "error";
}

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

/**
 * Ключ сравнения названий — ровно как уникальные индексы базы: lower(btrim(name)).
 * Нарочно не трогаем внутренние пробелы и «ё»: иначе пробный импорт сказал бы
 * «модель известна» там, где база завела бы вторую почти такую же.
 */
export function catalogKey(value: string): string {
  return value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu, "").toLocaleLowerCase("ru-RU");
}

/**
 * Ключ прибора — ровно как generated column equipment.serial_number_normalized:
 * убираем пробелы, которые убирает Postgres, и поднимаем регистр. Неразрывный
 * пробел остаётся: в базе он тоже остаётся, и прибор ищется по тому же ключу.
 */
export function importSerialKey(value: string): string {
  return value.replace(/[\t\n\v\f\r ]+/gu, "").toUpperCase();
}

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

/** Столбцов узнали хотя бы столько — тогда строка считается заголовком. */
const MIN_HEADER_ROLES = 2;

function rolesOf(cells: readonly XlsxCellValue[]): Partial<Record<ColumnRole, number>> {
  const columns: Partial<Record<ColumnRole, number>> = {};
  cells.forEach((cell, index) => {
    const role = headerRole(cell);
    // Первое вхождение сильнее: в двухстрочном заголовке один столбец подписан
    // и как прибор, и как дата.
    if (role && columns[role] === undefined) columns[role] = index;
  });
  return columns;
}

/**
 * Строка похожа на заголовок: узнали не меньше двух столбцов (или все непустые
 * клетки — известные названия) и ни в одной клетке нет даты. Лишний столбец вроде
 * «Инженер» заголовком быть не мешает, а строка с датой заголовком не бывает.
 */
function looksLikeHeader(cells: readonly XlsxCellValue[]): boolean {
  const filled = cells.filter((cell) => !isBlank(cell));
  if (filled.length === 0) return false;
  if (filled.some((cell) => readImportDate(cell).ok)) return false;
  const known = Object.keys(rolesOf(cells)).length;
  return known >= MIN_HEADER_ROLES || (known > 0 && known === filled.length);
}

const MONTH_NAME = /^(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/u;

/**
 * Клетка похожа на дату или период, а не на название прибора: «март 2023»,
 * «01.2023», «2023», «Итого». Такие строки не должны становиться приборами.
 */
function looksLikeDateText(value: XlsxCellValue): boolean {
  if (typeof value === "number") return true;
  const source = text(value).toLocaleLowerCase("ru-RU");
  return MONTH_NAME.test(source)
    || /^\d{1,4}\s*[.,/-]/u.test(source)
    || /^\d+$/u.test(source)
    || /^(итого|всего|период)/u.test(source);
}

/** Серийный номер: в нём есть цифра. Иначе это название клиента или подзаголовок. */
function looksLikeSerial(value: string): boolean {
  return /\d/u.test(value) && value.length <= 120;
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
export function readImportDate(value: XlsxCellValue, date1904 = false): DateReadResult {
  if (isBlank(value)) return { ok: false, reason: "empty" };
  if (typeof value === "number") {
    const date = excelSerialToDateText(value, date1904);
    return date ? { ok: true, date: date.slice(0, 10) } : { ok: false, reason: "invalid" };
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
/** Предел колонки equipment.last_meter_reading: numeric(14, 2). */
const MAX_METER_READING = 999_999_999_999.99;

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

/** Приводит текст события к одному виду для ключа: так же, как historySourceKey. */
function eventTextKey(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU");
}

interface EventDraft {
  readonly row: number;
  readonly serialKey: string;
  readonly serialNumber: string;
  readonly happenedOn: string;
  readonly client: string;
  readonly workType: string;
  readonly description: string;
}

function pushEvent(state: MutableReading, draft: EventDraft): void {
  state.events.push({
    ...draft,
    happenedAt: companyDayStart(draft.happenedOn) ?? `${draft.happenedOn}T00:00:00+03:00`,
    summary: summaryOf(draft.workType, draft.description),
    sourceKey: ""
  });
}

/**
 * Проверяет строку события и складывает его. Если строка не годится, событие
 * не создаётся, а про строку остаётся замечание с подсказкой.
 */
function readEventRow(options: {
  readonly state: MutableReading;
  readonly rowNumber: number;
  readonly dateColumn: number | undefined;
  readonly dateSource: XlsxCellValue;
  readonly date: DateReadResult;
  readonly today: string;
  readonly workType: string;
  readonly description: string;
  readonly client: string;
  readonly device: ImportEquipmentRow;
  readonly seen: Map<string, number>;
}): void {
  const { state, rowNumber, date, device } = options;
  if (!date.ok) {
    state.issues.push({
      row: rowNumber,
      ...(options.dateColumn === undefined ? {} : { column: columnLetter(options.dateColumn) }),
      code: date.reason === "empty" ? "date_missing" : "date_invalid",
      problem: date.reason === "empty"
        ? "В строке события нет даты"
        : `Дату «${text(options.dateSource)}» не удалось прочитать`,
      fix: "Впишите дату в виде 15.03.2023 или датой Excel"
    });
    return;
  }
  if (date.date > options.today) {
    state.issues.push({
      row: rowNumber,
      ...(options.dateColumn === undefined ? {} : { column: columnLetter(options.dateColumn) }),
      code: "date_future",
      problem: `Дата ${date.date} позже сегодняшней`,
      fix: "Исправьте дату: события будущим числом база не принимает"
    });
    return;
  }
  if (!options.workType && !options.description) {
    state.issues.push({
      row: rowNumber, code: "event_empty",
      problem: "В строке есть только дата: нечего записать в историю",
      fix: "Впишите вид работ или описание, иначе удалите строку"
    });
    return;
  }
  const identity = [device.serialKey, date.date, eventTextKey(options.workType), eventTextKey(options.description)].join("\u001f");
  const twin = options.seen.get(identity);
  if (twin !== undefined) {
    state.issues.push({
      row: rowNumber, code: "duplicate_in_file",
      problem: `Строка повторяет строку ${twin}: тот же прибор, дата, вид и описание работ`,
      fix: "Если это два разных выезда, допишите, чем они отличались; иначе удалите одну строку"
    });
    return;
  }
  options.seen.set(identity, rowNumber);
  pushEvent(state, {
    row: rowNumber,
    serialKey: device.serialKey,
    serialNumber: device.serialNumber,
    happenedOn: date.date,
    client: options.client,
    workType: options.workType,
    description: options.description
  });
}

/** Разбирает лист «история прибора»: строка прибора, под ней его события. */
function readHistorySheet(
  sheet: XlsxReadSheet, header: HeaderMap, today: string, date1904: boolean, state: MutableReading
): void {
  const columns = header.columns;
  const clientColumn = columns.client ?? columns.site;
  const headerRows = new Set(header.rows);
  const byKey = new Map<string, ImportEquipmentRow>();
  const seen = new Map<string, number>();
  let block: ImportEquipmentRow | undefined;

  for (const row of sheet.rows) {
    if (headerRows.has(row.number)) { state.serviceRows += 1; continue; }
    if (row.cells.every(isBlank)) { state.serviceRows += 1; continue; }
    // Заголовок повторяется посреди листа, когда 1С выгружает по разделам.
    if (looksLikeHeader(row.cells)) { state.serviceRows += 1; continue; }
    const first = cell(row.cells, columns.device ?? columns.date);
    const second = cell(row.cells, columns.serial);
    const dateSource = cell(row.cells, columns.date);
    const date = readImportDate(dateSource, date1904);
    const workType = text(cell(row.cells, columns.workType));
    const description = text(cell(row.cells, columns.description));

    // Строка прибора: в первом столбце название прибора (а не дата или период),
    // во втором — серийный номер. Иначе клиент события стал бы серийным номером,
    // а следующие события сели бы на выдуманный прибор.
    if (!date.ok && !workType && !description) {
      const serialNumber = text(second);
      const modelName = text(first);
      const serialKey = importSerialKey(serialNumber);
      if (isBlank(first)) {
        // Пустая первая клетка — просто мусорная строка: блок прибора она не
        // открывает и события, идущие дальше, по-прежнему относятся к нему.
        state.issues.push({
          row: row.number, code: "row_unclear",
          problem: "В строке нет ни даты события, ни названия прибора",
          fix: "Строку прибора начинайте его названием и S/N, строку события — датой"
        });
        continue;
      }
      if (looksLikeDateText(first)) {
        state.issues.push({
          row: row.number, code: "row_unclear",
          problem: `«${text(first)}» не похоже на название прибора`,
          fix: "Уберите подзаголовки разделов (месяц, период, «Итого»): события после них непонятно к чему относить"
        });
        // Подзаголовок раздела обрывает блок: дальше может идти уже другой прибор,
        // и сажать его события на прежний — значит испортить историю.
        block = undefined;
        continue;
      }
      if (!serialKey) {
        state.issues.push({
          row: row.number, column: columnLetter(columns.serial ?? 1), code: "serial_missing",
          problem: `У прибора «${modelName}» нет серийного номера`,
          fix: "Впишите S/N прибора или удалите строку"
        });
        block = undefined;
        continue;
      }
      // Во втором столбце клиент, а не S/N: так выглядит подзаголовок раздела.
      // Без этой проверки название клиента стало бы прибором, а события сели бы на него.
      if (!looksLikeSerial(serialNumber)) {
        state.issues.push({
          row: row.number, column: columnLetter(columns.serial ?? 1), code: "row_unclear",
          problem: `«${serialNumber}» не похоже на серийный номер прибора`,
          fix: "Строку прибора начинайте его названием и S/N; подзаголовки разделов из файла уберите"
        });
        block = undefined;
        continue;
      }
      const known = byKey.get(serialKey);
      if (known) {
        if (modelName && known.modelName && catalogKey(modelName) !== catalogKey(known.modelName)) {
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
      byKey.set(serialKey, record);
      state.equipment.push(record);
      block = record;
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
    readEventRow({
      state, rowNumber: row.number, dateColumn: columns.date, dateSource, date, today,
      workType, description, client: text(cell(row.cells, clientColumn)), device: block, seen
    });
  }
}

/**
 * Разбирает таблицу с заголовком: одна строка — один прибор, а если в ней есть
 * столбец даты, то ещё и одно событие его истории (так 1С выгружает работы списком).
 */
function readEquipmentSheet(
  sheet: XlsxReadSheet, header: HeaderMap, today: string, date1904: boolean, state: MutableReading
): void {
  const columns = header.columns;
  const headerRows = new Set(header.rows);
  // Таблица событий: у прибора несколько строк, и повтор S/N — не ошибка.
  const withEvents = columns.date !== undefined
    && (columns.workType !== undefined || columns.description !== undefined);
  const clientColumn = columns.client ?? (withEvents ? columns.site : undefined);
  const siteColumn = columns.site;
  const byKey = new Map<string, ImportEquipmentRow>();
  const seen = new Map<string, number>();
  for (const row of sheet.rows) {
    if (headerRows.has(row.number)) { state.serviceRows += 1; continue; }
    if (row.cells.every(isBlank)) { state.serviceRows += 1; continue; }
    if (looksLikeHeader(row.cells)) { state.serviceRows += 1; continue; }
    const serialNumber = text(cell(row.cells, columns.serial));
    const serialKey = importSerialKey(serialNumber);
    if (!serialKey) {
      state.issues.push({
        row: row.number, column: columnLetter(columns.serial ?? 0), code: "serial_missing",
        problem: "В строке нет серийного номера",
        fix: "Впишите S/N: по нему прибор находят в реестре"
      });
      continue;
    }
    const modelName = text(cell(row.cells, columns.model ?? columns.device));
    const known = byKey.get(serialKey);
    if (!known && !modelName) {
      state.issues.push({
        row: row.number, column: columnLetter(columns.model ?? columns.device ?? 0), code: "model_missing",
        problem: `У прибора ${serialNumber} не указана модель`,
        fix: withEvents
          ? "Впишите модель в первой строке прибора: без неё не создать ни прибор, ни эту запись истории"
          : "Впишите модель прибора: без неё прибор в реестре не создать"
      });
      continue;
    }
    let device = known;
    if (known) {
      if (!withEvents) {
        state.issues.push({
          row: row.number, column: columnLetter(columns.serial ?? 0), code: "equipment_duplicate_in_file",
          problem: `Прибор ${serialNumber} уже был в строке ${known.row}`,
          fix: "Оставьте одну строку на прибор: в базу попадёт первая"
        });
        continue;
      }
      if (modelName && catalogKey(modelName) !== catalogKey(known.modelName)) {
        state.issues.push({
          row: row.number, column: columnLetter(columns.model ?? columns.device ?? 0), code: "equipment_duplicate_in_file",
          problem: `У прибора ${serialNumber} в строке ${known.row} другая модель: «${known.modelName}»`,
          fix: "Оставьте одну модель на прибор: в базу попадёт та, что встретилась первой"
        });
      }
    } else {
      const meterSource = cell(row.cells, columns.meter);
      const meterReading = readImportNumber(meterSource);
      if (!isBlank(meterSource) && (meterReading === undefined || meterReading < 0 || meterReading > MAX_METER_READING)) {
        state.issues.push({
          row: row.number, column: columnLetter(columns.meter ?? 0), code: "number_invalid",
          problem: meterReading === undefined
            ? `Показание счётчика «${text(meterSource)}» не число`
            : `Показание счётчика «${text(meterSource)}» вне допустимых значений`,
          fix: `Впишите число от 0 до ${MAX_METER_READING} без единиц измерения; прибор перенесём без показания`
        });
      }
      const record: ImportEquipmentRow = {
        row: row.number, serialNumber, serialKey, modelName,
        ...(text(cell(row.cells, columns.manufacturer)) ? { manufacturerName: text(cell(row.cells, columns.manufacturer)) } : {}),
        ...(text(cell(row.cells, siteColumn)) ? { siteName: text(cell(row.cells, siteColumn)) } : {}),
        ...(text(cell(row.cells, columns.payer)) ? { payerName: text(cell(row.cells, columns.payer)) } : {}),
        ...(text(cell(row.cells, columns.notes)) ? { notes: text(cell(row.cells, columns.notes)) } : {}),
        ...(meterReading !== undefined && meterReading >= 0 && meterReading <= MAX_METER_READING ? { meterReading } : {})
      };
      byKey.set(serialKey, record);
      state.equipment.push(record);
      device = record;
    }
    if (!withEvents || !device) continue;
    const dateSource = cell(row.cells, columns.date);
    // Строка только с прибором, без даты: события в ней нет, и это не ошибка.
    if (isBlank(dateSource)) continue;
    readEventRow({
      state, rowNumber: row.number, dateColumn: columns.date, dateSource,
      date: readImportDate(dateSource, date1904), today,
      workType: text(cell(row.cells, columns.workType)),
      description: text(cell(row.cells, columns.description)),
      client: text(cell(row.cells, clientColumn)),
      device, seen
    });
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
  const parsed = candidates.map((sheet) => ({ sheet, header: detectHeader(sheet) }));
  const chosen = parsed.find((item) => item.header !== undefined) ?? { sheet: candidates[0]!, header: undefined };
  const sheet = chosen.sheet;
  const state: MutableReading = { equipment: [], events: [], issues: [], serviceRows: 0 };
  const otherSheets = parsed
    .filter((item) => item.header !== undefined && item.sheet !== sheet)
    .map((item) => item.sheet.name);
  if (otherSheets.length > 0) {
    state.issues.push({
      row: 0, code: "sheet_skipped",
      problem: `В книге подходят и другие листы: ${otherSheets.join(", ")}. Читаем только «${sheet.name}»`,
      fix: "Загрузите остальные листы отдельными файлами: за один раз переносим один лист"
    });
  }
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
    readHistorySheet(sheet, chosen.header, today, book.date1904, state);
  } else {
    readEquipmentSheet(sheet, chosen.header, today, book.date1904, state);
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
  /** Скрытая модель занимает название в справочнике, но прибор на неё не завести. */
  readonly isActive: boolean;
}

export interface ImportManufacturerEntry {
  readonly name: string;
  readonly isActive: boolean;
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
  readonly manufacturers: readonly ImportManufacturerEntry[];
  /** Названия площадок и плательщиков из справочников: импорт их не заводит. */
  readonly sites: readonly string[];
  readonly payers: readonly string[];
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
  /** Строк файла без ошибок: они перенесутся (возможно, с оговоркой). */
  readonly readyRows: number;
  readonly errorRows: number;
  readonly warningRows: number;
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

/** Названия сравниваем так же, как уникальные индексы базы: lower(btrim(...)). */
function sameName(left: string, right: string): boolean {
  return catalogKey(left) === catalogKey(right);
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
  const existing = new Map(snapshot.equipment.map((item) => [importSerialKey(item.serialNumber), item]));
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

  const addEvents = (device: ImportEquipmentRow, events: readonly ImportHistoryRow[]): void => {
    for (const event of events) {
      writeEvents.push({
        serialNumber: device.serialNumber,
        sourceKey: event.sourceKey,
        happenedAt: event.happenedAt,
        summary: event.summary,
        client: event.client,
        description: event.description,
        workType: event.workType
      });
    }
  };

  for (const record of reading.equipment) {
    const events = eventsBySerial.get(record.serialKey) ?? [];
    const newEvents = events.filter((event) => !knownKeys.has(event.sourceKey));
    const seenEvents = events.length - newEvents.length;
    const inBase = existing.get(record.serialKey);

    // Прибор уже в реестре: ни модель, ни производитель не нужны — события
    // пишутся по серийному номеру, а данные самого прибора импорт не трогает.
    if (inBase) {
      const differences: ImportPlanDifference[] = [];
      if (record.modelName && !sameName(inBase.modelName, record.modelName)) {
        differences.push({ field: "Модель", inFile: record.modelName, inBase: inBase.modelName });
      }
      if (record.manufacturerName && !sameName(inBase.manufacturerName, record.manufacturerName)) {
        differences.push({ field: "Производитель", inFile: record.manufacturerName, inBase: inBase.manufacturerName });
      }
      equipment.push({
        row: record.row,
        serialNumber: record.serialNumber,
        serialKey: record.serialKey,
        modelName: record.modelName,
        manufacturerName: inBase.manufacturerName,
        action: "exists",
        modelAction: "known",
        differences,
        eventsCreate: newEvents.length,
        eventsExisting: seenEvents,
        eventsBlocked: 0
      });
      addEvents(record, newEvents);
      continue;
    }

    // Новый прибор: под каким производителем его заводить.
    const named = snapshot.models.filter((model) => sameName(model.name, record.modelName));
    const byFileManufacturer = record.manufacturerName
      ? named.find((model) => sameName(model.manufacturerName, record.manufacturerName ?? ""))
      : undefined;
    let manufacturerName = "";
    let modelAction: ImportPlanEquipment["modelAction"] = "unknown";
    let hiddenModel: ImportModelCatalogEntry | undefined;

    const takeModel = (model: ImportModelCatalogEntry): void => {
      manufacturerName = model.manufacturerName;
      modelAction = "known";
      if (!model.isActive) hiddenModel = model;
    };

    if (byFileManufacturer) {
      takeModel(byFileManufacturer);
    } else if (record.manufacturerName) {
      // Производитель указан в файле, а такой модели у него ещё нет: заведём модель.
      manufacturerName = record.manufacturerName;
      modelAction = "create";
    } else if (named.length === 1 && named[0]) {
      takeModel(named[0]);
    } else if (named.length > 1) {
      const chosen = options.defaultManufacturer
        ? named.find((model) => sameName(model.manufacturerName, options.defaultManufacturer ?? ""))
        : undefined;
      if (chosen) {
        takeModel(chosen);
      } else {
        issues.push({
          row: record.row, code: "model_ambiguous",
          problem: `Модель «${record.modelName}» есть у нескольких производителей: ${named.map((model) => model.manufacturerName).join(", ")}`,
          fix: "Добавьте в файл столбец «Производитель» или выберите производителя на экране импорта"
        });
      }
    } else if (options.defaultManufacturer) {
      manufacturerName = options.defaultManufacturer;
      modelAction = "create";
    } else {
      issues.push({
        row: record.row, code: "model_not_in_catalog",
        problem: `Модели «${record.modelName}» нет в справочнике моделей`,
        fix: "Выберите производителя на экране импорта (модель заведём) либо добавьте модель в справочник заранее"
      });
    }

    // Скрытую модель или скрытого производителя база на прибор не поставит:
    // говорим об этом здесь, а не отказом с идентификатором на последнем шаге.
    if (hiddenModel) {
      issues.push({
        row: record.row, code: "model_hidden",
        problem: `Модель «${hiddenModel.name}» у производителя «${hiddenModel.manufacturerName}» скрыта в справочнике`,
        fix: "Верните модель в справочнике кнопкой «Показать» и повторите пробный импорт"
      });
      manufacturerName = "";
    }
    const manufacturerEntry = manufacturerName
      ? snapshot.manufacturers.find((item) => sameName(item.name, manufacturerName))
      : undefined;
    if (manufacturerEntry && !manufacturerEntry.isActive) {
      issues.push({
        row: record.row, code: "manufacturer_hidden",
        problem: `Производитель «${manufacturerEntry.name}» скрыт в справочнике`,
        fix: "Верните производителя в справочнике кнопкой «Показать» и повторите пробный импорт"
      });
      manufacturerName = "";
    }

    const blocked = !manufacturerName;
    equipment.push({
      row: record.row,
      serialNumber: record.serialNumber,
      serialKey: record.serialKey,
      modelName: record.modelName,
      manufacturerName,
      action: blocked ? "blocked" : "create",
      modelAction,
      differences: [],
      eventsCreate: blocked ? 0 : newEvents.length,
      eventsExisting: blocked ? 0 : seenEvents,
      eventsBlocked: blocked ? events.length : 0
    });
    if (blocked) continue;

    if (modelAction === "create") {
      plannedModels.add(`${catalogKey(manufacturerName)}\u001f${catalogKey(record.modelName)}`);
      if (!manufacturerEntry) plannedManufacturers.add(catalogKey(manufacturerName));
    }
    // Площадку и плательщика импорт не заводит: их ведёт раздел «Клиенты».
    // Чего нет в справочнике — говорим сразу, а прибор создаём без привязки.
    const siteMatches = record.siteName
      ? snapshot.sites.filter((name) => sameName(name, record.siteName ?? "")).length
      : 0;
    if (record.siteName && siteMatches === 0) {
      issues.push({
        row: record.row, code: "site_not_found",
        problem: `Площадки «${record.siteName}» нет в справочнике`,
        fix: "Прибор создадим без площадки: добавьте площадку в «Клиентах» и привяжите прибор вручную"
      });
    }
    if (record.siteName && siteMatches > 1) {
      issues.push({
        row: record.row, code: "site_ambiguous",
        problem: `Площадок с названием «${record.siteName}» несколько — они у разных организаций`,
        fix: "Прибор создадим без площадки: привяжите его к нужной площадке вручную"
      });
    }
    const site = siteMatches === 1 ? record.siteName : undefined;
    const payer = record.payerName && snapshot.payers.some((name) => sameName(name, record.payerName ?? ""))
      ? record.payerName
      : undefined;
    if (record.payerName && !payer) {
      issues.push({
        row: record.row, code: "payer_not_found",
        problem: `Плательщика «${record.payerName}» нет в справочнике`,
        fix: "Прибор создадим без плательщика: добавьте плательщика в «Клиентах» и привяжите прибор вручную"
      });
    }
    writeEquipment.push({
      serialNumber: record.serialNumber,
      manufacturer: manufacturerName,
      model: record.modelName,
      ...(site ? { site } : {}),
      ...(payer ? { payer } : {}),
      ...(record.notes ? { notes: record.notes } : {}),
      ...(record.meterReading !== undefined ? { meterReading: record.meterReading } : {})
    });
    addEvents(record, newEvents);
  }

  const dataRows = reading.sheetRows - reading.serviceRows;
  const rowsWith = (severity: ImportIssueSeverity): number => new Set(
    issues.filter((issue) => issue.row > 0 && issueSeverity(issue.code) === severity).map((issue) => issue.row)
  ).size;
  const eventsCreate = equipment.reduce((total, item) => total + item.eventsCreate, 0);
  const eventsExisting = equipment.reduce((total, item) => total + item.eventsExisting, 0);
  const eventsBlocked = equipment.reduce((total, item) => total + item.eventsBlocked, 0);
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
      readyRows: Math.max(dataRows - rowsWith("error"), 0),
      errorRows: rowsWith("error"),
      warningRows: rowsWith("warning"),
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

/** Что база действительно записала: возвращает функция import_equipment_history (0054). */
export interface ImportWriteResult {
  readonly sourceName: string;
  readonly manufacturersCreated: number;
  readonly modelsCreated: number;
  readonly equipmentCreated: number;
  readonly equipmentAlready: number;
  readonly eventsCreated: number;
  readonly eventsAlready: number;
  /** События, для которых прибора в базе так и не нашлось: они не записаны. */
  readonly eventsWithoutEquipment: number;
}
