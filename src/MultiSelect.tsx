import React, { useEffect, useId, useRef, useState } from "react";
import { filterSummary } from "./filter-values.js";

export interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
}

/** С какого числа вариантов в списке появляется поиск. */
export const MULTI_SELECT_SEARCH_FROM = 11;

/**
 * Выбор нескольких значений для фильтров: кнопка с выбранным и список с галочками.
 * Список раскрывается под кнопкой внутри страницы (не поверх неё), поэтому работает
 * и в панели «Фильтры», и в мобильной шторке.
 */
export function MultiSelect({ label, options, value, onChange, emptyLabel = "Все", searchPlaceholder = "Найти", compact = false, allOption = true, invalid = false }: {
  readonly label: string;
  /** Строка «Все» в списке: в фильтрах она сбрасывает отбор, в поле формы не нужна. */
  readonly allOption?: boolean;
  /** Поле формы не заполнено: рамка красная. */
  readonly invalid?: boolean;
  /** Подпись над кнопкой не показывать (строка фильтров без подписей, как у приборов). */
  readonly compact?: boolean;
  readonly options: readonly MultiSelectOption[];
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly emptyLabel?: string;
  readonly searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();
  const labelId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent | TouchEvent) => {
      if (wrap.current && event.target instanceof Node && !wrap.current.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    wrap.current?.addEventListener("keydown", escape);
    const node = wrap.current;
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      node?.removeEventListener("keydown", escape);
    };
  }, [open]);

  const labelOf = (code: string) => options.find((option) => option.value === code)?.label ?? code;
  const searchable = options.length >= MULTI_SELECT_SEARCH_FROM;
  const norm = (text: string) => text.toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
  const shown = searchable && query.trim() ? options.filter((option) => norm(option.label).includes(norm(query.trim()))) : options;
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter((item) => item !== code) : [...value, code]);

  return <div className={`multi-select${compact ? " multi-select--compact" : ""}`} data-filter-active={value.length > 0 ? "true" : "false"} ref={wrap}>
    <span className={compact ? "sr-only" : "multi-select__label"} id={labelId}>{label}</span>
    <button aria-controls={listId} aria-expanded={open} aria-invalid={invalid || undefined} aria-labelledby={labelId} className={`multi-select__trigger${value.length && allOption ? " multi-select__trigger--active" : ""}${invalid ? " multi-select__trigger--invalid" : ""}`} onClick={() => setOpen((current) => !current)} title={value.length ? value.map(labelOf).join(", ") : undefined} type="button">
      <span>{filterSummary(value, labelOf, emptyLabel)}</span>
      <svg aria-hidden="true" height="14" viewBox="0 0 24 24" width="14"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" /></svg>
    </button>
    {open ? <div className="multi-select__panel" id={listId}>
      {searchable ? <input aria-label={`${label}: поиск`} autoFocus className="multi-select__search" onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} type="search" value={query} /> : null}
      <div aria-labelledby={labelId} className="multi-select__options" role="group">
        {allOption ? <label className="multi-select__option multi-select__option--all"><input checked={value.length === 0} onChange={() => onChange([])} type="checkbox" /><span>{emptyLabel}</span></label> : null}
        {shown.map((option) => <label className="multi-select__option" key={option.value}><input checked={value.includes(option.value)} onChange={() => toggle(option.value)} type="checkbox" /><span>{option.label}</span></label>)}
        {shown.length === 0 ? <p className="multi-select__empty">Ничего не нашли</p> : null}
      </div>
      <div className="multi-select__footer">
        <span>{value.length ? `Выбрано: ${value.length}` : ""}</span>
        <button onClick={() => setOpen(false)} type="button">Готово</button>
      </div>
    </div> : null}
  </div>;
}

/**
 * Несколько видов работ в задаче одним полем (встреча 18.11): выпадающий список с галочками,
 * как в фильтрах. Первый выбранный база хранит как вид работ задачи, остальные — дополнительными,
 * но на экране они равны.
 */
export function WorkTypesPicker({ options, value, onChange, error }: {
  readonly options: readonly MultiSelectOption[];
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly error?: string | null;
}) {
  return <div className="work-types-picker field-wide">
    <MultiSelect allOption={false} emptyLabel="Не выбран" invalid={Boolean(error)} label="Вид работ *" onChange={onChange} options={options} value={value} />
    {error ? <small className="work-types-picker__error">{error}</small> : null}
  </div>;
}
