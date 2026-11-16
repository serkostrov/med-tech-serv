import React, { useEffect, useMemo, useState, type FormEvent } from "react";
import { m2Api, type PriceRowApiRecord, type ReferenceCatalogValue } from "./m2-api.js";
import {
  Button,
  ConfirmationDialog,
  DataTableShell,
  DatePicker,
  DialogForm,
  MetricCard,
  PageIntro,
  ResourceState,
  Select,
  StatusBadge,
  toast
} from "./ui.js";
import { formatIsoCalendarDate } from "./date-format.js";
import { formatRussianCount } from "./equipment-changes.js";
import { companyToday } from "./task-dates.js";
import {
  ALL_CATEGORIES_LABEL,
  MAX_PRICE,
  PRICE_NOT_SET_HINT,
  PRICE_NOT_SET_LABEL,
  bulkPriceItems,
  canDeletePriceRow,
  filterPriceLines,
  formatMoney,
  guaranteeWorkLabel,
  nextPriceAfter,
  parseAmount,
  parseSignedNumber,
  previewBulkPrices,
  priceLineAmountText,
  priceLineNextText,
  priceLineStartText,
  priceLines,
  priceRowActiveOn,
  priceRowPeriodText,
  priceScopeKey,
  type BulkPriceMode,
  type PriceGuaranteeCategory,
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

function categoryOptions(values: readonly ReferenceCatalogValue[], rows: readonly PriceRowApiRecord[]): readonly PriceGuaranteeCategory[] {
  const priced = new Set(rows.map((row) => row.guaranteeCategoryId).filter((id): id is string => Boolean(id)));
  return values
    .filter((value) => value.isActive || priced.has(value.id))
    .map((value) => ({ id: value.id, name: value.name }));
}

/** История цен строки: периоды сверху вниз от новых к старым, будущую цену можно убрать. */
function PriceHistory({ line, today, canWrite, onDelete }: {
  readonly line: PriceLine;
  readonly today: string;
  readonly canWrite: boolean;
  readonly onDelete: (row: PriceListRow) => void;
}) {
  if (line.history.length === 0) return <p className="price-history__empty">{PRICE_NOT_SET_HINT}</p>;
  return <ul className="price-history__list">
    {line.history.map((row) => {
      const future = row.validFrom > today;
      const active = priceRowActiveOn(row, today);
      return <li key={row.id}>
        <strong>{formatMoney(row.amount)}</strong>
        <span>{priceRowPeriodText(row)}</span>
        <small>{guaranteeWorkLabel(row.includeGuaranteeWork)}</small>
        {active ? <StatusBadge tone="success">Действует</StatusBadge> : future ? <StatusBadge tone="purple">Ещё не началась</StatusBadge> : <StatusBadge tone="neutral">В истории</StatusBadge>}
        {canWrite && canDeletePriceRow(row, today)
          ? <Button className="button--compact" onClick={() => onDelete(row)} variant="ghost">Убрать</Button>
          : null}
      </li>;
    })}
  </ul>;
}

/**
 * Прайс: цены по видам работ. Видно с правом `price.read` или `finance.read`,
 * правка — только с `price.write`. Даты считаем по часам компании (Москва).
 */
export function PricePage() {
  const today = companyToday();
  const [rows, setRows] = useState<readonly PriceRowApiRecord[]>([]);
  const [workTypes, setWorkTypes] = useState<readonly PriceWorkType[]>([]);
  const [categories, setCategories] = useState<readonly PriceGuaranteeCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Правка одной цены: строка списка и поля окна.
  const [editing, setEditing] = useState<PriceLine | null>(null);
  const [amountDraft, setAmountDraft] = useState("");
  const [categoryDraft, setCategoryDraft] = useState("");
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
      const [priceRows, workTypeValues, categoryValues] = await Promise.all([
        m2Api.listPriceList(),
        m2Api.listCatalogValues("work-types"),
        m2Api.listCatalogValues("guarantee-categories")
      ]);
      setRows(priceRows);
      setWorkTypes(workTypeOptions(workTypeValues, priceRows));
      setCategories(categoryOptions(categoryValues, priceRows));
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

  const lines = useMemo(() => priceLines({ workTypes, rows, categories, on: today }), [workTypes, rows, categories, today]);
  const visible = useMemo(() => filterPriceLines(lines, search), [lines, search]);
  // Строка могла исчезнуть после обновления списка: выбор держим только по существующим.
  useEffect(() => {
    const keys = new Set(lines.map((line) => line.key));
    setSelected((current) => current.size === 0 || [...current].every((key) => keys.has(key)) ? current : new Set([...current].filter((key) => keys.has(key))));
  }, [lines]);

  // Процент и прибавку считаем от цены, действующей на выбранную дату начала: именно её
  // закроет база. На сегодняшнюю цену смотреть нельзя — на ту дату может действовать другая.
  const bulkOn = bulkFrom || today;
  const bulkLines = useMemo(() => priceLines({ workTypes, rows, categories, on: bulkOn }), [workTypes, rows, categories, bulkOn]);
  const selectedLines = bulkLines.filter((line) => selected.has(line.key));
  const bulkNumber = bulkMode === "fixed" ? parseAmount(bulkValue) : parseSignedNumber(bulkValue);
  const changes = bulkNumber === null ? [] : previewBulkPrices(selectedLines, { mode: bulkMode, value: bulkNumber });
  const items = bulkPriceItems(changes);
  const withPrice = lines.filter((line) => line.current).length;
  const withoutPrice = lines.length - withPrice;
  const planned = lines.filter((line) => line.next).length;
  const counting = loading && rows.length === 0;

  const toggleHistory = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
    setCategoryDraft(line.guaranteeCategoryId ?? "");
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
        guaranteeCategoryId: categoryDraft || null,
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

  // История берётся по выбранной в окне категории, а не по той, с которой окно открыли:
  // категорию в окне меняют, и подсказка про будущую цену должна смотреть на нужную историю.
  const editingHistory = editing
    ? rows.filter((row) => row.workTypeCode === editing.workTypeCode
        && priceScopeKey(row.guaranteeCategoryId) === priceScopeKey(categoryDraft || null))
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
    <PageIntro
      description="Цены по видам работ: что действует сейчас, с какой даты и как менялось раньше. Новая цена закрывает прошлую, история остаётся."
      title="Прайс"
    />
    <div className="metric-grid metric-grid--three">
      <MetricCard icon="finance" label="Цены заданы" value={counting ? "…" : String(withPrice)} />
      <MetricCard icon="references" label="Без цены" tone="orange" value={counting ? "…" : String(withoutPrice)} />
      <MetricCard detail="будущие цены" icon="clock" label="Начнут действовать" tone="purple" value={counting ? "…" : String(planned)} />
    </div>
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
    <DataTableShell
      meta={loading && rows.length === 0 ? undefined : formatRussianCount(visible.length, ["строка", "строки", "строк"])}
      title="Виды работ"
    >
      {loadError
        ? <ResourceState description={loadError} onRetry={() => void reload()} status="error" title="Прайс не загрузился" />
        : loading && rows.length === 0
          ? <ResourceState description="Подождите, цены сейчас появятся." status="loading" title="Загружаем прайс" />
          : lines.length === 0
            ? <ResourceState description="Сначала заведите виды работ в справочниках, затем назначьте им цены." status="empty" title="Видов работ пока нет" />
            : visible.length === 0
              ? <ResourceState description="Измените условия поиска." status="filtered-empty" title="Ничего не найдено" />
              : <div className="table-scroll"><table className="data-table price-table">
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
                  const open = expanded.has(line.key);
                  const nextText = priceLineNextText(line);
                  return <React.Fragment key={line.key}>
                    <tr className={selected.has(line.key) ? "data-table__selected" : ""}>
                      {canWrite ? <td className="task-select-cell"><input
                        aria-label={`Выбрать ${line.workTypeName} · ${line.guaranteeCategoryName}`}
                        checked={selected.has(line.key)}
                        onChange={(event) => toggleSelected(line.key, event.target.checked)}
                        type="checkbox"
                      /></td> : null}
                      <td><strong>{line.workTypeName}</strong><small>{line.guaranteeCategoryName} · {line.workTypeCode}</small></td>
                      <td className="numeric">{line.current
                        ? <strong>{priceLineAmountText(line)}</strong>
                        : <span className="is-empty">{priceLineAmountText(line)}</span>}</td>
                      <td>{priceLineStartText(line)}{nextText ? <small>{nextText}</small> : null}</td>
                      <td>{line.current
                        ? <StatusBadge tone={line.current.includeGuaranteeWork ? "info" : "neutral"}>{guaranteeWorkLabel(line.current.includeGuaranteeWork)}</StatusBadge>
                        : "—"}</td>
                      <td>{line.history.length === 0 ? <span className="muted">—</span> : <button
                        aria-controls={`price-history-${line.key}`}
                        aria-expanded={open}
                        className="text-button"
                        onClick={() => toggleHistory(line.key)}
                        type="button"
                      >{open ? "Скрыть историю" : `Все цены · ${line.history.length}`}</button>}</td>
                      {canWrite ? <td><div className="table-actions"><Button
                        className="button--compact"
                        onClick={() => openEditor(line)}
                        variant={line.current ? "secondary" : "primary"}
                      >{line.current ? "Изменить цену" : "Задать цену"}</Button></div></td> : null}
                    </tr>
                    {open ? <tr className="price-history-row" id={`price-history-${line.key}`}>
                      <td colSpan={columns}>
                        <PriceHistory canWrite={canWrite} line={line} onDelete={(row) => setDeleting({ line, row })} today={today} />
                      </td>
                    </tr> : null}
                  </React.Fragment>;
                })}</tbody>
              </table></div>}
    </DataTableShell>

    <DialogForm
      busy={saving}
      description="Цена начнёт действовать с указанной даты. Прошлую цену база закроет сама, история останется."
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
        /></label>
        <label>Действует с *<DatePicker aria-label="Дата начала действия цены" onChange={setValidFromDraft} required value={validFromDraft} />
          {laterPrice ? <span className="form-hint">Позже уже есть цена {formatMoney(laterPrice.amount)} с {formatIsoCalendarDate(laterPrice.validFrom)}: новая будет действовать только до неё.</span> : null}
        </label>
        <label className="dialog-form-grid__wide">Категория гарантии
          <Select onChange={(event) => setCategoryDraft(event.target.value)} value={categoryDraft}>
            <option value="">{ALL_CATEGORIES_LABEL}</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </Select>
          <span className="form-hint">Цена «{ALL_CATEGORIES_LABEL}» действует там, где у категории нет своей цены.</span>
        </label>
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
                {change.after === undefined ? null : <> → <strong>{formatMoney(change.after)}</strong></>}
              </span>
              {change.skipReason ? <small className="price-preview__skip">{change.skipReason}</small> : null}
            </li>)}</ul>}
        {bulkNumber === null ? null : <p className="form-hint">
          {items.length === 0
            ? "Ни одна строка не изменится."
            : `Изменится ${formatRussianCount(items.length, ["строка", "строки", "строк"])} из ${selectedLines.length}.`}
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
