import { useEffect, useState, type FormEvent } from "react";
import { formatDisplayDate } from "./date-format.js";
import { TASK_STATUS_LABELS, TASK_STATUS_TONES } from "./domain/task-status.js";
import { requestPeriod, requestProblem, requestStageHint, requestTitle, type RequestPriority } from "./initiator-request.js";
import { m2Api, type EquipmentApiRecord, type ReferenceCatalogValue, type TaskApiRecord } from "./m2-api.js";
import { companyToday } from "./task-dates.js";
import {
  Button, CardHeader, DatePicker, DialogForm, EntityDetailToolbar, Input, PageIntro, ResourceState, Select, StatusBadge, Textarea, toast
} from "./ui.js";

/**
 * Экран менеджера-инициатора (ТЗ, раздел 2): «Создание заявок, статусы и результаты только своих задач».
 * Заявка уходит координатору «Новой», без инженера, от имени инициатора; что видно и что можно,
 * решают права в базе (0009, 0014): чужих задач, цен и счетов инициатор не получает.
 */
export function InitiatorRequests() {
  const [tasks, setTasks] = useState<readonly TaskApiRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [openTask, setOpenTask] = useState<TaskApiRecord | null>(null);
  const reload = async () => {
    try {
      const page = await m2Api.tasksPage({ sort: "updated_desc", limit: 200 });
      setTasks(page.items);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не получилось загрузить заявки");
    }
  };
  useEffect(() => { void reload(); }, []);

  if (openTask) return <InitiatorTaskCard onBack={() => { setOpenTask(null); void reload(); }} task={openTask} />;

  const open = (tasks ?? []).filter((task) => task.status !== "closed" && task.status !== "cancelled");
  const done = (tasks ?? []).filter((task) => task.status === "closed" || task.status === "cancelled");
  return <>
    <PageIntro
      actions={<Button icon="plus" onClick={() => setFormOpen(true)}>Новая заявка</Button>}
      description="Ваши заявки и их статусы"
      title="Мои заявки"
    />
    {loadError ? <ResourceState description={loadError} status="error" title="Заявки не загрузились" />
      : tasks === null ? <ResourceState description="Подождите, заявки сейчас появятся." status="loading" title="Загружаем заявки" />
      : tasks.length === 0 ? <ResourceState description="Нажмите «Новая заявка»: найдите прибор по заводскому номеру и опишите, что случилось. Координатор назначит инженера, о ходе работ придут уведомления." status="empty" title="Заявок пока нет" />
      : <>
        <RequestTable onOpen={setOpenTask} tasks={open} title="В работе" empty="Открытых заявок нет." />
        {done.length > 0 ? <RequestTable onOpen={setOpenTask} tasks={done} title="Завершённые" /> : null}
      </>}
    {formOpen ? <InitiatorRequestForm onClose={() => setFormOpen(false)} onCreated={async (task) => { setFormOpen(false); await reload(); setOpenTask(task); }} /> : null}
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

function RequestTable({ title, tasks, onOpen, empty }: { readonly title: string; readonly tasks: readonly TaskApiRecord[]; readonly onOpen: (task: TaskApiRecord) => void; readonly empty?: string }) {
  return (
    <section className="card card--table">
      <CardHeader meta={String(tasks.length)} title={title} />
      {tasks.length === 0 ? <ResourceState description={empty ?? ""} status="empty" title="Пусто" />
        : <div className="table-scroll table-cards"><table className="data-table">
          <thead><tr>
            <th scope="col">Номер</th>
            <th scope="col">Заявка</th>
            <th scope="col">Прибор</th>
            <th scope="col">Срок</th>
            <th scope="col">Статус</th>
          </tr></thead>
          <tbody>{tasks.map((task) => <tr className="clickable-row" key={task.id} onClick={() => onOpen(task)}>
            <td data-label="Номер"><button className="text-button" onClick={(event) => { event.stopPropagation(); onOpen(task); }} type="button">{task.number}</button></td>
            <td className="cell-wide" data-label="Заявка"><strong>{task.title}</strong><small className="initiator-hint">{requestStageHint(task.status, task.engineerName)}</small></td>
            <td data-label="Прибор">{equipmentText(task)}</td>
            <td data-label="Срок">{periodText(task)}{task.isOverdue ? <small className="quote-overdue">просрочена</small> : null}</td>
            <td data-label="Статус"><StatusBadge tone={TASK_STATUS_TONES[task.status] ?? "warning"}>{TASK_STATUS_LABELS[task.status] ?? task.status}</StatusBadge></td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  );
}

/** Заявка глазами инициатора: что, где, когда, кто едет и что сделали. Менять её может только координатор. */
function InitiatorTaskCard({ task, onBack }: { readonly task: TaskApiRecord; readonly onBack: () => void }) {
  const facts: ReadonlyArray<readonly [string, string]> = [
    ["Прибор", equipmentText(task)],
    ["Площадка", task.customer?.siteName ?? "—"],
    ["Срочность", task.priority === "urgent" ? "Срочная, реакция 24 часа" : "Плановая"],
    ["Срок", periodText(task)],
    ["Инженер", task.engineerName ?? "ещё не назначен"],
    ["Подана", task.callDate ? formatDisplayDate(task.callDate) : "—"]
  ];
  const result: ReadonlyArray<readonly [string, string | undefined]> = [
    ["Что сделано", task.workDescription],
    ["Рекомендации", task.recommendations],
    ["Причина отмены", task.cancellationReason]
  ];
  return (
    <div className="initiator-card">
      <EntityDetailToolbar backLabel="К моим заявкам" onBack={onBack} />
      <header className="task-head">
        <div className="task-head__meta">
          <span className="task-head__number">{task.number}</span>
          <StatusBadge tone={TASK_STATUS_TONES[task.status] ?? "warning"}>{TASK_STATUS_LABELS[task.status] ?? task.status}</StatusBadge>
          {task.isOverdue ? <span className="task-head__flag task-head__flag--late">просрочена</span> : null}
        </div>
        <h1>{task.title}</h1>
        <p>{requestStageHint(task.status, task.engineerName)}</p>
      </header>
      <section className="card initiator-card__facts">
        <dl>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        {task.callReason ? <><h3>Что случилось</h3><p className="initiator-card__text">{task.callReason}</p></> : null}
        {result.filter(([, value]) => value).map(([label, value]) => <div key={label}><h3>{label}</h3><p className="initiator-card__text">{value}</p></div>)}
        {task.status !== "closed" && task.status !== "cancelled" ? <p className="form-hint">Сроки и инженера назначает координатор. Если что-то изменилось, напишите ему ответом на письмо по заявке.</p> : null}
      </section>
    </div>
  );
}

/** Новая заявка: прибор по S/N, что сделать, срочность, описание. Срок подставится, координатор поправит. */
function InitiatorRequestForm({ onClose, onCreated }: { readonly onClose: () => void; readonly onCreated: (task: TaskApiRecord) => Promise<void> }) {
  const [serial, setSerial] = useState("");
  const [found, setFound] = useState<readonly EquipmentApiRecord[] | null>(null);
  const [device, setDevice] = useState<EquipmentApiRecord | null>(null);
  const [searching, setSearching] = useState(false);
  const [workTypes, setWorkTypes] = useState<readonly ReferenceCatalogValue[]>([]);
  const [workTypeCode, setWorkTypeCode] = useState("repair");
  const [priority, setPriority] = useState<RequestPriority>("planned");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void m2Api.listCatalogValues("work-types").then((values) => {
      const active = values.filter((item) => item.isActive);
      setWorkTypes(active);
      if (!active.some((item) => (item.code ?? item.id) === "repair")) setWorkTypeCode(active[0]?.code ?? active[0]?.id ?? "");
    }).catch(() => setWorkTypes([]));
  }, []);
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
    const workTypeName = workTypes.find((item) => (item.code ?? item.id) === workTypeCode)?.name ?? "Заявка";
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
      toast.success("Координатор назначит инженера, о ходе работ придут уведомления", { title: `Заявка ${task.number} принята` });
      await onCreated(task);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Не получилось отправить заявку");
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogForm busy={busy} description="Найдите прибор по заводскому номеру и опишите, что случилось. Срок и инженера назначит координатор." error={error} onOpenChange={(open) => { if (!open) onClose(); }} onSubmit={submit} open size="lg" submitDisabled={!device} submitLabel="Отправить заявку" title="Новая заявка">
      <div className="initiator-serial field-wide">
        <label>Заводской номер (S/N) *<Input autoFocus onChange={(event) => { setSerial(event.target.value); setDevice(null); setFound(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(); } }} placeholder="Номер с таблички прибора" value={serial} /></label>
        <Button busy={searching} onClick={() => void search()} variant="secondary">Найти прибор</Button>
      </div>
      {found !== null && found.length === 0 ? <p className="field-wide form-hint initiator-serial__miss">Прибор с таким номером не найден. Проверьте номер на табличке прибора или отправьте заявку письмом — координатор заведёт прибор.</p> : null}
      {found !== null && found.length > 1 && !device ? <div className="field-wide quote-part-results" role="listbox" aria-label="Найденные приборы">
        {found.map((item) => <button aria-selected={false} className="quote-part-results__item" key={item.id} onClick={() => setDevice(item)} role="option" type="button"><strong>S/N {item.serialNumber}</strong><span>{item.manufacturer} {item.model}</span><small>{item.site ?? ""}</small></button>)}
      </div> : null}
      {device ? <p className="field-wide initiator-serial__found">Найден: <strong>{device.manufacturer} {device.model}, S/N {device.serialNumber}</strong>{device.site ? ` · ${device.site}` : ""}</p> : null}
      <div className="dialog-form-grid">
        <label>Что нужно сделать *<Select onChange={(event) => setWorkTypeCode(event.target.value)} value={workTypeCode}>{workTypes.map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label>
        <label>Срочность<Select onChange={(event) => setPriority(event.target.value as RequestPriority)} value={priority}><option value="planned">Плановая</option><option value="urgent">Срочная — реакция 24 часа</option></Select></label>
        <label className="dialog-form-grid__wide">Что случилось *<Textarea name="description" placeholder="Например: не проходит калибровка, ошибка температуры кюветы" required rows={3} /></label>
        <label>Выполнить до<DatePicker onChange={setUntil} value={until} /><span className="form-hint">Можно не указывать: координатор согласует срок.</span></label>
      </div>
    </DialogForm>
  );
}
