import React, { useEffect, useMemo, useState, type FormEvent } from "react";
import { m2Api, type PriceRowApiRecord, type ReferenceCatalogValue, type TaskApiRecord } from "./m2-api.js";
import {
  Button,
  ConfirmationDialog,
  DataTableShell,
  DatePicker,
  DialogForm,
  EntityDetailToolbar,
  PageTabs,
  PageIntro,
  ResourceState,
  Select,
  StatusBadge,
  toast
} from "./ui.js";
import { formatDisplayDate, formatIsoCalendarDate } from "./date-format.js";
import { EntityLink } from "./entity-links.js";
import { RegistryPagination, usePageSize } from "./RegistryPagination.js";
import { CompletedTasksToggle } from "./TaskStageBoard.js";
import { TASK_STATUS_LABELS, TASK_STATUS_TONES } from "./domain/task-status.js";
import { formatRussianCount, russianCountForm } from "./equipment-changes.js";
import { companyToday } from "./task-dates.js";
import {
  ALL_CATEGORIES_LABEL,
  MAX_PRICE,
  ZERO_PRICE_MESSAGE,
  PRICE_NOT_SET_HINT,
  PRICE_NOT_SET_LABEL,
  bulkPriceItems,
  canDeletePriceRow,
  filterPriceLines,
  formatMoney,
  guaranteeWorkLabel,
  isBackdatedPrice,
  nextPriceAfter,
  parseAmount,
  parseSignedNumber,
  zeroPriceCount,
  zeroPriceWarning,
  previewBulkPrices,
  priceLineAmountText,
  priceLineNextText,
  priceLineStartText,
  priceLines,
  priceRowActiveOn,
  priceRowPeriodText,
  type BulkPriceMode,
  type PriceLine,
  type PriceListRow,
  type PriceWorkType
} from "./price-list.js";

/** Как считаем новую цену выбранным строкам. */
const BULK_MODES: readonly { readonly value: BulkPriceMode; readonly label: string; readonly hint: string }[] = [
  { value: "percent", label: "Процентом", hint: "10 — поднять на 10%, −5 — снизить на 5%." },
  { value: "delta", label: "Прибавить сумму", hint: "500 — добавить 500 ₽ к каждой цене, −500 — убрать." },
  { value: "fixed", label: "Задать одну сумму", hint: "Все выбранные строки получат эту цену. Подходит и там, где цены ещё нет." }
];

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Вид работ: в справочнике его ключ — код (`work_types.code`). */
function workTypeOptions(values: readonly ReferenceCatalogValue[], rows: readonly PriceRowApiRecord[]): readonly PriceWorkType[] {
  const priced = new Set(rows.map((row) => row.workTypeCode));
  return values
    // Отключённый вид работ оставляем, только если по нему есть цены: иначе список пухнет старьём.
    .filter((value) => value.isActive || priced.has(value.code ?? value.id))
    .map((value) => ({ code: value.code ?? value.id, name: value.name }));
}


/**
 * Вид работ из прайса — своей страницей, а не всплывающим окном (вторая встреча 18.11: «карточку
 * такую сделать»): сверху цена сейчас и «Изменить цену», вкладки «История цен» и «Задачи» — все
 * задачи с этим видом работ, основным или дополнительным, постранично.
 */
function WorkTypePricePage({ line, today, canWrite, onBack, onDelete, onEdit }: {
  readonly line: PriceLine;
  readonly today: string;
  readonly canWrite: boolean;
  readonly onBack: () => void;
  readonly onDelete: (line: PriceLine, row: PriceListRow) => void;
  readonly onEdit: (line: PriceLine) => void;
}) {
  const [tab, setTab] = useState<"history" | "tasks">("history");
  const { pageSize, setPageSize } = usePageSize("work-type-tasks");
  const [pageIndex, setPageIndex] = useState(0);
  const [tasks, setTasks] = useState<{ readonly items: readonly TaskApiRecord[]; readonly total: number } | null>(null);
  // Закрытые и отменённые — по переключателю, как на доске задач (встреча 19.11).
  const [showClosed, setShowClosed] = useState(false);
  useEffect(() => {
    let alive = true;
    setTasks((current) => current ? { ...current, items: [] } : null);
    void m2Api.tasksPage({ workTypeCode: line.workTypeCode, ...(showClosed ? {} : { openOnly: true }), limit: pageSize, offset: pageIndex * pageSize, sort: "updated_desc" })
      .then((page) => { if (alive) setTasks({ items: page.items, total: page.total }); })
      .catch((error: unknown) => { if (alive) setTasks({ items: [], total: 0 }); toast.error(message(error, "Не получилось загрузить задачи")); });
    return () => { alive = false; };
  }, [line.workTypeCode, pageIndex, pageSize, showClosed]);
  const nextText = priceLineNextText(line);
  return <div className="engineer-page work-type-page">
    {/* «Изменить цену» — справа сверху, как «Изменить» в задаче и КП. */}
    <EntityDetailToolbar actions={canWrite ? <Button icon="edit" onClick={() => onEdit(line)} variant="secondary">{line.current ? "Изменить цену" : "Задать цену"}</Button> : undefined} backLabel="К прайсу" onBack={onBack} />
    <header className="task-head">
      <div className="task-head__meta"><span className="task-head__number">{line.workTypeCode}</span></div>
      <h1>{line.workTypeName}</h1>
      <p>{line.current ? `${priceLineAmountText(line)} · ${priceLineStartText(line)}` : PRICE_NOT_SET_LABEL}{nextText ? ` · ${nextText}` : ""}</p>
    </header>
    <PageTabs
      items={[
        { value: "history" as const, label: "История цен", badge: line.history.length },
        { value: "tasks" as const, label: "Задачи", ...(tasks ? { badge: tasks.total } : {}) }
      ]}
      label="Разделы вида работ"
      onValueChange={setTab}
      value={tab}
    />
    {tab === "history" ? <section className="task-section" aria-label="История цен">
      {line.history.length === 0
        ? <div className="task-section__empty"><p>{PRICE_NOT_SET_HINT}</p></div>
        : <div className="table-scroll table-cards"><table className="data-table price-history-table">
          <thead><tr>
            <th className="numeric" scope="col">Цена</th>
            <th scope="col">Период</th>
            <th scope="col">Гарантия</th>
            <th scope="col">Сейчас</th>
            {canWrite ? <th scope="col"><span className="sr-only">Действия</span></th> : null}
          </tr></thead>
          <tbody>{line.history.map((row) => {
            const future = row.validFrom > today;
            const active = priceRowActiveOn(row, today);
            return <tr key={row.id}>
              <td className="numeric" data-label="Цена"><strong>{formatMoney(row.amount)}</strong></td>
              <td data-label="Период">{priceRowPeriodText(row)}</td>
              <td data-label="Гарантия">{guaranteeWorkLabel(row.includeGuaranteeWork)}</td>
              <td data-label="Сейчас">{active
                ? <StatusBadge tone="success">Действует</StatusBadge>
                : future ? <StatusBadge tone="purple">Ещё не началась</StatusBadge> : <StatusBadge tone="neutral">В истории</StatusBadge>}</td>
              {canWrite ? <td>{canDeletePriceRow(row, today)
                ? <Button className="button--compact" onClick={() => onDelete(line, row)} variant="ghost">Убрать</Button>
                : null}</td> : null}
            </tr>;
          })}</tbody>
        </table></div>}
    </section> : null}
    {tab === "tasks" ? <section className="task-section" aria-label="Задачи с этим видом работ">
      <div className="task-list-toolbar"><CompletedTasksToggle onChange={(next) => { setShowClosed(next); setPageIndex(0); }} value={showClosed} /></div>
      {tasks === null
        ? <ResourceState description="Подождите." status="loading" title="Загружаем задачи" />
        : tasks.total === 0
          ? <div className="task-section__empty"><p>{showClosed ? "Задач с этим видом работ пока нет." : "Активных задач с этим видом работ нет."}</p></div>
          : <><div className="table-scroll"><table className="data-table task-list-table">
            {/* Номер и название — отдельными столбцами: строки не «едут» от длины названия (встреча 19.11). */}
            <thead><tr><th scope="col">Номер</th><th scope="col">Задача</th><th scope="col">Прибор</th><th scope="col">Клиент</th><th scope="col">Инженер</th><th scope="col">Срок</th><th scope="col">Этап</th></tr></thead>
            <tbody>{tasks.items.map((task) => <tr key={task.id}>
              <td className="task-list-table__number"><EntityLink target={{ kind: "task", id: task.id }}>{task.number}</EntityLink></td>
              <td><EntityLink target={{ kind: "task", id: task.id }}><strong>{task.title}</strong></EntityLink></td>
              <td>{task.equipmentId && task.equipmentLabel ? <EntityLink target={{ kind: "equipment", id: task.equipmentId }}>{[task.equipmentLabel.model, task.equipmentLabel.serialNumber ? `S/N ${task.equipmentLabel.serialNumber}` : undefined].filter(Boolean).join(" · ")}</EntityLink> : "—"}</td>
              <td>{task.siteId ? <EntityLink target={{ kind: "site", id: task.siteId }}>{task.customer?.siteName ?? "Клиент"}</EntityLink> : "—"}</td>
              <td>{task.engineerId ? <EntityLink target={{ kind: "engineer", id: task.engineerId }}>{task.engineerName ?? "Инженер"}</EntityLink> : <span className="muted">не назначен</span>}</td>
              <td className="cell-date">{task.status === "closed" ? formatDisplayDate(task.completedAt ?? task.visitDate) || "—" : task.periodTo ? `до ${formatDisplayDate(task.periodTo)}` : "—"}</td>
              <td><StatusBadge tone={TASK_STATUS_TONES[task.status] ?? "neutral"}>{TASK_STATUS_LABELS[task.status] ?? task.status}</StatusBadge></td>
            </tr>)}</tbody>
          </table></div>
          <RegistryPagination alwaysShow ariaLabel="Страницы задач вида работ" onPageChange={setPageIndex} onPageSizeChange={(size) => { setPageSize(size); setPageIndex(0); }} pageIndex={pageIndex} pageSize={pageSize} total={tasks.total} /></>}
    </section> : null}
  </div>;
}

/**
 * Прайс: цены по видам работ. Видно с правом `price.read` или `finance.read`,
 * правка — только с `price.write`. Даты считаем по часам компании (Москва).
 */
export function PricePage() {
  const today = companyToday();
  const [rows, setRows] = useState<readonly PriceRowApiRecord[]>([]);
  const [workTypes, setWorkTypes] = useState<readonly PriceWorkType[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [search, setSearch] = useState("");
  // Открытый вид работ — по ключу строки: после правки цены страница показывает свежую историю.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Правка одной цены: строка списка и поля окна.
  const [editing, setEditing] = useState<PriceLine | null>(null);
  const [amountDraft, setAmountDraft] = useState("");
  // Цена задним числом меняет то, что получат черновики счетов за прошлое: её подтверждают.
  const [backdateConfirmed, setBackdateConfirmed] = useState(false);
  const [guaranteeDraft, setGuaranteeDraft] = useState(false);
  const [validFromDraft, setValidFromDraft] = useState(today);
  // Массовое изменение выбранных строк.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState<BulkPriceMode>("percent");
  const [bulkValue, setBulkValue] = useState("");
  const [bulkFrom, setBulkFrom] = useState(today);
  const [deleting, setDeleting] = useState<{ readonly line: PriceLine; readonly row: PriceListRow } | null>(null);

  const reload = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [priceRows, workTypeValues] = await Promise.all([
        m2Api.listPriceList(),
        m2Api.listCatalogValues("work-types")
      ]);
      setRows(priceRows);
      setWorkTypes(workTypeOptions(workTypeValues, priceRows));
    } catch (error) {
      setLoadError(message(error, "Не получилось загрузить прайс"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    void m2Api.hasPermission("price.write").then(setCanWrite).catch(() => setCanWrite(false));
  }, []);

  // Цены по категориям гарантии не ведём: категорию с 17.11 не отмечают в паспорте прибора
  // (встреча 16.11), а счёт берёт цену «для всех» (0063). Старые строки категорий не показываем.
  const commonRows = useMemo(() => rows.filter((row) => !row.guaranteeCategoryId), [rows]);
  const lines = useMemo(() => priceLines({ workTypes, rows: commonRows, on: today }), [workTypes, commonRows, today]);
  const visible = useMemo(() => filterPriceLines(lines, search), [lines, search]);
  // Строка могла исчезнуть после обновления списка: выбор держим только по существующим.
  useEffect(() => {
    const keys = new Set(lines.map((line) => line.key));
    setSelected((current) => current.size === 0 || [...current].every((key) => keys.has(key)) ? current : new Set([...current].filter((key) => keys.has(key))));
  }, [lines]);

  // Процент и прибавку считаем от цены, действующей на выбранную дату начала: именно её
  // закроет база. На сегодняшнюю цену смотреть нельзя — на ту дату может действовать другая.
  const bulkOn = bulkFrom || today;
  const bulkLines = useMemo(() => priceLines({ workTypes, rows: commonRows, on: bulkOn }), [workTypes, commonRows, bulkOn]);
  const selectedLines = bulkLines.filter((line) => selected.has(line.key));
  const bulkNumber = bulkMode === "fixed" ? parseAmount(bulkValue) : parseSignedNumber(bulkValue);
  const changes = bulkNumber === null ? [] : previewBulkPrices(selectedLines, { mode: bulkMode, value: bulkNumber });
  const items = bulkPriceItems(changes);
  // Ноль разрешён, но пачкой он должен быть осознанным: про него говорим отдельно.
  const zeroCount = zeroPriceCount(changes);
  const withPrice = lines.filter((line) => line.current).length;
  const withoutPrice = lines.length - withPrice;
  const planned = lines.filter((line) => line.next).length;
  const counting = loading && rows.length === 0;

  const openLine = openKey ? lines.find((line) => line.key === openKey) ?? null : null;

  const toggleSelected = (key: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const openEditor = (line: PriceLine) => {
    setFormError(null);
    setEditing(line);
    setAmountDraft(line.current ? String(line.current.amount).replace(".", ",") : "");
    setBackdateConfirmed(false);
    setGuaranteeDraft(line.current?.includeGuaranteeWork === true);
    setValidFromDraft(today);
  };

  const openBulk = () => {
    setFormError(null);
    setBulkValue("");
    setBulkFrom(today);
    setBulkOpen(true);
  };

  const saveOne = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const amount = parseAmount(amountDraft);
    if (amount === null) {
      setFormError("Укажите цену числом, например 1 500,50");
      return;
    }
    if (!validFromDraft) {
      setFormError("Укажите дату, с которой действует цена");
      return;
    }
    if (amount === 0) {
      setFormError(ZERO_PRICE_MESSAGE);
      return;
    }
    if (isBackdatedPrice(validFromDraft, today) && !backdateConfirmed) {
      setFormError("Цена задним числом: отметьте ниже, что так и нужно");
      return;
    }
    if (amount > MAX_PRICE) {
      setFormError(`Цена слишком большая: не больше ${formatMoney(MAX_PRICE)}`);
      return;
    }
    // Иначе «Сохранить» без единой правки завело бы второй период с той же суммой,
    // и в истории появились бы две одинаковые записи подряд. База такую запись тоже
    // пропускает, но человеку нужно сказать, а не молча отрапортовать «Цена сохранена».
    if (editingActive && editingActive.amount === amount && editingActive.includeGuaranteeWork === guaranteeDraft) {
      setFormError("Цена и так такая: менять нечего");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await m2Api.setWorkPrice({
        workTypeCode: editing.workTypeCode,
        guaranteeCategoryId: null,
        amount,
        validFrom: validFromDraft,
        includeGuaranteeWork: guaranteeDraft
      });
      toast.success(`${editing.workTypeName}: ${formatMoney(amount)} с ${formatIsoCalendarDate(validFromDraft)}`, { title: "Цена сохранена" });
      setEditing(null);
      await reload();
    } catch (error) {
      const text = message(error, "Не получилось сохранить цену");
      setFormError(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  };

  const applyBulk = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (items.length === 0) {
      setFormError("Менять нечего: проверьте значение и выбранные строки");
      return;
    }
    if (!bulkFrom) {
      setFormError("Укажите дату, с которой действуют новые цены");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const changed = await m2Api.bulkUpdateWorkPrices(items, bulkFrom);
      toast.success(`${formatRussianCount(changed, ["позиция", "позиции", "позиций"])} с ${formatIsoCalendarDate(bulkFrom)}`, { title: "Цены изменены" });
      setBulkOpen(false);
      setSelected(new Set());
      await reload();
    } catch (error) {
      const text = message(error, "Не получилось изменить цены");
      setFormError(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  };

  // История цены «для всех»: только по ней считает счёт.
  const editingHistory = editing
    ? rows.filter((row) => row.workTypeCode === editing.workTypeCode
        && !row.guaranteeCategoryId)
    : [];
  // Цена, действующая на выбранную дату: по ней видно, что менять нечего.
  const editingActive = editing && validFromDraft
    ? editingHistory.find((row) => priceRowActiveOn(row, validFromDraft))
    : undefined;
  // Позже выбранной даты уже есть цена: новая будет закрыта её началом и действующей не станет.
  const laterPrice = editing && validFromDraft ? nextPriceAfter(editingHistory, validFromDraft) : undefined;
  const columns = canWrite ? 7 : 5;
  const editorTitle = editing ? `Цена · ${editing.workTypeName}` : "Цена вида работ";

  return <>
    {openLine ? <WorkTypePricePage
      canWrite={canWrite}
      line={openLine}
      onBack={() => setOpenKey(null)}
      onDelete={(line, row) => setDeleting({ line, row })}
      onEdit={openEditor}
      today={today}
    /> : <>
    <PageIntro
      description="Цены по видам работ: что действует сейчас, с какой даты и как менялось раньше. Новая цена закрывает прошлую, история остаётся."
      title="Прайс"
    />
    <div className="registry-toolbar">
      <label className="registry-toolbar__search" htmlFor="price-search">
        <span className="sr-only">Поиск по прайсу</span>
        <input id="price-search" onChange={(event) => setSearch(event.target.value)} placeholder="Вид работ, код или категория гарантии" type="search" value={search} />
      </label>
      <span className="registry-toolbar__spacer" />
      {canWrite ? <Button disabled={selected.size === 0} onClick={openBulk} variant="secondary">
        {selected.size === 0 ? "Изменить выбранные" : `Изменить выбранные · ${selected.size}`}
      </Button> : null}
    </div>
    <DataTableShell label="Виды работ">
      {loadError
        ? <ResourceState description={loadError} onRetry={() => void reload()} status="error" title="Прайс не загрузился" />
        : loading && rows.length === 0
          ? <ResourceState description="Подождите, цены сейчас появятся." status="loading" title="Загружаем прайс" />
          : lines.length === 0
            ? <ResourceState description="Сначала заведите виды работ в справочниках, затем назначьте им цены." status="empty" title="Видов работ пока нет" />
            : visible.length === 0
              ? <ResourceState description="Измените условия поиска." status="filtered-empty" title="Ничего не найдено" />
              : <div className="table-scroll table-cards table-cards--800"><table className="data-table price-table">
                <thead><tr>
                  {canWrite ? <th className="task-select-cell" scope="col"><input
                    aria-label="Выбрать все показанные строки"
                    checked={visible.length > 0 && visible.every((line) => selected.has(line.key))}
                    onChange={(event) => setSelected((current) => {
                      const next = new Set(current);
                      for (const line of visible) {
                        if (event.target.checked) next.add(line.key);
                        else next.delete(line.key);
                      }
                      return next;
                    })}
                    type="checkbox"
                  /></th> : null}
                  <th scope="col">Вид работ</th>
                  <th className="numeric" scope="col">Действующая цена</th>
                  <th scope="col">С какой даты</th>
                  <th scope="col">Гарантия</th>
                  <th scope="col">История</th>
                  {canWrite ? <th scope="col"><span className="sr-only">Действия</span></th> : null}
                </tr></thead>
                <tbody>{visible.map((line) => {
                  const nextText = priceLineNextText(line);
                  return <React.Fragment key={line.key}>
                    <tr className={selected.has(line.key) ? "data-table__selected" : ""}>
                      {canWrite ? <td className="task-select-cell"><input
                        aria-label={`Выбрать ${line.workTypeName} · ${line.guaranteeCategoryName}`}
                        checked={selected.has(line.key)}
                        onChange={(event) => toggleSelected(line.key, event.target.checked)}
                        type="checkbox"
                      /></td> : null}
                      <td className="cell-wide" data-label="Вид работ"><button className="entity-link" onClick={() => setOpenKey(line.key)} title="Открыть вид работ: история цен и задачи" type="button"><strong>{line.workTypeName}</strong></button>{line.guaranteeCategoryName === ALL_CATEGORIES_LABEL ? null : <small>{line.guaranteeCategoryName}</small>}</td>
                      <td className="numeric" data-label="Действующая цена">{line.current
                        ? <strong>{priceLineAmountText(line)}</strong>
                        : <span className="is-empty">{priceLineAmountText(line)}</span>}</td>
                      <td data-label="С какой даты">{priceLineStartText(line)}{nextText ? <small>{nextText}</small> : null}</td>
                      <td data-label="Гарантия">{line.current
                        ? <StatusBadge tone={line.current.includeGuaranteeWork ? "info" : "neutral"}>{guaranteeWorkLabel(line.current.includeGuaranteeWork)}</StatusBadge>
                        : "—"}</td>
                      <td data-label="История">{line.history.length === 0 ? <span className="muted">—</span> : <button
                        className="text-button"
                        onClick={() => setOpenKey(line.key)}
                        type="button"
                      >{formatRussianCount(line.history.length, ["цена", "цены", "цен"])}</button>}</td>
                      {canWrite ? <td><div className="table-actions"><Button
                        className="button--compact"
                        onClick={() => openEditor(line)}
                        variant="secondary"
                      >{line.current ? "Изменить цену" : "Задать цену"}</Button></div></td> : null}
                    </tr>
                  </React.Fragment>;
                })}</tbody>
              </table></div>}
    </DataTableShell>
    </>}

    <DialogForm
      busy={saving}
      description="Цена начнёт действовать с указанной даты, прошлая закроется днём раньше. Обе останутся в истории."
      error={formError}
      onOpenChange={(open) => { if (!open) setEditing(null); }}
      onSubmit={saveOne}
      open={Boolean(editing)}
      submitLabel="Сохранить цену"
      title={editorTitle}
    >
      <div className="dialog-form-grid">
        <label>Цена, ₽ *<input
          autoFocus
          inputMode="decimal"
          onChange={(event) => setAmountDraft(event.target.value)}
          placeholder="1 500,50"
          required
          value={amountDraft}
        />
          {parseAmount(amountDraft) === 0 ? <span className="form-hint form-hint--warning">{ZERO_PRICE_MESSAGE}.</span> : null}
        </label>
        <label>Действует с *<DatePicker aria-label="Дата начала действия цены" onChange={setValidFromDraft} required value={validFromDraft} />
          {laterPrice ? <span className="form-hint">Позже уже есть цена {formatMoney(laterPrice.amount)} с {formatIsoCalendarDate(laterPrice.validFrom)}: новая будет действовать только до неё.</span> : null}
        </label>
        {isBackdatedPrice(validFromDraft, today) ? <label className="field-check dialog-form-grid__wide">
          <input checked={backdateConfirmed} onChange={(event) => setBackdateConfirmed(event.target.checked)} type="checkbox" />
          <span>Да, цена задним числом, с {formatIsoCalendarDate(validFromDraft)}</span>
        </label> : null}
        <label className="field-check dialog-form-grid__wide">
          <input checked={guaranteeDraft} onChange={(event) => setGuaranteeDraft(event.target.checked)} type="checkbox" />
          <span>Включать работу по гарантии в счёт</span>
        </label>
      </div>
    </DialogForm>

    <DialogForm
      busy={saving}
      description="Новые цены начнут действовать с указанной даты. Что получится — видно ниже, до применения."
      error={formError}
      onOpenChange={(open) => { if (!open) setBulkOpen(false); }}
      onSubmit={applyBulk}
      open={bulkOpen}
      size="lg"
      submitDisabled={items.length === 0}
      submitLabel="Применить"
      title={`Изменить цены · ${formatRussianCount(selectedLines.length, ["строка", "строки", "строк"])}`}
    >
      <div className="dialog-form-grid">
        <label>Как считать
          <Select onChange={(event) => setBulkMode(event.target.value as BulkPriceMode)} value={bulkMode}>
            {BULK_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </Select>
        </label>
        <label>{bulkMode === "percent" ? "Процент *" : "Сумма, ₽ *"}<input
          autoFocus
          inputMode="decimal"
          onChange={(event) => setBulkValue(event.target.value)}
          placeholder={bulkMode === "percent" ? "10" : "500"}
          required
          value={bulkValue}
        /></label>
        <label>Действует с *<DatePicker aria-label="Дата начала новых цен" onChange={setBulkFrom} required value={bulkFrom} /></label>
        <p className="form-hint dialog-form-grid__wide">
          {BULK_MODES.find((mode) => mode.value === bulkMode)?.hint}
          {bulkMode === "fixed" ? null : " Считаем от цены, которая действует на выбранную дату."}
        </p>
      </div>
      <div className="price-preview">
        <span className="price-preview__label">Что получится</span>
        {bulkValue.trim() === ""
          ? <p className="form-hint">Укажите {bulkMode === "percent" ? "процент" : "сумму"} — и в списке появятся новые цены.</p>
          : bulkNumber === null
            ? <p className="form-hint">{bulkMode === "percent" ? "Процент указывают числом: 10 или −5." : "Сумму указывают числом, например 500 или 1 500,50."}</p>
            : <ul className="price-preview__list">{changes.map((change) => <li key={change.key}>
              <span className="price-preview__name"><strong>{change.workTypeName}</strong><small>{change.guaranteeCategoryName}</small></span>
              <span className="price-preview__amounts">
                {change.before === undefined ? <span className="is-empty">{PRICE_NOT_SET_LABEL}</span> : formatMoney(change.before)}
                {change.after === undefined ? null : <> → {change.skipReason ? <span className="is-empty">{formatMoney(change.after)}</span> : <strong>{formatMoney(change.after)}</strong>}</>}
              </span>
              {change.skipReason ? <small className="price-preview__skip">{change.skipReason}</small> : null}
            </li>)}</ul>}
        {zeroCount === 0 ? null : <p className="form-hint form-hint--warning">{zeroPriceWarning(zeroCount)}</p>}
        {bulkNumber === null ? null : <p className="form-hint">
          {items.length === 0
            ? "Ни одна строка не изменится."
            : `${russianCountForm(items.length, ["Изменится", "Изменятся", "Изменятся"])} ${formatRussianCount(items.length, ["строка", "строки", "строк"])} из ${selectedLines.length}.`}
        </p>}
      </div>
    </DialogForm>

    <ConfirmationDialog
      confirmLabel="Убрать цену"
      description={deleting
        ? <>Цена {formatMoney(deleting.row.amount)} с {formatIsoCalendarDate(deleting.row.validFrom)} ({deleting.line.workTypeName} · {deleting.line.guaranteeCategoryName}) ещё не начала действовать, её можно убрать. Действующие и прошлые цены остаются в истории.</>
        : null}
      onConfirm={async () => {
        if (!deleting) return;
        await m2Api.deleteFutureWorkPrice(deleting.row.id);
        toast.success(`${deleting.line.workTypeName}: будущая цена убрана`);
        setDeleting(null);
        await reload();
      }}
      onOpenChange={(open) => { if (!open) setDeleting(null); }}
      open={Boolean(deleting)}
      title="Убрать будущую цену?"
    />
  </>;
}
