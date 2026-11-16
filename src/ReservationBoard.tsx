import React, { useState, type DragEvent } from "react";
import type { StockReservationRecord, StockReservationStatus } from "./m2-api.js";
import { toast } from "./ui.js";
import {
  RESERVATION_BOARD_STATUSES,
  RESERVATION_STATUS_LABELS,
  reservationDropDecision,
  reservationQuantityText,
  reservationTaskNote,
  type ReservationAction
} from "./reservations.js";

/** «Иванов Пётр Алексеевич» → «ИП» для кружка на карточке. */
function initials(name: string): string {
  return name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

/** «Иванов Пётр Алексеевич» → «Иванов П. А.» */
function shortName(name: string): string {
  const [last, ...rest] = name.split(/\s+/u).filter(Boolean);
  return [last, ...rest.map((part) => `${part[0]}.`)].join(" ");
}

/**
 * Доска резервов: колонки по состояниям запчасти, карточки переносятся мышью.
 * Устроена как доска задач, только проще: резервы уже загружены целиком, догружать
 * колонки и запоминать места карточек не нужно.
 *
 * Перенос выполняет ровно то действие склада, что и кнопка в строке списка, поэтому
 * подтверждения («Выдать запчасть?», «Запчасть вернули на склад?») остаются те же:
 * карточка уезжает в новую колонку, только когда действие прошло и список перечитан.
 */
export function ReservationBoard({ items, canWrite, busyId, loading, onAction }: {
  readonly items: readonly StockReservationRecord[];
  /** Без права warehouse.write доска только показывает: карточки не перетаскиваются. */
  readonly canWrite: boolean;
  readonly busyId: string | null;
  readonly loading: boolean;
  readonly onAction: (reservation: StockReservationRecord, action: ReservationAction) => void;
}) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<StockReservationStatus | null>(null);
  const dragged = items.find((item) => item.id === draggedId);

  const finishDrag = () => { setDraggedId(null); setDropTarget(null); };

  const drop = (event: DragEvent<HTMLElement>, status: StockReservationStatus) => {
    event.preventDefault();
    const id = draggedId ?? event.dataTransfer.getData("text/plain");
    finishDrag();
    const reservation = items.find((item) => item.id === id);
    if (!reservation || busyId !== null) return;
    const decision = reservationDropDecision(reservation, status);
    // Бросили в ту же колонку: ничего не произошло, молчим.
    if (decision.kind === "no") { if (decision.reason) toast.warning(decision.reason, { title: `${reservation.number} остался в «${RESERVATION_STATUS_LABELS[reservation.status]}»` }); return; }
    onAction(reservation, decision.action);
  };

  return <div className="task-board reservation-board" aria-label="Доска резервов">{RESERVATION_BOARD_STATUSES.map((status) => {
    const cards = items.filter((item) => item.status === status);
    // Колонка не примет перетаскиваемую карточку: показываем её бледной, как на доске задач.
    const blocked = dragged !== undefined && dragged.status !== status && reservationDropDecision(dragged, status).kind === "no";
    return <section
      className={`task-board__column task-board__column--reservation-${status}${dropTarget === status && !blocked && dragged ? " task-board__column--drop" : ""}${blocked ? " task-board__column--blocked" : ""}`}
      key={status}
      onDragEnter={() => setDropTarget(status)}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && dropTarget === status) setDropTarget(null); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
      onDrop={(event) => drop(event, status)}
    >
      {/* Цвет точки берётся из колонки (--stage-color), отдельного класса по тону не нужно. */}
      <header><div><span className="task-board__title"><span aria-hidden="true" className="task-board__dot" />{RESERVATION_STATUS_LABELS[status]}</span><strong>{cards.length}</strong></div></header>
      <div className="task-board__cards">
        {loading && cards.length === 0 ? <p className="task-board__empty">Загружаем резервы…</p> : null}
        {cards.map((reservation) => {
          const note = reservationTaskNote(reservation);
          const engineer = reservation.issuedToName ?? reservation.engineerName;
          return <article
            aria-busy={busyId === reservation.id}
            className={`task-board-card${draggedId === reservation.id ? " task-board-card--dragging" : ""}`}
            data-board-card={reservation.id}
            draggable={canWrite && busyId === null}
            key={reservation.id}
            onDragEnd={finishDrag}
            onDragStart={(event) => { setDraggedId(reservation.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", reservation.id); }}
          >
            <div className="task-board-card__open">
              <span className="task-board-card__top">{reservation.number}{note ? <i>{note}</i> : null}</span>
              <strong>{reservation.articleNumber}</strong>
              <small>{reservation.partName} · {reservationQuantityText(reservation)}</small>
              <span className="task-board-card__foot">
                {engineer
                  ? <><span aria-hidden="true" className="task-board-card__ava">{initials(engineer)}</span><span className="task-board-card__eng" title={engineer}>{shortName(engineer)}</span></>
                  : <><span aria-hidden="true" className="task-board-card__ava task-board-card__ava--none">?</span><span className="task-board-card__eng task-board-card__eng--none">Инженер не назначен</span></>}
                {reservation.taskNumber ? <span className="task-board-card__due">{reservation.taskNumber}</span> : null}
              </span>
            </div>
          </article>;
        })}
        {!loading && cards.length === 0 ? <p className="task-board__empty">В этом состоянии резервов нет.</p> : null}
      </div>
    </section>;
  })}</div>;
}
