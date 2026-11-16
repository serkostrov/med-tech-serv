import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { m2Api, type InventoryPartRecord, type PartAliasRecord, type StockMovementRecord } from "./m2-api.js";
import { Button, Dialog, IconButton, Notice, ResourceState, Select, StatusBadge, toast } from "./ui.js";
import { parseAmount } from "./price-list.js";
import { formatRussianCount } from "./equipment-changes.js";
import {
  MOVEMENT_LABELS,
  MOVEMENT_TONES,
  PART_CONDITIONS,
  PART_CONDITION_LABELS,
  PART_CONDITION_LETTERS,
  conditionWithMostStock,
  conditionsWithStock,
  movementDeltaText,
  movementQuantityText,
  movementTargetText,
  movementWhenText,
  type PartCondition
} from "./stock-movements.js";

/** Сколько движений читаем за раз: столько же, сколько отдаёт функция базы по умолчанию. */
const MOVEMENTS_PAGE = 100;

type CardForm = "receipt" | "writeoff" | "adjustment" | null;

const FORM_TITLES: Readonly<Record<Exclude<CardForm, null>, string>> = {
  receipt: "Приход",
  writeoff: "Списание",
  adjustment: "Корректировка остатка"
};

/** Количество из поля: запятая и пробелы как в цене, иначе null. */
function parseQuantity(value: string): number | null {
  const normalized = value.replace(/[\s ]/gu, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,3})?$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Карточка позиции склада: остатки по состояниям, артикулы поставщиков, история движений
 * и складские операции — приход, списание, корректировка после инвентаризации.
 *
 * Проверки повторяют базу (0049): количество больше нуля, причина обязательна, списать
 * больше доступного нельзя. Последнее слово всё равно за базой — её отказ показываем как есть.
 * Цену прихода карточка только отправляет: читать её складу нельзя (0040), поэтому в остатках
 * и в истории денег нет.
 */
export function InventoryPartCard({ part, canWrite, open, onOpenChange, onChanged }: {
  readonly part: InventoryPartRecord | null;
  readonly canWrite: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Остаток изменился: список склада и карточки над ним пересчитываются заново. */
  readonly onChanged: () => void | Promise<void>;
}) {
  const [aliases, setAliases] = useState<readonly PartAliasRecord[]>([]);
  const [aliasDraft, setAliasDraft] = useState("");
  const [aliasBusy, setAliasBusy] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [movements, setMovements] = useState<readonly StockMovementRecord[]>([]);
  const [movementsTotal, setMovementsTotal] = useState(0);
  const [movementsState, setMovementsState] = useState<"loading" | "ready" | "error">("loading");
  const [movementsError, setMovementsError] = useState<string | null>(null);
  const [form, setForm] = useState<CardForm>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Карточку могли закрыть и открыть на другой запчасти: ответ на прежний запрос не должен
  // подставить чужую историю.
  const loadTurn = useRef(0);
  const partId = part?.id ?? "";

  const loadMovements = async (offset = 0) => {
    const turn = ++loadTurn.current;
    if (offset === 0) setMovementsState("loading");
    try {
      const page = await m2Api.inventoryPartMovements(partId, MOVEMENTS_PAGE, offset);
      if (turn !== loadTurn.current) return;
      setMovements((current) => offset === 0 ? page.items : [...current, ...page.items]);
      setMovementsTotal(page.total);
      setMovementsState("ready");
      setMovementsError(null);
    } catch (error) {
      if (turn !== loadTurn.current) return;
      setMovementsState("error");
      setMovementsError(error instanceof Error ? error.message : "Не получилось загрузить историю движений");
    }
  };

  const loadAliases = async () => {
    try { setAliases(await m2Api.partAliases(partId)); }
    catch (error) { setAliasError(error instanceof Error ? error.message : "Не получилось загрузить псевдонимы"); }
  };

  useEffect(() => {
    if (!open || !partId) return;
    setForm(null); setFormError(null); setAliasError(null); setAliasDraft("");
    setMovements([]); setMovementsTotal(0);
    void loadMovements(0);
    void loadAliases();
  }, [open, partId]);

  if (!part) return null;

  const addAlias = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const alias = aliasDraft.trim();
    if (!alias) { setAliasError("Напишите артикул поставщика"); return; }
    setAliasBusy(true); setAliasError(null);
    try {
      await m2Api.addPartAlias(part.id, alias);
      setAliasDraft("");
      await loadAliases();
      // Псевдоним меняет поиск по складу: строка списка показывает артикулы поставщиков.
      await onChanged();
    } catch (error) {
      setAliasError(error instanceof Error ? error.message : "Не получилось добавить псевдоним");
    } finally {
      setAliasBusy(false);
    }
  };

  const removeAlias = async (alias: PartAliasRecord) => {
    setAliasBusy(true); setAliasError(null);
    try {
      await m2Api.removePartAlias(alias.id);
      await loadAliases();
      await onChanged();
    } catch (error) {
      setAliasError(error instanceof Error ? error.message : "Не получилось убрать псевдоним");
    } finally {
      setAliasBusy(false);
    }
  };

  const submitForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const condition = String(data.get("condition") ?? "N") as PartCondition;
    const quantity = parseQuantity(String(data.get("quantity") ?? ""));
    const reason = String(data.get("reason") ?? "").trim();
    if (quantity === null) {
      setFormError(form === "adjustment"
        ? "Укажите, сколько насчитали: число, например 6 или 2,5"
        : "Укажите количество числом больше нуля, например 2 или 2,5");
      return;
    }
    if (form !== "adjustment" && quantity <= 0) {
      setFormError("Количество должно быть больше нуля");
      return;
    }
    if (form !== "receipt" && !reason) {
      setFormError(form === "writeoff"
        ? "Укажите причину списания: брак, утеря, бой — она останется в истории позиции"
        : "Укажите причину корректировки: номер инвентаризации или что именно разошлось");
      return;
    }
    const priceDraft = String(data.get("unitPrice") ?? "").trim();
    const unitPrice = priceDraft ? parseAmount(priceDraft) : undefined;
    if (form === "receipt" && priceDraft && unitPrice === null) {
      setFormError("Укажите цену числом, например 1 500,50");
      return;
    }
    setSaving(true); setFormError(null);
    try {
      if (form === "receipt") {
        await m2Api.receiveInventoryPart({
          partId: part.id,
          quantity,
          condition,
          ...(unitPrice === null || unitPrice === undefined ? {} : { unitPrice }),
          ...(reason ? { comment: reason } : {})
        });
        toast.success(`Оприходовано: ${movementQuantityText(quantity)} · ${PART_CONDITION_LABELS[condition]}`);
      } else if (form === "writeoff") {
        const left = await m2Api.writeOffInventoryPart({ partId: part.id, condition, quantity, reason });
        toast.success(`Списано: ${movementQuantityText(quantity)} · ${PART_CONDITION_LABELS[condition]}. Осталось ${movementQuantityText(left)}`);
      } else {
        const left = await m2Api.adjustInventoryPart({ partId: part.id, condition, countedQuantity: quantity, reason });
        toast.success(`Остаток поправлен: ${PART_CONDITION_LABELS[condition]} · ${movementQuantityText(left)}`);
      }
      setForm(null);
      await Promise.all([loadMovements(0), onChanged()]);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Не получилось провести операцию";
      setFormError(text);
    } finally {
      setSaving(false);
    }
  };

  // Списывать можно только то, что на складе есть; корректировка нужна и по пустому состоянию.
  const formConditions = form === "writeoff" ? conditionsWithStock(part.onHandByCondition) : PART_CONDITIONS;
  // Готовое к выдаче состояние: списывают обычно оттуда, где запчасти есть и они не в резерве.
  const defaultCondition = conditionWithMostStock(form === "writeoff" ? part.availableByCondition : part.onHandByCondition);
  const shown = movements.length;
  return <Dialog
    busy={saving}
    description={`Остатки по состояниям, артикулы поставщиков и всё, что происходило с позицией.${part.isActive ? "" : " Позиция снята с учёта."}`}
    onOpenChange={onOpenChange}
    open={open}
    size="lg"
    title={`${part.articleNumber} · ${part.name}`}
  >
    <section className="part-card__section">
      <h3 className="part-card__heading">Остаток по состояниям</h3>
      <div className="part-card__conditions">
        {PART_CONDITIONS.map((condition) => <div className="part-card__condition" key={condition}>
          <span className="part-card__condition-letter">{PART_CONDITION_LETTERS[condition]}</span>
          <div>
            <strong>{movementQuantityText(part.onHandByCondition[condition])}</strong>
            <small>{PART_CONDITION_LABELS[condition]}{part.onHandByCondition[condition] !== part.availableByCondition[condition]
              ? ` · доступно ${movementQuantityText(part.availableByCondition[condition])}`
              : ""}</small>
          </div>
        </div>)}
      </div>
      <dl className="part-card__totals">
        <div><dt>Всего на складе</dt><dd>{movementQuantityText(part.onHandQuantity)}</dd></div>
        <div><dt>В резерве</dt><dd>{movementQuantityText(part.reservedQuantity)}</dd></div>
        <div><dt>У инженеров</dt><dd>{movementQuantityText(part.withEngineersQuantity)}</dd></div>
        <div><dt>Минимум</dt><dd>{part.minimumStock > 0 ? movementQuantityText(part.minimumStock) : "не задан"}</dd></div>
      </dl>
      {canWrite ? <div className="part-card__actions">
        <Button className="button--compact" disabled={!part.isActive} onClick={() => { setFormError(null); setForm(form === "receipt" ? null : "receipt"); }} variant={form === "receipt" ? "primary" : "secondary"}>Пополнить</Button>
        <Button className="button--compact" disabled={part.onHandQuantity <= 0} onClick={() => { setFormError(null); setForm(form === "writeoff" ? null : "writeoff"); }} variant={form === "writeoff" ? "primary" : "secondary"}>Списать</Button>
        <Button className="button--compact" onClick={() => { setFormError(null); setForm(form === "adjustment" ? null : "adjustment"); }} variant={form === "adjustment" ? "primary" : "secondary"}>Поправить остаток</Button>
      </div> : null}
      {/* key={form}: форма пересобирается при смене операции, иначе состояние осталось бы
          от прошлой — список состояний у списания и корректировки разный. */}
      {canWrite && form ? <form className="dialog-form part-card__form" key={form} onSubmit={(event) => void submitForm(event)}>
        <h4 className="part-card__heading">{FORM_TITLES[form]}</h4>
        {formError ? <div className="form-error" role="alert">{formError}</div> : null}
        {form === "adjustment" ? <Notice tone="info">Впишите, сколько запчастей этого состояния насчитали на полке. Разницу база проведёт встречным движением — прежние движения останутся как есть.</Notice> : null}
        <label>Состояние<Select defaultValue={formConditions.includes(defaultCondition) ? defaultCondition : formConditions[0] ?? "N"} name="condition">
          {formConditions.map((condition) => <option key={condition} value={condition}>
            {PART_CONDITION_LETTERS[condition]} · {PART_CONDITION_LABELS[condition]}
            {form === "writeoff" ? ` · доступно ${movementQuantityText(part.availableByCondition[condition])}` : ""}
            {form === "adjustment" ? ` · в учёте ${movementQuantityText(part.onHandByCondition[condition])}` : ""}
          </option>)}
        </Select></label>
        <label>{form === "adjustment" ? "Насчитали по факту *" : "Количество *"}<input
          autoFocus
          inputMode="decimal"
          name="quantity"
          placeholder={form === "adjustment" ? "Сколько лежит на полке" : "Сколько штук"}
          required
        /></label>
        {form === "receipt" ? <label>Цена за единицу<input inputMode="decimal" name="unitPrice" placeholder="Как в накладной" /><small>Из неё счёт берёт стоимость запчасти. Без цены запчасть попадёт в счёт нулём с пометкой.</small></label> : null}
        <label className="field-wide">{form === "receipt" ? "Комментарий" : "Причина *"}<input
          name="reason"
          placeholder={form === "receipt" ? "Накладная, поставщик — по желанию"
            : form === "writeoff" ? "Брак, утеря, бой при перевозке"
            : "Инвентаризация 11/2026, пересчёт полки"}
          {...(form === "receipt" ? {} : { required: true })}
        /></label>
        <div className="part-card__form-actions">
          <Button disabled={saving} onClick={() => { setForm(null); setFormError(null); }} variant="secondary">Отмена</Button>
          <Button busy={saving} busyLabel="Проводим…" type="submit">{form === "receipt" ? "Оприходовать" : form === "writeoff" ? "Списать" : "Поправить остаток"}</Button>
        </div>
      </form> : null}
    </section>

    <section className="part-card__section">
      <h3 className="part-card__heading">Артикулы поставщиков</h3>
      <p className="part-card__hint">У одной запчасти бывает свой артикул у каждого поставщика. Склад и резервы находят позицию по любому из них.</p>
      {aliasError ? <div className="form-error" role="alert">{aliasError}</div> : null}
      {aliases.length ? <ul className="tag-list part-card__aliases">
        {aliases.map((alias) => <li className="tag" key={alias.id}>
          {alias.alias}
          {canWrite ? <IconButton disabled={aliasBusy} icon="close" label={`Убрать псевдоним ${alias.alias}`} onClick={() => void removeAlias(alias)} /> : null}
        </li>)}
      </ul> : <p className="part-card__empty">Псевдонимов пока нет: позиция находится только по своему артикулу {part.articleNumber}.</p>}
      {canWrite ? <form className="part-card__alias-form" onSubmit={(event) => void addAlias(event)}>
        <label className="sr-only" htmlFor="part-card-alias">Артикул поставщика</label>
        <input
          id="part-card-alias"
          onChange={(event) => setAliasDraft(event.target.value)}
          placeholder="Артикул поставщика, например 12V20W-AU"
          value={aliasDraft}
        />
        <Button busy={aliasBusy} busyLabel="Сохраняем…" className="button--compact" disabled={!aliasDraft.trim()} type="submit" variant="secondary">Добавить</Button>
      </form> : null}
    </section>

    <section className="part-card__section">
      <h3 className="part-card__heading">История движений{movementsTotal ? <span className="part-card__count">{formatRussianCount(movementsTotal, ["движение", "движения", "движений"])}</span> : null}</h3>
      {movementsState === "loading" && shown === 0 ? <ResourceState description="Подождите, история сейчас появится." status="loading" title="Загружаем историю" />
        : movementsState === "error" ? <ResourceState description={movementsError ?? ""} onRetry={() => void loadMovements(0)} status="error" title="История не загрузилась" />
        : shown === 0 ? <ResourceState description="Как только запчасть оприходуют или выдадут, здесь появятся движения." status="empty" title="Движений по позиции пока нет" />
        : <>
          <div className="table-scroll">
            <table className="data-table part-card__movements">
              <thead><tr><th>Когда</th><th>Движение</th><th className="numeric">Количество</th><th className="numeric">Остаток</th><th>Причина и связи</th></tr></thead>
              <tbody>{movements.map((movement) => <tr key={movement.id}>
                <td data-label="Когда">{movementWhenText(movement)}</td>
                <td data-label="Движение">
                  <StatusBadge tone={MOVEMENT_TONES[movement.type]}>{MOVEMENT_LABELS[movement.type]}</StatusBadge>
                  <span className="part-card__movement-condition">{PART_CONDITION_LETTERS[movement.condition]} · {PART_CONDITION_LABELS[movement.condition]}</span>
                </td>
                <td className="numeric" data-label="Количество"><strong className={movement.delta < 0 ? "danger-text" : ""}>{movementDeltaText(movement.delta)}</strong>
                  {movement.delta === 0 ? <small>{movementQuantityText(movement.quantity)}</small> : null}
                </td>
                <td className="numeric" data-label="Остаток">{movementQuantityText(movement.onHandAfter)}</td>
                <td data-label="Причина и связи">
                  {movement.comment ? <span>{movement.comment}</span> : null}
                  {movementTargetText(movement) ? <small>{movementTargetText(movement)}</small> : null}
                  {!movement.comment && !movementTargetText(movement) ? "—" : null}
                </td>
              </tr>)}</tbody>
            </table>
          </div>
          {shown < movementsTotal ? <Button
            busy={movementsState === "loading"}
            busyLabel="Загружаем…"
            className="button--compact"
            onClick={() => void loadMovements(shown)}
            variant="secondary"
          >Показать ещё · {movementsTotal - shown}</Button> : null}
        </>}
    </section>
  </Dialog>;
}
