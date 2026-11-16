import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { m2Api, type EngineerOverview, type InventoryPartRecord, type OperationsReportRecord } from "./m2-api.js";
import { InventoryBoard } from "./InventoryBoard.js";
import { InventoryPartCard } from "./InventoryPartCard.js";
import { StockReceiptImport } from "./StockReceiptImport.js";
import { conditionTotalsText, conditionTotalsTitle } from "./stock-movements.js";
import { EngineerCompetencyEditor, type CompetencyDraft, type CompetencyReferences } from "./EngineerCompetencyEditor.js";
import { competenciesToSave, competencyKey, competencyLabel, withManufacturerIds, type EngineerCompetency } from "./engineer-competencies.js";
import { AutoTextarea, Button, CardHeader, ConfirmationDialog, DataTableShell, DatePicker, DialogForm, FilterBar, IconButton, MetricCard, PageIntro, ResourceState, StatusBadge, Select, ViewSwitch, toast } from "./ui.js";
import { formatDisplayDate, isoCalendarDate, parseIsoCalendarDate } from "./date-format.js";
import { formatRussianCount } from "./equipment-changes.js";
import { parseAmount } from "./price-list.js";
import { companyToday } from "./task-dates.js";
import { RegistryPagination, usePageSize } from "./RegistryPagination.js";
import { reportFileName, reportWorkbook } from "./report-export.js";
import { XLSX_MIME } from "./xlsx.js";

function CompetencyTags({ engineer }: { readonly engineer: EngineerOverview }) {
  if (engineer.competencies.length === 0) return <>—</>;
  return (
    <ul aria-label={`Компетенции: ${engineer.fullName}`} className="competency-tags">
      {engineer.competencies.map((item, index) => <li className="tag" key={`${competencyKey(item)}-${index}`}>{competencyLabel(item)}</li>)}
    </ul>
  );
}

const EMPTY_DRAFT: CompetencyDraft = { manufacturerId: "", modelLine: "" };

export function EngineersPage() {
  const [engineers, setEngineers] = useState<readonly EngineerOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EngineerOverview | null>(null);
  // Компетенции в окне: теги и строка добавления. В базу уходят по «Сохранить карточку».
  const [competencies, setCompetencies] = useState<readonly EngineerCompetency[]>([]);
  const [draft, setDraft] = useState<CompetencyDraft>(EMPTY_DRAFT);
  const [references, setReferences] = useState<CompetencyReferences>({ manufacturers: [], models: [] });
  const [referencesState, setReferencesState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const reload = async () => {
    setLoading(true);
    try { setEngineers(await m2Api.engineers()); }
    catch (loadError) { toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить инженеров"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);
  const loadReferences = async () => {
    setReferencesState("loading");
    try {
      const passport = await m2Api.passportReferences();
      setReferences({ manufacturers: passport.manufacturers, models: passport.models });
      setReferencesState("ready");
    } catch (loadError) {
      setReferencesState("error");
      toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить справочник производителей");
    }
  };
  const openEditor = (engineer: EngineerOverview) => {
    setFormError(null);
    setCompetencies(engineer.competencies);
    setDraft(EMPTY_DRAFT);
    setEditing(engineer);
    if (referencesState === "idle" || referencesState === "error") void loadReferences();
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    // Набранную, но не добавленную линейку сохраняем вместе с тегами, а не теряем молча.
    const prepared = competenciesToSave(competencies, draft, editing.competencies, references.manufacturers);
    if ("error" in prepared) {
      setFormError(prepared.error);
      return;
    }
    setSaving(true); setFormError(null);
    try {
      await m2Api.updateEngineer(editing.id, {
        fullName: String(form.get("fullName") ?? "").trim(),
        ...(prepared.changed ? {
          competencies: prepared.items.map((item) => ({ manufacturerId: item.manufacturerId ?? "", manufacturer: item.manufacturer, modelLine: item.modelLine ?? "" }))
        } : {})
      });
      setEditing(null); await reload();
    } catch (saveError) {
      const text = saveError instanceof Error ? saveError.message : "Инженер не сохранён";
      setFormError(text);
      toast.error(text);
    }
    finally { setSaving(false); }
  };
  const active = engineers.filter((item) => item.isActive);
  const assigned = active.reduce((sum, item) => sum + item.assignedTaskCount, 0);
  const overdue = active.reduce((sum, item) => sum + item.overdueTaskCount, 0);
  const maxLoad = Math.max(1, ...engineers.map((item) => item.assignedTaskCount));
  return <>
    <PageIntro description="Кто сейчас занят, у кого просрочки и кому можно дать новую заявку." title="Инженеры" />
    <div className="metric-grid metric-grid--three">
      <MetricCard icon="engineers" label="Активные инженеры" value={String(active.length)} />
      <MetricCard icon="tasks" label="Открытые задачи" tone="yellow" value={String(assigned)} />
      <MetricCard icon="clock" label="Просроченные" tone="orange" value={String(overdue)} />
    </div>
    <DataTableShell meta={formatRussianCount(engineers.length, ["человек", "человека", "человек"])} title="Загрузка">{loading && engineers.length === 0 ? <ResourceState description="Подождите, список инженеров сейчас появится." status="loading" title="Загружаем инженеров" /> : engineers.length === 0 ? <ResourceState description="Когда появятся сотрудники с ролью инженера, они отобразятся здесь." status="empty" title="Инженеров пока нет" /> : <div className="table-scroll engineer-load-scroll"><table className="data-table engineer-load-table"><thead><tr><th>Инженер</th><th>Компетенции</th><th>Загрузка</th><th className="numeric">Открытые</th><th className="numeric">В работе</th><th className="numeric">Просрочено</th><th>Состояние</th><th><span className="sr-only">Действия</span></th></tr></thead><tbody>{engineers.map((engineer) => <tr className={engineer.isActive ? "" : "reference-admin-table__inactive"} key={engineer.id}><td className="engineer-load-table__wide" data-label="Инженер"><strong>{engineer.fullName}</strong></td><td className="engineer-load-table__wide" data-label="Компетенции"><CompetencyTags engineer={engineer} /></td><td className="engineer-load-table__wide" data-label="Загрузка"><div aria-label={`Загрузка: ${formatRussianCount(engineer.assignedTaskCount, ["задача", "задачи", "задач"])}`} className="load-cell"><span><i style={{ width: `${Math.max(4, engineer.assignedTaskCount / maxLoad * 100)}%` }} /></span></div></td><td className="numeric" data-label="Открытые">{engineer.assignedTaskCount}</td><td className="numeric" data-label="В работе">{engineer.inProgressTaskCount}</td><td className="numeric" data-label="Просрочено"><strong className={engineer.overdueTaskCount ? "danger-text" : ""}>{engineer.overdueTaskCount}</strong></td><td data-label="Состояние"><StatusBadge tone={!engineer.isActive ? "neutral" : engineer.overdueTaskCount ? "danger" : engineer.inProgressTaskCount ? "info" : "success"}>{!engineer.isActive ? "Неактивен" : engineer.overdueTaskCount ? "Есть просрочки" : engineer.inProgressTaskCount ? "На выезде" : "Свободен"}</StatusBadge></td><td><div className="table-actions"><IconButton icon="edit" label="Изменить карточку" onClick={() => openEditor(engineer)} /></div></td></tr>)}</tbody></table></div>}</DataTableShell>
    <DialogForm busy={saving} description="По компетенциям CRM подсказывает, кого назначить на прибор." error={formError} onOpenChange={(open) => { if (!open) setEditing(null); }} onSubmit={save} open={Boolean(editing)} submitLabel="Сохранить карточку" title="Изменить карточку инженера">
      <label className="field-wide">ФИО<input autoFocus defaultValue={editing?.fullName} name="fullName" required /></label>
      <div className="field-wide competency-field">
        <span className="competency-field__label">Компетенции</span>
        <EngineerCompetencyEditor
          canAdd={editing?.isActive !== false}
          draft={draft}
          onChange={setCompetencies}
          onDraftChange={setDraft}
          references={references}
          referencesState={referencesState === "idle" ? "loading" : referencesState}
          value={withManufacturerIds(competencies, references.manufacturers)}
        />
      </div>
    </DialogForm>
  </>;
}

const emptyPart = { articleNumber: "", name: "", minimumStock: 0, notes: "", isActive: true };

/**
 * Сколько позиций читаем на доску склада: доска показывает все колонки сразу, поэтому
 * страницами её не листают. Столько же читает выбор запчасти в задаче.
 */
const INVENTORY_BOARD_LIMIT = 500;

export function WarehousePage() {
  const [parts, setParts] = useState<readonly InventoryPartRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ search: "", state: "active", stock: "", sort: "article_asc" });
  const [summary, setSummary] = useState({ active: 0, belowMinimum: 0, withEngineers: 0 });
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const { pageSize, pageSizeRef, setPageSize } = usePageSize("inventory");
  // Доска или список, как в задачах и резервах. На складе доска только показывает:
  // остаток меняется приходом и выдачей, а не переносом карточки.
  const [view, setView] = useState<"board" | "list">("list");
  const viewRef = useRef<"board" | "list">("list");
  const [editing, setEditing] = useState<InventoryPartRecord | "new" | null>(null);
  const [receiving, setReceiving] = useState<InventoryPartRecord | null>(null);
  const [deactivating, setDeactivating] = useState<InventoryPartRecord | null>(null);
  // Открытая карточка позиции — по id, а не копией строки: после прихода или списания
  // список перечитывается, и в карточке должны быть свежие остатки, а не прежние.
  const [openedId, setOpenedId] = useState<string | null>(null);
  const lastOpened = useRef<InventoryPartRecord | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  // Ответ на прежний запрос не должен затереть свежий: доска и страница списка просят
  // разные объёмы, и при быстром переключении ответы могут прийти не по порядку.
  const loadTurn = useRef(0);
  const reload = async (nextFilters = filters, nextPageIndex = pageIndex, nextView = viewRef.current) => {
    const turn = ++loadTurn.current;
    setLoading(true);
    try {
      const board = nextView === "board";
      const page = await m2Api.inventoryPartPage({
        ...nextFilters,
        limit: board ? INVENTORY_BOARD_LIMIT : pageSizeRef.current,
        offset: board ? 0 : nextPageIndex * pageSizeRef.current
      });
      if (turn !== loadTurn.current) return;
      setParts(page.items); setTotal(page.total); setSummary(page.summary); setPageIndex(board ? 0 : nextPageIndex);
    }
    catch (loadError) { if (turn === loadTurn.current) toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить склад"); }
    finally { if (turn === loadTurn.current) setLoading(false); }
  };
  useEffect(() => {
    void reload();
    // Списание, корректировка и приход — складские операции: инженеру их не предлагаем,
    // хотя последнее слово всё равно за базой (0049, 0050).
    void m2Api.hasPermission("warehouse.write").then(setCanWrite).catch(() => setCanWrite(false));
  }, []);
  const changeView = (next: "board" | "list") => {
    viewRef.current = next;
    setView(next);
    void reload(filters, 0, next);
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = {
      articleNumber: String(form.get("articleNumber") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      minimumStock: Number(form.get("minimumStock") ?? 0),
      notes: String(form.get("notes") ?? "").trim(),
      ...(editing === "new" ? { initialQuantity: Number(form.get("initialQuantity") ?? 0) } : {})
    };
    setSaving(true); setFormError(null);
    try {
      if (editing === "new") await m2Api.createInventoryPart({ ...input, isActive: true });
      else if (editing) await m2Api.updateInventoryPart(editing.id, input);
      setEditing(null); await reload();
    } catch (saveError) {
      const text = saveError instanceof Error ? saveError.message : "Запчасть не сохранена";
      setFormError(text);
      toast.error(text);
    }
    finally { setSaving(false); }
  };
  const receive = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!receiving) return;
    const form = new FormData(event.currentTarget);
    const quantity = Number(String(form.get("quantity") ?? "").replace(",", "."));
    const condition = String(form.get("condition") ?? "N");
    const comment = String(form.get("comment") ?? "").trim();
    const priceDraft = String(form.get("unitPrice") ?? "").trim();
    // Цена прихода нужна счёту: из неё берётся стоимость запчасти в позициях (0040).
    // Поле необязательное: без него запчасть попадёт в счёт строкой с нулём и пометкой.
    const unitPrice = priceDraft ? parseAmount(priceDraft) : undefined;
    if (!(quantity > 0)) {
      setFormError("Укажите количество больше нуля");
      return;
    }
    if (priceDraft && unitPrice === null) {
      setFormError("Укажите цену числом, например 1 500,50");
      return;
    }
    setSaving(true); setFormError(null);
    try {
      await m2Api.receiveInventoryPart({
        partId: receiving.id,
        quantity,
        condition: condition === "G" || condition === "B" ? condition : "N",
        ...(unitPrice === null || unitPrice === undefined ? {} : { unitPrice }),
        ...(comment ? { comment } : {})
      });
      setReceiving(null);
      toast.success(`На склад поступило ${quantity} шт. · ${receiving.articleNumber}`);
      await reload();
    } catch (receiveError) {
      const text = receiveError instanceof Error ? receiveError.message : "Не получилось пополнить склад";
      setFormError(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  };
  const draft = editing === "new" ? emptyPart : editing;
  // Строка открытой карточки берётся из свежего списка: остатки в ней всегда те же,
  // что в таблице. После прихода или списания позиция может выпасть из отбора
  // («Ниже минимума» перестало подходить) — тогда показываем, что знали о ней в прошлый
  // раз: закрывать карточку под руками, пока человек смотрит историю, нельзя.
  const openedFromList = openedId ? parts.find((item) => item.id === openedId) : undefined;
  if (openedFromList) lastOpened.current = openedFromList;
  const opened = openedId ? openedFromList ?? lastOpened.current : undefined;
  return <>
    <PageIntro
      actions={<>
        {canWrite ? <Button onClick={() => setImporting(true)} variant="secondary">Приход файлом</Button> : null}
        <Button icon="plus" onClick={() => { setFormError(null); setEditing("new"); }}>Добавить запчасть</Button>
      </>}
      description="Накладную целиком загрузите кнопкой «Приход файлом». Остаток по одной позиции пополняйте в строке таблицы, а списание, корректировку и историю смотрите в её карточке."
      title="Склад"
      titleAside={<ViewSwitch items={[{ value: "board", label: "Доска" }, { value: "list", label: "Список" }]} label="Как показать склад" onValueChange={changeView} value={view} />}
    />
    <div className="metric-grid metric-grid--three">
      <MetricCard icon="inventory" label="Активные" value={String(summary.active)} />
      <MetricCard icon="warehouse" label="Мало на складе" tone="orange" value={String(summary.belowMinimum)} />
      <MetricCard icon="engineers" label="У инженеров" tone="purple" value={String(summary.withEngineers)} />
    </div>
    <FilterBar loading={loading} onReset={() => { const reset = { search: "", state: "active", stock: "", sort: "article_asc" }; setFilters(reset); void reload(reset, 0); }} onSubmit={() => reload(filters, 0)}><label className="filter-field--search">Поиск<input onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Артикул, артикул поставщика или наименование" type="search" value={filters.search} /></label><label>Состояние<Select onChange={(event) => setFilters((current) => ({ ...current, state: event.target.value }))} value={filters.state}><option value="active">Активные</option><option value="low">Ниже минимума</option><option value="inactive">Неактивные</option><option value="all">Все</option></Select></label><label>Наличие<Select onChange={(event) => setFilters((current) => ({ ...current, stock: event.target.value }))} value={filters.stock}><option value="">Любое</option><option value="available">Есть доступные</option><option value="none">Доступных нет</option><option value="engineers">На руках у инженеров</option></Select></label><label>Сортировка<Select onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value }))} value={filters.sort}><option value="article_asc">Артикул А–Я</option><option value="article_desc">Артикул Я–А</option><option value="name_asc">Наименование</option><option value="available_asc">Сначала малый остаток</option><option value="available_desc">Сначала большой остаток</option></Select></label></FilterBar>
    {view === "board" ? <DataTableShell meta={`${formatRussianCount(total, ["позиция", "позиции", "позиций"])}${total > parts.length ? `, из них на доске ${parts.length}` : ""}`} title="Запас по позициям">
      {loading && parts.length === 0 ? <ResourceState description="Подождите, склад сейчас появится." status="loading" title="Загружаем склад" />
        : parts.length === 0 ? <ResourceState description={filters.search || filters.state !== "active" || filters.stock ? "Измените поиск или сбросьте фильтры." : "Добавьте первую позицию, затем пополните остаток."} status={filters.search || filters.state !== "active" || filters.stock ? "filtered-empty" : "empty"} title={filters.search || filters.state !== "active" || filters.stock ? "Запчастей по этим условиям нет" : "Запчастей пока нет"} />
        : <InventoryBoard loading={loading} onOpen={(part) => setOpenedId(part.id)} parts={parts} />}
    </DataTableShell> : <DataTableShell meta={formatRussianCount(total, ["позиция", "позиции", "позиций"])} title="Запчасти">{loading && parts.length === 0 ? <ResourceState description="Подождите, склад сейчас появится." status="loading" title="Загружаем склад" /> : parts.length === 0 ? <ResourceState description={filters.search || filters.state !== "active" || filters.stock ? "Измените поиск или сбросьте фильтры." : "Добавьте первую позицию, затем пополните остаток."} status={filters.search || filters.state !== "active" || filters.stock ? "filtered-empty" : "empty"} title={filters.search || filters.state !== "active" || filters.stock ? "Запчастей по этим условиям нет" : "Запчастей пока нет"} /> : <><div className="table-scroll"><table className="data-table"><thead><tr><th>Артикул</th><th>Наименование</th><th className="numeric">На складе</th><th>Г · Н · Б</th><th className="numeric">В резерве</th><th className="numeric">Доступно</th><th className="numeric">Минимум</th><th className="numeric">У инженеров</th><th>Состояние</th><th><span className="sr-only">Действия</span></th></tr></thead><tbody>{parts.map((part) => <tr className={part.isActive ? "" : "reference-admin-table__inactive"} key={part.id}><td><strong>{part.articleNumber}</strong>{part.aliases ? <small className="inventory-table__aliases" title={`Артикулы поставщиков: ${part.aliases}`}>{part.aliases}</small> : null}</td><td>{part.name}</td><td className="numeric">{part.onHandQuantity}</td><td className="inventory-table__conditions" title={conditionTotalsTitle(part.onHandByCondition)}>{conditionTotalsText(part.onHandByCondition)}</td><td className="numeric">{part.reservedQuantity}</td><td className="numeric"><strong>{part.availableQuantity}</strong></td><td className="numeric">{part.minimumStock}</td><td className="numeric">{part.withEngineersQuantity}</td><td><StatusBadge tone={!part.isActive ? "neutral" : part.belowMinimum ? "danger" : "success"}>{!part.isActive ? "Неактивна" : part.belowMinimum ? "Ниже минимума" : "В норме"}</StatusBadge></td><td><div className="table-actions"><Button className="button--compact" onClick={() => setOpenedId(part.id)} variant="ghost">История</Button>{part.isActive ? <Button className="button--compact" onClick={() => { setFormError(null); setReceiving(part); }} variant="secondary">Пополнить</Button> : null}<IconButton icon="edit" label="Изменить карточку" onClick={() => { setFormError(null); setEditing(part); }} />{part.isActive ? <IconButton icon="disable" label="Отключить" onClick={() => setDeactivating(part)} /> : <IconButton icon="enable" label="Включить" onClick={() => void m2Api.updateInventoryPart(part.id, { isActive: true }).then(() => reload())} />}</div></td></tr>)}</tbody></table></div><RegistryPagination ariaLabel="Страницы склада" onPageChange={(next) => void reload(filters, next)} onPageSizeChange={(size) => { setPageSize(size); void reload(filters, 0); }} pageIndex={pageIndex} pageSize={pageSize} total={total} /></>}</DataTableShell>}
    <DialogForm busy={saving} description={editing === "new" ? "Можно сразу указать начальный остаток — он попадёт на склад как поступление." : "Изменятся наименование, минимум и примечание. Остаток меняйте через «Пополнить»."} error={formError} onOpenChange={(open) => { if (!open) setEditing(null); }} onSubmit={save} open={Boolean(draft)} submitLabel={editing === "new" ? "Добавить запчасть" : "Сохранить изменения"} title={editing === "new" ? "Новая запчасть" : "Изменить запчасть"}><label>Артикул<input autoFocus defaultValue={draft?.articleNumber} name="articleNumber" required /></label><label>Наименование<input defaultValue={draft?.name} name="name" required /></label><label>Минимальный остаток<input defaultValue={draft?.minimumStock} min="0" name="minimumStock" step="0.001" type="number" /></label>{editing === "new" ? <label>Начальный остаток<input defaultValue="0" min="0" name="initialQuantity" step="0.001" type="number" /></label> : null}<label className="field-wide">Примечание<AutoTextarea defaultValue={draft?.notes ?? ""} name="notes" rows={3} /></label></DialogForm>
    <DialogForm
      busy={saving}
      description={receiving ? `Сейчас на складе ${receiving.onHandQuantity} шт. · минимум ${receiving.minimumStock}.` : undefined}
      error={formError}
      onOpenChange={(open) => { if (!open) setReceiving(null); }}
      onSubmit={receive}
      open={Boolean(receiving)}
      submitLabel="Оприходовать"
      title={receiving ? `Пополнить · ${receiving.articleNumber}` : "Пополнить склад"}
    >
      <label>Количество *<input autoFocus min="0.001" name="quantity" placeholder="Сколько поступило" required step="0.001" type="number" /></label>
      <label>Состояние<Select defaultValue="N" name="condition"><option value="N">Н · новая</option><option value="G">Г · гарантийная</option><option value="B">Б · б/у</option></Select></label>
      <label>Цена за единицу<input inputMode="decimal" name="unitPrice" placeholder="Как в накладной" /><small>Из неё счёт берёт стоимость запчасти. Без цены запчасть попадёт в счёт нулём с пометкой.</small></label>
      <label className="field-wide">Комментарий<AutoTextarea name="comment" placeholder="Накладная, поставщик — по желанию" rows={2} /></label>
    </DialogForm>
    <ConfirmationDialog confirmLabel="Отключить" description={deactivating ? <>Запчасть {deactivating.articleNumber} останется в истории и её нельзя будет брать в новые заявки.</> : null} onConfirm={async () => { if (!deactivating) return; await m2Api.updateInventoryPart(deactivating.id, { isActive: false }); await reload(); }} onOpenChange={(open) => { if (!open) setDeactivating(null); }} open={Boolean(deactivating)} title="Отключить запчасть?" />
    <InventoryPartCard
      canWrite={canWrite}
      onChanged={() => reload()}
      onOpenChange={(open) => { if (!open) { setOpenedId(null); lastOpened.current = undefined; } }}
      open={Boolean(opened)}
      part={opened ?? null}
    />
    <StockReceiptImport onDone={() => reload()} onOpenChange={setImporting} open={importing} />
  </>;
}

type ReportPreset = "month" | "quarter" | "half" | "year";

const REPORT_PRESETS: readonly { readonly id: ReportPreset; readonly label: string }[] = [
  { id: "month", label: "Этот месяц" },
  { id: "quarter", label: "3 месяца" },
  { id: "half", label: "Полгода" },
  { id: "year", label: "Год" }
];

function startOfMonth(iso: string, monthsBack = 0): string {
  const parsed = parseIsoCalendarDate(iso);
  if (!parsed) return iso;
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1 - monthsBack, 1));
  return isoCalendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) ?? iso;
}

/** Период отчёта до сегодняшнего дня по Москве: данные компании считаются по её часам, а не по поясу устройства. */
function periodForPreset(preset: ReportPreset, today = companyToday()): { readonly from: string; readonly to: string } {
  const monthsBack = preset === "month" ? 0 : preset === "quarter" ? 2 : preset === "half" ? 5 : 11;
  return { from: startOfMonth(today, monthsBack), to: today };
}

function ReportBars({
  items,
  empty,
  keepOrder = false
}: {
  readonly items: readonly { readonly code?: string; readonly key?: string; readonly name: string; readonly value: number }[];
  readonly empty: string;
  readonly keepOrder?: boolean;
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return <p className="report-bars__empty">{empty}</p>;
  const rows = keepOrder ? items : [...items].sort((left, right) => right.value - left.value);
  const max = Math.max(1, ...rows.map((item) => item.value));
  return (
    <div className="report-bars">
      {rows.map((item) => {
        const share = Math.round((item.value / total) * 100);
        return (
          <div className={`report-bar${item.code ? ` report-bar--${item.code}` : ""}`} key={item.code ?? item.key ?? item.name}>
            <span title={item.name}>{item.name}</span>
            <div><i style={{ width: `${Math.round((item.value / max) * 100)}%` }} /></div>
            <strong>{item.value}<small>{share}%</small></strong>
          </div>
        );
      })}
    </div>
  );
}

/** 1 заявка, 2 заявки, 5 заявок. */
function requestsWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "заявок";
  if (ones === 1) return "заявка";
  if (ones >= 2 && ones <= 4) return "заявки";
  return "заявок";
}

export function ReportsPage() {
  const initial = periodForPreset("half");
  const [period, setPeriod] = useState(initial);
  const [preset, setPreset] = useState<ReportPreset | null>("half");
  const [report, setReport] = useState<OperationsReportRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  // Выгрузка за тот период, что сейчас на экране: сводка и все заявки периода в файл Excel.
  const exportExcel = async () => {
    if (!report) return;
    setExporting(true);
    try {
      const tasks = await m2Api.operationsReportTasks(report.period.from, report.period.to);
      const url = URL.createObjectURL(new Blob([(await reportWorkbook(report, tasks)) as BlobPart], { type: XLSX_MIME }));
      const link = document.createElement("a");
      link.href = url;
      link.download = reportFileName(report);
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success(`В файле сводка и ${tasks.length} ${requestsWord(tasks.length)}`, { title: "Отчёт выгружен" });
    } catch (exportError) {
      toast.error(exportError instanceof Error ? exportError.message : "Не получилось выгрузить отчёт", { title: "Файл не выгрузился" });
    } finally {
      setExporting(false);
    }
  };
  const reload = async (next = period) => {
    setLoading(true);
    try { setReport(await m2Api.operationsReport(next.from, next.to)); }
    catch (loadError) { toast.error(loadError instanceof Error ? loadError.message : "Не получилось построить отчёт", { title: "Отчёт не загрузился" }); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(initial); }, []);
  const applyPreset = (nextPreset: ReportPreset) => {
    const next = periodForPreset(nextPreset);
    setPreset(nextPreset);
    setPeriod(next);
    void reload(next);
  };
  const changeDate = (field: "from" | "to", value: string) => {
    setPreset(null);
    setPeriod((current) => ({ ...current, [field]: value }));
  };
  const resetPeriod = () => applyPreset("half");
  const cancelledCount = report?.tasksByStatus.find((item) => item.code === "cancelled")?.value ?? 0;
  const openCount = report ? Math.max(0, report.metrics.taskCount - report.metrics.closedCount - cancelledCount) : 0;
  const periodLabel = `${formatDisplayDate(period.from)} — ${formatDisplayDate(period.to)}`;
  return (
    <div className="report-page">
      <PageIntro
        actions={<Button busy={exporting} busyLabel="Готовим файл…" disabled={!report || loading} onClick={() => void exportExcel()} variant="secondary">Скачать в Excel</Button>}
        description="Сколько заявок за период, что закрыто вовремя и где уже вышел срок."
        title="Отчёты"
      />
      <div className="report-presets" role="group" aria-label="Быстрый период">
        {REPORT_PRESETS.map((item) => (
          <Button
            aria-pressed={preset === item.id}
            className={preset === item.id ? "report-presets__active" : ""}
            key={item.id}
            onClick={() => applyPreset(item.id)}
            variant={preset === item.id ? "secondary" : "ghost"}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <FilterBar loading={loading} onReset={resetPeriod} onSubmit={() => reload()} submitLabel="Показать">
        <label>Начало<DatePicker onChange={(from) => changeDate("from", from)} value={period.from} /></label>
        <label>Конец<DatePicker onChange={(to) => changeDate("to", to)} value={period.to} /></label>
      </FilterBar>
      {loading && !report ? <ResourceState description="Подождите, сводка сейчас появится." status="loading" title="Собираем отчёт" /> : null}
      {report ? <>
        <div className="metric-grid metric-grid--four">
          <MetricCard detail={periodLabel} icon="tasks" label="Всего заявок" value={String(report.metrics.taskCount)} />
          <MetricCard
            detail={report.metrics.closedCount === 0 ? "ещё нет закрытых" : `${report.metrics.closedOnTimePercent}% вовремя`}
            icon="check"
            label="Закрыто"
            tone="green"
            value={String(report.metrics.closedCount)}
          />
          <MetricCard
            detail={report.metrics.taskCount === 0 ? "нет открытых заявок" : report.metrics.overdueCount === 0 ? "все в сроке" : "срок уже вышел"}
            icon="clock"
            label="Просрочено"
            tone="orange"
            value={String(report.metrics.overdueCount)}
          />
          <MetricCard
            detail={report.metrics.taskCount === 0 ? "нет заявок за период" : openCount === 0 ? "все закрыты или отменены" : "ещё в работе"}
            icon="engineers"
            label="Открытые"
            tone="green"
            value={String(openCount)}
          />
        </div>
        {report.metrics.taskCount === 0
          ? <ResourceState description="Выберите другой период сверху или дождитесь новых заявок." icon="reports" status="filtered-empty" title="За этот период заявок нет" />
          : <div className="analytics-grid">
              <section className="card">
                <CardHeader meta={formatRussianCount(report.metrics.taskCount, ["заявка", "заявки", "заявок"])} title="По статусам" />
                <ReportBars empty="Нет разбивки по статусам." items={report.tasksByStatus} />
              </section>
              <section className="card">
                <CardHeader meta="что делали" title="Виды работ" />
                <ReportBars empty="Виды работ за период не указаны." items={report.tasksByWorkType} />
              </section>
              <section className="card analytics-grid__wide">
                <CardHeader meta={periodLabel} title="По месяцам" />
                <ReportBars empty="Нет заявок по месяцам." items={report.tasksByMonth} keepOrder />
              </section>
            </div>}
      </> : null}
    </div>
  );
}
