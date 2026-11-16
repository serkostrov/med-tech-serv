/**
 * Накладная таблицей → строки прихода для базы. Файл читает xlsx-read.ts, строки проверяет
 * база (preview_stock_receipt, миграция 0050): здесь только раскладка файла по колонкам.
 *
 * Почему проверки не здесь. Что считать ошибкой строки, решает база — она же и откажет
 * при подтверждении. Если бы текст ошибок жил ещё и тут, пользователь видел бы одно,
 * а при оприходовании получал другое. Страница сообщает только о том, чего база не видит:
 * файл без колонки артикула и файл без строк.
 */

/** Строка накладной, как её принимает база: номер строки файла нужен для ошибок. */
export interface StockReceiptRow {
  readonly row: number;
  readonly article: string;
  readonly quantity: string;
  readonly condition: string;
  readonly unit_price?: string;
  readonly comment?: string;
}

/** Какая колонка файла за что отвечает; -1 — такой колонки нет. */
export interface ReceiptColumns {
  readonly article: number;
  readonly quantity: number;
  readonly condition: number;
  readonly price: number;
  readonly name: number;
  /** Номер строки файла с заголовками (с единицы), 0 — заголовков нет. */
  readonly headerRow: number;
}

/**
 * Слова в заголовке, по которым узнаём колонку. Сравниваем по началу: «Кол-во, шт.»
 * и «Количество» одинаково, «Артикул поставщика» тоже артикул. «Ё» приводим к «е»,
 * как поиск в базе.
 */
const HEADER_WORDS: Readonly<Record<keyof Omit<ReceiptColumns, "headerRow">, readonly string[]>> = {
  article: ["артикул", "код", "каталожный", "парт", "part", "article", "sku"],
  quantity: ["кол", "количество", "шт", "quantity", "qty"],
  condition: ["состояние", "сост", "condition"],
  price: ["цена", "стоимость", "price", "сумма за"],
  name: ["наименование", "название", "номенклатура", "описание", "name"]
};

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/ё/gu, "е").replace(/[^a-zа-я0-9]+/gu, " ").trim();
}

function matchesHeader(cell: string, words: readonly string[]): boolean {
  const text = normalizeHeader(cell);
  if (!text) return false;
  // Сокращения в заголовках обычные («Наимен.», «Артик.»), поэтому слово узнаётся и по началу
  // в обе стороны. От четырёх букв — иначе «ц» или «на» цеплялись бы за что попало.
  return words.some((word) => text === word || text.startsWith(word) || (text.length >= 4 && word.startsWith(text)));
}

/**
 * Где какие колонки. Ищем строку заголовков в первых десяти строках: над таблицей
 * в накладной обычно стоят название поставщика и номер документа. Заголовков нет —
 * считаем, что колонки идут как артикул, наименование, количество, состояние, цена:
 * так выглядит выгрузка без шапки, и дальше человек увидит разбор и поймёт, что не так.
 */
export function detectReceiptColumns(rows: readonly (readonly string[])[]): ReceiptColumns {
  const limit = Math.min(rows.length, 10);
  for (let index = 0; index < limit; index += 1) {
    const row = rows[index] ?? [];
    const found = {
      article: row.findIndex((cell) => matchesHeader(cell, HEADER_WORDS.article)),
      quantity: row.findIndex((cell) => matchesHeader(cell, HEADER_WORDS.quantity)),
      condition: row.findIndex((cell) => matchesHeader(cell, HEADER_WORDS.condition)),
      price: row.findIndex((cell) => matchesHeader(cell, HEADER_WORDS.price)),
      name: row.findIndex((cell) => matchesHeader(cell, HEADER_WORDS.name))
    };
    // Заголовок считается найденным, когда понятны обе обязательные колонки.
    if (found.article >= 0 && found.quantity >= 0) return { ...found, headerRow: index + 1 };
  }
  return { article: 0, name: 1, quantity: 2, condition: 3, price: 4, headerRow: 0 };
}

function cell(row: readonly string[], at: number): string {
  return at >= 0 ? (row[at] ?? "").trim() : "";
}

/**
 * Строки прихода из таблицы. Пустые строки пропускаем молча: в накладных между разделами
 * попадаются пустые, ошибкой это не назовёшь. Номер строки — тот, что человек видит
 * в файле (с единицы), чтобы ошибки базы указывали на нужную строку.
 *
 * Комментарий (номер накладной) один на весь файл: его вписывает кладовщик в окне, в файле
 * его обычно нет, а в истории позиции он нужен у каждого движения.
 */
export function receiptRowsFromSheet(
  rows: readonly (readonly string[])[],
  columns: ReceiptColumns,
  comment = ""
): readonly StockReceiptRow[] {
  const result: StockReceiptRow[] = [];
  for (let index = columns.headerRow; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const article = cell(row, columns.article);
    const quantity = cell(row, columns.quantity);
    const condition = cell(row, columns.condition);
    const price = cell(row, columns.price);
    if (!article && !quantity && !condition && !price) continue;
    result.push({
      row: index + 1,
      article,
      quantity,
      condition,
      ...(price ? { unit_price: price } : {}),
      ...(comment.trim() ? { comment: comment.trim() } : {})
    });
  }
  return result;
}

/** Чего база о файле не узнает: нет колонки артикула или количества, нет строк. */
export function receiptFileProblem(rows: readonly (readonly string[])[], columns: ReceiptColumns, prepared: readonly StockReceiptRow[]): string | undefined {
  if (rows.length === 0) return "Файл пустой: в нём нет ни одной строки";
  if (prepared.length === 0) {
    return columns.headerRow
      ? "Под строкой заголовков нет ни одной строки с приходом"
      : "В файле нет ни одной строки с приходом";
  }
  if (columns.headerRow === 0 && prepared.every((item) => !item.article)) {
    return "Не нашлась колонка с артикулом: назовите её «Артикул» в первой строке файла";
  }
  return undefined;
}

/**
 * Сколько строк готово к приходу и сколько с ошибками. На входе то, что отдала база
 * (preview_stock_receipt): пересчитывать строки здесь нечего, только сложить.
 */
export function receiptPreviewSummary(rows: readonly {
  readonly matchedBy?: "article" | "alias";
  readonly quantity?: number;
  readonly error?: string;
}[]): {
  readonly ready: number;
  readonly broken: number;
  readonly quantity: number;
  readonly byAlias: number;
} {
  const ready = rows.filter((item) => !item.error);
  return {
    ready: ready.length,
    broken: rows.length - ready.length,
    quantity: ready.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
    byAlias: ready.filter((item) => item.matchedBy === "alias").length
  };
}
