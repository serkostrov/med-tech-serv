import React, { useEffect, useState, type FormEvent } from "react";
import { MAX_ANNUAL_MAINTENANCE_PERIODS } from "./domain/maintenance-plan.js";
import type { MaintenancePlanListResponse, MaintenancePlanPeriodResponse } from "./types.js";
import { m2Api, type EquipmentApiRecord } from "./m2-api.js";
import { Button, CardHeader, ConfirmationDialog, DatePicker, DialogForm, IconButton, PageIntro, Select, ViewSwitch, toast } from "./ui.js";
import { formatIsoCalendarDate } from "./date-format.js";

export const MAINTENANCE_MONTHS = [
  "Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"
] as const;

export const maintenancePlanStatusLabel: Readonly<Record<MaintenancePlanPeriodResponse["status"], string>> = {
  planned: "Запланировано",
  generated: "Задача создана",
  completed: "Выполнено",
  cancelled: "Отменено"
};

export function formatMaintenancePeriod(periodFrom: string, periodTo: string): string {
  return `${formatIsoCalendarDate(periodFrom)} — ${formatIsoCalendarDate(periodTo)}`;
}

type View = MaintenancePlanListResponse["view"];

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${count} ${word}`;
}

/** Где на годовой шкале сегодняшний день, в процентах; вне выбранного года — нет отметки. */
function todayPercent(year: number): number | undefined {
  const now = new Date();
  if (now.getFullYear() !== year) return undefined;
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return ((Date.UTC(year, now.getMonth(), now.getDate()) - start) / (end - start)) * 100;
}
interface PeriodDraft { readonly key: number; readonly periodFrom: string; readonly periodTo: string; readonly assignedEngineerId: string; readonly comment: string }

function shiftIsoDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function defaultPeriod(year: number, key: number, previousTo?: string): PeriodDraft {
  if (!previousTo) return { key, periodFrom: `${year}-07-01`, periodTo: `${year}-07-15`, assignedEngineerId: "", comment: "" };
  const periodFrom = shiftIsoDate(previousTo, 1);
  return { key, periodFrom, periodTo: shiftIsoDate(periodFrom, 14), assignedEngineerId: "", comment: "" };
}

export function MaintenancePlanPage() {
  const initialYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(initialYear);
  const [view, setView] = useState<View>("equipment");
  const [data, setData] = useState<MaintenancePlanListResponse | null>(null);
  const [equipment, setEquipment] = useState<readonly EquipmentApiRecord[]>([]);
  const [engineers, setEngineers] = useState<readonly { readonly id: string; readonly fullName: string }[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [equipmentId, setEquipmentId] = useState("");
  const [periods, setPeriods] = useState<readonly PeriodDraft[]>([defaultPeriod(initialYear, 1)]);
  const [nextPeriodKey, setNextPeriodKey] = useState(2);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = async (targetYear = year, targetView = view) => {
    setLoading(true);
    try {
      const [plans, devices, availableEngineers] = await Promise.all([
        m2Api.maintenancePlans(targetYear, targetView), m2Api.listEquipment(), m2Api.listTaskEngineers()
      ]);
      setData(plans);
      setEquipment(devices);
      setEngineers(availableEngineers);
      setSelected([]);
    } catch (loadError) {
      toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить план ТО");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(year, view); }, [year, view]);

  const changeYear = (nextYear: number) => {
    setYear(nextYear);
    setPeriods([defaultPeriod(nextYear, nextPeriodKey)]);
    setNextPeriodKey((value) => value + 1);
  };

  const updatePeriod = (key: number, patch: Partial<Omit<PeriodDraft, "key">>) => {
    setPeriods((current) => current.map((period) => period.key === key ? { ...period, ...patch } : period));
  };

  const chooseEquipment = (id: string) => {
    setEquipmentId(id);
    const existing = data?.items.filter((item) => item.equipmentId === id)
      .sort((left, right) => left.periodNo - right.periodNo) ?? [];
    if (existing.length === 0) {
      setPeriods([defaultPeriod(year, nextPeriodKey)]);
      setNextPeriodKey((value) => value + 1);
      return;
    }
    let key = nextPeriodKey;
    setPeriods(existing.map((item) => ({
      key: key++, periodFrom: item.periodFrom, periodTo: item.periodTo,
      assignedEngineerId: item.assignedEngineerId ?? "", comment: item.comment ?? ""
    })));
    setNextPeriodKey(key);
  };

  const addPeriod = () => {
    if (periods.length >= MAX_ANNUAL_MAINTENANCE_PERIODS) return;
    setPeriods((current) => [...current, defaultPeriod(year, nextPeriodKey, current.at(-1)?.periodTo)]);
    setNextPeriodKey((value) => value + 1);
  };

  const removePeriod = (key: number) => {
    if (periods.length <= 1) return;
    setPeriods((current) => current.filter((item) => item.key !== key));
  };

  const openForm = () => {
    setFormError(null);
    setEquipmentId("");
    setPeriods([defaultPeriod(year, nextPeriodKey)]);
    setNextPeriodKey((value) => value + 1);
    setFormOpen(true);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!equipmentId) {
      const text = "Выберите прибор для годового плана";
      setFormError(text);
      toast.warning(text);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await m2Api.replaceMaintenancePlan({
        equipmentId, year,
        periods: periods.map((period) => ({
          periodFrom: period.periodFrom, periodTo: period.periodTo,
          ...(period.assignedEngineerId ? { assignedEngineerId: period.assignedEngineerId } : {}),
          ...(period.comment.trim() ? { comment: period.comment.trim() } : {})
        }))
      });
      setFormOpen(false);
      await load();
    } catch (saveError) {
      const text = saveError instanceof Error ? saveError.message : "Не получилось сохранить план";
      setFormError(text);
      toast.error(text);
    } finally { setSaving(false); }
  };

  const [confirmAll, setConfirmAll] = useState(false);
  // Без выбранных строк задачи создаются по всем запланированным периодам года: сначала спрашиваем.
  const requestGenerate = () => {
    if (selected.length) { void generate(); return; }
    const eligibleCount = data?.items.filter((item) => item.status === "planned").length ?? 0;
    if (eligibleCount === 0) { toast.warning("Нет периодов со статусом «Запланировано» для генерации"); return; }
    setConfirmAll(true);
  };
  const generate = async () => {
    const eligible = data?.items.filter((item) => item.status === "planned") ?? [];
    const planIds = selected.length ? selected : eligible.map((item) => item.id);
    if (planIds.length === 0) {
      toast.warning("Нет периодов со статусом «Запланировано» для генерации");
      return;
    }
    try {
      const result = await m2Api.generateMaintenanceTasks(year, planIds);
      if (result.failures.length) {
        toast.warning(`Создано задач: ${result.created.length}. Уже существовало: ${result.existing.length}. Ошибок: ${result.failures.length}.`);
      } else {
        toast.success(result.created.length ? `Создано задач: ${result.created.length}. Они появились на доске в колонке «Новая».` : "Новых задач нет: по выбранным периодам задачи уже созданы.");
      }
      setSelected([]);
      await load();
    } catch (generateError) {
      toast.error(generateError instanceof Error ? generateError.message : "Не получилось создать плановые задачи");
    }
  };

  const toggle = (id: string) => setSelected((current) => current.includes(id)
    ? current.filter((item) => item !== id) : [...current, id]);
  const items = data?.items ?? [];
  const existingPlanCount = items.filter((item) => item.equipmentId === equipmentId).length;
  const generatedCount = items.filter((item) => item.generatedTaskId).length;
  const organizations = new Set(items.map((item) => item.organizationId).filter(Boolean)).size;
  const yearOptions = [year - 1, year, year + 1];

  const eligibleCount = items.filter((item) => item.status === "planned").length;
  const today = todayPercent(year);
  return <div className="maintenance-page">
    <PageIntro
      actions={
        <>
          <Button onClick={openForm} variant="secondary">Настроить план</Button>
          <Button disabled={loading} onClick={requestGenerate}>
            {selected.length ? `Создать задачи · ${selected.length}` : "Создать задачи"}
          </Button>
        </>
      }
      title="План ТО"
      titleAside={<>
        <div className="year-stepper" role="group" aria-label="Год плана">
          <button aria-label="Предыдущий год" onClick={() => changeYear(year - 1)} type="button">‹</button>
          <strong>{year}</strong>
          <button aria-label="Следующий год" onClick={() => changeYear(year + 1)} type="button">›</button>
        </div>
        <ViewSwitch items={[{ value: "equipment", label: "По приборам" }, { value: "engineer", label: "По инженерам" }, { value: "organization", label: "По организациям" }]} label="Группировка плана" onValueChange={setView} value={view} />
      </>}
    />
    <ConfirmationDialog
      confirmLabel={`Создать ${plural(eligibleCount, "задачу", "задачи", "задач")}`}
      description={`Строки не выбраны, поэтому задачи будут созданы по всем запланированным периодам ${year} года: ${plural(eligibleCount, "период", "периода", "периодов")}. Назначенным инженерам уйдут уведомления.`}
      onConfirm={generate}
      onOpenChange={setConfirmAll}
      open={confirmAll}
      title="Создать задачи по всему плану?"
      tone="primary"
    />

    <DialogForm
      busy={saving}
      description="Сначала выберите прибор, затем задайте периоды ТО. Из сохранённого плана потом можно создать задачи инженерам."
      error={formError}
      onOpenChange={setFormOpen}
      onSubmit={submit}
      open={formOpen}
      size="lg"
      submitDisabled={!equipmentId}
      submitLabel="Сохранить план"
      title={`План прибора на ${year} год`}
    >
      <div className="maintenance-plan-form">
        <label className="maintenance-plan-form__device">
          Прибор *
          <Select onChange={(event) => chooseEquipment(event.target.value)} required value={equipmentId}>
            <option value="">Выберите прибор</option>
            {equipment.map((item) => (
              <option key={item.id} value={item.id}>{item.model} · S/N {item.serialNumber} · {item.organization ?? item.site ?? "без организации"}</option>
            ))}
          </Select>
        </label>
        {equipmentId ? (
          <div className="maintenance-plan-form__periods">
            <div className="maintenance-plan-form__periods-head">
              <div>
                <h3>Периоды ТО</h3>
                <p>{existingPlanCount > 0 ? `У прибора уже есть план на ${year} год. Сохранение заменит текущие периоды.` : `Можно задать от 1 до ${MAX_ANNUAL_MAINTENANCE_PERIODS} периодов в год.`}</p>
              </div>
              <span>{periods.length} из {MAX_ANNUAL_MAINTENANCE_PERIODS}</span>
            </div>
            <div className="maintenance-period-editor">
              {periods.map((period, index) => (
                <article aria-labelledby={`maintenance-period-${period.key}`} className="maintenance-period-card" key={period.key}>
                  <header>
                    <h4 id={`maintenance-period-${period.key}`}>ТО № {index + 1}</h4>
                    {periods.length > 1 ? <IconButton icon="close" label={`Удалить период ${index + 1}`} onClick={() => removePeriod(period.key)} /> : null}
                  </header>
                  <label>
                    Начало
                    <DatePicker onChange={(periodFrom) => updatePeriod(period.key, { periodFrom })} required value={period.periodFrom} />
                  </label>
                  <label>
                    Окончание
                    <DatePicker onChange={(periodTo) => updatePeriod(period.key, { periodTo })} required value={period.periodTo} />
                  </label>
                  <label>
                    Инженер
                    <Select onChange={(event) => updatePeriod(period.key, { assignedEngineerId: event.target.value })} value={period.assignedEngineerId}>
                      <option value="">Назначить позднее</option>
                      {engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.fullName}</option>)}
                    </Select>
                  </label>
                  <label>
                    Комментарий
                    <input maxLength={500} onChange={(event) => updatePeriod(period.key, { comment: event.target.value })} placeholder="Необязательно" value={period.comment} />
                  </label>
                </article>
              ))}
            </div>
            {periods.length < MAX_ANNUAL_MAINTENANCE_PERIODS
              ? <Button icon="plus" onClick={addPeriod} variant="secondary">Добавить период</Button>
              : <p className="form-hint">В год можно задать не больше {MAX_ANNUAL_MAINTENANCE_PERIODS} периодов ТО.</p>}
          </div>
        ) : <p className="maintenance-plan-form__empty">Сначала выберите прибор — тогда можно задать периоды ТО.</p>}
      </div>
    </DialogForm>

    <section className="card card--table maintenance-schedule">
      <CardHeader
        headingId="maintenance-schedule-title"
        meta={`${plural(items.length, "период", "периода", "периодов")} · задач создано: ${generatedCount} · ${plural(organizations, "организация", "организации", "организаций")}`}
        title={`График на ${year} год`}
      />
      <div className="maintenance-months" aria-hidden="true">{MAINTENANCE_MONTHS.map((month) => <span key={month}>{month}</span>)}{today !== undefined ? <i className="maintenance-today-label" style={{ left: `${today}%` }}>сегодня</i> : null}</div>
      {loading ? <div className="resource-state resource-state--skeleton" role="status"><span className="sr-only">Загружаем план</span>{[0, 1, 2, 3].map((row) => <div className="skeleton-row" key={row}><div className="skeleton-row__a" /><div className="skeleton-row__b" /><div className="skeleton-row__c" /></div>)}</div> : data ? data.groups.map((group) => {
        const first = group.items[0];
        // По приборам подписываем группу моделью и клиентом, а не одним серийным номером.
        const label = view === "equipment" && first ? `${first.equipment.manufacturer} ${first.equipment.model} · S/N ${first.equipment.serialNumber}` : group.label;
        const sub = view === "equipment" && first ? first.organization ?? first.site : undefined;
        return <article className="maintenance-group" key={group.key}>
        <header><h3>{label}{sub ? <small>{sub}</small> : null}</h3><span>{plural(group.items.length, "период", "периода", "периодов")}</span></header>
        {group.items.map((item) => <div className="maintenance-row" key={item.id}>
          <label className="maintenance-row__select"><input checked={selected.includes(item.id)} disabled={item.status !== "planned"} onChange={() => toggle(item.id)} type="checkbox" /><span className="sr-only">Выбрать период {formatMaintenancePeriod(item.periodFrom, item.periodTo)}</span></label>
          <div className="maintenance-row__identity"><strong>{view === "equipment" ? `ТО № ${item.periodNo}` : `${item.equipment.model} · S/N ${item.equipment.serialNumber}`}</strong><span>{formatMaintenancePeriod(item.periodFrom, item.periodTo)} · {item.assignedEngineerName ?? "инженер не назначен"}</span></div>
          <div className="maintenance-track">{today !== undefined ? <i aria-hidden="true" className="maintenance-today" style={{ left: `${today}%` }} /> : null}<span className={`maintenance-bar maintenance-bar--${item.status}`} style={{ left: `${item.timeline.leftPercent}%`, width: `${Math.max(item.timeline.widthPercent, 0.8)}%` }} title={formatMaintenancePeriod(item.periodFrom, item.periodTo)}>{item.timeline.crossesYearBoundary ? "↔" : ""}</span></div>
          <span className={`maintenance-status maintenance-status--${item.status}`}>{maintenancePlanStatusLabel[item.status]}</span>
        </div>)}
      </article>;
      }) : null}
      {!loading && data?.groups.length === 0 ? <p className="maintenance-empty">На {year} год периоды ТО ещё не заданы. Нажмите «Настроить план», чтобы добавить обслуживание приборов.</p> : null}
    </section>
  </div>;
}
