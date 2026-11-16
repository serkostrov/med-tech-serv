import { useEffect, useState, type FormEvent } from "react";
import { m2Api, type InvoiceCardResponse, type InvoiceItemApiRecord } from "./m2-api.js";
import {
  AutoTextarea,
  Button,
  ConfirmationDialog,
  DialogForm,
  EntityDetailToolbar,
  ResourceState,
  StatusBadge,
  toast
} from "./ui.js";
import { formatDisplayDateTime } from "./date-format.js";
import { formatMoney } from "./price-list.js";
import { formatRussianCount } from "./equipment-changes.js";
import { XLSX_MIME } from "./xlsx.js";
import { invoiceWorkbook } from "./invoice-export.js";
import {
  invoiceActions,
  invoiceAmounts,
  invoiceFileName,
  invoiceHistorySteps,
  invoiceItemGroups,
  invoiceItemTypeLabel,
  invoiceItemsInOrder,
  invoiceLineAmount,
  invoiceLinesWithoutPrice,
  invoiceModifierLabel,
  invoicePreviewTotal,
  invoiceStatusLabel,
  invoiceStatusNote,
  invoiceStatusTone,
  parseInvoiceAdjustment,
  type InvoiceActionKind
} from "./invoice-card.js";

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const PRICE_MISSING_HINT = "Цены на дату работ не нашлось в прайсе";

/** Количество: часы работ бывают дробными, лишние нули в хвосте не нужны. */
function quantityText(quantity: number): string {
  return quantity.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
}

/** Таблица строк счёта. Гарантийные показываем так же, но их сумма — справочная. */
function InvoiceItemsTable({ items, guarantee = false }: { readonly items: readonly InvoiceItemApiRecord[]; readonly guarantee?: boolean }) {
  return <div className="table-scroll"><table className="data-table">
    <thead><tr>
      <th scope="col">Задача</th>
      <th scope="col">Позиция</th>
      <th className="numeric" scope="col">Количество</th>
      <th className="numeric" scope="col">Цена</th>
      <th className="numeric" scope="col">{guarantee ? "Сумма справочно" : "Сумма"}</th>
    </tr></thead>
    <tbody>{invoiceItemsInOrder(items).map((item) => {
      const modifier = invoiceModifierLabel(item.modifier);
      return <tr key={item.id}>
        <td>{item.taskNumber ?? <span className="is-empty">Без задачи</span>}</td>
        <td>
          <strong>{item.description}</strong>
          <small>{invoiceItemTypeLabel(item.itemType)}{modifier ? ` · ${modifier}` : ""}</small>
        </td>
        <td className="numeric">{quantityText(item.quantity)}</td>
        <td className="numeric">{item.unitPrice === 0
          ? <span className="is-empty" title={PRICE_MISSING_HINT}>Нет цены</span>
          : formatMoney(item.unitPrice)}</td>
        <td className="numeric">{guarantee
          ? <span className="muted">{formatMoney(invoiceLineAmount(item))}</span>
          : <strong>{formatMoney(invoiceLineAmount(item))}</strong>}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

/**
 * Карточка счёта: шапка, позиции, отдельно гарантийные строки, итог со строкой корректировки,
 * история статусов и действия по статусу. Кнопки показываются по праву `finance.write`,
 * а разрешает переходы база — интерфейс предлагает только те, что она примет.
 */
export function InvoiceCardPage({ invoiceId, invoiceNumber, onBack, onChanged }: {
  readonly invoiceId: string;
  readonly invoiceNumber?: string;
  readonly onBack: () => void;
  readonly onChanged?: () => void;
}) {
  const [card, setCard] = useState<InvoiceCardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirming, setConfirming] = useState<Exclude<InvoiceActionKind, "correct"> | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [adjustmentDraft, setAdjustmentDraft] = useState("");
  const [reasonDraft, setReasonDraft] = useState("");

  const reload = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setCard(await m2Api.invoiceCard(invoiceId));
    } catch (error) {
      setLoadError(message(error, "Не получилось открыть счёт"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    void m2Api.hasPermission("finance.write").then(setCanWrite).catch(() => setCanWrite(false));
  }, [invoiceId]);

  const invoice = card?.invoice;
  const number = invoice?.number ?? invoiceNumber ?? "";
  const status = invoice?.status ?? "";
  const items = card?.items ?? [];
  const groups = invoiceItemGroups(items);
  const amounts = invoiceAmounts(card ?? { items: [], subtotal: 0, adjustmentAmount: 0, totalAmount: 0 });
  const withoutPrice = invoiceLinesWithoutPrice(items);
  const steps = invoiceHistorySteps(card?.statusHistory ?? []);
  const actions = invoiceActions({ status, canWrite });
  const adjustment = parseInvoiceAdjustment(adjustmentDraft);

  // Счёт меняет только база, поэтому после каждого действия перечитываем карточку целиком.
  const apply = async (kind: Exclude<InvoiceActionKind, "correct">) => {
    if (kind === "issue") await m2Api.issueInvoice(invoiceId);
    if (kind === "transfer") await m2Api.transferInvoiceTo1c(invoiceId);
    if (kind === "rebuild") await m2Api.rebuildInvoiceItems(invoiceId);
    if (kind === "cancel") await m2Api.cancelInvoice(invoiceId);
    const done: Readonly<Record<string, string>> = {
      issue: `Счёт ${number} выставлен`,
      transfer: `Счёт ${number} передан в 1С`,
      rebuild: `Позиции счёта ${number} пересобраны по прайсу`,
      cancel: `Счёт ${number} отменён`
    };
    toast.success(done[kind] ?? "Готово");
    setConfirming(null);
    await reload();
    onChanged?.();
  };

  const correct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (adjustment === null) {
      setFormError("Укажите сумму корректировки числом со знаком: «−500» уменьшит счёт, «500» увеличит");
      return;
    }
    if (!reasonDraft.trim()) {
      setFormError("Напишите причину корректировки: она останется в счёте");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await m2Api.correctInvoice(invoiceId, adjustment, reasonDraft);
      toast.success(`Счёт ${number}: ${formatMoney(adjustment)}`, { title: "Корректировка сохранена" });
      setCorrecting(false);
      await reload();
      onChanged?.();
    } catch (error) {
      const text = message(error, "Не получилось скорректировать счёт");
      setFormError(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  };

  // Файл собираем так же, как отчёт по заявкам: строки даёт база, интерфейс складывает их в .xlsx.
  const exportFile = async () => {
    setExporting(true);
    try {
      const rows = await m2Api.invoiceExportRows(invoiceId);
      const url = URL.createObjectURL(new Blob([(await invoiceWorkbook(rows)) as BlobPart], { type: XLSX_MIME }));
      const link = document.createElement("a");
      link.href = url;
      link.download = invoiceFileName({ number });
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success(`В файле ${formatRussianCount(rows.length, ["строка", "строки", "строк"])}`, { title: `Счёт ${number} выгружен` });
    } catch (error) {
      toast.error(message(error, "Не получилось выгрузить счёт"), { title: "Файл не выгрузился" });
    } finally {
      setExporting(false);
    }
  };

  const openCorrection = () => {
    setFormError(null);
    setAdjustmentDraft(card && card.adjustmentAmount !== 0 ? String(card.adjustmentAmount).replace(".", ",") : "");
    setReasonDraft(card?.correctionReason ?? "");
    setCorrecting(true);
  };

  const start = (kind: InvoiceActionKind) => {
    if (kind === "correct") openCorrection();
    else setConfirming(kind);
  };

  const confirmations: Readonly<Record<Exclude<InvoiceActionKind, "correct">, {
    readonly title: string;
    readonly description: string;
    readonly confirmLabel: string;
    readonly cancelLabel?: string;
    readonly tone?: "danger" | "primary";
  }>> = {
    issue: {
      title: `Выставить счёт ${number}?`,
      description: "Счёт перейдёт в «Выставлен», дату выставления запишет база. Пересобрать позиции после этого уже нельзя.",
      confirmLabel: "Выставить",
      tone: "primary"
    },
    transfer: {
      title: `Передать счёт ${number} в 1С?`,
      description: "После передачи счёт не меняют: ни сумм, ни корректировок. Отменить его тоже будет нельзя.",
      confirmLabel: "Передать в 1С",
      tone: "primary"
    },
    rebuild: {
      title: `Пересобрать позиции счёта ${number}?`,
      description: "Позиции соберутся заново по задачам счёта и действующему прайсу. Нынешние строки заменятся, корректировка останется.",
      confirmLabel: "Пересобрать",
      tone: "primary"
    },
    cancel: {
      title: `Отменить счёт ${number}?`,
      description: "Счёт останется в списке со статусом «Отменён», его задачи можно будет выставить в новый счёт. Вернуть отменённый счёт в работу нельзя.",
      confirmLabel: "Отменить счёт",
      cancelLabel: "Не отменять"
    }
  };
  const confirmation = confirming ? confirmations[confirming] : null;

  if (loading && !card) {
    return <div className="equipment-card-view">
      <EntityDetailToolbar backLabel="К счетам" onBack={onBack} />
      <ResourceState description="Подождите, счёт сейчас откроется." status="loading" title={number ? `Загружаем счёт ${number}` : "Загружаем счёт"} />
    </div>;
  }

  if (loadError || !card || !invoice) {
    return <div className="equipment-card-view">
      <EntityDetailToolbar backLabel="К счетам" onBack={onBack} />
      <ResourceState description={loadError ?? "Счёт не загрузился"} onRetry={() => void reload()} status="error" title="Счёт не открылся" />
    </div>;
  }

  const requisites = invoice.payer.requisites ?? {};
  const inn = requisites.inn ?? "";
  const kpp = requisites.kpp ?? "";

  return <div className="equipment-card-view">
    <EntityDetailToolbar
      actions={<>
        <Button busy={exporting} disabled={items.length === 0} onClick={() => void exportFile()} variant="secondary">Выгрузить в Excel</Button>
        {actions.map((action) => <Button key={action.kind} onClick={() => start(action.kind)} variant={action.variant}>{action.label}</Button>)}
      </>}
      backLabel="К счетам"
      onBack={onBack}
    />
    <header className="task-head">
      <div className="task-head__meta">
        <span className="task-head__number">{number}</span>
        <StatusBadge tone={invoiceStatusTone(status)}>{invoiceStatusLabel(status)}</StatusBadge>
      </div>
      <h1>{invoice.payer.name || "Плательщик не указан"}</h1>
      <p>{[inn ? `ИНН ${inn}` : null, kpp ? `КПП ${kpp}` : null, invoiceStatusNote(status)].filter(Boolean).join(" · ")}</p>
    </header>
    <div className="task-layout">
      <div className="task-layout__main">
        <section aria-labelledby="invoice-items-title" className="task-section">
          <header className="task-section__head">
            <h3 id="invoice-items-title">Позиции счёта</h3>
            <span className="muted">{formatRussianCount(groups.billable.length, ["строка", "строки", "строк"])}</span>
          </header>
          {groups.billable.length === 0
            ? <ResourceState
              description={status === "draft"
                ? "Позиции заполняются при создании счёта: работа по задаче и установленные запчасти. Если их нет, счёт создан до обновления базы на сервере — после обновления нажмите «Пересобрать по прайсу»."
                : "В счёте нет строк, которые идут в сумму."}
              status="empty"
              title="Позиций пока нет"
            />
            : <>
              <InvoiceItemsTable items={groups.billable} />
              {withoutPrice.length > 0
                ? <p className="form-hint">Без цены {formatRussianCount(withoutPrice.length, ["строка", "строки", "строк"])}: её не нашлось в прайсе на дату работ. Задайте цену в прайсе и пересоберите черновик.</p>
                : null}
            </>}
        </section>
        {groups.guarantee.length > 0 ? <section aria-labelledby="invoice-guarantee-title" className="task-section">
          <header className="task-section__head">
            <h3 id="invoice-guarantee-title">По гарантии</h3>
            <span className="muted">в сумму счёта не входит</span>
          </header>
          <InvoiceItemsTable guarantee items={groups.guarantee} />
          <p className="form-hint">Эти работы сделаны по гарантии: в счёте они видны, но платить за них не нужно. Сумма показана справочно.</p>
        </section> : null}
        <section aria-labelledby="invoice-history-title" className="task-section">
          <header className="task-section__head"><h3 id="invoice-history-title">История статусов</h3></header>
          {steps.length === 0
            ? <div className="task-section__empty"><p>Записей пока нет. Здесь появятся все смены статуса счёта.</p></div>
            : <ol className="equipment-history-list">{steps.map((step, index) => <li className="task-history__item" key={`${step.status}-${step.at}-${index}`}>
              <span aria-hidden="true" className={`task-history__dot task-history__dot--${invoiceStatusTone(step.status)}`} />
              <div className="task-history__body">
                <div className="task-history__line">
                  <strong>{step.label}</strong>
                  <time dateTime={step.at}>{formatDisplayDateTime(step.at)}</time>
                </div>
                <span className="task-history__actor">{step.actorName ?? "Система"}</span>
              </div>
            </li>)}</ol>}
        </section>
      </div>
      <aside aria-label="Итог счёта" className="task-layout__aside">
        <section className="task-props">
          <header className="task-props__head"><h2>Итог</h2></header>
          <dl>
            <div><dt>Позиции</dt><dd>{formatMoney(amounts.subtotal)}</dd></div>
            <div><dt>Корректировка</dt><dd>
              {amounts.adjustment === 0 ? <span className="is-empty">Нет</span> : formatMoney(amounts.adjustment)}
              {card.correctionReason ? <small>{card.correctionReason}</small> : null}
            </dd></div>
            <div><dt>К оплате</dt><dd><strong>{formatMoney(amounts.total)}</strong></dd></div>
            {groups.guarantee.length > 0
              ? <div><dt>По гарантии</dt><dd>{formatMoney(amounts.guarantee)}<small>в счёт не входит</small></dd></div>
              : null}
          </dl>
          {amounts.matches ? null : <p className="form-hint">Сумма строк не сходится с суммой счёта из базы: обновите страницу.</p>}
          <dl>
            <div><dt>Создан</dt><dd>{formatDisplayDateTime(invoice.createdAt)}</dd></div>
            <div><dt>Выставлен</dt><dd>{invoice.issuedAt ? formatDisplayDateTime(invoice.issuedAt) : <span className="is-empty">Ещё нет</span>}</dd></div>
            <div><dt>Передан в 1С</dt><dd>{invoice.transferredAt ? formatDisplayDateTime(invoice.transferredAt) : <span className="is-empty">Ещё нет</span>}</dd></div>
            <div><dt>Задач в счёте</dt><dd>{invoice.taskIds.length === 0 ? <span className="is-empty">Нет</span> : String(invoice.taskIds.length)}</dd></div>
          </dl>
        </section>
      </aside>
    </div>

    <ConfirmationDialog
      cancelLabel={confirmation?.cancelLabel ?? "Отмена"}
      confirmLabel={confirmation?.confirmLabel ?? "Подтвердить"}
      description={confirmation?.description ?? null}
      onConfirm={async () => { if (confirming) await apply(confirming); }}
      onOpenChange={(open) => { if (!open) setConfirming(null); }}
      open={Boolean(confirming)}
      title={confirmation?.title ?? "Счёт"}
      tone={confirmation?.tone ?? "danger"}
    />

    <DialogForm
      busy={saving}
      description="Корректировка меняет итог счёта, а не его позиции. Причина останется в счёте и в истории."
      error={formError}
      onOpenChange={(open) => { if (!open) setCorrecting(false); }}
      onSubmit={correct}
      open={correcting}
      submitLabel="Сохранить корректировку"
      title={`Корректировка счёта ${number}`}
    >
      <div className="dialog-form-grid">
        <label>Сумма, ₽ *<input
          autoFocus
          inputMode="decimal"
          onChange={(event) => setAdjustmentDraft(event.target.value)}
          placeholder="−500,00"
          required
          value={adjustmentDraft}
        />
          <span className="form-hint">Со знаком: «−500» уменьшит счёт, «500» увеличит.</span>
        </label>
        <label className="dialog-form-grid__wide">Причина *<AutoTextarea
          maxLength={500}
          onChange={(event) => setReasonDraft(event.target.value)}
          placeholder="Например: скидка по договору"
          required
          rows={2}
          value={reasonDraft}
        /></label>
        <p className="form-hint dialog-form-grid__wide">
          {adjustment === null
            ? "Укажите сумму — и здесь появится новый итог счёта."
            : <>Было {formatMoney(amounts.total)} → станет <strong>{formatMoney(invoicePreviewTotal(amounts.subtotal, adjustment))}</strong>.
              {amounts.subtotal + adjustment < 0 ? " Ниже нуля итог не опускается." : ""}</>}
        </p>
      </div>
    </DialogForm>
  </div>;
}
