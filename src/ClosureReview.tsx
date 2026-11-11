import React, { useState } from "react";
import type { TaskCardResponse } from "./m2-api.js";
import { Button, StatusBadge } from "./ui.js";
import { formatDisplayDate } from "./date-format.js";
import { FileGallery } from "./FileGallery.js";

function reviewValue(primary: string | undefined, closure: string | undefined): string {
  return primary ?? closure ?? "Не заполнено";
}

function yesNo(value: boolean | undefined): string {
  return value === undefined ? "Не заполнено" : value ? "Да" : "Нет";
}

export function ClosureReview({ card, busy, canClose, canReturn, onOpenAct, onClose, onReturn }: {
  readonly card: TaskCardResponse;
  readonly busy: boolean;
  readonly canClose: boolean;
  readonly canReturn: boolean;
  readonly onOpenAct: () => void;
  readonly onClose: () => Promise<void>;
  readonly onReturn: (comment: string) => Promise<void>;
}) {
  const [reworkOpen, setReworkOpen] = useState(false);
  const [reworkComment, setReworkComment] = useState("");
  const { task, closure } = card;
  // Текущее фото акта: записанное в закрытии, иначе последнее загруженное (после «Заменить»).
  const actFile = card.files.find((file) => file.id === closure?.actFileId) ?? [...card.files].reverse().find((file) => file.kind === "act");
  const attachments = card.files.filter((file) => file.id !== actFile?.id);
  const meterReading = task.meterReading ?? closure?.meterReading;
  const workModifier = task.workModifier ?? closure?.workModifier;
  const hours = task.hours ?? closure?.hours;
  const texts: readonly (readonly [string, string])[] = [
    ["Причина неисправности", card.reason?.name ?? "Не заполнено"],
    ["Причина вызова", reviewValue(task.callReason, closure?.callReason)],
    ["Описание работ", reviewValue(task.workDescription, closure?.workDescription)],
    ["Рекомендации", reviewValue(task.recommendations, closure?.recommendations)],
    ["Замечания пользователя", reviewValue(task.userRemarks, closure?.userRemarks)],
    ["Вид работ", `${card.workType?.name ?? "Не заполнено"}${workModifier ? ` · ${workModifier === "G" ? "Г, гарантия" : "Н, неправильная эксплуатация"}` : ""}`],
    ["Часы", hours === undefined ? "Не применимо" : String(hours)],
    ["Показание счётчика", meterReading === undefined ? "Не заполнено" : String(meterReading)]
  ];
  const flags: readonly (readonly [string, boolean | undefined])[] = [
    ["Работы выполнены полностью", task.workCompleted ?? closure?.workCompleted],
    ["Аппарат исправен и допущен", task.apparatusApproved ?? closure?.apparatusApproved],
    ["Заказчик претензий не имеет", task.customerHasNoClaims ?? closure?.customerHasNoClaims],
    ["Продолжение первичной заявки", task.continuedInPrimary ?? closure?.continuedInPrimary]
  ];

  return <section aria-labelledby="closure-review-title" className="closure-review">
    <header className="closure-review__header">
      <div>
        <h2 id="closure-review-title">Проверка закрытия <StatusBadge tone="info">На проверке</StatusBadge></h2>
        <p>
          {closure?.submittedByName ?? card.engineer?.fullName ?? "Инженер"} передал работу на проверку
          {closure?.submittedAt ? ` ${formatDisplayDate(closure.submittedAt, true)}` : ""}. Сверьте акт, фото и результат.
        </p>
      </div>
      <div className="closure-review__buttons">
        <Button disabled={busy || !canReturn} onClick={() => setReworkOpen((open) => !open)} variant="secondary">На доработку</Button>
        <button className="button button--success" disabled={busy || !canClose} onClick={() => void onClose()} type="button">Проверено — закрыть</button>
      </div>
    </header>

    {reworkOpen ? <div className="closure-review__rework">
      <label htmlFor={`rework-comment-${task.id}`}>Что исправить инженеру</label>
      <textarea autoFocus id={`rework-comment-${task.id}`} maxLength={2000} onChange={(event) => setReworkComment(event.target.value)} placeholder="Например: нет фото шильдика, уточните показание счётчика" rows={3} value={reworkComment} />
      <p>Комментарий попадёт в историю задачи и в уведомление инженеру.</p>
      <div className="closure-review__rework-actions">
        <Button onClick={() => { setReworkOpen(false); setReworkComment(""); }} variant="ghost">Отмена</Button>
        <Button busy={busy} busyLabel="Отправляем…" disabled={!reworkComment.trim()} onClick={() => void onReturn(reworkComment.trim())}>Вернуть на доработку</Button>
      </div>
    </div> : null}

    <div className="closure-review__grid">
      <section className="card closure-review__result">
        <div className="card-header"><div><h3>Результат работ</h3><p>Из сервисного акта</p></div></div>
        <dl className="closure-review__fields">
          {texts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <ul className="closure-review__flags">
          {flags.map(([label, value]) => <li key={label}><span>{label}</span><StatusBadge tone={value === undefined ? "neutral" : value ? "success" : "warning"}>{yesNo(value)}</StatusBadge></li>)}
        </ul>
      </section>

      <div className="closure-review__evidence">
        <section className="card">
          <div className="card-header"><div><h3>Акт</h3><p>Фото подписанного оригинала</p></div><Button onClick={onOpenAct} variant="secondary">Открыть акт</Button></div>
          <div className="closure-review__files">
            {actFile ? <FileGallery files={[actFile]} /> : <p className="closure-review__missing">Фото акта не загружено</p>}
          </div>
        </section>
        <section className="card">
          <div className="card-header"><div><h3>Фото, видео и документы</h3><p>{attachments.length ? `Файлов: ${attachments.length}` : "Нет вложений"}</p></div></div>
          <div className="closure-review__files"><FileGallery emptyText="Дополнительных вложений нет." files={attachments} /></div>
        </section>
      </div>
    </div>

    <section className="card closure-review__parts">
      <div className="card-header"><div><h3>Использованные запчасти</h3><p>{card.parts.length ? `Позиций: ${card.parts.length}` : "Не использовались"}</p></div></div>
      {card.parts.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">Артикул</th><th scope="col">Наименование</th><th scope="col">Количество</th><th scope="col">Г/Н/Б</th></tr></thead><tbody>
        {card.parts.map((part) => <tr key={part.id}><td><strong>{part.articleNumber}</strong></td><td>{part.name}</td><td>{part.quantity}</td><td>{part.condition === "G" ? "Г, гарантийная" : part.condition === "N" ? "Н, новая" : "Б, б/у"}</td></tr>)}
      </tbody></table></div> : null}
    </section>
  </section>;
}
