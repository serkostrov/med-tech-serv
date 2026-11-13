import React from "react";
import type { WorkActModel, WorkActPartCondition } from "./work-act.js";
import { Button, EntityDetailToolbar } from "./ui.js";
import { formatDisplayDate } from "./date-format.js";
import { companyDateText, companyTime } from "./task-dates.js";

const PART_LABELS: Readonly<Record<WorkActPartCondition, string>> = {
  G: "Г",
  N: "Н",
  B: "Б"
};

/** Календарная дата как есть, момент времени по часам компании (как в бумажном акте). */
function date(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? formatDisplayDate(value) : companyDateText(value);
}

function time(value: string): string {
  return companyTime(value);
}

function Mark({ checked, children }: { readonly checked: boolean; readonly children: string }) {
  return <div className="work-act-mark"><span aria-label={checked ? "Отмечено" : "Не отмечено"}>{checked ? "✓" : ""}</span>{children}</div>;
}

function Party({ party }: { readonly party: WorkActModel["customerParty"] }) {
  return <section className="work-act-party">
    <h3>{party.heading}:</h3>
    <div className="work-act-party__position"><span>Должность:</span><strong>{party.position}</strong></div>
    <div className="work-act-party__signatures">
      <div><span className="work-act-signature-line" /><small>(Подпись)</small></div>
      <div><span className="work-act-signature-line">{party.fullName}</span><small>(Расшифровка)</small></div>
    </div>
    <div className="work-act-seal">М.П.</div>
  </section>;
}

function blankRows(count: number, columns: number) {
  return Array.from({ length: count }, (_, row) => <tr aria-hidden="true" key={`blank-${row}`}>
    {Array.from({ length: columns }, (__, column) => <td key={column}>&nbsp;</td>)}
  </tr>);
}

export function WorkAct({ act, onBack, onEditRows }: { readonly act: WorkActModel; readonly onBack: () => void; readonly onEditRows?: () => void }) {
  const equipmentBlankRows = Math.max(0, 5 - act.equipment.length);
  const partBlankRows = Math.max(0, 5 - act.parts.length);
  return <div className="work-act-print-root">
    <EntityDetailToolbar actions={<>{onEditRows ? <Button onClick={onEditRows} variant="secondary">Строки акта</Button> : null}<Button onClick={() => window.print()}>Печать</Button></>} backLabel="К задаче" onBack={onBack} />
    <article className="work-act-document" aria-label={`Акт выполненных работ ${act.number}`}>
      <header className="work-act-company">
        <strong>{act.company.name}</strong>
        <span>ИНН {act.company.inn}</span>
        <span>{act.company.address}</span>
        <span>тел./факс: {act.company.phone}</span>
        <span>e-mail: {act.company.email}</span>
      </header>

      <div className="work-act-title">
        <h1>Акт выполненных работ</h1>
        <strong>Договор № {act.contractNumber}</strong>
      </div>

      <section className="work-act-facts">
        <div><span>Дата вызова (заявки):</span><strong>{date(act.callDate)}</strong></div>
        <div><span>Дата выезда инженера:</span><strong>{date(act.visitDate)}</strong></div>
        <div><span>Дата окончания работ:</span><strong>{date(act.completionDate)}</strong></div>
        <div><span>Время начала работ:</span><strong>{time(act.workStartedAt)}</strong></div>
        <div><span>Время окончания работ:</span><strong>{time(act.workFinishedAt)}</strong></div>
      </section>

      <section className="work-act-customer">
        <div><span>Заказчик:</span><strong>{act.customer.name}</strong></div>
        <div><span>Адрес:</span><strong>{act.customer.address}</strong></div>
        <div><span>Контактное лицо:</span><strong>{act.customer.contactFullName}</strong></div>
        <div><span>Телефон:</span><strong>{act.customer.contactPhone}</strong></div>
      </section>

      <table className="work-act-table work-act-equipment">
        <thead><tr><th>№</th><th>Наименование прибора</th><th>Серийный номер</th><th>Показания счётчика</th></tr></thead>
        <tbody>
          {act.equipment.map((item, index) => <tr key={`${item.serialNumber}-${index}`}><td>{index + 1}</td><td>{item.name}</td><td>{item.serialNumber}</td><td>{item.meterReading ?? ""}</td></tr>)}
          {blankRows(equipmentBlankRows, 4)}
        </tbody>
      </table>

      <section className="work-act-works">
        <h2>Выполненные работы</h2>
        {act.works.map((work, index) => <div key={`${work.name}-${index}`}><span className="work-act-checkbox">✓</span><strong>{work.name}</strong>{work.modifier ? <b>{work.modifier === "G" ? "Г" : "Н"}</b> : null}{work.hours !== undefined ? <span>({work.hours} ч.)</span> : null}</div>)}
        {act.works.length === 0 ? <div className="work-act-empty-line" /> : null}
        <p>Г — гарантийные работы; Н — неправильная эксплуатация оборудования.</p>
      </section>

      <section className="work-act-text-fields">
        <div><h2>Причина вызова:</h2><p>{act.callReason}</p></div>
        <div><h2>Описание работ:</h2><p>{act.workDescription}</p></div>
        <div><h2>Рекомендации:</h2><p>{act.recommendations}</p></div>
        <div><h2>Замечания пользователя:</h2><p>{act.userRemarks}</p></div>
      </section>

      <h2 className="work-act-parts-title">Использованы следующие запасные части:</h2>
      <table className="work-act-table work-act-parts">
        <thead><tr><th>Каталожный номер</th><th>Наименование</th><th>Г/Н/Б</th><th>Кол-во</th></tr></thead>
        <tbody>
          {act.parts.map((part, index) => <tr key={`${part.articleNumber}-${index}`}><td>{part.articleNumber}</td><td>{part.name}</td><td>{PART_LABELS[part.condition]}</td><td>{part.quantity}</td></tr>)}
          {blankRows(partBlankRows, 4)}
        </tbody>
      </table>
      <p className="work-act-legend">Г — гарантийная запчасть, Н — новая, Б — б/у.</p>

      <section className="work-act-marks">
        <Mark checked={act.marks.workCompleted}>Работы выполнены полностью с надлежащим качеством.</Mark>
        <Mark checked={act.marks.apparatusApproved}>Аппарат исправен и допущен к работе.</Mark>
        <Mark checked={act.marks.customerHasNoClaims}>Заказчик претензий не имеет.</Mark>
        <Mark checked={act.marks.continuedInPrimary}>Работа будет продолжена в счёт первичной заявки.</Mark>
      </section>

      <footer className="work-act-parties"><Party party={act.customerParty} /><Party party={act.contractorParty} /></footer>
    </article>
  </div>;
}
