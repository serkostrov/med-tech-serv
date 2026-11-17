/**
 * Документы склада (миграция 0062): перемещение на склад инженера, возврат на склад
 * и списание. Создаёт их сама база при движении запчасти, здесь — только подписи
 * и выгрузка в Excel.
 *
 * Цен в документах нет: цена прихода закрыта от склада и инженера (0040), а стоимость
 * списания считает 1С. Точный вид документа уточняет бухгалтерия — когда он появится,
 * меняется лист выгрузки здесь, а не база.
 */
import { formatDisplayDate } from "./date-format.js";
import type { XlsxCell, XlsxSheet } from "./xlsx.js";

export type StockDocumentKind = "transfer" | "return" | "writeoff";

export const STOCK_DOCUMENT_KINDS: readonly StockDocumentKind[] = ["transfer", "return", "writeoff"];

/** Документ склада из списка (функция stock_document_list). */
export interface StockDocumentRecord {
  readonly id: string;
  readonly number: string;
  readonly kind: StockDocumentKind;
  /** Дата документа, YYYY-MM-DD по часам компании. */
  readonly date: string;
  readonly taskId?: string;
  readonly taskNumber?: string;
  readonly taskTitle?: string;
  readonly equipmentSerialNumber?: string;
  readonly equipmentName?: string;
  readonly siteName?: string;
  readonly engineerName?: string;
  readonly lineCount: number;
  readonly totalQuantity: number;
}

/** Строка документа: одно движение склада (функция stock_document_lines_for). */
export interface StockDocumentLine {
  readonly documentId: string;
  readonly movementId: string;
  readonly articleNumber: string;
  readonly partName: string;
  readonly condition: "G" | "N" | "B";
  readonly quantity: number;
  readonly reservationNumber?: string;
  readonly occurredAt: string;
  /** Причина списания брака или комментарий движения. */
  readonly comment?: string;
}

export interface StockDocumentPage {
  readonly items: readonly StockDocumentRecord[];
  readonly total: number;
}

export const STOCK_DOCUMENT_KIND_LABELS: Readonly<Record<StockDocumentKind, string>> = {
  transfer: "Перемещение на склад инженера",
  return: "Возврат на склад",
  writeoff: "Списание"
};

/** Короткая подпись вида для узкой колонки и значка. */
export const STOCK_DOCUMENT_KIND_SHORT: Readonly<Record<StockDocumentKind, string>> = {
  transfer: "Перемещение",
  return: "Возврат",
  writeoff: "Списание"
};

/** Что документ значит для бухгалтерии: подпись под заголовком карточки. */
export const STOCK_DOCUMENT_KIND_HINTS: Readonly<Record<StockDocumentKind, string>> = {
  transfer: "Кладовщик выдал запчасти инженеру. Запчасти ещё числятся за компанией — на складе инженера.",
  return: "Инженер вернул запчасти на основной склад.",
  writeoff: "Запчасти установлены в прибор: инженер отметил «установлено», координатор закрыл задачу."
};

/** Подпись под заголовком: у списания брака задачи нет, и объяснение другое. */
export function stockDocumentHint(document: Pick<StockDocumentRecord, "kind" | "taskNumber">): string {
  if (document.kind === "writeoff" && !document.taskNumber) return "Кладовщик списал запчасти со склада: брак или утеря.";
  return STOCK_DOCUMENT_KIND_HINTS[document.kind];
}

export const STOCK_DOCUMENT_CONDITION_LABELS: Readonly<Record<StockDocumentLine["condition"], string>> = {
  G: "Г · гарантийная",
  N: "Н · новая",
  B: "Б · б/у"
};

export function isStockDocumentKind(value: string): value is StockDocumentKind {
  return (STOCK_DOCUMENT_KINDS as readonly string[]).includes(value);
}

/**
 * Основание документа одной строкой: задача, а без задачи — причина списания.
 * Списание брака приходит без задачи, и пустая клетка «Основание» в бухгалтерии
 * вызвала бы вопрос, откуда документ.
 */
export function stockDocumentBasis(document: StockDocumentRecord, lines: readonly StockDocumentLine[] = []): string {
  if (document.taskNumber) return document.taskTitle ? `Задача ${document.taskNumber} · ${document.taskTitle}` : `Задача ${document.taskNumber}`;
  const reasons = [...new Set(lines.map((line) => line.comment?.trim()).filter((reason): reason is string => Boolean(reason)))];
  if (reasons.length) return `Списание со склада: ${reasons.join("; ")}`;
  return document.kind === "writeoff" ? "Списание со склада" : "";
}

/** Прибор документа: «Beckman Coulter AU 480 · S/N 123». */
export function stockDocumentEquipment(document: StockDocumentRecord): string {
  const serial = document.equipmentSerialNumber ? `S/N ${document.equipmentSerialNumber}` : "";
  return [document.equipmentName, serial].filter(Boolean).join(" · ");
}

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3))).replace(".", ",");
}

/** «3 строки · 5 шт.» */
export function stockDocumentTotalsText(document: Pick<StockDocumentRecord, "lineCount" | "totalQuantity">): string {
  const n = document.lineCount;
  const word = n % 10 === 1 && n % 100 !== 11 ? "строка" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "строки" : "строк";
  return `${n} ${word} · ${formatQuantity(document.totalQuantity)} шт.`;
}

const DOCUMENT_HEADER = [
  "Документ", "Вид", "Дата", "Основание", "Прибор", "Площадка", "Инженер",
  "Артикул", "Наименование", "Состояние", "Количество", "Резерв", "Причина"
];

/**
 * Лист «Документы склада»: строка на каждую запчасть документа, шапка документа
 * повторяется в каждой строке. Так файл сортируется и фильтруется в Excel без
 * объединённых ячеек, а в 1С переносится построчно.
 */
export function stockDocumentSheets(
  documents: readonly StockDocumentRecord[],
  lines: readonly StockDocumentLine[]
): readonly XlsxSheet[] {
  const byDocument = new Map<string, StockDocumentLine[]>();
  for (const line of lines) {
    const bucket = byDocument.get(line.documentId);
    if (bucket) bucket.push(line);
    else byDocument.set(line.documentId, [line]);
  }
  const rows: XlsxCell[][] = [];
  for (const document of documents) {
    const own = byDocument.get(document.id) ?? [];
    const head: XlsxCell[] = [
      document.number,
      STOCK_DOCUMENT_KIND_LABELS[document.kind],
      formatDisplayDate(document.date),
      stockDocumentBasis(document, own),
      stockDocumentEquipment(document),
      document.siteName ?? "",
      document.engineerName ?? ""
    ];
    if (own.length === 0) {
      rows.push([...head, "", "", "", "", "", ""]);
      continue;
    }
    for (const line of own) {
      rows.push([
        ...head,
        line.articleNumber,
        line.partName,
        STOCK_DOCUMENT_CONDITION_LABELS[line.condition],
        line.quantity,
        line.reservationNumber ?? "",
        document.taskNumber ? "" : line.comment ?? ""
      ]);
    }
  }
  return [{
    name: "Документы склада",
    rows: [DOCUMENT_HEADER, ...rows],
    headerRow: 1,
    widths: [14, 30, 12, 40, 34, 26, 24, 18, 36, 16, 12, 12, 30]
  }];
}

/** Имя файла одного документа: «ПМ-000001 Перемещение 17.11.2026.xlsx». */
export function stockDocumentFileName(document: StockDocumentRecord): string {
  return `${document.number} ${STOCK_DOCUMENT_KIND_SHORT[document.kind]} ${formatDisplayDate(document.date)}.xlsx`;
}
