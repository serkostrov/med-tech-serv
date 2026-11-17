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
  canExportInvoice,
  invoiceCardActions,
  invoiceAmounts,
  invoiceFileName,
  invoiceHistorySteps,
  invoiceItemGroups,
  invoiceItemTypeLabel,
  invoiceItemsInOrder,
  invoiceLineAmount,
  invoiceLineSource,
  invoiceLinesWithoutPrice,
  invoiceAdjustmentProblem,
  invoiceMissingPriceHint,
  invoiceZeroPriceWarning,
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

/** Количество: часы работ бывают дробными, лишние нули в хвосте не нужны. */
function quantityText(quantity: number): string {
  return quantity.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
}

/** Таблица строк счёта. Гарантийные показываем так же, но их сумма — справочная. */
function InvoiceItemsTable({ items, guarantee = false }: { readonly items: readonly InvoiceItemApiRecord[]; readonly guarantee?: boolean }) {
  return <div className="table-scroll table-cards"><table className="data-table">
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
        <td data-label="Задача">{item.taskNumber ?? <span className="is-empty">Без задачи</span>}</td>
        <td className="cell-wide" data-label="Позиция">
          <strong>{item.description}</strong>
          <small>{invoiceItemTypeLabel(item.itemType)}{modifier ? ` · ${modifier}` : ""}</small>
        </td>
        <td className="numeric" data-label="Количество">{quantityText(item.quantity)}</td>
        <td className="numeric" data-label="Цена">{item.unitPrice === 0
          ? <span className="is-empty">Нет цены</span>
          : formatMoney(item.unitPrice)}
          <small className="invoice-line__source">{invoiceLineSource(item)}</small></td>
        <td className="numeric" data-label={guarantee ? "Сумма справочно" : "Сумма"}>{guarantee
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
  // Гарантийные строки в сумму не идут: их «нет цены» клиенту ничего не стоит.
  const withoutPrice = invoiceLinesWithoutPrice(groups.billable);
  const zeroPriceWarning = invoiceZeroPriceWarning(withoutPrice);
  const steps = invoiceHistorySteps(card?.statusHistory ?? []);
  const actions = invoiceCardActions({ status, canWrite });
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
      rebuild: `Строки счёта ${number} обновлены по прайсу`,
      cancel: `Счёт ${number} отменён`
    };
    toast.success(done[kind] ?? "Готово");
    setConfirming(null);
    await reload();
    onChanged?.();
  };

  const correct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = invoiceAdjustmentProblem({
      subtotal: amounts.subtotal,
      currentAdjustment: amounts.adjustment,
      currentReason: card?.correctionReason ?? "",
      next: adjustment,
      reason: reasonDraft
    });
    if (problem || adjustment === null) {
      setFormError(problem || "Укажите сумму числом со знаком");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await m2Api.correctInvoice(invoiceId, adjustment, reasonDraft);
      toast.success(adjustment === 0 ? `Счёт ${number}: скидки и надбавки больше нет` : `Счёт ${number}: ${formatMoney(adjustment)}`, { title: "Корректировка сохранена" });
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
    // Причину каждый раз пишут новую: база не примет ту же самую второй раз (0040).
    setReasonDraft("");
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
    issue: zeroPriceWarning ? {
      title: `Выставить счёт ${number} со строкой без цены?`,
      description: `${zeroPriceWarning} Лучше сначала задать цену и нажать «Обновить по прайсу»: после выставления строки не пересобираются.`,
      confirmLabel: "Выставить без цены",
      cancelLabel: "Не выставлять"
    } : {
      title: `Выставить счёт ${number}?`,
      description: "Счёт перейдёт в «Выставлен», дату выставления запишет база. Пересобрать позиции после этого уже нельзя.",
      confirmLabel: "Выставить",
      tone: "primary"
    },
    transfer: zeroPriceWarning ? {
      title: `Передать в 1С счёт ${number} со строкой без цены?`,
      description: `${zeroPriceWarning} После передачи счёт не поменять и не отменить.`,
      confirmLabel: "Передать без цены",
      cancelLabel: "Не передавать"
    } : {
      title: `Передать счёт ${number} в 1С?`,
      description: "После передачи счёт не меняют: ни сумм, ни корректировок. Отменить его тоже будет нельзя.",
      confirmLabel: "Передать в 1С",
      tone: "primary"
    },
    rebuild: {
      title: `Обновить строки счёта ${number} по прайсу?`,
      description: "Строки соберутся заново: работы — по прайсу на день работ, запчасти — по цене прихода. Нужно, если поменяли цену в прайсе или результат задачи. Скидка останется.",
      confirmLabel: "Обновить",
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
      actions={<Button busy={exporting} disabled={!canExportInvoice({ itemCount: items.length })} onClick={() => void exportFile()} variant="secondary">Выгрузить в Excel</Button>}
      backLabel="К счетам"
      onBack={onBack}
    />
    <header className="task-head">
      <div className="task-head__meta">
        <span className="task-head__number">{number}</span>
        <StatusBadge tone={invoiceStatusTone(status)}>{invoiceStatusLabel(status)}</StatusBadge>
      </div>
      <h1>{invoice.payer.name || "Плательщик не указан"}</h1>
      <p>{[inn ? `ИНН ${inn}` : null, kpp ? `КПП ${kpp}` : null, actions.next ? null : invoiceStatusNote(status)].filter(Boolean).join(" · ")}</p>
    </header>
    {actions.next ? <section aria-label="Следующий шаг" className="task-next-step">
      <div className="task-next-step__text"><strong>{actions.next.title}</strong><span>{actions.next.hint}</span></div>
      <div className="task-next-step__actions">
        <Button onClick={() => start(actions.next!.kind)}>{actions.next.label}</Button>
      </div>
    </section> : null}
    <div className="task-layout">
      <div className="task-layout__main">
        <section aria-labelledby="invoice-items-title" className="task-section">
          <header className="task-section__head">
            <h3 id="invoice-items-title">Позиции счёта</h3>
            <div className="task-section__actions">
              <span className="muted">{formatRussianCount(groups.billable.length, ["строка", "строки", "строк"])}</span>
              {actions.canRebuild ? <Button className="button--compact" onClick={() => start("rebuild")} variant="secondary">Обновить по прайсу</Button> : null}
            </div>
          </header>
          {groups.billable.length === 0
            ? <ResourceState
              description={groups.guarantee.length > 0
                ? "Все работы этого счёта гарантийные: они ниже, в блоке «По гарантии», и в сумму не входят."
                : status === "draft"
                  ? "Строки собираются из задач счёта: работы по прайсу и установленные запчасти. Если строк нет, нажмите «Обновить по прайсу» — они соберутся заново."
                  : "В счёте нет строк, которые идут в сумму."}
              status="empty"
              title={groups.guarantee.length > 0 ? "Платных позиций нет" : "Позиций пока нет"}
            />
            : <>
              <InvoiceItemsTable items={groups.billable} />
              {withoutPrice.length > 0
                ? <p className="form-hint">{invoiceMissingPriceHint(withoutPrice, status === "draft")}</p>
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
            <div><dt>Скидка или надбавка</dt><dd>
              {amounts.adjustment === 0 ? <span className="is-empty">Нет</span> : formatMoney(amounts.adjustment)}
              {card.correctionReason ? <small>{card.correctionReason}</small> : null}
              {actions.canCorrect ? <button className="link-button invoice-correct-link" onClick={() => start("correct")} type="button">{amounts.adjustment === 0 ? "Добавить" : "Изменить"}</button> : null}
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
          {actions.canCancel ? <button className="task-props__cancel" onClick={() => start("cancel")} type="button">Отменить счёт</button> : null}
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
      description="Скидка или надбавка меняет итог счёта, а не его строки. Причина останется в счёте и в истории."
      error={formError}
      onOpenChange={(open) => { if (!open) setCorrecting(false); }}
      onSubmit={correct}
      open={correcting}
      submitLabel="Сохранить"
      title={`Скидка или надбавка · ${number}`}
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
          <span className="form-hint">Со знаком: «−500» уменьшит счёт, «500» увеличит{amounts.adjustment !== 0 ? ", «0» уберёт" : ""}.</span>
          {amounts.adjustment !== 0
            ? <button className="link-button" onClick={() => setAdjustmentDraft("0")} type="button">Убрать скидку или надбавку</button>
            : null}
        </label>
        <label className="dialog-form-grid__wide">Причина *<AutoTextarea
          maxLength={500}
          onChange={(event) => setReasonDraft(event.target.value)}
          placeholder={amounts.adjustment !== 0 && adjustment === 0 ? "Например: скидка поставлена по ошибке" : "Например: скидка по договору"}
          required
          rows={2}
          value={reasonDraft}
        />{card?.correctionReason ? <span className="form-hint">Прошлая причина: «{card.correctionReason}». Напишите новую — каждая корректировка остаётся в счёте со своей причиной.</span> : null}</label>
        <p className="form-hint dialog-form-grid__wide">
          {adjustment === null
            ? "Укажите сумму — и здесь появится новый итог счёта."
            : amounts.subtotal + adjustment < 0
              ? <>Скидка больше суммы позиций {formatMoney(amounts.subtotal)}: так нельзя, итог не может быть меньше нуля.</>
              : <>Было {formatMoney(amounts.total)} → станет <strong>{formatMoney(invoicePreviewTotal(amounts.subtotal, adjustment))}</strong>.
                {adjustment > 0 && amounts.subtotal > 0 && adjustment > amounts.subtotal ? " Надбавка больше суммы позиций — проверьте сумму." : ""}</>}
        </p>
      </div>
    </DialogForm>
  </div>;
}
