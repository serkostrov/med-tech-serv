import React, { useRef, useState, type ChangeEvent } from "react";
import { m2Api, type StockReceiptPreviewRow } from "./m2-api.js";
import { Button, Dialog, Notice, ResourceState, StatusBadge, toast } from "./ui.js";
import { formatRussianCount } from "./equipment-changes.js";
import { formatMoney } from "./price-list.js";
import { readSpreadsheetFile } from "./xlsx-read.js";
import {
  detectReceiptColumns,
  receiptFileProblem,
  receiptPreviewSummary,
  receiptRowsFromSheet,
  type StockReceiptRow
} from "./stock-receipt-import.js";
import { PART_CONDITION_LABELS, PART_CONDITION_LETTERS, movementQuantityText } from "./stock-movements.js";

/**
 * Приход накладной файлом: загрузили таблицу, посмотрели, что система распознала,
 * и только после подтверждения оприходовали.
 *
 * Разбор строк и все отказы приходят из базы (preview_stock_receipt, 0050): здесь их
 * показывают списком по строкам. Пока кнопку «Оприходовать» не нажали, на складе
 * не меняется ничего — предпросмотр только читает.
 */
export function StockReceiptImport({ open, onOpenChange, onDone }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Приход проведён: список склада перечитывается. */
  readonly onDone: () => void | Promise<void>;
}) {
  const [fileName, setFileName] = useState("");
  const [comment, setComment] = useState("");
  const [rows, setRows] = useState<readonly StockReceiptRow[]>([]);
  const [preview, setPreview] = useState<readonly StockReceiptPreviewRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [applying, setApplying] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setFileName(""); setRows([]); setPreview([]); setProblem(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  /** Разбор файла и запрос к базе: что она распознала и что в строках не так. */
  const askDatabase = async (prepared: readonly StockReceiptRow[]) => {
    setPreview(await m2Api.previewStockReceipt(prepared));
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setReading(true); setProblem(null); setPreview([]); setRows([]);
    setFileName(file.name);
    try {
      const sheet = await readSpreadsheetFile(file);
      const columns = detectReceiptColumns(sheet);
      const prepared = receiptRowsFromSheet(sheet, columns, comment);
      const fileProblem = receiptFileProblem(sheet, columns, prepared);
      if (fileProblem) { setProblem(fileProblem); return; }
      setRows(prepared);
      await askDatabase(prepared);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Файл не прочитался");
    } finally {
      setReading(false);
    }
  };

  /**
   * Номер накладной вписывают и после загрузки файла: он идёт в комментарий каждого
   * движения. Разбор базы от него не зависит, поэтому заново не спрашиваем — номер
   * доедет вместе со строками при приходе.
   */
  const changeComment = async (value: string) => {
    setComment(value);
    if (!rows.length) return;
    const trimmed = value.trim();
    setRows(rows.map(({ comment: previous, ...rest }) => trimmed ? { ...rest, comment: trimmed } : rest));
  };

  const summary = receiptPreviewSummary(preview);
  const ready = preview.length > 0 && summary.broken === 0;

  const apply = async () => {
    if (!ready) return;
    setApplying(true);
    try {
      const applied = await m2Api.receiveStockBatch(rows);
      const total = applied.reduce((sum, item) => sum + item.quantity, 0);
      toast.success(`Оприходовано ${formatRussianCount(applied.length, ["позиция", "позиции", "позиций"])} · ${movementQuantityText(total)}`, { title: "Накладная проведена" });
      onOpenChange(false);
      reset();
      setComment("");
      await onDone();
    } catch (error) {
      // Отказ базы показываем как есть: в нём и число ошибок, и первая строка.
      setProblem(error instanceof Error ? error.message : "Не получилось оприходовать накладную");
    } finally {
      setApplying(false);
    }
  };

  return <Dialog
    busy={applying}
    description="Файл .xlsx или .csv: артикул, количество, состояние и цена. Пока не нажмёте «Оприходовать», на складе ничего не изменится."
    footer={<>
      <Button disabled={applying} onClick={() => onOpenChange(false)} variant="secondary">Закрыть</Button>
      <Button busy={applying} busyLabel="Проводим…" disabled={!ready} onClick={() => void apply()}>
        {ready ? `Оприходовать · ${formatRussianCount(summary.ready, ["строка", "строки", "строк"])}` : "Оприходовать"}
      </Button>
    </>}
    onOpenChange={(next) => { if (!next) { reset(); setComment(""); } onOpenChange(next); }}
    open={open}
    size="lg"
    title="Приход накладной файлом"
  >
    <div className="receipt-import">
      <div className="receipt-import__fields">
        <label>Файл накладной
          <input
            accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void chooseFile(event)}
            ref={inputRef}
            type="file"
          />
          <small>Колонки узнаются по заголовкам: «Артикул», «Количество», «Состояние», «Цена». Состояние можно писать буквой или словом.</small>
        </label>
        <label>Накладная<input
          onChange={(event) => void changeComment(event.target.value)}
          placeholder="Накладная 108 от 14.11.2026"
          value={comment}
        /><small>Попадёт в историю каждой позиции этого прихода.</small></label>
      </div>

      {reading ? <ResourceState description="Читаем файл и спрашиваем базу, что в нём распознано." status="loading" title="Разбираем накладную" /> : null}
      {problem ? <div className="form-error" role="alert">{problem}</div> : null}

      {!reading && preview.length > 0 ? <>
        {summary.broken > 0
          ? <Notice icon="info" tone="warning">
              {formatRussianCount(summary.broken, ["строка", "строки", "строк"])} с ошибками: поправьте их в файле и загрузите снова.
              Приход проводится целиком — пока ошибка есть хотя бы в одной строке, на склад не попадёт ни одна.
            </Notice>
          : <Notice icon="check" tone="success">
              Распознано {formatRussianCount(summary.ready, ["строка", "строки", "строк"])} на {movementQuantityText(summary.quantity)}
              {summary.byAlias > 0 ? `, из них ${summary.byAlias} по артикулу поставщика` : ""}. Проверьте и нажмите «Оприходовать».
            </Notice>}
        <div className="table-scroll">
          <table className="data-table receipt-import__table">
            <thead><tr><th>Строка</th><th>Артикул из файла</th><th>Запчасть на складе</th><th className="numeric">Количество</th><th>Состояние</th><th className="numeric">Цена</th><th>Что не так</th></tr></thead>
            <tbody>{preview.map((row) => <tr className={row.error ? "receipt-import__row--broken" : ""} key={row.rowNo}>
              <td data-label="Строка">{row.rowNo}</td>
              <td data-label="Артикул из файла"><strong>{row.article || "—"}</strong></td>
              <td data-label="Запчасть на складе">{row.partArticle
                ? <>
                    <span>{row.partArticle} · {row.partName}</span>
                    {row.matchedBy === "alias" ? <small>нашлась по артикулу поставщика</small> : null}
                  </>
                : "—"}</td>
              <td className="numeric" data-label="Количество">{row.quantity === undefined ? "—" : movementQuantityText(row.quantity)}</td>
              <td data-label="Состояние">{row.condition ? `${PART_CONDITION_LETTERS[row.condition]} · ${PART_CONDITION_LABELS[row.condition]}` : "—"}</td>
              {/* Цена из файла, а не со склада: читать цену прихода складу нельзя (0040).
                  Показываем, чтобы было видно, если в цену попала колонка «Сумма». */}
              <td className="numeric" data-label="Цена">{row.unitPrice === undefined ? "—" : formatMoney(row.unitPrice)}</td>
              <td data-label="Что не так">{row.error
                ? <StatusBadge tone="danger">{row.error}</StatusBadge>
                : <StatusBadge tone="success">Готово к приходу</StatusBadge>}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </> : null}

      {!reading && !problem && preview.length === 0 && fileName
        ? <ResourceState description={`В файле ${fileName} не нашлось строк с приходом.`} status="empty" title="Строк не нашлось" />
        : null}
    </div>
  </Dialog>;
}
