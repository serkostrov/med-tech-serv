import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import {
  formatIsoCalendarDate,
  isoCalendarDate,
  parseDisplayDate,
  parseDisplayTime,
  parseIsoCalendarDate,
  joinLocalDateTime,
  splitLocalDateTime,
  todayIsoDate
} from "../../date-format.js";
import { cn } from "../../lib/utils.js";
import { Select } from "./select.js";

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;
const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"
] as const;
const POPOVER_WIDTH = 308;

export function isDatePickerSurface(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-date-picker]"));
}

function currentTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function monthCursorFromIso(value: string): { readonly year: number; readonly month: number } {
  const parsed = parseIsoCalendarDate(value) ?? parseIsoCalendarDate(todayIsoDate());
  const fallback = new Date();
  return parsed ?? { year: fallback.getFullYear(), month: fallback.getMonth() + 1 };
}

function shiftMonth(cursor: { readonly year: number; readonly month: number }, delta: number) {
  const date = new Date(cursor.year, cursor.month - 1 + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

function calendarCells(year: number, month: number): readonly (string | null)[] {
  const first = new Date(year, month - 1, 1);
  const leading = (first.getDay() + 6) % 7;
  const days = new Date(year, month, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= days; day += 1) {
    const iso = isoCalendarDate(year, month, day);
    if (iso) cells.push(iso);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function yearOptions(centerYear: number): readonly number[] {
  const years: number[] = [];
  for (let year = centerYear - 16; year <= centerYear + 10; year += 1) years.push(year);
  return years;
}

export interface DatePickerProps {
  readonly name?: string;
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onChange?: (value: string) => void;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly allowClear?: boolean;
  readonly id?: string;
  readonly "aria-label"?: string;
}

export function DatePicker({
  name,
  value,
  defaultValue = "",
  onChange,
  required = false,
  disabled = false,
  allowClear,
  id,
  "aria-label": ariaLabel
}: DatePickerProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const controlled = value !== undefined;
  const [internal, setInternal] = useState(defaultValue);
  const iso = (controlled ? value : internal) ?? "";
  const canClear = allowClear ?? !required;
  const [draft, setDraft] = useState(() => formatIsoCalendarDate(iso));
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => monthCursorFromIso(iso));
  const [position, setPosition] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const today = todayIsoDate();

  useEffect(() => {
    setDraft(formatIsoCalendarDate(iso));
  }, [iso]);

  const commit = (next: string) => {
    inputRef.current?.setCustomValidity("");
    if (!controlled) setInternal(next);
    onChange?.(next);
    setDraft(formatIsoCalendarDate(next));
  };

  const applyDraft = (): boolean => {
    const parsed = parseDisplayDate(draft);
    if (parsed === null) {
      if (!required) {
        setDraft(formatIsoCalendarDate(iso));
        return true;
      }
      inputRef.current?.setCustomValidity("Укажите дату в формате дд.мм.гггг");
      inputRef.current?.reportValidity();
      return false;
    }
    commit(parsed);
    return true;
  };

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const height = popoverRef.current?.offsetHeight ?? 360;
      let left = rect.left;
      let top = rect.bottom + 6;
      if (left + POPOVER_WIDTH > window.innerWidth - 8) left = window.innerWidth - POPOVER_WIDTH - 8;
      if (left < 8) left = 8;
      if (top + height > window.innerHeight - 8 && rect.top - height - 6 > 8) top = rect.top - height - 6;
      setPosition({ top, left, width: POPOVER_WIDTH });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, cursor]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const cells = useMemo(() => calendarCells(cursor.year, cursor.month), [cursor]);
  const years = useMemo(() => yearOptions(cursor.year), [cursor.year]);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      if (!applyDraft()) event.preventDefault();
      setOpen(false);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor(monthCursorFromIso(iso || today));
      setOpen(true);
    }
  };

  const popover = open && typeof document !== "undefined"
    ? createPortal(
      <div
        className="date-picker-popover"
        data-date-picker=""
        ref={popoverRef}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
        style={{ ...position, pointerEvents: "auto" }}
        aria-label="Календарь"
      >
        <div className="date-picker-popover__header">
          <button aria-label="Предыдущий месяц" onMouseDown={(event) => event.preventDefault()} onClick={() => setCursor((current) => shiftMonth(current, -1))} type="button">
            <ChevronLeft size={14} />
          </button>
          <div className="date-picker-popover__caption">
            <Select
              aria-label="Месяц"
              onChange={(event) => setCursor((current) => ({ ...current, month: Number(event.target.value) }))}
              value={cursor.month}
            >
              {MONTHS.map((label, index) => <option key={label} value={index + 1}>{label}</option>)}
            </Select>
            <Select
              aria-label="Год"
              onChange={(event) => setCursor((current) => ({ ...current, year: Number(event.target.value) }))}
              value={cursor.year}
            >
              {years.map((year) => <option key={year} value={year}>{year}</option>)}
            </Select>
          </div>
          <button aria-label="Следующий месяц" onMouseDown={(event) => event.preventDefault()} onClick={() => setCursor((current) => shiftMonth(current, 1))} type="button">
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="date-picker-popover__weekdays">
          {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
        </div>
        <div className="date-picker-popover__grid">
          {cells.map((day, index) => day
            ? <button
                aria-current={day === today ? "date" : undefined}
                aria-pressed={day === iso}
                className={cn("date-picker-popover__day", day === iso && "is-selected", day === today && "is-today")}
                key={day}
                onClick={() => { commit(day); setOpen(false); }}
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >{Number(day.slice(8))}</button>
            : <span className="date-picker-popover__empty" key={`empty-${index}`} />)}
        </div>
        <div className="date-picker-popover__footer">
          <button onMouseDown={(event) => event.preventDefault()} onClick={() => { commit(today); setCursor(monthCursorFromIso(today)); setOpen(false); }} type="button">Сегодня</button>
          {canClear ? <button onMouseDown={(event) => event.preventDefault()} onClick={() => { commit(""); setOpen(false); }} type="button">Очистить</button> : null}
        </div>
      </div>,
      document.body
    )
    : null;

  return (
    <div className="date-picker" data-date-picker="" ref={rootRef}>
      <div className="date-picker__control">
        <input
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={ariaLabel}
          autoComplete="off"
          disabled={disabled}
          id={inputId}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && rootRef.current?.contains(next)) return;
            applyDraft();
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            inputRef.current?.setCustomValidity("");
          }}
          onFocus={() => { setCursor(monthCursorFromIso(iso || today)); }}
          onKeyDown={onInputKeyDown}
          placeholder="дд.мм.гггг"
          ref={inputRef}
          required={required}
          spellCheck={false}
          type="text"
          value={draft}
        />
        {canClear && iso ? (
          <button aria-label="Очистить дату" className="date-picker__clear" disabled={disabled} onClick={() => commit("")} onMouseDown={(event) => event.preventDefault()} type="button">
            <X size={14} />
          </button>
        ) : null}
        <button
          aria-label="Открыть календарь"
          className="date-picker__trigger"
          disabled={disabled}
          onClick={() => {
            setCursor(monthCursorFromIso(iso || today));
            setOpen((current) => !current);
          }}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          <CalendarDays size={14} />
        </button>
      </div>
      {name ? <input name={name} required={required} type="hidden" value={iso} /> : null}
      {popover}
    </div>
  );
}

export interface DateTimePickerProps {
  readonly name?: string;
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onChange?: (value: string) => void;
  readonly required?: boolean;
  readonly disabled?: boolean;
}

export function DateTimePicker({
  name,
  value,
  defaultValue = "",
  onChange,
  required = false,
  disabled = false
}: DateTimePickerProps) {
  const controlled = value !== undefined;
  const [internal, setInternal] = useState(defaultValue);
  const combined = controlled ? (value ?? "") : internal;
  const parts = splitLocalDateTime(combined);
  const [timeDraft, setTimeDraft] = useState(parts.time);
  const timeDraftRef = useRef(parts.time);

  useEffect(() => {
    setTimeDraft(parts.time);
    timeDraftRef.current = parts.time;
  }, [parts.time]);

  const commit = (date: string, time: string) => {
    const next = joinLocalDateTime(date, time);
    if (!controlled) setInternal(next);
    onChange?.(next);
  };

  return (
    <div className="date-time-picker" data-date-picker="">
      <DatePicker
        disabled={disabled}
        onChange={(date) => {
          const typed = parseDisplayTime(timeDraftRef.current);
          const time = typed || parts.time || (date ? currentTime() : "");
          commit(date, time);
        }}
        required={required}
        value={parts.date}
      />
      <input
        aria-label="Время"
        autoComplete="off"
        className="date-picker__time"
        disabled={disabled}
        onBlur={() => {
          const parsed = parseDisplayTime(timeDraft);
          if (parsed === null) {
            setTimeDraft(parts.time);
            return;
          }
          setTimeDraft(parsed);
          if (parts.date || parsed) commit(parts.date, parsed);
        }}
        onChange={(event) => {
          timeDraftRef.current = event.target.value;
          setTimeDraft(event.target.value);
        }}
        placeholder="чч:мм"
        required={required}
        spellCheck={false}
        type="text"
        value={timeDraft}
      />
      {name ? <input name={name} required={required} type="hidden" value={combined} /> : null}
    </div>
  );
}
