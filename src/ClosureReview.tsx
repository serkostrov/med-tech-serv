import React, { useState } from "react";
import type { StockReservationRecord, TaskCardResponse } from "./m2-api.js";
import { AutoTextarea, Button, StatusBadge } from "./ui.js";
import { formatDisplayDate } from "./date-format.js";
import { RESERVATION_CONDITION_LABELS } from "./reservations.js";
import { partQuantityText } from "./TaskReservations.js";

/** Вкладка карточки задачи, куда ведёт пункт сводки. */
export type ClosureReviewSection = "work" | "parts";

/** Сколько фото с выезда нужно для закрытия (п. 3.3 ТЗ: 3–5 фото, до 10). Ту же границу проверяет база. */
export const MIN_CLOSURE_PHOTOS = 3;

/**
 * Почему задачу пока нельзя закрыть: база отклонит закрытие без фото акта и без трёх фото с выезда.
 * Пустой список: закрыть можно.
 */
export function closureBlockers(card: Pick<TaskCardResponse, "files" | "closure">): readonly string[] {
  const blockers: string[] = [];
  const hasAct = card.files.some((file) => file.id === card.closure?.actFileId || file.kind === "act");
  if (!hasAct) blockers.push("нет фото акта");
  const photos = card.files.filter((file) => file.kind === "photo").length;
  if (photos < MIN_CLOSURE_PHOTOS) blockers.push(`фото с выезда ${photos} из ${MIN_CLOSURE_PHOTOS} обязательных`);
  return blockers;
}

/**
 * Пункты акта, которые инженер не отметил. Закрыть всё равно можно: честный акт бывает и таким
 * («претензии есть», «аппарат не допущен»), координатор решает сам. Поэтому только предупреждение.
 */
export function uncheckedActMarks(card: Pick<TaskCardResponse, "closure" | "task">): readonly string[] {
  const { task, closure } = card;
  const checks: readonly [boolean | undefined, string][] = [
    [task.workCompleted ?? closure?.workCompleted, "работы выполнены полностью"],
    [task.apparatusApproved ?? closure?.apparatusApproved, "аппарат исправен и допущен"],
    [task.customerHasNoClaims ?? closure?.customerHasNoClaims, "претензий нет"]
  ];
  return checks.filter(([value]) => value !== true).map(([, label]) => label);
}

/**
 * Решение по задаче на проверке: кто и когда сдал работу, «На доработку» и «Проверено — закрыть».
 * Сами материалы (результат, фото акта, фото с выезда, запчасти) показаны один раз ниже,
 * во вкладках карточки. Здесь только сводка, что приложено, и переход к нужной вкладке.
 */
/**
 * Выданные со склада запчасти, которые инженер не отметил установленными. Закрывать задачу
 * это не мешает: они останутся за инженером, пока склад не примет возврат.
 */
export function unmarkedIssuedParts(
  card: Pick<TaskCardResponse, "parts">,
  reservations: readonly StockReservationRecord[]
): readonly StockReservationRecord[] {
  return reservations.filter((item) => item.status === "issued"
    && !card.parts.some((part) => part.reservationId === item.id && part.installed === true));
}

export function ClosureReview({ card, busy, canClose, canReturn, onClose, onReturn, onShow, reservations = [] }: {
  readonly card: TaskCardResponse;
  readonly busy: boolean;
  /** Резервы задачи: по ним видно, что выдали, но не отметили установленным. */
  readonly reservations?: readonly StockReservationRecord[];
  readonly canClose: boolean;
  readonly canReturn: boolean;
  readonly onClose: () => Promise<void>;
  readonly onReturn: (comment: string) => Promise<void>;
  /** Открыть вкладку с материалами («Работа и акт» или «Запчасти»). */
  readonly onShow?: (section: ClosureReviewSection) => void;
}) {
  const [reworkOpen, setReworkOpen] = useState(false);
  const [reworkComment, setReworkComment] = useState("");
  const { task, closure } = card;
  // Кто и когда передал работу на проверку: последняя смена этапа на «На проверке» из истории.
  // Запись акта обновляется только при сохранении результата, поэтому после доработки
  // её время осталось бы от первой сдачи.
  const handIn = card.journal
    .filter((entry) => entry.toStatus === "under_review")
    .reduce<(typeof card.journal)[number] | undefined>((latest, entry) => !latest || Date.parse(entry.occurredAt) > Date.parse(latest.occurredAt) ? entry : latest, undefined);
  const submitter = handIn?.actorName ?? closure?.submittedByName ?? card.engineer?.fullName ?? "Инженер";
  const submittedAt = handIn?.occurredAt ?? closure?.submittedAt;
  const hasAct = card.files.some((file) => file.id === closure?.actFileId || file.kind === "act");
  const photos = card.files.filter((file) => file.kind === "photo").length;
  const videos = card.files.filter((file) => file.kind === "video").length;
  const summary: readonly { readonly label: string; readonly section: ClosureReviewSection; readonly missing?: boolean }[] = [
    { label: hasAct ? "Фото акта загружено" : "Фото акта не загружено", section: "work", missing: !hasAct },
    {
      label: photos >= MIN_CLOSURE_PHOTOS
        ? `Фото с выезда: ${photos}${videos ? `, видео: ${videos}` : ""}`
        : `Фото с выезда: ${photos} из ${MIN_CLOSURE_PHOTOS} обязательных${videos ? `, видео: ${videos}` : ""}`,
      section: "work",
      missing: photos < MIN_CLOSURE_PHOTOS
    },
    { label: card.parts.length ? `Запчасти: ${card.parts.length}` : "Запчасти не использовались", section: "parts" }
  ];
  const installed = card.parts.filter((part) => part.installed === true);
  const unmarked = unmarkedIssuedParts(card, reservations);
  // Закрыть нельзя, пока не хватает того, что проверяет база: объясняем сразу, а не ошибкой после нажатия.
  const blockers = closureBlockers(card);
  const unchecked = uncheckedActMarks(card);

  return <section aria-labelledby="closure-review-title" className="closure-review">
    <header className="closure-review__header">
      <div>
        <h2 id="closure-review-title">Проверка закрытия <StatusBadge tone="info">На проверке</StatusBadge></h2>
        <p>
          {submitter} передал работу на проверку
          {submittedAt ? ` ${formatDisplayDate(submittedAt, true)}` : ""}. Сверьте результат, фото акта и запчасти ниже и примите решение.
        </p>
        <ul aria-label="Что приложено к работе" className="closure-review__summary">
          {summary.map((item) => <li className={item.missing ? "closure-review__summary-item--missing" : undefined} key={item.label}>
            {onShow ? <button className="text-button" onClick={() => onShow(item.section)} type="button">{item.label}</button> : item.label}
          </li>)}
        </ul>
        {installed.length ? <ul aria-label="Установленные запчасти" className="closure-review__parts">
          {installed.map((part) => <li key={part.id}>
            <strong>{part.articleNumber}</strong> {part.name} · {partQuantityText(part.quantity)} · {RESERVATION_CONDITION_LABELS[part.condition]}
            {part.reservationNumber ? <small>{part.reservationNumber}</small> : null}
          </li>)}
        </ul> : null}
      </div>
      <div className="closure-review__buttons">
        <Button disabled={busy || !canReturn} onClick={() => setReworkOpen((open) => !open)} variant="secondary">На доработку</Button>
        <button className="button button--success" disabled={busy || !canClose || blockers.length > 0} onClick={() => void onClose()} title={blockers.length ? `Закрыть пока нельзя: ${blockers.join("; ")}` : undefined} type="button">Проверено — закрыть</button>
      </div>
    </header>
    {canClose && blockers.length ? <p className="closure-review__blocked" role="note">
      Закрыть пока нельзя: {blockers.join("; ")}. Догрузите недостающее во вкладке «Работа и акт» или верните задачу на доработку и напишите инженеру, что добавить.
    </p> : null}
    {unmarked.length ? <p className="closure-review__note" role="note">
      Выдано, но не отмечено установленным: {unmarked.length}. Останется за инженером, пока склад не примет возврат.
    </p> : null}
    {canClose && !blockers.length && unchecked.length ? <p className="closure-review__note" role="note">
      В акте не отмечено: {unchecked.join(", ")}. Проверьте, что это так и задумано, прежде чем закрывать.
    </p> : null}

    {reworkOpen ? <div className="closure-review__rework">
      <label htmlFor={`rework-comment-${task.id}`}>Что исправить инженеру</label>
      <AutoTextarea autoFocus id={`rework-comment-${task.id}`} maxLength={2000} onChange={(event) => setReworkComment(event.target.value)} placeholder="Например: нет фото шильдика, уточните показание счётчика" rows={3} value={reworkComment} />
      <p>Комментарий попадёт в историю задачи и в уведомление инженеру.</p>
      <div className="closure-review__rework-actions">
        <Button onClick={() => { setReworkOpen(false); setReworkComment(""); }} variant="ghost">Отмена</Button>
        <Button busy={busy} busyLabel="Отправляем…" disabled={!reworkComment.trim()} onClick={() => void onReturn(reworkComment.trim())}>Вернуть на доработку</Button>
      </div>
    </div> : null}
  </section>;
}
