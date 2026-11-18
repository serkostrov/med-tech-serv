import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { PayerOption } from "./customer-selection.js";
import { formatDisplayDate } from "./date-format.js";
import { m2Api, type PriceRowApiRecord, type QuoteApiRecord, type QuoteItemApiRecord, type QuotePartOption, type ReferenceCatalogValue } from "./m2-api.js";
import { formatMoney } from "./price-list.js";
import {
  QUOTE_STATUS_LABELS, QUOTE_STATUS_TONES, formatQuoteQuantity, parseQuoteNumber, quoteActions, quoteItemProblem,
  quoteOverdue, quoteTotalText, quoteWorkbookSheet, type QuoteStatus
} from "./quotes.js";
import { downloadWorkbook } from "./registry-export.js";
import { MultiSelect } from "./MultiSelect.js";
import { companyToday } from "./task-dates.js";
import {
  Button, CardHeader, DatePicker, DialogForm, EntityDetailToolbar, IconButton, Input, PageIntro, ResourceState, Select, StatusBadge, toast
} from "./ui.js";

/**
 * КП — коммерческие предложения клиентам (ТЗ, блок 9): позиции из номенклатуры склада с остатком
 * и работы по прайсу, сумма, статус, выгрузка в Excel. Правила статусов и правки держит база (0071).
 */
export function QuotesPage() {
  const [quotes, setQuotes] = useState<readonly QuoteApiRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  // Статусы — по нескольку (встреча 18.11).
  const [statusFilter, setStatusFilter] = useState<readonly string[]>([]);
  const [editor, setEditor] = useState<{ readonly mode: "create" } | { readonly mode: "edit"; readonly quote: QuoteApiRecord } | null>(null);
  const [cardRefresh, setCardRefresh] = useState(0);
  const [sites, setSites] = useState<readonly { readonly id: string; readonly name: string }[]>([]);
  const [payers, setPayers] = useState<readonly PayerOption[]>([]);

  const reload = async () => {
    try {
      setQuotes(await m2Api.listQuotes());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не получилось загрузить КП");
    }
  };
  useEffect(() => {
    void reload();
    void m2Api.hasPermission("contracts.write").then(setCanWrite).catch(() => setCanWrite(false));
    void m2Api.listSiteNames().then(setSites).catch(() => setSites([]));
    void m2Api.listPayers().then(setPayers).catch(() => setPayers([]));
  }, []);

  const today = companyToday();
  const shown = useMemo(() => (quotes ?? []).filter((quote) => statusFilter.length === 0 || statusFilter.includes(quote.status)), [quotes, statusFilter]);

  const editorDialog = editor ? <QuoteHeaderDialog
    key={editor.mode === "edit" ? editor.quote.id : "new"}
    onClose={() => setEditor(null)}
    onSaved={async (saved) => {
      setEditor(null);
      await reload();
      if (editor.mode === "create" && saved) setOpenId(saved.id);
      else setCardRefresh((value) => value + 1);
    }}
    payers={payers}
    quote={editor.mode === "edit" ? editor.quote : undefined}
    sites={sites}
  /> : null;

  if (openId) {
    return <>
      <QuoteCard
        canWrite={canWrite}
        id={openId}
        onBack={() => { setOpenId(null); void reload(); }}
        onEdit={(quote) => setEditor({ mode: "edit", quote })}
        refresh={cardRefresh}
      />
      {editorDialog}
    </>;
  }

  return <>
    <PageIntro
      actions={canWrite ? <Button icon="plus" onClick={() => setEditor({ mode: "create" })}>Создать КП</Button> : null}
      description="Коммерческие предложения клиентам: запчасти со склада и работы по прайсу"
      title="КП"
    />
    <section className="card card--table" aria-labelledby="quotes-title">
      <CardHeader
        action={<MultiSelect compact emptyLabel="Все статусы" label="Статус КП" onChange={setStatusFilter} options={(Object.keys(QUOTE_STATUS_LABELS) as QuoteStatus[]).map((status) => ({ value: status, label: QUOTE_STATUS_LABELS[status] }))} value={statusFilter} />}
        headingId="quotes-title"
        meta={quotes ? `${shown.length} из ${quotes.length}` : undefined}
        title="Коммерческие предложения"
      />
      {loadError ? <ResourceState description={loadError} status="error" title="КП не загрузились" />
        : quotes === null ? <ResourceState description="Подождите, список сейчас появится." status="loading" title="Загружаем КП" />
        : shown.length === 0 ? <ResourceState
          description={quotes.length === 0 ? (canWrite ? "Нажмите «Создать КП», добавьте запчасти и работы — сумма посчитается сама." : "КП пока никто не создавал.") : "С таким статусом КП нет."}
          status="empty"
          title={quotes.length === 0 ? "КП пока нет" : "Ничего не нашлось"}
        />
        : <div className="table-scroll table-cards"><table className="data-table">
          <thead><tr>
            <th scope="col">Номер</th>
            <th scope="col">Название</th>
            <th scope="col">Клиент</th>
            <th className="numeric" scope="col">Сумма</th>
            <th scope="col">Действует до</th>
            <th scope="col">Статус</th>
          </tr></thead>
          <tbody>{shown.map((quote) => <tr className="clickable-row" key={quote.id} onClick={() => setOpenId(quote.id)}>
            <td data-label="Номер"><button className="text-button" onClick={(event) => { event.stopPropagation(); setOpenId(quote.id); }} type="button">{quote.number}</button></td>
            <td className="cell-wide" data-label="Название"><strong>{quote.name}</strong></td>
            <td data-label="Клиент">{[quote.siteName, quote.payerName].filter(Boolean).join(" · ") || "—"}</td>
            <td className="numeric" data-label="Сумма">{formatMoney(quote.totalAmount)}</td>
            <td data-label="Действует до">{quote.validUntil ? formatDisplayDate(quote.validUntil) : "—"}{quoteOverdue(quote, today) ? <small className="quote-overdue">срок прошёл</small> : null}</td>
            <td data-label="Статус"><StatusBadge tone={QUOTE_STATUS_TONES[quote.status]}>{QUOTE_STATUS_LABELS[quote.status]}</StatusBadge></td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    {editorDialog}
  </>;
}

/** Шапка КП: название, клиент, срок действия. Создание и правка черновика — одно окно. */
function QuoteHeaderDialog({ quote, sites, payers, onClose, onSaved }: {
  readonly quote: QuoteApiRecord | undefined;
  readonly sites: readonly { readonly id: string; readonly name: string }[];
  readonly payers: readonly PayerOption[];
  readonly onClose: () => void;
  readonly onSaved: (saved?: QuoteApiRecord) => Promise<void>;
}) {
  const [validUntil, setValidUntil] = useState(quote?.validUntil ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = {
      name: String(data.get("name") ?? ""),
      siteId: String(data.get("siteId") ?? ""),
      payerId: String(data.get("payerId") ?? ""),
      validUntil
    };
    setBusy(true);
    setError(null);
    try {
      if (quote) {
        await m2Api.updateQuote(quote.id, input);
        toast.success("Изменения сохранены", { title: quote.number });
        await onSaved();
      } else {
        const created = await m2Api.createQuote(input);
        toast.success("Добавьте запчасти и работы — сумма посчитается сама", { title: `${created.number} создано` });
        await onSaved(created);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не получилось сохранить КП");
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogForm
      busy={busy}
      description={quote ? "Название, клиента и срок меняют, пока КП — черновик." : "Новое КП создаётся черновиком. Позиции добавите в его карточке."}
      error={error}
      onOpenChange={(open) => { if (!open) onClose(); }}
      onSubmit={submit}
      open
      submitLabel={quote ? "Сохранить" : "Создать КП"}
      title={quote ? `Изменить ${quote.number}` : "Новое КП"}
    >
      <div className="dialog-form-grid">
        <label className="dialog-form-grid__wide">Название *<Input defaultValue={quote?.name ?? ""} maxLength={200} name="name" placeholder="Например, лампы и реагенты для КДЛ" required /></label>
        <label>Площадка<Select defaultValue={quote?.siteId ?? ""} name="siteId"><option value="">Не выбрана</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</Select></label>
        <label>Плательщик<Select defaultValue={quote?.payerId ?? ""} name="payerId"><option value="">Не выбран</option>{payers.filter((payer) => payer.isActive !== false || payer.id === quote?.payerId).map((payer) => <option key={payer.id} value={payer.id}>{payer.name}</option>)}</Select></label>
        <label>Действует до<DatePicker onChange={setValidUntil} value={validUntil} /></label>
      </div>
    </DialogForm>
  );
}

function QuoteCard({ id, canWrite, onBack, onEdit, refresh }: {
  readonly id: string;
  readonly canWrite: boolean;
  readonly onBack: () => void;
  readonly onEdit: (quote: QuoteApiRecord) => void;
  readonly refresh: number;
}) {
  const [data, setData] = useState<{ readonly quote: QuoteApiRecord; readonly items: readonly QuoteItemApiRecord[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<ReadonlyMap<string, number>>(new Map());
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<"part" | "work" | null>(null);
  const load = async () => {
    try {
      const loaded = await m2Api.quote(id);
      setData(loaded);
      setError(null);
      const partIds = loaded.items.flatMap((item) => (item.partId ? [item.partId] : []));
      void m2Api.quotePartsAvailability(partIds).then(setAvailable).catch(() => setAvailable(new Map()));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не получилось открыть КП");
    }
  };
  useEffect(() => { void load(); }, [id, refresh]);

  if (error) return <><EntityDetailToolbar backLabel="К списку КП" onBack={onBack} /><ResourceState description={error} status="error" title="КП не открылось" /></>;
  if (!data) return <><EntityDetailToolbar backLabel="К списку КП" onBack={onBack} /><ResourceState description="Подождите, КП сейчас откроется." status="loading" title="Открываем КП" /></>;

  const { quote, items } = data;
  const editable = canWrite && quote.status === "draft";
  const overdue = quoteOverdue(quote, companyToday());
  const changeStatus = async (to: QuoteStatus, label: string) => {
    setBusy(true);
    try {
      await m2Api.setQuoteStatus(quote.id, to);
      toast.success(`Статус: ${QUOTE_STATUS_LABELS[to]}`, { title: `${quote.number}: ${label.toLowerCase()}` });
      await load();
    } catch (statusError) {
      toast.error(statusError instanceof Error ? statusError.message : "Не получилось сменить статус");
    } finally {
      setBusy(false);
    }
  };
  const exportExcel = () => {
    void downloadWorkbook([quoteWorkbookSheet(quote, items.map((item) => ({
      description: item.description,
      ...(item.partArticle ?? item.workTypeName ? { code: item.partArticle ?? item.workTypeName } : {}),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal
    })))], `${quote.number}.xlsx`).catch((exportError: unknown) => toast.error(exportError instanceof Error ? exportError.message : "Не получилось выгрузить КП"));
  };
  const actions = canWrite ? quoteActions(quote.status) : [];

  return (
    <div className="quote-card">
      <EntityDetailToolbar
        actions={<Button onClick={exportExcel} variant="secondary">Скачать в Excel</Button>}
        backLabel="К списку КП"
        onBack={onBack}
      />
      <header className="task-head">
        <div className="task-head__meta">
          <span className="task-head__number">{quote.number}</span>
          <StatusBadge tone={QUOTE_STATUS_TONES[quote.status]}>{QUOTE_STATUS_LABELS[quote.status]}</StatusBadge>
          {overdue ? <span className="task-head__flag task-head__flag--late">срок действия прошёл</span> : null}
        </div>
        <h1>{quote.name}</h1>
        <p>{[quote.siteName, quote.payerName].filter(Boolean).join(" · ") || "Клиент не указан"}{quote.validUntil ? ` · действует до ${formatDisplayDate(quote.validUntil)}` : ""}</p>
      </header>

      {actions.length > 0 || editable ? <div className="quote-card__actions">
        {actions.map((action) => <Button busy={busy} disabled={busy || (action.to === "sent" && items.length === 0)} key={action.to} onClick={() => void changeStatus(action.to, action.label)} variant={action.primary ? "primary" : "secondary"}>{action.label}</Button>)}
        {editable ? <Button onClick={() => onEdit(quote)} variant="ghost">Изменить название и клиента</Button> : null}
        {quote.status === "draft" && items.length === 0 ? <span className="form-hint">Пустое КП клиенту не отправить: сначала добавьте позиции.</span> : null}
        {quote.status === "sent" && overdue ? <span className="form-hint">Срок действия прошёл: отметьте «Срок истёк» или верните в черновик и продлите.</span> : null}
      </div> : null}

      <section className="card card--table" aria-labelledby="quote-items-title">
        <CardHeader
          action={editable ? <div className="quote-card__add">
            <Button icon="plus" onClick={() => setAdding("part")} variant="secondary">Запчасть со склада</Button>
            <Button icon="plus" onClick={() => setAdding("work")} variant="secondary">Работа по прайсу</Button>
          </div> : undefined}
          headingId="quote-items-title"
          meta={quoteTotalText(quote.totalAmount, items.length)}
          title="Позиции"
        />
        {items.length === 0
          ? <ResourceState description={editable ? "Добавьте запчасти со склада и работы по прайсу: цену и количество можно поправить." : "В этом КП нет позиций."} status="empty" title="Позиций пока нет" />
          : <div className="table-scroll table-cards"><table className="data-table quote-items">
            <thead><tr>
              <th scope="col">Позиция</th>
              <th className="numeric" scope="col">Количество</th>
              <th className="numeric" scope="col">Цена, ₽</th>
              <th className="numeric" scope="col">Сумма</th>
              {editable ? <th scope="col"><span className="sr-only">Убрать</span></th> : null}
            </tr></thead>
            <tbody>{items.map((item) => <QuoteItemRow available={item.partId ? available.get(item.partId) : undefined} editable={editable} item={item} key={item.id} onChanged={load} />)}</tbody>
            <tfoot><tr><th colSpan={3} scope="row">Итого</th><td className="numeric"><strong>{formatMoney(quote.totalAmount)}</strong></td>{editable ? <td /> : null}</tr></tfoot>
          </table></div>}
      </section>

      {adding === "part" ? <QuotePartDialog onAdded={async () => { setAdding(null); await load(); }} onClose={() => setAdding(null)} quoteId={quote.id} /> : null}
      {adding === "work" ? <QuoteWorkDialog onAdded={async () => { setAdding(null); await load(); }} onClose={() => setAdding(null)} quoteId={quote.id} /> : null}
    </div>
  );
}

/** Строка позиции. В черновике количество и цена правятся прямо в таблице и сохраняются при уходе из поля. */
function QuoteItemRow({ item, editable, available, onChanged }: {
  readonly item: QuoteItemApiRecord;
  readonly editable: boolean;
  readonly available: number | undefined;
  readonly onChanged: () => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(String(item.quantity).replace(".", ","));
  const [price, setPrice] = useState(String(item.unitPrice).replace(".", ","));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setQuantity(String(item.quantity).replace(".", ",")); setPrice(String(item.unitPrice).replace(".", ",")); }, [item.quantity, item.unitPrice]);
  const save = async () => {
    const next = { quantity: parseQuoteNumber(quantity), unitPrice: parseQuoteNumber(price) };
    if (next.quantity === item.quantity && next.unitPrice === item.unitPrice) return;
    const problem = quoteItemProblem({ ...next, ...(item.partCountable !== undefined ? { countable: item.partCountable } : {}), ...(item.partArticle ? { article: item.partArticle } : {}) });
    if (problem) {
      toast.error(problem);
      setQuantity(String(item.quantity).replace(".", ","));
      setPrice(String(item.unitPrice).replace(".", ","));
      return;
    }
    setSaving(true);
    try { await m2Api.updateQuoteItem(item.id, next); await onChanged(); }
    catch (saveError) { toast.error(saveError instanceof Error ? saveError.message : "Не получилось сохранить позицию"); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    setSaving(true);
    try { await m2Api.deleteQuoteItem(item.id); await onChanged(); }
    catch (removeError) { toast.error(removeError instanceof Error ? removeError.message : "Не получилось убрать позицию"); }
    finally { setSaving(false); }
  };
  const stockNote = item.partId === undefined ? null
    : available === undefined ? null
    : available >= item.quantity ? <small className="quote-items__stock">на складе свободно {formatQuoteQuantity(available)}</small>
    : <small className="quote-items__stock quote-items__stock--short">на складе свободно {formatQuoteQuantity(Math.max(0, available))} — не хватает</small>;
  return (
    <tr>
      <td className="cell-wide" data-label="Позиция">
        <strong>{item.description}</strong>
        <small className="quote-items__kind">{item.partArticle ? `запчасть · ${item.partArticle}` : `работа${item.workTypeName && item.workTypeName !== item.description ? ` · ${item.workTypeName}` : ""}`}</small>
        {stockNote}
      </td>
      <td className="numeric" data-label="Количество">{editable
        ? <Input aria-label={`Количество: ${item.description}`} disabled={saving} inputMode="decimal" onBlur={() => void save()} onChange={(event) => setQuantity(event.target.value)} value={quantity} />
        : formatQuoteQuantity(item.quantity)}</td>
      <td className="numeric" data-label="Цена">{editable
        ? <Input aria-label={`Цена: ${item.description}`} disabled={saving} inputMode="decimal" onBlur={() => void save()} onChange={(event) => setPrice(event.target.value)} value={price} />
        : formatMoney(item.unitPrice)}</td>
      <td className="numeric" data-label="Сумма"><strong>{formatMoney(item.lineTotal)}</strong></td>
      {editable ? <td data-label=""><IconButton disabled={saving} icon="trash" label={`Убрать ${item.description}`} onClick={() => void remove()} /></td> : null}
    </tr>
  );
}

/** Запчасть со склада: поиск по артикулу (и старым артикулам) и названию, видно, сколько свободно. */
function QuotePartDialog({ quoteId, onClose, onAdded }: { readonly quoteId: string; readonly onClose: () => void; readonly onAdded: () => Promise<void> }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<readonly QuotePartOption[] | null>(null);
  const [chosen, setChosen] = useState<QuotePartOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      void m2Api.searchQuoteParts(search).then((found) => { if (alive) setResults(found); }).catch(() => { if (alive) setResults([]); });
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [search]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chosen) { setError("Выберите запчасть из списка"); return; }
    const data = new FormData(event.currentTarget);
    const quantity = parseQuoteNumber(String(data.get("quantity") ?? ""));
    const unitPrice = parseQuoteNumber(String(data.get("unitPrice") ?? ""));
    const problem = quoteItemProblem({ quantity, unitPrice, article: chosen.articleNumber });
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await m2Api.addQuoteItem({ quoteId, partId: chosen.id, description: `${chosen.name} (${chosen.articleNumber})`, quantity, unitPrice });
      await onAdded();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Не получилось добавить запчасть");
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogForm busy={busy} description="Запчасть из номенклатуры склада. Цену для клиента укажите сами." error={error} onOpenChange={(open) => { if (!open) onClose(); }} onSubmit={submit} open size="lg" submitDisabled={!chosen} submitLabel="Добавить в КП" title="Запчасть со склада">
      <label className="field-wide">Поиск<Input autoFocus onChange={(event) => { setSearch(event.target.value); setChosen(null); }} placeholder="Артикул или название" type="search" value={search} /></label>
      <div className="quote-part-results field-wide" role="listbox" aria-label="Найденные запчасти">
        {results === null ? <p className="form-hint">Ищем…</p>
          : results.length === 0 ? <p className="form-hint">Ничего не нашлось. Новую запчасть заводят в разделе «Склад».</p>
          : results.map((part) => <button aria-selected={chosen?.id === part.id} className={`quote-part-results__item${chosen?.id === part.id ? " quote-part-results__item--on" : ""}`} key={part.id} onClick={() => setChosen(part)} role="option" type="button">
            <strong>{part.articleNumber}</strong>
            <span>{part.name}</span>
            <small className={part.availableQuantity > 0 ? "" : "quote-items__stock--short"}>свободно {formatQuoteQuantity(part.availableQuantity)}</small>
          </button>)}
      </div>
      {chosen ? <div className="dialog-form-grid">
        <label>Количество *<Input defaultValue="1" inputMode="decimal" name="quantity" required /></label>
        <label>Цена за штуку, ₽ *<Input inputMode="decimal" name="unitPrice" placeholder="Например, 1 500" required /></label>
      </div> : null}
    </DialogForm>
  );
}

/** Работа по прайсу: цена подставляется из действующей цены «для всех», её можно поправить. */
function QuoteWorkDialog({ quoteId, onClose, onAdded }: { readonly quoteId: string; readonly onClose: () => void; readonly onAdded: () => Promise<void> }) {
  const [workTypes, setWorkTypes] = useState<readonly ReferenceCatalogValue[]>([]);
  const [prices, setPrices] = useState<readonly PriceRowApiRecord[]>([]);
  const [code, setCode] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void m2Api.listCatalogValues("work-types").then((values) => setWorkTypes(values.filter((item) => item.isActive))).catch(() => setWorkTypes([]));
    void m2Api.listPriceList().then(setPrices).catch(() => setPrices([]));
  }, []);
  const today = companyToday();
  const priceFor = (workTypeCode: string): number | undefined => prices.find((row) => row.workTypeCode === workTypeCode && row.guaranteeCategoryId === null
    && row.validFrom <= today && (row.validTo === null || row.validTo > today))?.amount;
  const pick = (next: string) => {
    setCode(next);
    const current = priceFor(next);
    setPrice(current === undefined ? "" : String(current).replace(".", ","));
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const workType = workTypes.find((item) => (item.code ?? item.id) === code);
    if (!workType) { setError("Выберите вид работ"); return; }
    const data = new FormData(event.currentTarget);
    const quantity = parseQuoteNumber(String(data.get("quantity") ?? ""));
    const unitPrice = parseQuoteNumber(price);
    const problem = quoteItemProblem({ quantity, unitPrice });
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await m2Api.addQuoteItem({ quoteId, workTypeCode: code, description: workType.name, quantity, unitPrice });
      await onAdded();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Не получилось добавить работу");
    } finally {
      setBusy(false);
    }
  };
  const priceHint = code ? (priceFor(code) === undefined ? "В прайсе цены нет — укажите сами." : "Цена из прайса на сегодня, можно поправить.") : null;
  return (
    <DialogForm busy={busy} description="Вид работ из справочника, цена — из прайса." error={error} onOpenChange={(open) => { if (!open) onClose(); }} onSubmit={submit} open submitDisabled={!code} submitLabel="Добавить в КП" title="Работа по прайсу">
      <div className="dialog-form-grid">
        <label className="dialog-form-grid__wide">Вид работ *<Select onChange={(event) => pick(event.target.value)} required value={code}><option value="">Не выбран</option>{workTypes.map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label>
        <label>Количество *<Input defaultValue="1" inputMode="decimal" name="quantity" required /></label>
        <label>Цена, ₽ *<Input inputMode="decimal" onChange={(event) => setPrice(event.target.value)} required value={price} />{priceHint ? <span className="form-hint">{priceHint}</span> : null}</label>
      </div>
    </DialogForm>
  );
}
