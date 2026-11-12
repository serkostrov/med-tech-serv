import React, { useState } from "react";
import type { TaskCardResponse } from "./m2-api.js";
import { AutoTextarea, Button, StatusBadge } from "./ui.js";
import { formatDisplayDate } from "./date-format.js";

/** Вкладка карточки задачи, куда ведёт пункт сводки. */
export type ClosureReviewSection = "work" | "parts";

/**
 * Решение по задаче на проверке: кто и когда сдал работу, «На доработку» и «Проверено — закрыть».
 * Сами материалы (результат, фото акта, фото с выезда, запчасти) показаны один раз ниже,
 * во вкладках карточки. Здесь только сводка, что приложено, и переход к нужной вкладке.
 */
export function ClosureReview({ card, busy, canClose, canReturn, onClose, onReturn, onShow }: {
  readonly card: TaskCardResponse;
  readonly busy: boolean;
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
  const media = card.files.filter((file) => file.kind === "photo" || file.kind === "video").length;
  const summary: readonly { readonly label: string; readonly section: ClosureReviewSection; readonly missing?: boolean }[] = [
    { label: hasAct ? "Фото акта загружено" : "Фото акта не загружено", section: "work", missing: !hasAct },
    { label: media ? `Фото и видео с выезда: ${media}` : "Фото с выезда нет", section: "work" },
    { label: card.parts.length ? `Запчасти: ${card.parts.length}` : "Запчасти не использовались", section: "parts" }
  ];

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
      </div>
      <div className="closure-review__buttons">
        <Button disabled={busy || !canReturn} onClick={() => setReworkOpen((open) => !open)} variant="secondary">На доработку</Button>
        <button className="button button--success" disabled={busy || !canClose} onClick={() => void onClose()} type="button">Проверено — закрыть</button>
      </div>
    </header>

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
