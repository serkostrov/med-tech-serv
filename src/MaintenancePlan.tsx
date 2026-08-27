import React, { useEffect, useState, type FormEvent } from "react";
import { MAX_ANNUAL_MAINTENANCE_PERIODS } from "./domain/maintenance-plan.js";
import type { MaintenancePlanListResponse, MaintenancePlanPeriodResponse } from "./types.js";
import { m2Api, type EquipmentApiRecord } from "./m2-api.js";
import { Button, CardHeader, DatePicker, DialogForm, IconButton, MetricCard, PageIntro, PageTabs, Select, toast } from "./ui.js";
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
      }
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

  return <div className="maintenance-page">
    <PageIntro
      actions={
        <>
          <Button onClick={openForm} variant="secondary">Настроить план</Button>
          <Button disabled={loading} onClick={() => void generate()}>
            {selected.length ? `Создать задачи · ${selected.length}` : "Создать задачи"}
          </Button>
        </>
      }
      description="Отметьте периоды обслуживания приборов и создайте из них заявки инженерам."
      title="План ТО"
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

    <div className="maintenance-toolbar" aria-label="Настройки представления">
      <PageTabs
        items={yearOptions.map((option) => ({ value: String(option), label: String(option) }))}
        label="Год плана"
        onValueChange={(value) => changeYear(Number(value))}
        value={String(year)}
      />
      <PageTabs
        items={[
          { value: "equipment", label: "По приборам" },
          { value: "engineer", label: "По инженерам" },
          { value: "organization", label: "По организациям" }
        ]}
        label="Группировка плана"
        onValueChange={setView}
        value={view}
      />
    </div>

    <div className="metric-grid metric-grid--three">
      <MetricCard detail="периодов обслуживания" icon="maintenance" label="В плане" value={String(items.length)} />
      <MetricCard detail="задач со связью с планом" icon="tasks" label="Сформировано" tone="purple" value={String(generatedCount)} />
      <MetricCard detail="в текущем представлении" icon="references" label="Организации" tone="green" value={String(organizations)} />
    </div>

    <section className="card card--table maintenance-schedule">
      <CardHeader
        headingId="maintenance-schedule-title"
        meta={`${data?.groups.length ?? 0} групп`}
        title={`График на ${year} год`}
      />
      <div className="maintenance-months" aria-hidden="true">{MAINTENANCE_MONTHS.map((month) => <span key={month}>{month}</span>)}</div>
      {loading ? <p className="maintenance-empty">Загружаем план…</p> : data ? data.groups.map((group) => <article className="maintenance-group" key={group.key}>
        <header><h3>{group.label}</h3><span>{group.items.length} периодов</span></header>
        {group.items.map((item) => <div className="maintenance-row" key={item.id}>
          <label className="maintenance-row__select"><input checked={selected.includes(item.id)} disabled={item.status !== "planned"} onChange={() => toggle(item.id)} type="checkbox" /><span className="sr-only">Выбрать период {formatMaintenancePeriod(item.periodFrom, item.periodTo)}</span></label>
          <div className="maintenance-row__identity"><strong>{view === "equipment" ? `ТО № ${item.periodNo}` : `${item.equipment.model} · S/N ${item.equipment.serialNumber}`}</strong><span>{formatMaintenancePeriod(item.periodFrom, item.periodTo)} · {item.assignedEngineerName ?? "инженер не назначен"}</span></div>
          <div className="maintenance-track"><span className={`maintenance-bar maintenance-bar--${item.status}`} style={{ left: `${item.timeline.leftPercent}%`, width: `${Math.max(item.timeline.widthPercent, 0.8)}%` }} title={formatMaintenancePeriod(item.periodFrom, item.periodTo)}>{item.timeline.crossesYearBoundary ? "↔" : ""}</span></div>
          <span className={`maintenance-status maintenance-status--${item.status}`}>{maintenancePlanStatusLabel[item.status]}</span>
        </div>)}
      </article>) : null}
      {!loading && data?.groups.length === 0 ? <p className="maintenance-empty">На {year} год периоды ТО ещё не заданы. Нажмите «Настроить план», чтобы добавить обслуживание приборов.</p> : null}
    </section>
  </div>;
}
