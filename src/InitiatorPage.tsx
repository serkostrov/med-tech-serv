import { useEffect, useState, type FormEvent } from "react";
import { formatDisplayDate } from "./date-format.js";
import { TASK_STATUS_LABELS, TASK_STATUS_TONES } from "./domain/task-status.js";
import { requestPeriod, requestProblem, requestStageHint, requestTitle, type RequestPriority } from "./initiator-request.js";
import { m2Api, type EquipmentApiRecord, type ReferenceCatalogValue, type TaskApiRecord } from "./m2-api.js";
import { companyToday } from "./task-dates.js";
import {
  Button, DatePicker, DialogForm, EntityDetailToolbar, Input, PageIntro, PageTabs, ResourceState, Select, StatusBadge, Textarea, ViewSwitch, toast
} from "./ui.js";
import { RegistryPagination, usePageSize } from "./RegistryPagination.js";
import { CompletedTasksToggle, TaskStageBoard, isOpenTask } from "./TaskStageBoard.js";

/**
 * Экран менеджера-инициатора (ТЗ, раздел 2): «Создание заявок, статусы и результаты только своих задач».
 * Заявка инициатора и есть задача: при отправке создаётся обычная задача «Новая», без инженера, от его
 * имени (initiator_id). Поэтому на экране она называется задачей и выглядит как карточка задачи у других
 * ролей (встреча 19.11: «если это одна сущность, пусть так же выглядит, чтобы не было разночтений»).
 * Что видно и что можно, решают права в базе (0009, 0014): чужих задач, цен и счетов инициатор не получает.
 */
export function InitiatorRequests() {
  const [tasks, setTasks] = useState<readonly TaskApiRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [openTask, setOpenTask] = useState<TaskApiRecord | null>(null);
  const [workTypes, setWorkTypes] = useState<readonly ReferenceCatalogValue[]>([]);
  // Доска по этапам или один список постранично (вторая встреча 18.11).
  const [view, setView] = useState<"board" | "list">("board");
  // Закрытые и отменённые — по переключателю, как на доске задач (встреча 19.11).
  const [showCompleted, setShowCompleted] = useState(false);
  const { pageSize, setPageSize } = usePageSize("initiator-requests");
  const [pageIndex, setPageIndex] = useState(0);
  const reload = async () => {
    try {
      // Только свои задачи (0014): их немного даже за годы, поэтому берём разом.
      const page = await m2Api.tasksPage({ sort: "updated_desc", limit: 1000 });
      setTasks(page.items);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не получилось загрузить задачи");
    }
  };
  useEffect(() => { void reload(); }, []);
  useEffect(() => { void m2Api.listCatalogValues("work-types").then(setWorkTypes).catch(() => setWorkTypes([])); }, []);
  const workTypeName = (code: string | undefined) => code ? workTypes.find((item) => (item.code ?? item.id) === code)?.name : undefined;

  if (formOpen) return <InitiatorRequestForm onClose={() => setFormOpen(false)} onCreated={async (task) => { setFormOpen(false); await reload(); setOpenTask(task); }} workTypes={workTypes.filter((item) => item.isActive)} />;
  if (openTask) return <InitiatorTaskCard onBack={() => { setOpenTask(null); void reload(); }} task={openTask} workTypeName={workTypeName(openTask.workTypeCode)} />;

  const all = tasks ?? [];
  const listed = showCompleted ? all : all.filter(isOpenTask);
  const pageShown = Math.min(pageIndex, Math.max(0, Math.ceil(listed.length / pageSize) - 1));
  return <>
    <PageIntro
      actions={<Button icon="plus" onClick={() => setFormOpen(true)}>Новая задача</Button>}
      title="Мои задачи"
      titleAside={<ViewSwitch items={[{ value: "board", label: "Доска" }, { value: "list", label: "Список" }]} label="Как показать задачи" onValueChange={setView} value={view} />}
    />
    {loadError ? <ResourceState description={loadError} status="error" title="Задачи не загрузились" />
      : tasks === null ? <ResourceState description="Подождите, задачи сейчас появятся." status="loading" title="Загружаем задачи" />
      : tasks.length === 0 ? <ResourceState description="Нажмите «Новая задача», чтобы подать первую." status="empty" title="Задач пока нет" />
      : <>
        <div className="task-list-toolbar"><CompletedTasksToggle onChange={(next) => { setShowCompleted(next); setPageIndex(0); }} value={showCompleted} /></div>
        {view === "board"
          ? <TaskStageBoard label="Мои задачи по этапам" onOpen={setOpenTask} show={{ engineer: true }} showCompleted={showCompleted} tasks={all} />
          : listed.length === 0 ? <ResourceState description="Закрытые и отменённые — по переключателю справа." status="filtered-empty" title="Активных задач нет" />
          : <section className="card card--table">
            <RequestTable onOpen={setOpenTask} tasks={listed.slice(pageShown * pageSize, (pageShown + 1) * pageSize)} />
            <RegistryPagination alwaysShow ariaLabel="Страницы моих задач" onPageChange={setPageIndex} onPageSizeChange={(size) => { setPageSize(size); setPageIndex(0); }} pageIndex={pageShown} pageSize={pageSize} total={listed.length} />
          </section>}
      </>}
  </>;
}

function equipmentText(task: TaskApiRecord): string {
  const label = task.equipmentLabel;
  if (!label) return "—";
  return [[label.manufacturer, label.model].filter(Boolean).join(" "), `S/N ${label.serialNumber}`].filter(Boolean).join(" · ");
}

function periodText(task: TaskApiRecord): string {
  if (!task.periodTo) return "—";
  return task.periodFrom && task.periodFrom !== task.periodTo
    ? `${formatDisplayDate(task.periodFrom)} — ${formatDisplayDate(task.periodTo)}`
    : formatDisplayDate(task.periodTo);
}

/** Все задачи одной таблицей, колонки как в других списках задач: номер отдельно, этап последним. */
function RequestTable({ tasks, onOpen }: { readonly tasks: readonly TaskApiRecord[]; readonly onOpen: (task: TaskApiRecord) => void }) {
  return (
    <div className="table-scroll table-cards"><table className="data-table task-list-table">
          <thead><tr>
            <th scope="col">Номер</th>
            <th scope="col">Задача</th>
            <th scope="col">Прибор</th>
            <th scope="col">Инженер</th>
            <th scope="col">Срок</th>
            <th scope="col">Этап</th>
          </tr></thead>
          <tbody>{tasks.map((task) => <tr className="clickable-row" key={task.id} onClick={() => onOpen(task)}>
            <td className="task-list-table__number" data-label="Номер"><button className="text-button" onClick={(event) => { event.stopPropagation(); onOpen(task); }} type="button">{task.number}</button></td>
            <td className="cell-wide" data-label="Задача"><strong>{task.title}</strong></td>
            <td data-label="Прибор">{equipmentText(task)}</td>
            <td data-label="Инженер">{task.engineerName ?? <span className="muted">не назначен</span>}</td>
            <td data-label="Срок">{task.status === "closed" ? formatDisplayDate(task.completedAt ?? task.visitDate) || "—" : periodText(task)}{task.isOverdue ? <small className="quote-overdue">просрочена</small> : null}</td>
            <td data-label="Этап"><StatusBadge tone={TASK_STATUS_TONES[task.status] ?? "warning"}>{TASK_STATUS_LABELS[task.status] ?? task.status}</StatusBadge></td>
          </tr>)}</tbody>
        </table></div>
  );
}

/**
 * Задача глазами инициатора — та же карточка, что у координатора и инженера: шапка с номером и этапом,
 * «Что случилось», вкладки «Свойства» и «Работа и акт». Без кнопок: менять задачу может только координатор.
 */
function InitiatorTaskCard({ task, onBack, workTypeName }: { readonly task: TaskApiRecord; readonly onBack: () => void; readonly workTypeName?: string | undefined }) {
  const [tab, setTab] = useState<"props" | "work">("props");
  const result: ReadonlyArray<readonly [string, string | undefined]> = [
    ["Что сделано", task.workDescription],
    ["Рекомендации", task.recommendations],
    ["Причина отмены", task.cancellationReason]
  ];
  const filled = result.filter(([, value]) => value);
  return <>
    <EntityDetailToolbar backLabel="К моим задачам" onBack={onBack} />
    <header className="task-head">
      <div className="task-head__meta">
        <span className="task-head__number">{task.number}</span>
        <StatusBadge tone={TASK_STATUS_TONES[task.status] ?? "warning"}>{TASK_STATUS_LABELS[task.status] ?? task.status}</StatusBadge>
        {task.priority === "urgent" ? <span className="task-head__flag task-head__flag--urgent">Срочная</span> : null}
        {task.isOverdue ? <span className="task-head__flag task-head__flag--late">Срок истёк</span> : null}
      </div>
      <h1>{task.title}</h1>
      <p>{[workTypeName, task.customer?.siteName].filter(Boolean).join(" · ")}</p>
    </header>
    <section aria-label="Этап задачи" className="task-next-step"><div className="task-next-step__text"><strong>{requestStageHint(task.status, task.engineerName)}</strong></div></section>
    <div className="task-layout task-layout--single">
      <div className="task-layout__main">
        {task.callReason ? <section className="task-brief" aria-label="Что случилось"><h2>Что случилось</h2><p>{task.callReason}</p></section> : null}
        <PageTabs items={[
          { value: "props" as const, label: "Свойства" },
          { value: "work" as const, label: "Работа и акт" }
        ]} label="Разделы карточки задачи" onValueChange={setTab} value={tab} />
        {tab === "props" ? <section aria-label="Свойства задачи" className="task-props task-props--tab">
          <header className="task-props__head"><h2>Свойства</h2></header>
          <dl>
            <div><dt>Инженер</dt><dd>{task.engineerName ?? <span className="is-empty">Не назначен</span>}</dd></div>
            <div><dt>Срок</dt><dd>{task.periodTo ? periodText(task) : <span className="is-empty">Не указан</span>}</dd></div>
            <div><dt>Срочность</dt><dd>{task.priority === "urgent" ? "Срочная" : "Плановая"}</dd></div>
            {workTypeName ? <div><dt>Вид работ</dt><dd>{workTypeName}</dd></div> : null}
            {task.callDate ? <div><dt>Подана</dt><dd>{formatDisplayDate(task.callDate)}</dd></div> : null}
            {task.visitDate ? <div><dt>Дата выезда</dt><dd>{formatDisplayDate(task.visitDate)}</dd></div> : null}
            {task.completedAt ? <div><dt>Окончание работ</dt><dd>{formatDisplayDate(task.completedAt)}</dd></div> : null}
          </dl>
          <dl>
            <div><dt>Прибор</dt><dd>{task.equipmentLabel ? <>{[task.equipmentLabel.manufacturer, task.equipmentLabel.model].filter(Boolean).join(" ") || "Прибор"}<small>S/N {task.equipmentLabel.serialNumber}</small></> : <span className="is-empty">Не выбран</span>}</dd></div>
            <div><dt>Площадка</dt><dd>{task.customer?.siteName || <span className="is-empty">Не указана</span>}{task.customer?.address ? <small>{task.customer.address}</small> : null}</dd></div>
          </dl>
        </section> : null}
        {tab === "work" ? <section className="task-section" aria-labelledby={`initiator-result-${task.id}`}>
          <header className="task-section__head"><h3 id={`initiator-result-${task.id}`}>Результат работ</h3></header>
          {filled.length ? <dl className="task-doc">{filled.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            : <div className="task-section__empty"><p>{task.status === "closed" ? "Результат не заполнен." : "Инженер ещё не заполнил результат."}</p></div>}
        </section> : null}
      </div>
    </div>
  </>;
}

/**
 * Новая задача: прибор по S/N, что сделать, срочность, описание. Срок подставится, координатор поправит.
 * Страницей, как «Новая задача» у координатора (UI/UX-разбор 19.11).
 */
function InitiatorRequestForm({ onClose, onCreated, workTypes }: {
  readonly onClose: () => void;
  readonly onCreated: (task: TaskApiRecord) => Promise<void>;
  readonly workTypes: readonly ReferenceCatalogValue[];
}) {
  const [serial, setSerial] = useState("");
  const [found, setFound] = useState<readonly EquipmentApiRecord[] | null>(null);
  const [device, setDevice] = useState<EquipmentApiRecord | null>(null);
  const [searching, setSearching] = useState(false);
  const [workTypeCode, setWorkTypeCode] = useState("repair");
  const [priority, setPriority] = useState<RequestPriority>("planned");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // «Ремонт» по умолчанию; если его в справочнике нет — первый активный вид работ.
  useEffect(() => {
    if (workTypes.length && !workTypes.some((item) => (item.code ?? item.id) === workTypeCode)) setWorkTypeCode(workTypes[0]?.code ?? workTypes[0]?.id ?? "");
  }, [workTypes]);
  const search = async () => {
    const value = serial.trim();
    if (!value) { setError("Введите заводской номер (S/N)"); return; }
    setSearching(true);
    setError(null);
    try {
      const page = await m2Api.equipmentPage({ search: value, limit: 10 });
      setFound(page.items);
      const exact = page.items.filter((item) => item.serialNumber.trim().toLowerCase() === value.toLowerCase());
      setDevice(exact.length === 1 ? exact[0] ?? null : page.items.length === 1 ? page.items[0] ?? null : null);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Не получилось найти прибор");
    } finally {
      setSearching(false);
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const description = String(new FormData(event.currentTarget).get("description") ?? "");
    const today = companyToday();
    const problem = requestProblem({ ...(device ? { equipmentId: device.id } : {}), ...(workTypeCode ? { workTypeCode } : {}), description, ...(until ? { until } : {}), today });
    if (problem || !device) { setError(problem ?? "Найдите прибор по заводскому номеру (S/N)"); return; }
    const workTypeName = workTypes.find((item) => (item.code ?? item.id) === workTypeCode)?.name ?? "Задача";
    const period = requestPeriod(priority, today, until || undefined);
    setBusy(true);
    setError(null);
    try {
      const task = await m2Api.createTask({
        title: requestTitle(workTypeName, { manufacturer: device.manufacturer, model: device.model, serialNumber: device.serialNumber }),
        workTypeCode,
        priority,
        equipmentId: device.id,
        callReason: description.trim(),
        periodFrom: period.from,
        periodTo: period.to,
        asInitiator: true
      });
      toast.success("Координатор назначит инженера, о ходе работ придут уведомления", { title: `Задача ${task.number} создана` });
      await onCreated(task);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Не получилось создать задачу");
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogForm asPage backLabel="К моим задачам" busy={busy} description="Найдите прибор по заводскому номеру и опишите, что случилось. Срок и инженера назначит координатор." error={error} onOpenChange={(open) => { if (!open) onClose(); }} onSubmit={submit} open size="lg" submitDisabled={!device} submitLabel="Создать задачу" title="Новая задача">
      <div className="initiator-serial field-wide">
        <label>Заводской номер (S/N) *<Input autoFocus onChange={(event) => { setSerial(event.target.value); setDevice(null); setFound(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(); } }} placeholder="Номер с таблички прибора" value={serial} /></label>
        <Button busy={searching} onClick={() => void search()} variant="secondary">Найти прибор</Button>
      </div>
      {found !== null && found.length === 0 ? <p className="field-wide form-hint initiator-serial__miss">Прибор с таким номером не найден. Проверьте номер на табличке прибора или напишите координатору письмом — он заведёт прибор.</p> : null}
      {found !== null && found.length > 1 && !device ? <div className="field-wide quote-part-results" role="listbox" aria-label="Найденные приборы">
        {found.map((item) => <button aria-selected={false} className="quote-part-results__item" key={item.id} onClick={() => setDevice(item)} role="option" type="button"><strong>S/N {item.serialNumber}</strong><span>{item.manufacturer} {item.model}</span><small>{item.site ?? ""}</small></button>)}
      </div> : null}
      {device ? <p className="field-wide initiator-serial__found">Найден: <strong>{device.manufacturer} {device.model}, S/N {device.serialNumber}</strong>{device.site ? ` · ${device.site}` : ""}</p> : null}
      <div className="dialog-form-grid">
        <label>Что нужно сделать *<Select onChange={(event) => setWorkTypeCode(event.target.value)} value={workTypeCode}>{workTypes.map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label>
        <label>Срочность<Select onChange={(event) => setPriority(event.target.value as RequestPriority)} value={priority}><option value="planned">Плановая</option><option value="urgent">Срочная — реакция 24 часа</option></Select></label>
        <label className="dialog-form-grid__wide">Что случилось *<Textarea name="description" placeholder="Например: не проходит калибровка, ошибка температуры кюветы" required rows={3} /></label>
        <label>Выполнить до<DatePicker onChange={setUntil} value={until} /></label>
      </div>
    </DialogForm>
  );
}
