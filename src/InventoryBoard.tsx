import React from "react";
import type { InventoryPartRecord } from "./m2-api.js";
import { partQuantityText } from "./TaskReservations.js";
import { conditionTotalsText, conditionTotalsTitle } from "./stock-movements.js";

/** Колонки склада по тревожности запаса, слева направо. */
export type StockGroup = "out" | "below" | "low" | "normal";

export const STOCK_GROUPS: readonly { readonly id: StockGroup; readonly label: string; readonly hint: string }[] = [
  { id: "out", label: "Нет на складе", hint: "остатка нет совсем" },
  { id: "below", label: "Ниже минимума", hint: "доступно меньше минимума" },
  { id: "low", label: "Заканчивается", hint: "доступное близко к минимуму" },
  { id: "normal", label: "В норме", hint: "запаса хватает" }
];

/**
 * Запас «заканчивается», пока доступного не больше полутора минимумов: сверх минимума
 * остаётся ещё половина минимума. Порог взят с запасом на одну-две выдачи, чтобы позиция
 * попадала в колонку до того, как уйдёт ниже минимума.
 */
export const LOW_STOCK_FACTOR = 1.5;

/**
 * В какую колонку встаёт позиция. Сначала самое тревожное: пусто на складе, потом ниже
 * минимума, потом «заканчивается».
 *
 * Минимум не задан (0 или меньше) — сравнивать не с чем: такая позиция не попадает ни в
 * «ниже минимума», ни в «заканчивается». Либо «нет на складе», если остатка нет совсем,
 * либо «в норме». То же правило у признака below_minimum в базе: при нулевом минимуме он
 * всегда ложный.
 */
export function inventoryStockGroup(part: Pick<InventoryPartRecord, "onHandQuantity" | "availableQuantity" | "minimumStock" | "belowMinimum">): StockGroup {
  if (part.onHandQuantity <= 0) return "out";
  if (part.belowMinimum) return "below";
  if (part.minimumStock > 0 && part.availableQuantity <= part.minimumStock * LOW_STOCK_FACTOR) return "low";
  return "normal";
}

/**
 * Доска склада: позиции номенклатуры по состоянию запаса. Только смотреть: остаток
 * меняется приходом и выдачей, а не переносом карточки, поэтому карточки не перетаскиваются.
 */
export function InventoryBoard({ parts, loading, onOpen }: {
  readonly parts: readonly InventoryPartRecord[];
  readonly loading: boolean;
  /** Открыть карточку позиции: остатки по состояниям, артикулы поставщиков и история движений. */
  readonly onOpen?: (part: InventoryPartRecord) => void;
}) {
  return <div className="task-board inventory-board" aria-label="Доска склада">{STOCK_GROUPS.map((group) => {
    const cards = parts.filter((part) => inventoryStockGroup(part) === group.id);
    return <section className={`task-board__column task-board__column--stock-${group.id}`} key={group.id}>
      <header>
        <div><span className="task-board__title"><span aria-hidden="true" className="task-board__dot" />{group.label}</span><strong>{cards.length}</strong></div>
        <span>{group.hint}</span>
      </header>
      <div className="task-board__cards">
        {loading && cards.length === 0 ? <p className="task-board__empty">Загружаем склад…</p> : null}
        {cards.map((part) => <article className="task-board-card" key={part.id}>
          {/* Вся карточка — кнопка: по ней открывается позиция с историей движений. */}
          <button className="task-board-card__open" onClick={() => onOpen?.(part)} type="button">
            <span className="task-board-card__top">{part.articleNumber}{part.isActive ? null : <i>Неактивна</i>}</span>
            <strong>{part.name}</strong>
            {/* Единиц измерения в номенклатуре нет: целые считаем штуками, как в резервах и задачах. */}
            <dl>
              <div><dt>На складе</dt><dd>{partQuantityText(part.onHandQuantity)}</dd></div>
              {/* Резервируют и выдают в состоянии, поэтому Г, Н и Б видно сразу на карточке. */}
              <div><dt>Г · Н · Б</dt><dd title={conditionTotalsTitle(part.onHandByCondition)}>{conditionTotalsText(part.onHandByCondition)}</dd></div>
              {part.reservedQuantity > 0 ? <div><dt>В резерве</dt><dd>{partQuantityText(part.reservedQuantity)}</dd></div> : null}
              {part.reservedQuantity > 0 ? <div><dt>Доступно</dt><dd>{partQuantityText(part.availableQuantity)}</dd></div> : null}
              <div><dt>Минимум</dt><dd>{part.minimumStock > 0 ? partQuantityText(part.minimumStock) : "не задан"}</dd></div>
            </dl>
          </button>
        </article>)}
        {!loading && cards.length === 0 ? <p className="task-board__empty">Таких позиций нет.</p> : null}
      </div>
    </section>;
  })}</div>;
}
