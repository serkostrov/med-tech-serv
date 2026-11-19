import { EntityLink } from "./entity-links.js";
import React, { useEffect, useRef, useState } from "react";
import { m2Api } from "./m2-api.js";
import { Button, DataTableShell, DatePicker, Dialog, EntityDetailToolbar, FilterBar, ResourceState, Select, StatusBadge, toast, type StatusTone } from "./ui.js";
import { RegistryPagination, usePageSize } from "./RegistryPagination.js";
import { formatDisplayDate } from "./date-format.js";
import { formatRussianCount } from "./equipment-changes.js";
import { downloadWorkbook, registryFileName } from "./registry-export.js";
import {
  STOCK_DOCUMENT_CONDITION_LABELS,
  STOCK_DOCUMENT_KIND_LABELS,
  STOCK_DOCUMENT_KIND_SHORT,
  stockDocumentBasis,
  stockDocumentEquipment,
  stockDocumentFileName,
  stockDocumentHint,
  stockDocumentSheets,
  stockDocumentTotalsText,
  type StockDocumentKind,
  type StockDocumentLine,
  type StockDocumentRecord
} from "./stock-documents.js";

const KIND_TONES: Readonly<Record<StockDocumentKind, StatusTone>> = {
  transfer: "info",
  return: "neutral",
  writeoff: "purple"
};

/** Сколько документов выгружаем в Excel за раз: строки документов база отдаёт по 1000 документов. */
const EXPORT_LIMIT = 1000;

function KindBadge({ kind }: { readonly kind: StockDocumentKind }) {
  return <StatusBadge tone={KIND_TONES[kind]}>{STOCK_DOCUMENT_KIND_SHORT[kind]}</StatusBadge>;
}

/** Карточка документа: шапка, строки и выгрузка этого документа в Excel. */
export function StockDocumentDialog({ document, onClose, asPage = false }: {
  readonly document: StockDocumentRecord | null;
  readonly onClose: () => void;
  /** Страницей вместо окна (встреча 18.11: «по попапам неудобно»): «Назад» возвращает к списку. */
  readonly asPage?: boolean;
}) {
  const [lines, setLines] = useState<readonly StockDocumentLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const documentId = document?.id;
  useEffect(() => {
    if (!documentId) return;
    let alive = true;
    setLines(null);
    setError(null);
    m2Api.stockDocumentLines([documentId])
      .then((loaded) => { if (alive) setLines(loaded); })
      .catch((loadError: unknown) => { if (alive) setError(loadError instanceof Error ? loadError.message : "Не получилось загрузить строки документа"); });
    return () => { alive = false; };
  }, [documentId]);
  const exportOne = async () => {
    if (!document || !lines) return;
    setExporting(true);
    try {
      await downloadWorkbook(stockDocumentSheets([document], lines), stockDocumentFileName(document));
    } catch (exportError) {
      toast.error(exportError instanceof Error ? exportError.message : "Не получилось выгрузить документ", { title: "Файл не выгрузился" });
    } finally {
      setExporting(false);
    }
  };
  const withoutTask = document ? !document.taskNumber : false;
  const allFacts: readonly (readonly [string, string])[] = document ? [
    ["Дата", formatDisplayDate(document.date)],
    ["Основание", stockDocumentBasis(document, lines ?? [])],
    ["Инженер", document.engineerName ?? ""],
    ["Прибор", stockDocumentEquipment(document)],
    ["Площадка", document.siteName ?? ""]
  ] : [];
  const facts = allFacts.filter(([, value]) => value);
  const content = <>
    {document ? <div className="stock-document">
      <dl className="stock-document__facts">
        {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === "Основание" && document.taskId ? <EntityLink target={{ kind: "task", id: document.taskId }}>{value}</EntityLink> : value}</dd></div>)}
      </dl>
      {error ? <ResourceState description={error} status="error" title="Строки не загрузились" />
        : !lines ? <ResourceState description="Подождите, строки документа сейчас появятся." status="loading" title="Загружаем строки" />
        : <div className="table-scroll table-cards"><table className="data-table">
          <thead><tr>
            <th scope="col">Артикул</th>
            <th scope="col">Наименование</th>
            <th scope="col">Состояние</th>
            <th className="numeric" scope="col">Количество</th>
            <th scope="col">{withoutTask ? "Причина" : "Резерв"}</th>
          </tr></thead>
          <tbody>{lines.map((line) => <tr key={line.movementId}>
            <td data-label="Артикул"><strong>{line.articleNumber}</strong></td>
            <td className="cell-wide" data-label="Наименование">{line.partName}</td>
            <td data-label="Состояние">{STOCK_DOCUMENT_CONDITION_LABELS[line.condition]}</td>
            <td className="numeric" data-label="Количество">{line.quantity}</td>
            <td data-label={withoutTask ? "Причина" : "Резерв"}>{withoutTask ? line.comment ?? "" : line.reservationNumber ?? ""}</td>
          </tr>)}</tbody>
        </table></div>}
    </div> : null}
  </>;
  if (asPage && document) {
    return <div className="stock-document-page">
      <EntityDetailToolbar backLabel="К документам" onBack={onClose} />
      <header className="task-head">
        <div className="task-head__meta"><span className="task-head__number">{document.number}</span><KindBadge kind={document.kind} /></div>
        <h1>{STOCK_DOCUMENT_KIND_LABELS[document.kind]} {document.number}</h1>
        <div className="engineer-page__actions"><Button busy={exporting} busyLabel="Готовим файл…" disabled={!lines || lines.length === 0} onClick={() => void exportOne()} variant="secondary">Скачать в Excel</Button></div>
      </header>
      <section className="task-section">{content}</section>
    </div>;
  }
  return <Dialog
    describeHidden
    description={document ? stockDocumentHint(document) : undefined}
    footer={<>
      <Button onClick={onClose} variant="secondary">Закрыть</Button>
      <Button busy={exporting} busyLabel="Готовим файл…" disabled={!lines || lines.length === 0} onClick={() => void exportOne()}>Скачать в Excel</Button>
    </>}
    onOpenChange={(open) => { if (!open) onClose(); }}
    open={Boolean(document)}
    size="lg"
    title={document ? `${STOCK_DOCUMENT_KIND_LABELS[document.kind]} ${document.number}` : "Документ склада"}
  >
    {content}
  </Dialog>;
}

const EMPTY_FILTERS = { kind: "" as StockDocumentKind | "", search: "", from: "", to: "" };

/** Склад → «Документы»: все документы склада с отбором и выгрузкой. */
export function StockDocumentsView() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [documents, setDocuments] = useState<readonly StockDocumentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pageIndex, setPageIndex] = useState(0);
  const { pageSize, pageSizeRef, setPageSize } = usePageSize("stock-documents");
  const [opened, setOpened] = useState<StockDocumentRecord | null>(null);
  const [exporting, setExporting] = useState(false);
  const loadTurn = useRef(0);
  const reload = async (nextFilters = filters, nextPage = pageIndex) => {
    const turn = ++loadTurn.current;
    setLoading(true);
    try {
      const page = await m2Api.stockDocumentPage({ ...nextFilters, limit: pageSizeRef.current, offset: nextPage * pageSizeRef.current });
      if (turn !== loadTurn.current) return;
      setDocuments(page.items); setTotal(page.total); setPageIndex(nextPage);
    } catch (loadError) {
      if (turn === loadTurn.current) toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить документы склада");
    } finally {
      if (turn === loadTurn.current) setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, []);
  // Весь отбор, а не открытую страницу: бухгалтерии нужен период целиком.
  const exportExcel = async () => {
    setExporting(true);
    try {
      const page = await m2Api.stockDocumentPage({ ...filters, limit: EXPORT_LIMIT, offset: 0 });
      const lines = await m2Api.stockDocumentLines(page.items.map((item) => item.id));
      await downloadWorkbook(stockDocumentSheets(page.items, lines), registryFileName("Документы склада"));
      const cut = page.total > page.items.length ? `. В файл вошли первые ${page.items.length} из ${page.total}: сузьте период` : "";
      toast.success(`В файле ${formatRussianCount(page.items.length, ["документ", "документа", "документов"])}${cut}`, { title: "Документы выгружены" });
    } catch (exportError) {
      toast.error(exportError instanceof Error ? exportError.message : "Не получилось выгрузить документы", { title: "Файл не выгрузился" });
    } finally {
      setExporting(false);
    }
  };
  const filtered = Boolean(filters.kind || filters.search || filters.from || filters.to);
  // Открытый документ — страницей на месте списка; «К документам» возвращает к тому же отбору.
  if (opened) return <StockDocumentDialog asPage document={opened} onClose={() => setOpened(null)} />;
  return <>
    <FilterBar loading={loading} onReset={() => { setFilters(EMPTY_FILTERS); void reload(EMPTY_FILTERS, 0); }} onSubmit={() => reload(filters, 0)}>
      <label className="filter-field--search">Поиск<input onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Номер, задача, S/N, инженер или артикул" type="search" value={filters.search} /></label>
      <label>Документ<Select onChange={(event) => setFilters((current) => ({ ...current, kind: event.target.value as StockDocumentKind | "" }))} value={filters.kind}>
        <option value="">Все документы</option>
        <option value="transfer">Перемещение на склад инженера</option>
        <option value="return">Возврат на склад</option>
        <option value="writeoff">Списание</option>
      </Select></label>
      <label>Период с<DatePicker onChange={(from) => setFilters((current) => ({ ...current, from }))} placeholder="С какого дня" value={filters.from} /></label>
      <label>Период по<DatePicker onChange={(to) => setFilters((current) => ({ ...current, to }))} placeholder="По какой день" value={filters.to} /></label>
    </FilterBar>
    <DataTableShell
      action={<Button busy={exporting} busyLabel="Готовим файл…" disabled={loading || total === 0} onClick={() => void exportExcel()} variant="secondary">Скачать в Excel</Button>}
      label="Документы склада"
    >
      {loading && documents.length === 0 ? <ResourceState description="Подождите, документы сейчас появятся." status="loading" title="Загружаем документы" />
        : documents.length === 0 ? <ResourceState
          description={filtered ? "Измените поиск или сбросьте фильтры." : "Документ появится сам, когда кладовщик выдаст запчасть инженеру, инженер вернёт её на склад или координатор закроет задачу с установленной запчастью."}
          status={filtered ? "filtered-empty" : "empty"}
          title={filtered ? "Документов по этим условиям нет" : "Документов пока нет"}
        />
        : <><div className="table-scroll table-cards"><table className="data-table stock-documents-table">
          <thead><tr>
            <th scope="col">Номер</th>
            <th scope="col">Документ</th>
            <th scope="col">Дата</th>
            <th scope="col">Основание</th>
            <th scope="col">Прибор</th>
            <th scope="col">Инженер</th>
            <th scope="col">Состав</th>
          </tr></thead>
          <tbody>{documents.map((document) => <tr className="stock-documents-table__row" key={document.id} onClick={() => setOpened(document)}>
            <td data-label="Номер"><button className="link-button" onClick={(event) => { event.stopPropagation(); setOpened(document); }} type="button"><strong>{document.number}</strong></button></td>
            <td data-label="Документ"><KindBadge kind={document.kind} /></td>
            <td data-label="Дата">{formatDisplayDate(document.date)}</td>
            <td className="cell-wide" data-label="Основание">{document.taskNumber ? <>{document.taskNumber}{document.taskTitle ? <small>{document.taskTitle}</small> : null}</> : <span className="muted">{document.kind === "writeoff" ? "Списание со склада, без задачи" : "Без задачи"}</span>}</td>
            <td className="cell-wide" data-label="Прибор">{document.equipmentSerialNumber ? <>S/N {document.equipmentSerialNumber}{document.equipmentName ? <small>{document.equipmentName}</small> : null}</> : "—"}</td>
            <td data-label="Инженер">{document.engineerName ?? "—"}</td>
            <td className="stock-documents-table__totals" data-label="Состав">{stockDocumentTotalsText(document)}</td>
          </tr>)}</tbody>
        </table></div>
        <RegistryPagination ariaLabel="Страницы документов склада" alwaysShow onPageChange={(next) => void reload(filters, next)} onPageSizeChange={(size) => { setPageSize(size); void reload(filters, 0); }} pageIndex={pageIndex} pageSize={pageSize} total={total} /></>}
    </DataTableShell>
  </>;
}

/**
 * Документы склада по задаче в карточке задачи: координатор видит, что перемещение
 * и списание сформировались. Без права на склад и финансы блока нет вовсе — база
 * откажет, и пустой отказ на экране ничего бы не объяснил.
 */
export function TaskStockDocuments({ taskId, refreshKey }: { readonly taskId: string; readonly refreshKey?: string }) {
  const [documents, setDocuments] = useState<readonly StockDocumentRecord[]>([]);
  const [opened, setOpened] = useState<StockDocumentRecord | null>(null);
  useEffect(() => {
    let alive = true;
    m2Api.stockDocumentPage({ taskId, limit: 50 })
      .then((page) => { if (alive) setDocuments(page.items); })
      .catch(() => { if (alive) setDocuments([]); });
    return () => { alive = false; };
  }, [taskId, refreshKey]);
  if (documents.length === 0) return null;
  return <section className="task-section" aria-labelledby={`task-stock-documents-${taskId}`}>
    <header className="task-section__head">
      <h3 id={`task-stock-documents-${taskId}`}>Документы склада</h3>
    </header>
    <ul className="task-stock-documents">
      {documents.map((document) => <li key={document.id}>
        <button className="task-stock-documents__item" onClick={() => setOpened(document)} type="button">
          <KindBadge kind={document.kind} />
          <strong>{document.number}</strong>
          <span>{formatDisplayDate(document.date)}</span>
          <small>{stockDocumentTotalsText(document)}</small>
        </button>
      </li>)}
    </ul>
    <StockDocumentDialog document={opened} onClose={() => setOpened(null)} />
  </section>;
}
