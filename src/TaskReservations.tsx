import React, { useEffect, useMemo, useState, type FormEvent } from "react";
import { m2Api, type InventoryPartRecord, type StockReservationRecord } from "./m2-api.js";
import type { TaskPartPosition } from "./types.js";

import { Button, ConfirmationDialog, DialogForm, ResourceState, Select, StatusBadge, toast } from "./ui.js";
import {
  RESERVATION_CONDITION_LABELS,
  RESERVATION_STATUS_LABELS,
  RESERVATION_STATUS_TONES,
  engineerReservationHint,
  lastReservationStep,
  reservationQuantityText,
  reservationStepText
} from "./reservations.js";

type PartCondition = TaskPartPosition["condition"];

const CONDITIONS: readonly PartCondition[] = ["G", "N", "B"];

/** Количество без лишнего нуля: «2 шт.», «1,5». */
export function partQuantityText(quantity: number): string {
  return Number.isInteger(quantity) ? `${quantity} шт.` : String(quantity).replace(".", ",");
}

/** Шаги резерва: последний всегда виден, остальные открываются по кнопке. */
export function ReservationSteps({ reservation }: { readonly reservation: StockReservationRecord }) {
  const [open, setOpen] = useState(false);
  const last = lastReservationStep(reservation);
  if (!last) return null;
  return <div className="reservation-steps">
    <small className="reservation-steps__last">{reservationStepText(last)}</small>
    {reservation.steps.length > 1 ? <button
      aria-expanded={open}
      className="text-button reservation-steps__toggle"
      onClick={() => setOpen((current) => !current)}
      type="button"
    >{open ? "Скрыть шаги" : `Все шаги · ${reservation.steps.length}`}</button> : null}
    {open ? <ol className="reservation-steps__list">
      {reservation.steps.map((step, index) => <li key={`${step.status}-${step.changedAt}-${index}`}>{reservationStepText(step)}</li>)}
    </ol> : null}
  </div>;
}

/**
 * Резервы со склада в карточке задачи: что заказано, на каком шаге и кто его сделал.
 * Кладовщик, координатор и руководитель (право warehouse.write) резервируют отсюда же.
 */
export function TaskReservationsSection({ taskId, taskInWork, reservations, loading, loadError, canWrite, onChanged }: {
  readonly taskId: string;
  /** Задача ещё в работе: по закрытой и отменённой резервировать нечего. */
  readonly taskInWork: boolean;
  readonly reservations: readonly StockReservationRecord[];
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly canWrite: boolean;
  readonly onChanged: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState<StockReservationRecord | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const cancelReservation = async (reservation: StockReservationRecord) => {
    setBusyId(reservation.id);
    try {
      await m2Api.cancelStockReservation(reservation.id);
      toast.success(`Резерв ${reservation.number} снят, запчасть снова доступна`);
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не получилось снять резерв");
    } finally {
      setBusyId(null);
    }
  };

  return <section aria-labelledby={`task-reservations-${taskId}`} className="task-section">
    <header className="task-section__head">
      <h3 id={`task-reservations-${taskId}`}>Резерв со склада</h3>
      {canWrite && taskInWork ? <div className="task-section__actions">
        <Button icon="plus" onClick={() => setAdding(true)}>Зарезервировать запчасть</Button>
      </div> : null}
    </header>
    {loadError ? <ResourceState description={loadError} status="error" title="Резервы не загрузились" />
      : loading && reservations.length === 0 ? <ResourceState description="Подождите, резервы сейчас появятся." status="loading" title="Загружаем резервы" />
      : reservations.length === 0 ? <div className="task-section__empty">
        <p>{canWrite && taskInWork ? "Запчасти со склада под задачу не резервировали. Нажмите «Зарезервировать запчасть», если они нужны на выезде." : "Запчасти со склада под задачу не резервировали."}</p>
      </div>
      : <ul className="task-reservations">{reservations.map((reservation) => {
        const canCancel = canWrite && (reservation.status === "created" || reservation.status === "warehouse_notified");
        return <li className="task-reservations__item" key={reservation.id}>
          <div className="task-reservations__main">
            <span className="task-reservations__number">{reservation.number}</span>
            <strong>{reservation.articleNumber}</strong>
            <span className="task-reservations__name">{reservation.partName}</span>
            <small>{partQuantityText(reservation.quantity)} · {RESERVATION_CONDITION_LABELS[reservation.condition]}</small>
          </div>
          <div className="task-reservations__state">
            <StatusBadge tone={RESERVATION_STATUS_TONES[reservation.status]}>{RESERVATION_STATUS_LABELS[reservation.status]}</StatusBadge>
            <ReservationSteps reservation={reservation} />
          </div>
          {canCancel ? <div className="task-reservations__actions">
            <Button busy={busyId === reservation.id} busyLabel="Снимаем…" className="button--compact" disabled={busyId !== null} onClick={() => setCancelling(reservation)} variant="ghost">Снять резерв</Button>
          </div> : null}
        </li>;
      })}</ul>}
    <ReserveTaskPartDialog
      onCreated={onChanged}
      onOpenChange={setAdding}
      open={adding}
      taskId={taskId}
    />
    <ConfirmationDialog
      confirmLabel="Снять резерв"
      description={cancelling ? <>Резерв {cancelling.number} снимется, запчасть {cancelling.articleNumber} снова станет доступна для других задач.</> : null}
      onConfirm={async () => { if (cancelling) await cancelReservation(cancelling); }}
      onOpenChange={(open) => { if (!open) setCancelling(null); }}
      open={Boolean(cancelling)}
      title="Снять резерв?"
      tone="danger"
    />
  </section>;
}

/** Окно «Зарезервировать запчасть»: поиск по складу, состояние и количество. */
function ReserveTaskPartDialog({ taskId, open, onOpenChange, onCreated }: {
  readonly taskId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: () => Promise<void>;
}) {
  const [parts, setParts] = useState<readonly InventoryPartRecord[]>([]);
  const [query, setQuery] = useState("");
  const [partId, setPartId] = useState("");
  const [condition, setCondition] = useState<PartCondition>("N");
  const [quantity, setQuantity] = useState("1");
  const [available, setAvailable] = useState<Readonly<Record<PartCondition, number>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(""); setPartId(""); setCondition("N"); setQuantity("1"); setAvailable(null); setFormError(null);
    void m2Api.inventoryParts(false)
      .then((items) => setParts(items.filter((item) => item.isActive)))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не получилось загрузить склад"));
  }, [open]);

  useEffect(() => {
    if (!partId) { setAvailable(null); return; }
    let cancelled = false;
    void m2Api.inventoryPartAvailability(partId)
      .then((totals) => { if (!cancelled) setAvailable(totals); })
      .catch(() => { if (!cancelled) setAvailable(null); });
    return () => { cancelled = true; };
  }, [partId]);

  const found = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ru-RU");
    const list = normalized
      ? parts.filter((part) => `${part.articleNumber} ${part.name}`.toLocaleLowerCase("ru-RU").includes(normalized))
      : parts;
    return [...list].sort((left, right) => left.name.localeCompare(right.name, "ru")).slice(0, 25);
  }, [parts, query]);
  const selected = parts.find((part) => part.id === partId);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = Number(quantity.replace(",", "."));
    if (!partId) { setFormError("Выберите запчасть со склада"); return; }
    if (!Number.isFinite(amount) || amount <= 0) { setFormError("Укажите количество больше нуля"); return; }
    setBusy(true);
    setFormError(null);
    try {
      const created = await m2Api.createTaskPartReservation(taskId, { partId, condition, quantity: amount });
      toast.success(`Резерв ${created.number}: ${selected?.articleNumber ?? "запчасть"} · ${partQuantityText(amount)}`);
      onOpenChange(false);
      await onCreated();
    } catch (error) {
      // Сообщения про остаток приходят из базы («На складе доступно 1 шт. …»): показываем как есть.
      const message = error instanceof Error ? error.message : "Не получилось зарезервировать запчасть";
      setFormError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return <DialogForm
    busy={busy}
    description="Склад соберёт запчасть и выдаст её инженеру задачи."
    error={formError}
    onOpenChange={onOpenChange}
    onSubmit={submit}
    open={open}
    size="lg"
    submitLabel="Зарезервировать"
    title="Зарезервировать запчасть"
  >
    <label className="field-wide">Поиск по складу
      <input
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Артикул или наименование"
        type="search"
        value={query}
      />
    </label>
    <div className="field-wide reserve-part-list" role="listbox" aria-label="Запчасти склада">
      {found.length === 0 ? <p className="muted">{parts.length === 0 ? "Склад пока пуст" : "По запросу ничего не найдено"}</p>
        : found.map((part) => <button
          aria-selected={part.id === partId}
          className={`reserve-part-option${part.id === partId ? " is-selected" : ""}`}
          key={part.id}
          onClick={() => setPartId(part.id)}
          role="option"
          type="button"
        >
          <span className="reserve-part-option__text"><strong>{part.name}</strong><small>{part.articleNumber}</small></span>
          <span className="reserve-part-option__stock">{part.availableQuantity > 0 ? `доступно ${part.availableQuantity}` : "нет на складе"}</span>
        </button>)}
    </div>
    <label>Состояние
      <Select onChange={(event) => setCondition(event.target.value as PartCondition)} value={condition}>
        {CONDITIONS.map((item) => <option key={item} value={item}>
          {RESERVATION_CONDITION_LABELS[item]}{available ? ` · доступно ${available[item]}` : ""}
        </option>)}
      </Select>
      {selected && available ? <span className="form-hint">{selected.articleNumber}: Г {available.G}, Н {available.N}, Б {available.B}</span> : null}
    </label>
    <label>Количество
      <input
        inputMode="decimal"
        min="0.001"
        onChange={(event) => setQuantity(event.target.value)}
        required
        step="0.001"
        type="number"
        value={quantity}
      />
    </label>
  </DialogForm>;
}

/** Инженеру на карточке: что забрать на складе и на каком шаге запчасть. */
export function EngineerPickupNote({ reservations }: { readonly reservations: readonly StockReservationRecord[] }) {
  const items = reservations.filter((item) => engineerReservationHint(item.status) !== undefined);
  if (items.length === 0) return null;
  return <section aria-label="Запчасти со склада" className="task-pickup">
    <h2>Получить на складе</h2>
    <ul className="task-pickup__list">{items.map((reservation) => <li key={reservation.id}>
      <strong>{reservation.articleNumber}</strong>
      <span>{reservation.partName}</span>
      <small>{reservationQuantityText(reservation)} · {engineerReservationHint(reservation.status)}</small>
    </li>)}</ul>
  </section>;
}

/**
 * Блок формы результата: выданные со склада запчасти с отметкой «Установлена».
 * Отметка живёт в самом резерве (install_marked), поэтому и галочка берётся оттуда.
 * Галочки уходят в setTaskPartsInstalled вместе с сохранением результата.
 */
export function ResultReservationChecks({ reservations, hasEquipment = true }: {
  readonly reservations: readonly StockReservationRecord[];
  /** Без прибора база отметку не примет: объясняем это сразу, а не ошибкой после сохранения. */
  readonly hasEquipment?: boolean;
}) {
  const issued = reservations.filter((item) => item.status === "issued");
  if (issued.length === 0) return null;
  if (!hasEquipment) return <fieldset className="field-wide result-checks result-parts"><legend>Запчасти со склада</legend>
    <p className="form-hint">У задачи не выбран прибор, поэтому отметить установку нельзя. Попросите координатора указать прибор.</p>
  </fieldset>;
  return <fieldset className="field-wide result-checks result-parts"><legend>Запчасти со склада</legend>
    <p className="form-hint">Отметьте, что из выданного встало на прибор. Неотмеченное останется за вами, пока склад не примет возврат.</p>
    {issued.map((reservation) => <label className="field-check result-parts__row" key={reservation.id}>
      <input
        defaultChecked={reservation.installMarked}
        name="installedReservation"
        type="checkbox"
        value={reservation.id}
      />
      <span className="result-parts__text">
        <strong>{reservation.articleNumber}</strong>
        <span>{reservation.partName}</span>
        <small>{reservation.number} · {partQuantityText(reservation.quantity)} · {RESERVATION_CONDITION_LABELS[reservation.condition]}</small>
      </span>
    </label>)}
  </fieldset>;
}
