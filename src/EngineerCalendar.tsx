import React, { useEffect, useRef, useState } from "react";
import { m2Api, type AssignmentSuggestionRecord, type EngineerCalendarData, type TaskCardResponse } from "./m2-api.js";
import {
  MAX_CALENDAR_DAYS,
  OVERLOADED_TASKS_PER_DAY,
  buildEngineerCalendar,
  calendarDayTitle,
  calendarRange,
  calendarRangeTitle,
  periodLoadText,
  rankAssignmentCandidates,
  shiftCalendarRange,
  taskOccupiedRange,
  type CalendarMode,
  type CalendarPlacement,
  type CalendarRange,
  type CalendarRow,
  type CalendarTask
} from "./engineer-calendar.js";
import { companyToday } from "./task-dates.js";
import { Button, CardHeader, DatePicker, Dialog, MetricCard, ResourceState, StatusBadge, ViewSwitch, toast } from "./ui.js";
import { formatIsoCalendarDate } from "./date-format.js";
import { formatRussianCount } from "./equipment-changes.js";
import { TASK_STATUS_LABELS, TASK_STATUS_TONES } from "./domain/task-status.js";

const EMPTY_CALENDAR: EngineerCalendarData = { engineers: [], tasks: [] };

/** С этой длины периода подписи в клетках не читаются: показываем полоски, подробности в подсказке. */
const DENSE_FROM_DAYS = 11;

/** Период задачи словами: «16.11.2026 — 18.11.2026», один день — одной датой. */
function taskPeriodText(task: CalendarTask): string {
  const occupied = taskOccupiedRange(task);
  if (!occupied) return "срок не задан";
  if (occupied.from === occupied.to) return formatIsoCalendarDate(occupied.from);
  return `${formatIsoCalendarDate(occupied.from)} — ${formatIsoCalendarDate(occupied.to)}`;
}

/** Что показать в подсказке к задаче: номер, название, срок, площадка и прибор. */
function taskHint(task: CalendarTask, placement?: CalendarPlacement): string {
  return [
    `${task.number} · ${task.title}`,
    TASK_STATUS_LABELS[task.status] ?? task.status,
    taskPeriodText(task),
    placement && placement.dayCount > 1 ? `день ${placement.dayIndex} из ${placement.dayCount}` : null,
    placement?.isVisitDay ? "выезд в этот день" : null,
    task.siteName,
    task.equipmentLabel,
    task.isOverdue ? "просрочена" : null
  ].filter(Boolean).join(" · ");
}

/** Состояние строки инженера словами: это же подписано в значке. */
function rowStateLabel(row: CalendarRow): { readonly tone: "neutral" | "danger" | "warning" | "success" | "info"; readonly text: string } {
  if (!row.engineer.isActive) return { tone: "neutral", text: "Неактивен" };
  if (row.summary.overdueTaskCount > 0) return { tone: "danger", text: "Есть просрочки" };
  if (row.summary.overloadedDayCount > 0) return { tone: "warning", text: "Перегружен" };
  if (row.summary.taskCount === 0) return { tone: "success", text: "Свободен" };
  return { tone: "info", text: "Занят" };
}

function TaskChip({ placement, onOpen }: {
  readonly placement: CalendarPlacement;
  readonly onOpen: (taskId: string) => void;
}) {
  const task = placement.task;
  const classes = [
    "calendar-task",
    `calendar-task--${task.status}`,
    placement.isFirstVisibleDay ? "calendar-task--start" : "calendar-task--continued",
    placement.isLastVisibleDay ? "calendar-task--end" : "",
    task.isOverdue ? "calendar-task--overdue" : "",
    task.priority === "urgent" ? "calendar-task--urgent" : "",
    placement.isVisitDay ? "calendar-task--visit" : ""
  ].filter(Boolean).join(" ");
  return (
    <button
      aria-label={taskHint(task, placement)}
      className={classes}
      onClick={() => onOpen(task.id)}
      title={taskHint(task, placement)}
      type="button"
    >
      <span className="calendar-task__number">
        {placement.continuesBefore && placement.isFirstVisibleDay ? "←" : ""}
        {placement.isFirstVisibleDay ? task.number : "·"}
        {placement.continuesAfter && placement.isLastVisibleDay ? "→" : ""}
      </span>
      {placement.isFirstVisibleDay ? <span className="calendar-task__title">{task.title}</span> : null}
    </button>
  );
}

/**
 * Карточка задачи из календаря: посмотреть и назначить инженера, не уходя на другой экран.
 * Полный разбор задачи остаётся в разделе «Задачи», здесь только то, что нужно для раздачи
 * выездов: срок, площадка, прибор и выбор инженера с подсказкой по занятости.
 */
function CalendarTaskDialog({ taskId, canAssign, onClose, onAssigned }: {
  readonly taskId: string;
  readonly canAssign: boolean;
  readonly onClose: () => void;
  readonly onAssigned: () => void;
}) {
  const [card, setCard] = useState<TaskCardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState<readonly AssignmentSuggestionRecord[]>([]);
  const [engineerId, setEngineerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void m2Api.taskCard(taskId)
      .then(async (loaded) => {
        if (cancelled) return;
        setCard(loaded);
        setEngineerId("");
        if (!canAssign) return;
        const hints = await m2Api.taskAssignmentSuggestions(
          taskId,
          loaded.equipment?.manufacturer ?? "",
          loaded.equipment?.model,
          { periodFrom: loaded.task.periodFrom, periodTo: loaded.task.periodTo, visitDate: loaded.task.visitDate }
        );
        if (!cancelled) setSuggestions(rankAssignmentCandidates(hints));
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Не получилось открыть задачу");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, canAssign]);

  const assign = async () => {
    if (!card || !engineerId) return;
    setBusy(true);
    setError(null);
    try {
      if (card.engineer?.id) await m2Api.reassignTask(taskId, engineerId);
      else await m2Api.assignTask(taskId, engineerId);
      const name = suggestions.find((item) => item.engineerId === engineerId)?.fullName;
      toast.success(name ? `Инженер назначен: ${name}` : "Инженер назначен");
      onAssigned();
      onClose();
    } catch (assignError) {
      const message = assignError instanceof Error ? assignError.message : "Не получилось назначить инженера";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const task = card?.task;
  // Сменить инженера даёт база (canReassign); у задачи без инженера хватает права назначения.
  const canChange = canAssign && Boolean(task) && (card?.engineer?.id ? card.canReassign !== false : true);
  return (
    <Dialog
      busy={busy}
      description={task ? `${TASK_STATUS_LABELS[task.status] ?? task.status} · срок ${taskPeriodText({ id: task.id, number: task.number, title: task.title, status: task.status, periodFrom: task.periodFrom, periodTo: task.periodTo, visitDate: task.visitDate })}` : "Загружаем задачу…"}
      footer={<>
        <Button disabled={busy} onClick={onClose} variant="secondary">Закрыть</Button>
        {canChange ? <Button busy={busy} disabled={!engineerId} onClick={() => void assign()}>{card?.engineer?.id ? "Сменить инженера" : "Назначить инженера"}</Button> : null}
      </>}
      onOpenChange={(open) => { if (!open) onClose(); }}
      open
      size="lg"
      title={task ? `${task.number} · ${task.title}` : "Задача"}
    >
      {loading && !card ? <ResourceState description="Подождите, карточка сейчас появится." status="loading" title="Загружаем задачу" /> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {card && task ? <div className="calendar-task-card">
        <dl className="calendar-task-card__facts">
          <div><dt>Инженер</dt><dd>{card.engineer?.fullName ?? <span className="is-empty">Не назначен</span>}</dd></div>
          <div><dt>Площадка</dt><dd>{card.task.customer?.siteName ?? "—"}</dd></div>
          <div><dt>Прибор</dt><dd>{card.equipment ? `${card.equipment.manufacturer} ${card.equipment.model} · S/N ${card.equipment.serialNumber}` : "—"}</dd></div>
          <div><dt>Дата выезда</dt><dd>{task.visitDate ? formatIsoCalendarDate(task.visitDate.slice(0, 10)) : "не назначена"}</dd></div>
          {task.callReason ? <div><dt>Причина вызова</dt><dd>{task.callReason}</dd></div> : null}
        </dl>
        {canChange ? <div className="engineer-picker-field">
          <span className="engineer-picker-field__label">{card.engineer?.id ? "Кому передать" : "Кого назначить"}</span>
          {suggestions.length === 0 ? <p className="form-hint">Активных инженеров нет. Добавьте их в разделе «Инженеры».</p> : (
            <div aria-label="Инженеры" className="engineer-picker" role="listbox">
              {suggestions.map((item) => {
                const selected = item.engineerId === engineerId;
                const hints = [
                  item.previouslyWorkedWithEquipment ? "работал с таким прибором" : null,
                  item.load ? periodLoadText(item.load) : item.isAvailable ? "свободен" : "занят"
                ].filter(Boolean).join(" · ");
                return (
                  <button
                    aria-selected={selected}
                    className={`engineer-picker__option${selected ? " is-selected" : ""}${item.load?.isOverloaded ? " engineer-picker__option--overloaded" : ""}`}
                    key={item.engineerId}
                    onClick={() => setEngineerId(item.engineerId)}
                    role="option"
                    type="button"
                  >
                    <strong>{item.fullName}</strong>
                    <span>{hints}</span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="form-hint">Подсказка считает занятость на срок этой задачи и ничего не запрещает: решение за вами.</p>
        </div> : canAssign ? <p className="form-hint">Инженера этой задачи уже не меняют: она сдана, закрыта или отменена.</p> : null}
      </div> : null}
    </Dialog>
  );
}

/**
 * Календарь загрузки инженеров: инженеры по строкам, дни периода по столбцам.
 * Видно, у кого какие задачи в какой день, кто перегружен и у кого окно.
 *
 * Дни и просрочка считаются по дню компании (Москва), как везде в системе.
 * Задачи за период отдаёт база (функция engineer_calendar, миграция 0051), раскладку
 * по дням делает чистый модуль engineer-calendar.ts.
 */
export function EngineerCalendar() {
  const today = companyToday();
  const [mode, setMode] = useState<CalendarMode>("week");
  const [range, setRange] = useState<CalendarRange>(() => calendarRange("week", today));
  // Свой период набирают в двух полях: показываем его, только когда обе даты заданы.
  const [customDraft, setCustomDraft] = useState<CalendarRange>(() => calendarRange("week", today));
  const [data, setData] = useState<EngineerCalendarData>(EMPTY_CALENDAR);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canAssign, setCanAssign] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  // Ответ на прежний период не должен затереть свежий: периоды переключают быстро.
  const loadTurn = useRef(0);

  const load = async (next: CalendarRange) => {
    const turn = ++loadTurn.current;
    setLoading(true);
    try {
      const loaded = await m2Api.engineerCalendar(next.from, next.to);
      if (turn !== loadTurn.current) return;
      setData(loaded);
      setLoadError(null);
    } catch (error) {
      if (turn !== loadTurn.current) return;
      const message = error instanceof Error ? error.message : "Не получилось загрузить календарь загрузки";
      setLoadError(message);
      setData(EMPTY_CALENDAR);
      toast.error(message);
    } finally {
      if (turn === loadTurn.current) setLoading(false);
    }
  };

  useEffect(() => { void load(range); }, [range.from, range.to]);
  useEffect(() => {
    void m2Api.hasPermission("tasks.assign").then(setCanAssign).catch(() => setCanAssign(false));
  }, []);

  const changeMode = (next: CalendarMode) => {
    setMode(next);
    if (next === "custom") {
      setCustomDraft(range);
      return;
    }
    // Остаёмся около уже показанного периода, а не прыгаем на сегодня.
    setRange(calendarRange(next, range.from));
  };

  const applyCustom = (draft: CalendarRange) => {
    setCustomDraft(draft);
    if (!draft.from || !draft.to) return;
    try {
      setRange(calendarRange("custom", draft.from, draft));
      setLoadError(null);
    } catch (error) {
      // Период с ошибкой не грузим: показываем отказ по-русски и ждём исправления.
      setLoadError(error instanceof Error ? error.message : "Укажите период короче");
    }
  };

  const calendar = buildEngineerCalendar({ engineers: data.engineers, tasks: data.tasks, range, today });
  const dense = calendar.days.length >= DENSE_FROM_DAYS;
  const showToday = today >= range.from && today <= range.to;
  return <>
    <div className="engineer-calendar-toolbar">
      <div className="engineer-calendar-toolbar__period" role="group" aria-label="Период календаря">
        <Button aria-label="Предыдущий период" onClick={() => setRange(shiftCalendarRange(range, mode, -1))} variant="secondary">‹</Button>
        <strong className="engineer-calendar-toolbar__title">{calendarRangeTitle(range, mode)}</strong>
        <Button aria-label="Следующий период" onClick={() => setRange(shiftCalendarRange(range, mode, 1))} variant="secondary">›</Button>
        <Button disabled={showToday && mode !== "custom"} onClick={() => { setRange(calendarRange(mode === "custom" ? "week" : mode, today)); if (mode === "custom") setMode("week"); }} variant="ghost">Сегодня</Button>
      </div>
      <ViewSwitch
        items={[{ value: "week", label: "Неделя" }, { value: "month", label: "Месяц" }, { value: "custom", label: "Свой период" }]}
        label="Период календаря"
        onValueChange={changeMode}
        value={mode}
      />
      {mode === "custom" ? <div className="engineer-calendar-toolbar__custom">
        <label>С<DatePicker onChange={(from) => applyCustom({ ...customDraft, from })} value={customDraft.from} /></label>
        <label>По<DatePicker onChange={(to) => applyCustom({ ...customDraft, to })} value={customDraft.to} /></label>
        <small>Не больше {MAX_CALENDAR_DAYS} дней</small>
      </div> : null}
    </div>

    <div className="metric-grid metric-grid--four">
      <MetricCard icon="engineers" label="Инженеров в сетке" value={String(calendar.rows.length)} />
      <MetricCard icon="tasks" label="Задач в периоде" tone="yellow" value={String(calendar.totals.taskCount)} />
      <MetricCard icon="clock" label={`Перегружены (от ${OVERLOADED_TASKS_PER_DAY} задач в день)`} tone="orange" value={String(calendar.totals.overloadedEngineerCount)} />
      <MetricCard icon="engineers" label="Свободны весь период" tone="purple" value={String(calendar.totals.freeEngineerCount)} />
    </div>

    <section className="card card--table engineer-calendar">
      <CardHeader
        headingId="engineer-calendar-title"
        meta={`${formatRussianCount(calendar.days.length, ["день", "дня", "дней"])} · ${formatRussianCount(calendar.totals.taskCount, ["задача", "задачи", "задач"])}${calendar.totals.undatedTaskCount ? ` · без срока: ${calendar.totals.undatedTaskCount}` : ""}`}
        title="Календарь загрузки"
      />
      {loadError && calendar.rows.length === 0
        ? <ResourceState description={loadError} status="error" title="Календарь не загрузился" />
        : loading && calendar.rows.length === 0
          ? <ResourceState description="Подождите, сетка сейчас появится." status="loading" title="Загружаем календарь" />
          : calendar.rows.length === 0
            ? <ResourceState description="Когда появятся сотрудники с ролью инженера, их загрузка отобразится здесь." status="empty" title="Инженеров пока нет" />
            : <div className="engineer-calendar__scroll">
              <div
                className={`engineer-calendar__grid${dense ? " engineer-calendar__grid--dense" : ""}`}
                role="table"
                aria-label={`Загрузка инженеров: ${calendarRangeTitle(range, mode)}`}
                style={{ ["--calendar-days" as string]: String(calendar.days.length) }}
              >
                <div className="engineer-calendar__head" role="row">
                  <div className="engineer-calendar__corner" role="columnheader">Инженер</div>
                  {calendar.days.map((day) => <div
                    className={`engineer-calendar__day${day.isWeekend ? " is-weekend" : ""}${day.isToday ? " is-today" : ""}${day.isPast ? " is-past" : ""}`}
                    key={day.date}
                    role="columnheader"
                    title={calendarDayTitle(day.date)}
                  >
                    <span>{day.weekdayLabel}</span>
                    <strong>{day.dayLabel}</strong>
                    {day.startsMonth ? <small>{day.monthLabel}</small> : null}
                  </div>)}
                  <div className="engineer-calendar__undated-head" role="columnheader">Без срока</div>
                </div>
                {calendar.rows.map((row) => {
                  const state = rowStateLabel(row);
                  return <div className="engineer-calendar__row" key={row.engineer.id} role="row">
                    <div className={`engineer-calendar__name${row.engineer.isActive ? "" : " is-inactive"}`} role="rowheader">
                      <strong>{row.engineer.fullName}</strong>
                      <span>
                        <StatusBadge tone={state.tone}>{state.text}</StatusBadge>
                        <small>{formatRussianCount(row.summary.taskCount, ["задача", "задачи", "задач"])} · пик {row.summary.busiestDayCount} · окон {row.summary.freeWorkdayCount}</small>
                      </span>
                    </div>
                    {row.cells.map((cell) => <div
                      className={`engineer-calendar__cell engineer-calendar__cell--${cell.level}${cell.isWeekend ? " is-weekend" : ""}${cell.isToday ? " is-today" : ""}`}
                      key={cell.date}
                      role="cell"
                      title={`${row.engineer.fullName} · ${calendarDayTitle(cell.date)}: ${cell.placements.length ? formatRussianCount(cell.placements.length, ["задача", "задачи", "задач"]) : "свободен"}`}
                    >
                      {cell.placements.map((placement) => <TaskChip key={placement.task.id} onOpen={setOpenTaskId} placement={placement} />)}
                    </div>)}
                    <div className="engineer-calendar__undated" role="cell">
                      {row.undatedTasks.length === 0 ? <span className="is-empty">—</span> : row.undatedTasks.map((task) => <button
                        className="calendar-task calendar-task--undated"
                        key={task.id}
                        onClick={() => setOpenTaskId(task.id)}
                        title={taskHint(task)}
                        type="button"
                      >
                        <span className="calendar-task__number">{task.number}</span>
                      </button>)}
                    </div>
                  </div>;
                })}
              </div>
            </div>}
      {calendar.unassignedTasks.length > 0 ? <div className="engineer-calendar__unassigned">
        <h3>Ещё не назначены · {calendar.unassignedTasks.length}</h3>
        <p>Задачи периода без инженера. Откройте задачу и выберите, кому её отдать.</p>
        <div className="engineer-calendar__unassigned-list">
          {calendar.unassignedTasks.map((task) => <button
            className={`calendar-task calendar-task--${task.status}${task.isOverdue ? " calendar-task--overdue" : ""}`}
            key={task.id}
            onClick={() => setOpenTaskId(task.id)}
            title={taskHint(task)}
            type="button"
          >
            <span className="calendar-task__number">{task.number}</span>
            <span className="calendar-task__title">{task.title}</span>
            <StatusBadge tone={TASK_STATUS_TONES[task.status] ?? "neutral"}>{taskPeriodText(task)}</StatusBadge>
          </button>)}
        </div>
      </div> : null}
      <p className="engineer-calendar__legend">
        Задача на несколько дней занимает каждый свой день · <i className="calendar-legend calendar-legend--overloaded" /> перегруз: {OVERLOADED_TASKS_PER_DAY} и больше задач в день
        · <i className="calendar-legend calendar-legend--weekend" /> суббота и воскресенье · задачи без срока — в последнем столбце
      </p>
    </section>

    {openTaskId ? <CalendarTaskDialog
      canAssign={canAssign}
      key={openTaskId}
      onAssigned={() => void load(range)}
      onClose={() => setOpenTaskId(null)}
      taskId={openTaskId}
    /> : null}
  </>;
}
