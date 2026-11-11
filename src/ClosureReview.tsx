import React, { useState } from "react";
import type { TaskCardResponse } from "./m2-api.js";
import { Button, StatusBadge } from "./ui.js";
import { formatDisplayDate } from "./date-format.js";

const FILE_KIND_LABELS: Readonly<Record<string, string>> = {
  act: "Фото акта",
  photo: "Фотофиксация",
  video: "Видеофиксация",
  document: "Документ",
  mail_attachment: "Из письма клиента"
};

function reviewValue(primary: string | undefined, closure: string | undefined): string {
  return primary ?? closure ?? "Не заполнено";
}

function yesNo(value: boolean | undefined): string {
  return value === undefined ? "Не заполнено" : value ? "Да" : "Нет";
}

function fileHref(file: { readonly url?: string }): string {
  return file.url ?? "#";
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
  const [reworkComment, setReworkComment] = useState("");
  const { task, closure } = card;
  const actFile = card.files.find((file) => file.id === closure?.actFileId || file.kind === "act");
  const attachments = card.files.filter((file) => file.id !== actFile?.id);
  const meterReading = task.meterReading ?? closure?.meterReading;
  const workModifier = task.workModifier ?? closure?.workModifier;
  const hours = task.hours ?? closure?.hours;

  return <section aria-labelledby="closure-review-title" className="closure-review">
    <header className="closure-review__header">
      <div>
        <p className="page-intro__eyebrow">Решение координатора</p>
        <h2 id="closure-review-title">Проверка закрытия</h2>
        <p>Сверьте акт, вложения и результат работ перед окончательным закрытием.</p>
      </div>
      <StatusBadge tone="info">На проверке</StatusBadge>
    </header>

    <div className="closure-review__meta">
      <strong>{closure?.submittedByName ?? card.engineer?.fullName ?? "Инженер"}</strong>
      <span>Передано на проверку: {closure?.submittedAt ? formatDisplayDate(closure.submittedAt, true) : "дата не указана"}</span>
    </div>

    <div className="closure-review__grid">
      <section className="card closure-review__result">
        <div className="card-header"><div><h3>Поля закрытия</h3><p>Все данные из сервисного акта</p></div></div>
        <dl className="detail-list task-result-list">
          <div><dt>Причина неисправности</dt><dd>{card.reason?.name ?? "Не заполнено"}</dd></div>
          <div><dt>Причина вызова</dt><dd>{reviewValue(task.callReason, closure?.callReason)}</dd></div>
          <div><dt>Описание работ</dt><dd>{reviewValue(task.workDescription, closure?.workDescription)}</dd></div>
          <div><dt>Рекомендации</dt><dd>{reviewValue(task.recommendations, closure?.recommendations)}</dd></div>
          <div><dt>Замечания пользователя</dt><dd>{reviewValue(task.userRemarks, closure?.userRemarks)}</dd></div>
          <div><dt>Вид и модификатор работ</dt><dd>{card.workType?.name ?? "Не заполнено"}{workModifier ? ` · ${workModifier}` : ""}</dd></div>
          <div><dt>Часы</dt><dd>{hours ?? "Не применимо"}</dd></div>
          <div><dt>Показание счётчика</dt><dd>{meterReading ?? "Не заполнено"}</dd></div>
          <div><dt>Работы выполнены полностью</dt><dd>{yesNo(task.workCompleted ?? closure?.workCompleted)}</dd></div>
          <div><dt>Аппарат исправен и допущен</dt><dd>{yesNo(task.apparatusApproved ?? closure?.apparatusApproved)}</dd></div>
          <div><dt>Заказчик претензий не имеет</dt><dd>{yesNo(task.customerHasNoClaims ?? closure?.customerHasNoClaims)}</dd></div>
          <div><dt>Продолжение первичной заявки</dt><dd>{yesNo(task.continuedInPrimary ?? closure?.continuedInPrimary)}</dd></div>
        </dl>
      </section>

      <div className="closure-review__evidence">
        <section className="card closure-review__act">
          <div className="card-header"><div><h3>Акт выполненных работ</h3><p>Фото подписанного оригинала и печатная форма</p></div></div>
          <div className="closure-review__file-list">
            {actFile ? <a href={fileHref(actFile)}><strong>{actFile.originalName}</strong><span>Фото акта · {(actFile.byteSize / 1024).toFixed(1)} КБ</span></a> : <p className="closure-review__missing">Фото акта не найдено</p>}
            <Button onClick={onOpenAct} variant="secondary">Открыть акт целиком</Button>
          </div>
        </section>

        <section className="card">
          <div className="card-header"><div><h3>Вложения</h3><p>{attachments.length} файлов фото-, видеофиксации и документов</p></div></div>
          <div className="closure-review__file-list">
            {attachments.map((file) => <a href={fileHref(file)} key={file.id}><strong>{file.originalName}</strong><span>{FILE_KIND_LABELS[file.kind] ?? "Файл"} · {(file.byteSize / 1024).toFixed(1)} КБ</span></a>)}
            {attachments.length === 0 ? <p className="muted">Дополнительных вложений нет.</p> : null}
          </div>
        </section>
      </div>
    </div>

    <section className="card closure-review__parts">
      <div className="card-header"><div><h3>Использованные запчасти</h3><p>{card.parts.length} позиций · признаки Г/Н/Б из акта</p></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">Артикул</th><th scope="col">Наименование</th><th scope="col">Количество</th><th scope="col">Г/Н/Б</th></tr></thead><tbody>
        {card.parts.map((part) => <tr key={part.id}><td><strong>{part.articleNumber}</strong></td><td>{part.name}</td><td>{part.quantity}</td><td>{part.condition === "G" ? "Г · гарантийная" : part.condition === "N" ? "Н · новая" : "Б · б/у"}</td></tr>)}
        {card.parts.length === 0 ? <tr><td colSpan={4}>Запчасти не использовались.</td></tr> : null}
      </tbody></table></div>
    </section>

    <section className="card closure-review__decision">
      <div><h3>Решение по закрытию</h3><p>Комментарий обязателен при возврате и попадёт в журнал задачи и уведомление инженеру.</p></div>
      <label htmlFor={`rework-comment-${task.id}`}>Комментарий для инженера<textarea id={`rework-comment-${task.id}`} maxLength={2000} onChange={(event) => setReworkComment(event.target.value)} placeholder="Что именно нужно исправить или дополнить" required rows={3} value={reworkComment} /></label>
      <div className="closure-review__buttons">
        <button className="button button--secondary" disabled={busy || !canReturn || !reworkComment.trim()} onClick={() => void onReturn(reworkComment.trim())} type="button">На доработку</button>
        <button className="button button--success" disabled={busy || !canClose} onClick={() => void onClose()} type="button">Проверено — закрыть</button>
      </div>
    </section>
  </section>;
}
