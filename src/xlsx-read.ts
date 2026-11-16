/**
 * Чтение таблиц без сторонних библиотек: .xlsx и .csv. Обратная сторона xlsx.ts,
 * который такие файлы собирает, и приём тот же — zip руками, XML разбором строк.
 *
 * .xlsx это zip-архив с XML. Читаем оглавление архива (central directory), распаковываем
 * нужные файлы браузерным DecompressionStream, из первого листа берём ячейки. Текст ячейки
 * может лежать в общей таблице строк (sharedStrings.xml, обычный Excel), прямо в ячейке
 * (inlineStr, так пишем мы сами) или числом. Пустые ячейки не пропускаем, а оставляем
 * пустыми строками: иначе колонки в строке съезжают и количество попадает в цену.
 */

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;

/** Последняя колонка листа Excel — XFD. Номер больше бывает только у битого файла. */
const MAX_COLUMN = 16_383;

/** Строки из таблицы: лист как есть, ячейка — текст. */
export type SheetRows = readonly (readonly string[])[];

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data);
}

/**
 * Текст файла. Внутри .xlsx всегда UTF-8, а вот .csv Excel в русской локали сохраняет
 * в windows-1251: читать его как UTF-8 значит получить кракозябры вместо артикулов
 * и состояний. Поэтому сначала строгий UTF-8, и только если он не сошёлся — 1251.
 */
function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    try {
      return new TextDecoder("windows-1251").decode(data);
    } catch {
      // Кодировки нет в браузере: читаем как UTF-8 с заменой, файл хотя бы откроется.
      return decodeUtf8(data);
    }
  }
}

/** Распаковка deflate средствами браузера; архив без сжатия читается и без неё. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Этот браузер не умеет распаковывать xlsx: сохраните накладную в CSV и загрузите его");
  }
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    // Распаковщик бросает пустую ошибку: без своего текста человек увидел бы пустую плашку.
    throw new Error("Файл .xlsx повреждён: часть его не распаковывается. Пересохраните накладную");
  }
}

/**
 * Файлы из zip-архива: имя → содержимое. Оглавление читаем с конца архива, как и говорит
 * формат: так имена и смещения берутся из одного места, без догадок о порядке файлов.
 */
export async function unzipEntries(data: Uint8Array): Promise<ReadonlyMap<string, Uint8Array>> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  // Хвост архива: комментарий к нему может быть до 64 КБ, дальше искать нечего.
  for (let position = data.length - 22; position >= Math.max(0, data.length - 66_000); position -= 1) {
    if (view.getUint32(position, true) === ZIP_EOCD) { eocd = position; break; }
  }
  if (eocd < 0) throw new Error("Файл не похож на xlsx: не читается как архив");
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const result = new Map<string, Uint8Array>();
  const decoder = new TextDecoder("utf-8");
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > data.length || view.getUint32(cursor, true) !== ZIP_CENTRAL) {
      throw new Error("Файл не похож на xlsx: оглавление архива не читается");
    }
    const method = view.getUint16(cursor + 10, true);
    const packedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(data.subarray(cursor + 46, cursor + 46 + nameLength));
    // Смещения берутся из самого файла: у битого архива (и у zip64, где здесь стоит
    // 0xFFFFFFFF) они уводят за край, и DataView бросает ошибку без понятного текста.
    if (localOffset + 30 > data.length) {
      throw new Error("Файл .xlsx повреждён: оглавление архива указывает за его край. Пересохраните накладную");
    }
    // Дополнительное поле у локального заголовка своё: смещение данных считаем по нему.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + packedSize > data.length) {
      throw new Error("Файл .xlsx повреждён: часть файлов в архиве обрезана. Пересохраните накладную");
    }
    const packed = data.subarray(start, start + packedSize);
    if (!name.endsWith("/")) {
      result.set(name, method === 0 ? packed : await inflateRaw(packed));
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&#x([0-9a-fA-F]+);/gu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, "&");
}

/** Весь текст внутри тегов <t>: в общей таблице строка может быть разбита на куски с разным шрифтом. */
function textOfRuns(xml: string): string {
  let text = "";
  for (const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)) text += unescapeXml(match[1] ?? "");
  return text;
}

/** Общая таблица строк: обычный Excel держит текст ячеек в ней, а в ячейке только номер. */
export function parseSharedStrings(xml: string): readonly string[] {
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gu)].map((match) => textOfRuns(match[1] ?? ""));
}

/** Номер колонки по имени ячейки: A1 → 0, B2 → 1, AA3 → 26. Обратное columnName из xlsx.ts. */
export function columnIndex(reference: string): number {
  const letters = /^([A-Za-z]+)/u.exec(reference)?.[1];
  if (!letters) return -1;
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** Ячейки листа: текст по колонкам, пустые остаются пустыми. */
export function parseSheet(xml: string, sharedStrings: readonly string[]): SheetRows {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/row>)/gu)) {
    const body = rowMatch[1] ?? "";
    const cells: string[] = [];
    for (const cellMatch of body.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const attributes = cellMatch[1] ?? "";
      const content = cellMatch[2] ?? "";
      const reference = /r="([^"]+)"/u.exec(attributes)?.[1] ?? "";
      const type = /t="([^"]+)"/u.exec(attributes)?.[1] ?? "n";
      const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/u.exec(content)?.[1] ?? "";
      let value: string;
      if (type === "s") {
        value = sharedStrings[Number(raw)] ?? "";
      } else if (type === "inlineStr") {
        value = textOfRuns(content);
      } else if (type === "e") {
        // Ошибка формулы (#Н/Д): пустая клетка понятнее, чем код ошибки в артикуле.
        value = "";
      } else {
        value = unescapeXml(raw);
      }
      const at = reference ? columnIndex(reference) : cells.length;
      // Дальше XFD (16383) Excel колонок не делает: номер больше — файл битый, и наивный
      // добор пустых клеток съел бы память, а то и повесил бы страницу. Такую клетку пропускаем.
      const column = at >= 0 && at <= MAX_COLUMN ? at : at > MAX_COLUMN ? -1 : cells.length;
      if (column < 0) continue;
      while (cells.length < column) cells.push("");
      cells[column] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/** Первый лист книги: по оглавлению, а не по имени файла — лист может лежать не в sheet1.xml. */
function firstSheetPath(entries: ReadonlyMap<string, Uint8Array>): string {
  const workbook = entries.get("xl/workbook.xml");
  const relations = entries.get("xl/_rels/workbook.xml.rels");
  if (workbook && relations) {
    const id = /<sheet\s[^>]*r:id="([^"]+)"/u.exec(decodeUtf8(workbook))?.[1];
    if (id) {
      const target = new RegExp(`<Relationship[^>]*Id="${id}"[^>]*Target="([^"]+)"`, "u").exec(decodeUtf8(relations))?.[1];
      if (target) return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//u, "")}`;
    }
  }
  return "xl/worksheets/sheet1.xml";
}

/** Строки первого листа файла .xlsx. */
export async function readXlsxRows(data: Uint8Array): Promise<SheetRows> {
  const entries = await unzipEntries(data);
  const path = firstSheetPath(entries);
  const sheet = entries.get(path) ?? entries.get("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("В файле не нашлось ни одного листа с данными");
  const shared = entries.get("xl/sharedStrings.xml");
  return parseSheet(decodeUtf8(sheet), shared ? parseSharedStrings(decodeUtf8(shared)) : []);
}

/**
 * Строки из CSV: разделитель — точка с запятой или запятая, что встретилось в первой
 * строке чаще (Excel в русской локали сохраняет с точкой с запятой). Кавычки по правилам
 * CSV: внутри них разделитель и перевод строки — обычные символы, две кавычки подряд — одна.
 */
export function parseCsvRows(text: string): SheetRows {
  const clean = text.replace(/^﻿/u, "");
  const headLine = clean.split(/\r?\n/u)[0] ?? "";
  const semicolons = (headLine.match(/;/gu) ?? []).length;
  const commas = (headLine.match(/,/gu) ?? []).length;
  const tabs = (headLine.match(/\t/gu) ?? []).length;
  const separator = tabs > semicolons && tabs > commas ? "\t" : commas > semicolons ? "," : ";";
  const rows: string[][] = [];
  let cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (quoted) {
      if (char === "\"") {
        if (clean[index + 1] === "\"") { value += "\""; index += 1; }
        else quoted = false;
      } else value += char;
      continue;
    }
    if (char === "\"") { quoted = true; continue; }
    if (char === separator) { cells.push(value); value = ""; continue; }
    if (char === "\n") { cells.push(value); rows.push(cells); cells = []; value = ""; continue; }
    if (char === "\r") continue;
    value += char;
  }
  if (value !== "" || cells.length) { cells.push(value); rows.push(cells); }
  return rows;
}

/** Строки из файла накладной: .xlsx распаковываем, .csv и .txt читаем текстом. */
export async function readSpreadsheetFile(file: { readonly name: string; arrayBuffer: () => Promise<ArrayBuffer> }): Promise<SheetRows> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const looksZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (looksZip) return readXlsxRows(bytes);
  if (/\.xlsx?$/iu.test(file.name)) {
    throw new Error("Файл .xls старого формата не читается: сохраните его как .xlsx или .csv");
  }
  return parseCsvRows(decodeText(bytes));
}
