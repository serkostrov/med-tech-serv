import React, { useEffect, useState, type FormEvent } from "react";
import { m2Api, type EngineerOverview, type InventoryPartRecord, type OperationsReportRecord } from "./m2-api.js";
import { Button, CardHeader, ConfirmationDialog, DataTableShell, DatePicker, DialogForm, FilterBar, IconButton, MetricCard, PageIntro, ResourceState, StatusBadge, Select, toast } from "./ui.js";
import { formatDisplayDate, isoCalendarDate, parseIsoCalendarDate, todayIsoDate } from "./date-format.js";
import { RegistryPagination, usePageSize } from "./RegistryPagination.js";

function competencyText(engineer: EngineerOverview): string {
  const values = engineer.competencies.map((item) => [item.manufacturer, item.modelLine].filter(Boolean).join(" · ")).filter(Boolean);
  return values.length ? values.join(", ") : "—";
}

export function EngineersPage() {
  const [engineers, setEngineers] = useState<readonly EngineerOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EngineerOverview | null>(null);
  const reload = async () => {
    setLoading(true);
    try { setEngineers(await m2Api.engineers()); }
    catch (loadError) { toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить инженеров"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const manufacturer = String(form.get("manufacturer") ?? "").trim();
    const modelLine = String(form.get("modelLine") ?? "").trim();
    setSaving(true); setFormError(null);
    try {
      await m2Api.updateEngineer(editing.id, {
        fullName: String(form.get("fullName") ?? "").trim(),
        competencies: manufacturer && modelLine ? [{ manufacturer, modelLine }] : []
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
      <MetricCard icon="tasks" label="Назначенные задачи" tone="yellow" value={String(assigned)} />
      <MetricCard icon="clock" label="Просроченные" tone="orange" value={String(overdue)} />
    </div>
    <DataTableShell meta={`${engineers.length} человек`} title="Загрузка">{loading && engineers.length === 0 ? <ResourceState description="Подождите, список инженеров сейчас появится." status="loading" title="Загружаем инженеров" /> : engineers.length === 0 ? <ResourceState description="Когда появятся сотрудники с ролью инженера, они отобразятся здесь." status="empty" title="Инженеров пока нет" /> : <div className="table-scroll"><table className="data-table engineer-load-table"><thead><tr><th>Инженер</th><th>Компетенции</th><th>Загрузка</th><th className="numeric">Назначено</th><th className="numeric">В работе</th><th className="numeric">Просрочено</th><th>Состояние</th><th><span className="sr-only">Действия</span></th></tr></thead><tbody>{engineers.map((engineer) => <tr className={engineer.isActive ? "" : "reference-admin-table__inactive"} key={engineer.id}><td><strong>{engineer.fullName}</strong></td><td>{competencyText(engineer)}</td><td><div aria-label={`Загрузка: ${engineer.assignedTaskCount} задач`} className="load-cell"><span><i style={{ width: `${Math.max(4, engineer.assignedTaskCount / maxLoad * 100)}%` }} /></span></div></td><td className="numeric">{engineer.assignedTaskCount}</td><td className="numeric">{engineer.inProgressTaskCount}</td><td className="numeric"><strong className={engineer.overdueTaskCount ? "danger-text" : ""}>{engineer.overdueTaskCount}</strong></td><td><StatusBadge tone={!engineer.isActive ? "neutral" : engineer.overdueTaskCount ? "danger" : engineer.inProgressTaskCount ? "info" : "success"}>{!engineer.isActive ? "Неактивен" : engineer.overdueTaskCount ? "Есть просрочки" : engineer.inProgressTaskCount ? "На выезде" : "Свободен"}</StatusBadge></td><td><div className="table-actions"><IconButton icon="edit" label="Изменить карточку" onClick={() => { setFormError(null); setEditing(engineer); }} /></div></td></tr>)}</tbody></table></div>}</DataTableShell>
    <DialogForm busy={saving} description="Имя и компетенции влияют на подсказки при назначении." error={formError} onOpenChange={(open) => { if (!open) setEditing(null); }} onSubmit={save} open={Boolean(editing)} submitLabel="Сохранить карточку" title="Изменить карточку инженера"><label className="field-wide">ФИО<input autoFocus defaultValue={editing?.fullName} name="fullName" required /></label><label>Производитель<input defaultValue={editing?.competencies[0]?.manufacturer ?? ""} name="manufacturer" /></label><label>Линейка приборов<input defaultValue={editing?.competencies[0]?.modelLine ?? ""} name="modelLine" /></label></DialogForm>
  </>;
}

const emptyPart = { articleNumber: "", name: "", minimumStock: 0, notes: "", isActive: true };

export function WarehousePage() {
  const [parts, setParts] = useState<readonly InventoryPartRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ search: "", state: "active", sort: "article_asc" });
  const [summary, setSummary] = useState({ active: 0, belowMinimum: 0, withEngineers: 0 });
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const { pageSize, pageSizeRef, setPageSize } = usePageSize("inventory");
  const [editing, setEditing] = useState<InventoryPartRecord | "new" | null>(null);
  const [receiving, setReceiving] = useState<InventoryPartRecord | null>(null);
  const [deactivating, setDeactivating] = useState<InventoryPartRecord | null>(null);
  const reload = async (nextFilters = filters, nextPageIndex = pageIndex) => {
    setLoading(true);
    try {
      const page = await m2Api.inventoryPartPage({ ...nextFilters, limit: pageSizeRef.current, offset: nextPageIndex * pageSizeRef.current });
      setParts(page.items); setTotal(page.total); setSummary(page.summary); setPageIndex(nextPageIndex);
    }
    catch (loadError) { toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить склад"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);
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
    if (!(quantity > 0)) {
      setFormError("Укажите количество больше нуля");
      return;
    }
    setSaving(true); setFormError(null);
    try {
      await m2Api.receiveInventoryPart({
        partId: receiving.id,
        quantity,
        condition: condition === "G" || condition === "B" ? condition : "N",
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
  return <>
    <PageIntro actions={<Button icon="plus" onClick={() => { setFormError(null); setEditing("new"); }}>Добавить запчасть</Button>} description="Новую позицию добавьте кнопкой сверху. Остаток пополняйте кнопкой «Пополнить» в строке таблицы." title="Склад" />
    <div className="metric-grid metric-grid--three">
      <MetricCard icon="inventory" label="Активные" value={String(summary.active)} />
      <MetricCard icon="warehouse" label="Мало на складе" tone="orange" value={String(summary.belowMinimum)} />
      <MetricCard icon="engineers" label="У инженеров" tone="purple" value={String(summary.withEngineers)} />
    </div>
    <FilterBar loading={loading} onReset={() => { const reset = { search: "", state: "active", sort: "article_asc" }; setFilters(reset); void reload(reset, 0); }} onSubmit={() => reload(filters, 0)}><label className="filter-field--search">Поиск<input onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Артикул или наименование" type="search" value={filters.search} /></label><label>Состояние<Select onChange={(event) => setFilters((current) => ({ ...current, state: event.target.value }))} value={filters.state}><option value="active">Активные</option><option value="low">Ниже минимума</option><option value="inactive">Неактивные</option><option value="all">Все</option></Select></label><label>Сортировка<Select onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value }))} value={filters.sort}><option value="article_asc">Артикул А–Я</option><option value="article_desc">Артикул Я–А</option><option value="name_asc">Наименование</option><option value="available_asc">Сначала малый остаток</option><option value="available_desc">Сначала большой остаток</option></Select></label></FilterBar>
    <DataTableShell meta={`${total} позиций`} title="Запчасти">{loading && parts.length === 0 ? <ResourceState description="Подождите, склад сейчас появится." status="loading" title="Загружаем склад" /> : parts.length === 0 ? <ResourceState description={filters.search || filters.state !== "active" ? "Измените поиск или сбросьте фильтры." : "Добавьте первую позицию, затем пополните остаток."} status={filters.search || filters.state !== "active" ? "filtered-empty" : "empty"} title={filters.search || filters.state !== "active" ? "Запчастей по этим условиям нет" : "Запчастей пока нет"} /> : <><div className="table-scroll"><table className="data-table"><thead><tr><th>Артикул</th><th>Наименование</th><th className="numeric">На складе</th><th className="numeric">В резерве</th><th className="numeric">Доступно</th><th className="numeric">Минимум</th><th className="numeric">У инженеров</th><th>Состояние</th><th><span className="sr-only">Действия</span></th></tr></thead><tbody>{parts.map((part) => <tr className={part.isActive ? "" : "reference-admin-table__inactive"} key={part.id}><td><strong>{part.articleNumber}</strong></td><td>{part.name}</td><td className="numeric">{part.onHandQuantity}</td><td className="numeric">{part.reservedQuantity}</td><td className="numeric"><strong>{part.availableQuantity}</strong></td><td className="numeric">{part.minimumStock}</td><td className="numeric">{part.withEngineersQuantity}</td><td><StatusBadge tone={!part.isActive ? "neutral" : part.belowMinimum ? "danger" : "success"}>{!part.isActive ? "Неактивна" : part.belowMinimum ? "Ниже минимума" : "В норме"}</StatusBadge></td><td><div className="table-actions">{part.isActive ? <Button className="button--compact" onClick={() => { setFormError(null); setReceiving(part); }} variant="secondary">Пополнить</Button> : null}<IconButton icon="edit" label="Изменить карточку" onClick={() => { setFormError(null); setEditing(part); }} />{part.isActive ? <IconButton icon="disable" label="Отключить" onClick={() => setDeactivating(part)} /> : <IconButton icon="enable" label="Включить" onClick={() => void m2Api.updateInventoryPart(part.id, { isActive: true }).then(() => reload())} />}</div></td></tr>)}</tbody></table></div><RegistryPagination ariaLabel="Страницы склада" onPageChange={(next) => void reload(filters, next)} onPageSizeChange={(size) => { setPageSize(size); void reload(filters, 0); }} pageIndex={pageIndex} pageSize={pageSize} total={total} /></>}</DataTableShell>
    <DialogForm busy={saving} description={editing === "new" ? "Можно сразу указать начальный остаток — он попадёт на склад как поступление." : "Изменятся наименование, минимум и примечание. Остаток меняйте через «Пополнить»."} error={formError} onOpenChange={(open) => { if (!open) setEditing(null); }} onSubmit={save} open={Boolean(draft)} submitLabel={editing === "new" ? "Добавить запчасть" : "Сохранить изменения"} title={editing === "new" ? "Новая запчасть" : "Изменить запчасть"}><label>Артикул<input autoFocus defaultValue={draft?.articleNumber} name="articleNumber" required /></label><label>Наименование<input defaultValue={draft?.name} name="name" required /></label><label>Минимальный остаток<input defaultValue={draft?.minimumStock} min="0" name="minimumStock" step="0.001" type="number" /></label>{editing === "new" ? <label>Начальный остаток<input defaultValue="0" min="0" name="initialQuantity" step="0.001" type="number" /></label> : null}<label className="field-wide">Примечание<textarea defaultValue={draft?.notes ?? ""} name="notes" rows={3} /></label></DialogForm>
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
      <label className="field-wide">Комментарий<textarea name="comment" placeholder="Накладная, поставщик — по желанию" rows={2} /></label>
    </DialogForm>
    <ConfirmationDialog confirmLabel="Отключить" description={deactivating ? <>Запчасть {deactivating.articleNumber} останется в истории и её нельзя будет брать в новые заявки.</> : null} onConfirm={async () => { if (!deactivating) return; await m2Api.updateInventoryPart(deactivating.id, { isActive: false }); await reload(); }} onOpenChange={(open) => { if (!open) setDeactivating(null); }} open={Boolean(deactivating)} title="Отключить запчасть?" />
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

function periodForPreset(preset: ReportPreset, today = todayIsoDate()): { readonly from: string; readonly to: string } {
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

export function ReportsPage() {
  const initial = periodForPreset("half");
  const [period, setPeriod] = useState(initial);
  const [preset, setPreset] = useState<ReportPreset | null>("half");
  const [report, setReport] = useState<OperationsReportRecord | null>(null);
  const [loading, setLoading] = useState(true);
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
      <PageIntro description="Сколько заявок за период, что закрыто вовремя и где уже вышел срок." title="Отчёты" />
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
            detail={report.metrics.closedCount === 0 ? "ещё нет закрытых" : `${report.metrics.closedOnTimePercent}% закрыто вовремя`}
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
                <CardHeader meta={`${report.metrics.taskCount} заявок`} title="По статусам" />
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
