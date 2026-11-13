import React, { useEffect, useState, type FormEvent } from "react";
import { MAX_ANNUAL_MAINTENANCE_PERIODS } from "./domain/maintenance-plan.js";
import type { MaintenancePlanListResponse, MaintenancePlanPeriodResponse } from "./types.js";
import { m2Api, type EquipmentApiRecord } from "./m2-api.js";
import { Button, CardHeader, ConfirmationDialog, DatePicker, DialogForm, IconButton, PageIntro, Select, ViewSwitch, toast } from "./ui.js";
import { formatIsoCalendarDate } from "./date-format.js";
import { EquipmentFolderPicker } from "./EquipmentFolderPicker.js";
import { equipmentOptionMeta, equipmentOptionTitle } from "./equipment-options.js";

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

/** По периоду уже создана задача: такой период план не меняет. */
export function periodHasTask(item: Pick<MaintenancePlanPeriodResponse, "generatedTaskId" | "status">): boolean {
  return Boolean(item.generatedTaskId) || item.status === "generated" || item.status === "completed";
}

/** По периоду можно создать задачу: он запланирован, и задачи по нему ещё нет. */
export function canGenerateTask(item: Pick<MaintenancePlanPeriodResponse, "generatedTaskId" | "status">): boolean {
  return item.status === "planned" && !item.generatedTaskId;
}

/**
 * Период в окне только для просмотра: по нему создана задача или он закрыт (не «Запланировано»).
 * То же правило, что в функции базы replace_maintenance_plan: такие периоды она не меняет.
 */
export function periodLocked(item: Pick<MaintenancePlanPeriodResponse, "generatedTaskId" | "status">): boolean {
  return item.status !== "planned" || Boolean(item.generatedTaskId);
}

/** Итог «Создать задачи» одной строкой: сколько создано, что уже было и почему не создались остальные. */
export function generationSummary(result: { readonly created: readonly unknown[]; readonly existing: readonly unknown[]; readonly failures: readonly { readonly error: string }[] }): { readonly tone: "success" | "warning"; readonly text: string } {
  if (result.failures.length) {
    const reason = result.failures[0]?.error;
    return {
      tone: "warning",
      text: `Создано задач: ${result.created.length}. Уже были: ${result.existing.length}. Не создано: ${result.failures.length}${reason ? ` — ${reason}` : ""}`
    };
  }
  if (result.created.length === 0) return { tone: "success", text: "Новых задач нет: по выбранным периодам задачи уже созданы." };
  return { tone: "success", text: `Создано задач: ${result.created.length}. Они на доске в колонке «Запланировано» и станут новыми к началу периода ТО.` };
}

const NO_EQUIPMENT: readonly EquipmentApiRecord[] = [];

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
export interface PeriodDraft {
  readonly key: number;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly assignedEngineerId: string;
  readonly comment: string;
  /** По периоду создана задача или он закрыт: в окне только для просмотра, база его не меняет. */
  readonly locked: boolean;
  /** Почему период не меняется: «Задача создана», «Выполнено», «Отменено». */
  readonly lockLabel?: string;
  readonly engineerName?: string;
}

/**
 * Периоды прибора в черновик окна: по датам (номер ТО в окне и в графике — порядок дат),
 * периоды с задачей и закрытые — только для просмотра. Ключи начинаются с startKey.
 */
export function planDrafts(items: readonly MaintenancePlanPeriodResponse[], startKey: number): { readonly drafts: readonly PeriodDraft[]; readonly nextKey: number } {
  let key = startKey;
  const drafts = [...items]
    .sort((left, right) => left.periodFrom.localeCompare(right.periodFrom) || left.periodTo.localeCompare(right.periodTo))
    .map((item): PeriodDraft => {
      const locked = periodLocked(item);
      return {
        key: key++,
        periodFrom: item.periodFrom,
        periodTo: item.periodTo,
        assignedEngineerId: item.assignedEngineerId ?? "",
        comment: item.comment ?? "",
        locked,
        ...(locked ? { lockLabel: item.status === "planned" ? maintenancePlanStatusLabel.generated : maintenancePlanStatusLabel[item.status] } : {}),
        ...(item.assignedEngineerName ? { engineerName: item.assignedEngineerName } : {})
      };
    });
  return { drafts, nextKey: key };
}

function shiftIsoDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function defaultPeriod(year: number, key: number, previousTo?: string): PeriodDraft {
  if (!previousTo) return { key, periodFrom: `${year}-07-01`, periodTo: `${year}-07-15`, assignedEngineerId: "", comment: "", locked: false };
  const periodFrom = shiftIsoDate(previousTo, 1);
  return { key, periodFrom, periodTo: shiftIsoDate(periodFrom, 14), assignedEngineerId: "", comment: "", locked: false };
}

export function MaintenancePlanPage() {
  const initialYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(initialYear);
  const [view, setView] = useState<View>("equipment");
  const [data, setData] = useState<MaintenancePlanListResponse | null>(null);
  const [engineers, setEngineers] = useState<readonly { readonly id: string; readonly fullName: string }[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [equipmentId, setEquipmentId] = useState("");
  // Прибор выбирают поиском, как в новой задаче: список в тысячу приборов без поиска не пролистать.
  const [selectedDevice, setSelectedDevice] = useState<EquipmentApiRecord | null>(null);
  const [pickingDevice, setPickingDevice] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [periods, setPeriods] = useState<readonly PeriodDraft[]>([defaultPeriod(initialYear, 1)]);
  const [nextPeriodKey, setNextPeriodKey] = useState(2);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = async (targetYear = year, targetView = view) => {
    setLoading(true);
    try {
      const [plans, availableEngineers] = await Promise.all([
        m2Api.maintenancePlans(targetYear, targetView), m2Api.listTaskEngineers()
      ]);
      setData(plans);
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

  const chooseEquipment = (device: EquipmentApiRecord) => {
    const id = device.id;
    setSelectedDevice(device);
    setPickingDevice(false);
    setFormError(null);
    setEquipmentId(id);
    const existing = data?.items.filter((item) => item.equipmentId === id) ?? [];
    if (existing.length === 0) {
      setPeriods([defaultPeriod(year, nextPeriodKey)]);
      setNextPeriodKey((value) => value + 1);
      return;
    }
    const { drafts, nextKey } = planDrafts(existing, nextPeriodKey);
    setPeriods(drafts);
    setNextPeriodKey(nextKey);
  };

  const addPeriod = () => {
    if (periods.length >= MAX_ANNUAL_MAINTENANCE_PERIODS) return;
    // Новый период — после самого позднего, даже если периоды в окне идут не по датам.
    setPeriods((current) => [...current, defaultPeriod(year, nextPeriodKey, current.map((item) => item.periodTo).sort().at(-1))]);
    setNextPeriodKey((value) => value + 1);
  };

  const removePeriod = (key: number) => {
    if (periods.length <= 1) return;
    setPeriods((current) => current.filter((item) => item.key !== key || item.locked));
  };

  const openForm = () => {
    setFormError(null);
    setEquipmentId("");
    setSelectedDevice(null);
    setPickingDevice(false);
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
    const eligibleCount = data?.items.filter(canGenerateTask).length ?? 0;
    if (eligibleCount === 0) { toast.warning("Нет периодов со статусом «Запланировано» для генерации"); return; }
    setConfirmAll(true);
  };
  const generate = async () => {
    if (generating) return;
    const eligibleCount = data?.items.filter(canGenerateTask).length ?? 0;
    if (!selected.length && eligibleCount === 0) {
      toast.warning("Нет периодов со статусом «Запланировано» для генерации");
      return;
    }
    setGenerating(true);
    try {
      // Без выбора — все запланированные периоды года: сервер сам находит их, а не тысяча id в запросе.
      const result = selected.length ? await m2Api.generateMaintenanceTasks(year, selected) : await m2Api.generateMaintenanceTasks(year);
      const summary = generationSummary(result);
      if (summary.tone === "warning") toast.warning(summary.text);
      else toast.success(summary.text);
      setSelected([]);
      await load();
    } catch (generateError) {
      toast.error(generateError instanceof Error ? generateError.message : "Не получилось создать плановые задачи");
    } finally {
      setGenerating(false);
    }
  };

  const toggle = (id: string) => setSelected((current) => current.includes(id)
    ? current.filter((item) => item !== id) : [...current, id]);
  const items = data?.items ?? [];
  const existingPlanCount = items.filter((item) => item.equipmentId === equipmentId).length;
  // Периоды с задачей и закрытые в окне только для просмотра: база их не меняет.
  const lockedPeriodCount = periods.filter((item) => item.locked).length;
  const generatedCount = items.filter(periodHasTask).length;
  const organizations = new Set(items.map((item) => item.organizationId).filter(Boolean)).size;

  const eligibleCount = items.filter(canGenerateTask).length;
  const today = todayPercent(year);
  return <div className="maintenance-page">
    <PageIntro
      actions={
        <>
          <Button onClick={openForm} variant="secondary">Настроить план</Button>
          <Button busy={generating} busyLabel="Создаём задачи…" disabled={loading} onClick={requestGenerate}>
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
      description={`Строки не выбраны, поэтому задачи будут созданы по всем запланированным периодам ${year} года: ${plural(eligibleCount, "период", "периода", "периодов")}. Они появятся на доске в колонке «Запланировано» и станут новыми к началу периода ТО.`}
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
      submitDisabled={!equipmentId || pickingDevice}
      submitLabel="Сохранить план"
      title={`План прибора на ${year} год`}
    >
      <div className="maintenance-plan-form">
        <div className="equipment-picker maintenance-plan-form__device">
          <span className="equipment-picker__label">Прибор *</span>
          {selectedDevice && !pickingDevice ? (
            <div className="equipment-picker__selected">
              <p className="equipment-picker__result">
                <strong>{equipmentOptionTitle(selectedDevice)}</strong>
                <span>{equipmentOptionMeta(selectedDevice)}</span>
              </p>
              <Button onClick={() => setPickingDevice(true)} variant="secondary">Сменить</Button>
            </div>
          ) : (
            <>
              <EquipmentFolderPicker allowCreate={false} equipment={NO_EQUIPMENT} onSelect={chooseEquipment} />
              {selectedDevice ? <Button className="maintenance-plan-form__keep" onClick={() => setPickingDevice(false)} variant="ghost">Не менять прибор</Button> : null}
            </>
          )}
        </div>
        {/* Пока выбирают другой прибор, периоды старого не показываем и не сохраняем. */}
        {equipmentId && !pickingDevice ? (
          <div className="maintenance-plan-form__periods">
            <div className="maintenance-plan-form__periods-head">
              <div>
                <h3>Периоды ТО</h3>
                <p>{lockedPeriodCount > 0
                  ? "Периоды с задачей и закрытые не меняются: сроки ТО переносите в самих задачах. Остальные периоды можно менять и добавлять новые."
                  : existingPlanCount > 0 ? `У прибора уже есть план на ${year} год. Сохранение заменит текущие периоды.` : `Можно задать от 1 до ${MAX_ANNUAL_MAINTENANCE_PERIODS} периодов в год.`}</p>
              </div>
              <span>{periods.length} из {MAX_ANNUAL_MAINTENANCE_PERIODS}</span>
            </div>
            <div className="maintenance-period-editor">
              {periods.map((period, index) => period.locked ? (
                <article aria-labelledby={`maintenance-period-${period.key}`} className="maintenance-period-card maintenance-period-card--locked" key={period.key}>
                  <header>
                    <h4 id={`maintenance-period-${period.key}`}>ТО № {index + 1}</h4>
                    <span className="maintenance-period-card__lock">{period.lockLabel ?? maintenancePlanStatusLabel.generated}</span>
                  </header>
                  <dl className="maintenance-period-card__facts">
                    <div><dt>Начало</dt><dd>{formatIsoCalendarDate(period.periodFrom)}</dd></div>
                    <div><dt>Окончание</dt><dd>{formatIsoCalendarDate(period.periodTo)}</dd></div>
                    <div><dt>Инженер</dt><dd>{period.engineerName ?? "не назначен"}</dd></div>
                    {period.comment ? <div><dt>Комментарий</dt><dd>{period.comment}</dd></div> : null}
                  </dl>
                </article>
              ) : (
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
        {group.items.map((item, index) => <div className="maintenance-row" key={item.id}>
          <label className="maintenance-row__select"><input checked={selected.includes(item.id)} disabled={!canGenerateTask(item)} onChange={() => toggle(item.id)} type="checkbox" /><span className="sr-only">Выбрать период {formatMaintenancePeriod(item.periodFrom, item.periodTo)}</span></label>
          <div className="maintenance-row__identity"><strong>{view === "equipment" ? `ТО № ${index + 1}` : `${item.equipment.model} · S/N ${item.equipment.serialNumber}`}</strong><span>{formatMaintenancePeriod(item.periodFrom, item.periodTo)} · {item.assignedEngineerName ?? "инженер не назначен"}</span></div>
          <div className="maintenance-track">{today !== undefined ? <i aria-hidden="true" className="maintenance-today" style={{ left: `${today}%` }} /> : null}<span className={`maintenance-bar maintenance-bar--${item.status}`} style={{ left: `${item.timeline.leftPercent}%`, width: `${Math.max(item.timeline.widthPercent, 0.8)}%` }} title={formatMaintenancePeriod(item.periodFrom, item.periodTo)}>{item.timeline.crossesYearBoundary ? "↔" : ""}</span></div>
          <span className={`maintenance-status maintenance-status--${item.status}`}>{maintenancePlanStatusLabel[item.status]}</span>
        </div>)}
      </article>;
      }) : null}
      {!loading && data?.groups.length === 0 ? <p className="maintenance-empty">На {year} год периоды ТО ещё не заданы. Нажмите «Настроить план», чтобы добавить обслуживание приборов.</p> : null}
    </section>
  </div>;
}
