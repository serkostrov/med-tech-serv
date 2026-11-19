import { EntityLink, useEntityNav } from "./entity-links.js";
import { MultiSelect } from "./MultiSelect.js";
import { RegistryPagination, usePageSize } from "./RegistryPagination.js";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { m2Api, type AssignmentSuggestionRecord, type EngineerCalendarData, type TaskCardResponse } from "./m2-api.js";
import {
  MAX_CALENDAR_DAYS,
  buildEngineerCalendar,
  calendarDayTitle,
  calendarRange,
  calendarRangeTitle,
  calendarRowBars,
  rankAssignmentCandidates,
  shiftCalendarRange,
  taskOccupiedRange,
  UNASSIGNED_ENGINEER,
  type CalendarBar,
  type CalendarMode,
  type CalendarRange,
  type CalendarRow,
  type CalendarTask,
  type EngineerCalendar as CalendarLayout
} from "./engineer-calendar.js";
import { companyToday } from "./task-dates.js";
import { Button, DatePicker, Dialog, ResourceState, StatusBadge, ViewSwitch, toast } from "./ui.js";
import { EngineerPicker } from "./EngineerPicker.js";
import { formatIsoCalendarDate } from "./date-format.js";
import { formatRussianCount } from "./equipment-changes.js";
import { TASK_STATUS_LABELS } from "./domain/task-status.js";

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

/** Что показать в подсказке к задаче: номер, название, этап, срок, выезд, площадка и прибор. */
function taskHint(task: CalendarTask): string {
  return [
    `${task.number} · ${task.title}`,
    TASK_STATUS_LABELS[task.status] ?? task.status,
    taskPeriodText(task),
    task.visitDate ? `выезд ${formatIsoCalendarDate(task.visitDate.slice(0, 10))}` : null,
    task.siteName,
    task.equipmentLabel,
    task.isOverdue ? "просрочена" : null
  ].filter(Boolean).join(" · ");
}

/** Значки у фамилии: только беды — просрочка и перегруз. «Свободен» и цифры убраны (встреча 18.11). */
function rowStateBadges(row: CalendarRow): readonly { readonly tone: "neutral" | "danger" | "warning"; readonly text: string }[] {
  if (!row.engineer.isActive) return [{ tone: "neutral", text: "Отключён" }];
  const badges: { readonly tone: "danger" | "warning"; readonly text: string }[] = [];
  if (row.summary.overdueTaskCount > 0) badges.push({ tone: "danger", text: "Просрочка" });
  if (row.summary.overloadedDayCount > 0) badges.push({ tone: "warning", text: "Перегруз" });
  return badges;
}

function CalendarBarButton({ bar, dense, onOpen }: {
  readonly bar: CalendarBar;
  readonly dense: boolean;
  readonly onOpen: (taskId: string) => void;
}) {
  const task = bar.task;
  const days = bar.end - bar.start + 1;
  const classes = [
    "calendar-bar",
    `calendar-bar--${task.status}`,
    bar.continuesBefore ? "calendar-bar--from-before" : "",
    bar.continuesAfter ? "calendar-bar--to-after" : "",
    task.isOverdue ? "calendar-bar--overdue" : "",
    task.priority === "urgent" ? "calendar-bar--urgent" : ""
  ].filter(Boolean).join(" ");
  const hint = taskHint(task);
  return <button
    aria-label={hint}
    className={classes}
    onClick={() => onOpen(task.id)}
    style={{ gridColumn: `${bar.start + 1} / ${bar.end + 2}`, gridRow: String(bar.lane + 1) }}
    title={hint}
    type="button"
  >
    <span className="calendar-bar__number">{task.number}</span>
    {dense && days < 4 ? null : <span className="calendar-bar__title">{task.title}</span>}
  </button>;
}

/**
 * Дни инженера одной дорожкой: фон дней (выходные, сегодня) и полосы задач поверх. Цвет полосы —
 * только этап задачи; заливка перегруза, красная перекраска просроченной и черта дня выезда убраны:
 * «лишнее визуально, не перемудрить» (вторая встреча 18.11). Просрочку видно по красному номеру.
 */
function CalendarTrack({ row, dense, onOpenTask }: {
  readonly row: CalendarRow;
  readonly dense: boolean;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const { bars, lanes } = calendarRowBars(row);
  return <div
    className="engineer-calendar__track"
    role="cell"
    style={{
      gridColumn: `2 / span ${row.cells.length}`,
      gridTemplateColumns: `repeat(${row.cells.length}, minmax(0, 1fr))`,
      // Последний ряд добирает высоту строки, когда фамилия в две строки выше полос.
      gridTemplateRows: `repeat(${Math.max(lanes, 1)}, var(--calendar-lane)) minmax(0, 1fr)`
    }}
  >
    {row.cells.map((cell, index) => <span
      aria-hidden="true"
      className={`engineer-calendar__bg${cell.isWeekend ? " is-weekend" : ""}${cell.isToday ? " is-today" : ""}`}
      key={cell.date}
      style={{ gridColumn: String(index + 1) }}
      title={`${row.engineer.fullName} · ${calendarDayTitle(cell.date)}: ${cell.placements.length ? formatRussianCount(cell.placements.length, ["задача", "задачи", "задач"]) : "свободен"}`}
    />)}
    {bars.map((bar) => <CalendarBarButton bar={bar} dense={dense} key={bar.task.id} onOpen={onOpenTask} />)}
  </div>;
}

function CalendarRowView({ row, dense, showUndated, onOpenTask }: {
  readonly row: CalendarRow;
  readonly dense: boolean;
  readonly showUndated: boolean;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const unassigned = row.engineer.id === UNASSIGNED_ENGINEER.id;
  const badges = unassigned ? [] : rowStateBadges(row);
  return <div className={`engineer-calendar__row${unassigned ? " engineer-calendar__row--unassigned" : ""}`} role="row">
    <div className={`engineer-calendar__name${row.engineer.isActive ? "" : " is-inactive"}`} role="rowheader">
      {unassigned
        ? <strong>Не назначены</strong>
        : <strong><EntityLink target={{ kind: "engineer", id: row.engineer.id }}>{row.engineer.fullName}</EntityLink></strong>}
      {badges.length ? <span>{badges.map((badge) => <StatusBadge key={badge.text} tone={badge.tone}>{badge.text}</StatusBadge>)}</span> : null}
    </div>
    <CalendarTrack dense={dense} onOpenTask={onOpenTask} row={row} />
    {showUndated ? <div className="engineer-calendar__undated" role="cell">
      {row.undatedTasks.map((task) => <button
        aria-label={taskHint(task)}
        className={`calendar-bar calendar-bar--undated calendar-bar--${task.status}`}
        key={task.id}
        onClick={() => onOpenTask(task.id)}
        title={taskHint(task)}
        type="button"
      >
        <span className="calendar-bar__number">{task.number}</span>
      </button>)}
    </div> : null}
  </div>;
}

/**
 * Сама сетка: дни в шапке, строка на инженера, клетка на день. Вынесена отдельно, чтобы
 * раскладку можно было отрисовать и проверить без запросов к базе.
 */
/**
 * Свой календарь инженера на телефоне — списком по дням (аудит 17.11, № 91): в широкой
 * сетке на узком экране видно два с половиной дня и колонку с собственным именем.
 * На широком экране список прячется, остаётся сетка.
 */
function OwnDayList({ calendar, onOpenTask }: {
  readonly calendar: CalendarLayout;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const row = calendar.rows[0];
  const busy = row ? row.cells.filter((cell) => cell.placements.length > 0) : [];
  return <div className="own-day-list">
    {busy.length === 0
      ? <p className="own-day-list__empty">В этом периоде задач нет.</p>
      : <ol>{busy.map((cell) => {
        const day = calendar.days.find((item) => item.date === cell.date);
        return <li className={cell.isToday ? "is-today" : undefined} key={cell.date}>
          <h4>{day?.weekdayLabel ?? ""} {calendarDayTitle(cell.date)}{cell.isToday ? " · сегодня" : ""}</h4>
          <ul>{cell.placements.map((placement) => <li key={placement.task.id}>
            <button className={`own-day-list__task${placement.task.isOverdue ? " is-overdue" : ""}`} onClick={() => onOpenTask(placement.task.id)} type="button">
              <strong>{placement.task.number}</strong> {placement.task.title}
              <small>{[placement.task.siteName, placement.task.isOverdue ? "срок прошёл" : placement.dayCount > 1 ? `день ${placement.dayIndex} из ${placement.dayCount}` : ""].filter(Boolean).join(" · ")}</small>
            </button>
          </li>)}</ul>
        </li>;
      })}</ol>}
  </div>;
}

export function EngineerCalendarGrid({ calendar, title, onOpenTask, reserveBottom = 0 }: {
  readonly calendar: CalendarLayout;
  readonly title: string;
  readonly onOpenTask: (taskId: string) => void;
  /** Место под строкой страниц внизу: сетка доходит до неё, а не до края экрана. */
  readonly reserveBottom?: number;
}) {
  // В длинном периоде названия не влезают: у коротких полос остаётся номер, полное — в подсказке.
  const dense = calendar.days.length >= DENSE_FROM_DAYS;
  const rows = calendar.unassignedRow ? [calendar.unassignedRow, ...calendar.rows] : calendar.rows;
  // Столбец «Без срока» — только если такие задачи есть: пустой столбец из прочерков не нужен.
  const showUndated = rows.some((row) => row.undatedTasks.length > 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  useFillScreenHeight(scrollRef, rows.length, reserveBottom);
  return <div
    aria-label={`Календарь загрузки: ${title}`}
    className="engineer-calendar__scroll"
    ref={scrollRef}
    role="region"
    tabIndex={0}
  >
    <div
      aria-label={`Загрузка инженеров: ${title}`}
      className={`engineer-calendar__grid${dense ? " engineer-calendar__grid--dense" : ""}${showUndated ? " engineer-calendar__grid--undated" : ""}`}
      role="table"
      style={{ ["--calendar-days" as string]: String(calendar.days.length) }}
    >
      <div className="engineer-calendar__head" role="row">
        <div className="engineer-calendar__corner" role="columnheader">Инженер</div>
        {calendar.days.map((day, index) => <div
          className={`engineer-calendar__day${day.isWeekend ? " is-weekend" : ""}${day.isToday ? " is-today" : ""}${day.isPast ? " is-past" : ""}`}
          key={day.date}
          role="columnheader"
          title={calendarDayTitle(day.date)}
        >
          {/* Месяц — только на 1-м числе внутри периода и в строке дня недели, чтобы числа стояли
              на одной линии («1 ноября съехал», вторая встреча 18.11). Месяц периода — в заголовке. */}
          <span>{index > 0 && day.date.endsWith("-01") ? <b className="engineer-calendar__month">{dense ? day.monthLabel : `${day.weekdayLabel} · ${day.monthLabel}`}</b> : day.weekdayLabel}</span>
          <strong>{day.dayLabel}</strong>
        </div>)}
        {showUndated ? <div className="engineer-calendar__undated-head" role="columnheader">Без срока</div> : null}
      </div>
      {rows.map((row) => <CalendarRowView dense={dense} key={row.engineer.id || "unassigned"} onOpenTask={onOpenTask} row={row} showUndated={showUndated} />)}
    </div>
  </div>;
}

/**
 * Сетка листается внутри себя, чтобы шапка с днями стояла на месте, — и доходит до низа экрана
 * (18.11: «поле надо продлить до конца, почему оно обрезано»). Раньше высота была «экран минус
 * 240 пикселей» с запасом, и снизу оставалась пустая полоса. Теперь считаем по месту сетки на
 * странице: в разделе «Инженеры» и на странице инженера она начинается на разной высоте.
 */
function useFillScreenHeight(ref: React.RefObject<HTMLDivElement | null>, rowCount: number, reserveBottom: number) {
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof window === "undefined") return;
    const fit = () => {
      if (window.innerWidth <= 760) { element.style.maxHeight = ""; return; }
      const top = element.getBoundingClientRect().top + window.scrollY;
      element.style.maxHeight = `${Math.max(420, window.innerHeight - top - 16 - reserveBottom)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [ref, rowCount, reserveBottom]);
}

/** Можно ли отсюда назначить или сменить инженера: решают этап задачи и права, как в «Задачах». */
function taskAssignable(card: TaskCardResponse): boolean {
  return card.availableActions.some((action) => action.code === "assign") || card.canReassign === true;
}

/** Почему инженера сейчас не выбрать: объясняем словами, а не прячем список молча. */
function assignRefusal(card: TaskCardResponse): string {
  if (card.task.status === "planned") {
    return "Задача пока запланирована по ТО. Чтобы назначить инженера, сначала отметьте её новой в разделе «Задачи».";
  }
  if (["under_review", "closed", "cancelled"].includes(card.task.status)) {
    return "Инженера этой задачи уже не меняют: она сдана, закрыта или отменена.";
  }
  return "Назначать инженеров может координатор или руководитель.";
}

/**
 * Карточка задачи из календаря: посмотреть и назначить инженера, не уходя на другой экран.
 * Полный разбор задачи остаётся в разделе «Задачи», здесь только то, что нужно для раздачи
 * выездов: срок, площадка, прибор и выбор инженера с подсказкой по занятости.
 */
function CalendarTaskDialog({ taskId, onClose, onAssigned }: {
  readonly taskId: string;
  readonly onClose: () => void;
  readonly onAssigned: () => void;
}) {
  const [card, setCard] = useState<TaskCardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState<readonly AssignmentSuggestionRecord[]>([]);
  // Пока занятость считается, «инженеров нет» писать рано: отличаем ожидание от пустого ответа.
  const [suggestionsState, setSuggestionsState] = useState<"loading" | "ready">("loading");
  // Инженера в окне календаря не предвыбираем: назначение — решение человека, и оно
  // не должно происходить одним нажатием по задаче, открытой «просто посмотреть».
  const [engineerId, setEngineerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSuggestionsState("loading");
    setError(null);
    void m2Api.taskCard(taskId)
      .then(async (loaded) => {
        if (cancelled) return;
        setCard(loaded);
        setEngineerId("");
        // Можно ли назначать, решает сама задача: её этап и права, как в разделе «Задачи».
        if (!taskAssignable(loaded)) {
          setSuggestionsState("ready");
          return;
        }
        const hints = await m2Api.taskAssignmentSuggestions(
          taskId,
          loaded.equipment?.manufacturer ?? "",
          loaded.equipment?.model,
          { periodFrom: loaded.task.periodFrom, periodTo: loaded.task.periodTo, visitDate: loaded.task.visitDate }
        );
        if (!cancelled) {
          setSuggestions(rankAssignmentCandidates(hints));
          setSuggestionsState("ready");
        }
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Не получилось открыть задачу");
        setSuggestionsState("ready");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId]);

  const assign = async () => {
    if (!card || !engineerId) return;
    setBusy(true);
    setError(null);
    try {
      // Смена инженера — только там, где это видит база (canReassign). У новой задачи
      // с инженером из плана ТО это всё ещё назначение: оно и переводит её в «Назначена».
      if (card.canReassign === true) await m2Api.reassignTask(taskId, engineerId);
      else await m2Api.assignTask(taskId, engineerId);
      const name = suggestions.find((item) => item.engineerId === engineerId)?.fullName;
      toast.success(name
        ? `${card.canReassign === true ? "Инженер изменён" : "Инженер назначен"}: ${name}`
        : card.canReassign === true ? "Инженер изменён" : "Инженер назначен");
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
  const canChange = card ? taskAssignable(card) : false;
  return (
    <Dialog
      busy={busy}
      description={task ? `${TASK_STATUS_LABELS[task.status] ?? task.status} · срок ${taskPeriodText({ id: task.id, number: task.number, title: task.title, status: task.status, periodFrom: task.periodFrom, periodTo: task.periodTo, visitDate: task.visitDate })}` : "Загружаем задачу…"}
      footer={<>
        <Button disabled={busy} onClick={onClose} variant="secondary">Закрыть</Button>
        {canChange ? <Button busy={busy} disabled={!engineerId} onClick={() => void assign()}>{card?.canReassign === true ? "Сменить инженера" : "Назначить инженера"}</Button> : null}
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
          <span className="engineer-picker-field__label">{card.canReassign === true ? "Кому передать" : "Кого назначить"}</span>
          <EngineerPicker items={suggestions} onChange={setEngineerId} state={suggestionsState} value={engineerId} />
        </div> : <p className="form-hint">{assignRefusal(card)}</p>}
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
/** Этапы в фильтре календаря — по порядку жизни задачи. */
const CALENDAR_STATUS_FILTER: readonly string[] = ["planned", "new", "assigned", "in_progress", "under_review", "closed"];

/**
 * Календарь загрузки. Координатор видит всех инженеров и может отобрать одного и этап
 * задачи (встреча 16.11: «два фильтра — тип задачи и инженер»). Инженер видит только
 * себя — это решает и база (engineer_calendar_scope), — а задачу открывает своей карточкой.
 */
export function EngineerCalendar({ ownOnly = false, onOpenTask, engineerId }: {
  /** Календарь инженера: только его задачи, без фильтра по людям и без «не назначенных». */
  readonly ownOnly?: boolean;
  /** Календарь одного инженера на его странице (18.11): только его задачи, без выбора инженеров. */
  readonly engineerId?: string;
  /** Открыть задачу своей карточкой вместо окна назначения. */
  readonly onOpenTask?: (taskId: string) => void;
} = {}) {
  const today = companyToday();
  // Инженеры и этапы — по нескольку (18.11: «везде, где списки, выбор нескольких»).
  const [engineerFilter, setEngineerFilter] = useState<readonly string[]>(engineerId ? [engineerId] : []);
  const nav = useEntityNav();
  // Инженеры постранично (18.11), как письма. «Не назначены» — на каждой странице сверху.
  const { pageSize, setPageSize } = usePageSize("engineer-calendar");
  const [pageIndex, setPageIndex] = useState(0);
  const [statusFilter, setStatusFilter] = useState<readonly string[]>([]);
  const [mode, setMode] = useState<CalendarMode>("week");
  const [range, setRange] = useState<CalendarRange>(() => calendarRange("week", today));
  // Свой период набирают в двух полях: показываем его, только когда обе даты заданы.
  const [customDraft, setCustomDraft] = useState<CalendarRange>(() => calendarRange("week", today));
  // Данные храним вместе с периодом, за который они пришли: пока летит запрос нового
  // периода, сетка должна показывать прежний, а не раскладывать старые задачи по новым дням.
  const [data, setData] = useState<{ readonly range: CalendarRange; readonly loaded: EngineerCalendarData }>(
    () => ({ range: calendarRange("week", today), loaded: EMPTY_CALENDAR })
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Отказ по своему периоду показываем прямо у полей: иначе человек меняет дату, а сетка молчит.
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  // Ответ на прежний период не должен затереть свежий: периоды переключают быстро.
  const loadTurn = useRef(0);

  const load = async (next: CalendarRange) => {
    const turn = ++loadTurn.current;
    setLoading(true);
    try {
      const loaded = await m2Api.engineerCalendar(next.from, next.to);
      if (turn !== loadTurn.current) return;
      setData({ range: next, loaded });
      setLoadError(null);
    } catch (error) {
      if (turn !== loadTurn.current) return;
      const message = error instanceof Error ? error.message : "Не получилось загрузить календарь загрузки";
      setLoadError(message);
      setData({ range: next, loaded: EMPTY_CALENDAR });
      toast.error(message);
    } finally {
      if (turn === loadTurn.current) setLoading(false);
    }
  };

  useEffect(() => { void load(range); }, [range.from, range.to]);

  // Период и поля «С»/«По» меняются вместе: иначе стрелки двигают сетку, а поля врут,
  // и следующая правка даты собирает период из устаревшего черновика.
  const showRange = (next: CalendarRange) => {
    setRange(next);
    setCustomDraft(next);
    setPeriodError(null);
  };

  const changeMode = (next: CalendarMode) => {
    setMode(next);
    setPeriodError(null);
    if (next === "custom") {
      setCustomDraft(range);
      return;
    }
    // Остаёмся около уже показанного периода, а не прыгаем на сегодня.
    showRange(calendarRange(next, range.from));
  };

  const applyCustom = (draft: CalendarRange) => {
    setCustomDraft(draft);
    if (!draft.from || !draft.to) {
      setPeriodError(draft.from || draft.to ? "Укажите начало и конец периода" : null);
      return;
    }
    try {
      setRange(calendarRange("custom", draft.from, draft));
      setPeriodError(null);
    } catch (error) {
      // Период с ошибкой не грузим: показываем отказ по-русски и ждём исправления.
      setPeriodError(error instanceof Error ? error.message : "Укажите период короче");
    }
  };

  // Пересобираем раскладку только когда меняются данные или день: на каждое открытие
  // окна задачи заново раскладывать месяц на двадцать инженеров незачем.
  const calendar = useMemo(() => {
    // Отбор — до раскладки: перегруз и «свободен весь период» считаются по тому, что видно.
    const engineers = engineerFilter.length ? data.loaded.engineers.filter((item) => engineerFilter.includes(item.id)) : data.loaded.engineers;
    const tasks = data.loaded.tasks.filter((task) => (statusFilter.length === 0 || statusFilter.includes(task.status))
      && (engineerFilter.length === 0 || (task.engineerId !== undefined && engineerFilter.includes(task.engineerId))));
    return buildEngineerCalendar({ engineers, tasks, range: data.range, today });
  }, [data, today, engineerFilter, statusFilter]);
  // Страницы — только в общем календаре: у одного инженера (своём или на его странице) строка одна.
  const paged = !ownOnly && !engineerId;
  const pageCount = Math.max(1, Math.ceil(calendar.rows.length / pageSize));
  const shownPage = Math.min(pageIndex, pageCount - 1);
  const pagedCalendar = paged ? { ...calendar, rows: calendar.rows.slice(shownPage * pageSize, (shownPage + 1) * pageSize) } : calendar;
  // Нажатие на задачу открывает саму задачу, как везде (18.11: «я должен передавать внутри календаря?»).
  // Инженера меняют в карточке задачи. Окно назначения — только там, где переходов между страницами нет.
  const openTask = (taskId: string) => {
    if (onOpenTask) onOpenTask(taskId);
    else if (nav) nav.open({ kind: "task", id: taskId });
    else setOpenTaskId(taskId);
  };
  const showToday = today >= range.from && today <= range.to;
  return <>
    <div className="engineer-calendar-toolbar">
      <div className="engineer-calendar-toolbar__period" role="group" aria-label="Период календаря">
        <Button aria-label="Предыдущий период" onClick={() => showRange(shiftCalendarRange(range, mode, -1))} variant="secondary">‹</Button>
        <strong className="engineer-calendar-toolbar__title">{calendarRangeTitle(range, mode)}</strong>
        <Button aria-label="Следующий период" onClick={() => showRange(shiftCalendarRange(range, mode, 1))} variant="secondary">›</Button>
        <Button disabled={showToday} onClick={() => showRange(mode === "custom" ? { from: today, to: today } : calendarRange(mode, today))} variant="ghost">Сегодня</Button>
      </div>
      <ViewSwitch
        items={[{ value: "week", label: "Неделя" }, { value: "month", label: "Месяц" }, { value: "custom", label: "Свой период" }]}
        label="Период календаря"
        onValueChange={changeMode}
        value={mode}
      />
      <div className="engineer-calendar-toolbar__filters">
        {ownOnly || engineerId ? null : <MultiSelect compact emptyLabel="Все инженеры" label="Инженер" onChange={(next) => { setEngineerFilter(next); setPageIndex(0); }} options={data.loaded.engineers.map((item) => ({ value: item.id, label: item.fullName }))} searchPlaceholder="Фамилия инженера" value={engineerFilter} />}
        <MultiSelect compact emptyLabel="Все этапы" label="Этап" onChange={setStatusFilter} options={CALENDAR_STATUS_FILTER.map((code) => ({ value: code, label: TASK_STATUS_LABELS[code] ?? code }))} value={statusFilter} />
      </div>
      {mode === "custom" ? <div className="engineer-calendar-toolbar__custom">
        <label>С<DatePicker onChange={(from) => applyCustom({ ...customDraft, from })} value={customDraft.from} /></label>
        <label>По<DatePicker onChange={(to) => applyCustom({ ...customDraft, to })} value={customDraft.to} /></label>
        <small>Не больше {MAX_CALENDAR_DAYS} дней</small>
        {periodError ? <p className="form-error" role="alert">{periodError}</p> : null}
      </div> : null}
    </div>


    <section aria-labelledby="engineer-calendar-title" className="card card--table engineer-calendar">
      <h2 className="sr-only" id="engineer-calendar-title">Календарь загрузки</h2>
      {loadError && calendar.rows.length === 0
        ? <ResourceState description={loadError} onRetry={() => void load(range)} status="error" title="Календарь не загрузился" />
        : loading && calendar.rows.length === 0
          ? <ResourceState description="Подождите, сетка сейчас появится." status="loading" title="Загружаем календарь" />
          : calendar.rows.length === 0
            ? <ResourceState description="Когда появятся сотрудники с ролью инженера, их загрузка отобразится здесь." status="empty" title="Инженеров пока нет" />
            : <div aria-busy={loading} className={loading ? "engineer-calendar__pending" : undefined}>
              {/* Пока летит запрос нового периода, показываем прежний и помечаем ожидание:
                  раскладывать старые задачи по новым дням нельзя. */}
              <div className={ownOnly ? "own-calendar-grid" : undefined}>
                <EngineerCalendarGrid calendar={pagedCalendar} onOpenTask={openTask} reserveBottom={paged ? 64 : 0} title={calendarRangeTitle(calendar.range, mode)} />
                {paged ? <RegistryPagination alwaysShow ariaLabel="Страницы календаря по инженерам" onPageChange={setPageIndex} onPageSizeChange={(size) => { setPageSize(size); setPageIndex(0); }} pageIndex={shownPage} pageSize={pageSize} total={calendar.rows.length} /> : null}
              </div>
              {ownOnly ? <OwnDayList calendar={calendar} onOpenTask={openTask} /> : null}
            </div>}
    </section>

    {openTaskId ? <CalendarTaskDialog
      key={openTaskId}
      onAssigned={() => void load(range)}
      onClose={() => setOpenTaskId(null)}
      taskId={openTaskId}
    /> : null}
  </>;
}
