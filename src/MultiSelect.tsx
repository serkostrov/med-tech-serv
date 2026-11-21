import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { filterSummary } from "./filter-values.js";

export interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
}

/** С какого числа вариантов в списке появляется поиск. */
export const MULTI_SELECT_SEARCH_FROM = 11;

/**
 * Выбор нескольких значений: кнопка с выбранным и список с галочками.
 * В фильтрах список висит под кнопкой. В формах и окнах — в верхнем слое браузера (popover):
 * страница под ним не сдвигается, а край окна его не обрезает (21.11: «вся страница вниз едет»).
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
  const panelRef = useRef<HTMLDivElement>(null);
  // Кнопка у правого края экрана — список открывается влево, по правому краю кнопки
  // (18.11: «Все этапы» в календаре уходил за край). Меряем до отрисовки, без мигания.
  const [alignRight, setAlignRight] = useState(false);
  // И по высоте: не влезает вниз — открываем вверх, если там просторнее, иначе укорачиваем
  // прокручиваемую часть, чтобы «Готово» было на экране (проверка на экране 1024×700).
  const [openUp, setOpenUp] = useState(false);
  const [optionsMaxHeight, setOptionsMaxHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open) { setAlignRight(false); setOpenUp(false); setOptionsMaxHeight(undefined); return undefined; }
    const panel = panelRef.current;
    const trigger = wrap.current;
    if (!panel || !trigger) return undefined;
    // Фокус в поиск — без прокрутки к нему, иначе браузер сам двигает страницу.
    const focusSearch = () => panel.querySelector<HTMLInputElement>(".multi-select__search")?.focus({ preventScroll: true });
    const button = trigger.querySelector<HTMLElement>(".multi-select__trigger");
    if (button && trigger.closest(".dialog-form") && typeof panel.showPopover === "function") {
      panel.setAttribute("popover", "manual");
      panel.showPopover();
      const options = panel.querySelector<HTMLElement>(".multi-select__options");
      const place = () => {
        const box = button.getBoundingClientRect();
        // Поле уехало за край прокрутки формы — список за ним не тянем, закрываем.
        const area = button.closest(".form-page, .dialog-body")?.getBoundingClientRect();
        if (area && (box.bottom < area.top || box.top > area.bottom)) { setOpen(false); return; }
        const viewWidth = document.documentElement.clientWidth;
        const viewHeight = window.visualViewport?.height ?? window.innerHeight;
        const width = Math.min(Math.max(box.width, 260), viewWidth - 16);
        panel.style.width = `${width}px`;
        panel.style.left = `${Math.max(8, Math.min(box.left, viewWidth - width - 8))}px`;
        if (options) options.style.maxHeight = "";
        const height = panel.offsetHeight;
        const below = viewHeight - box.bottom - 12;
        const above = box.top - 12;
        // Вниз, как привычно; вверх — только когда внизу почти нет места (меньше пяти строк).
        const up = height > below && below < 240 && above > below;
        const room = up ? above : below;
        if (options && height > room) options.style.maxHeight = `${Math.max(120, room - (height - options.offsetHeight))}px`;
        panel.style.top = up ? "auto" : `${box.bottom + 4}px`;
        panel.style.bottom = up ? `${window.innerHeight - box.top + 4}px` : "auto";
      };
      place();
      focusSearch();
      const onScroll = (event: Event) => { if (!(event.target instanceof Node && panel.contains(event.target))) place(); };
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", place);
      window.visualViewport?.addEventListener("resize", place);
      return () => {
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", place);
        window.visualViewport?.removeEventListener("resize", place);
      };
    }
    focusSearch();
    if (getComputedStyle(panel).position !== "absolute") return undefined;
    const box = trigger.getBoundingClientRect();
    // Край — ближайший блок, который обрезает по ширине (область страницы), или край экрана.
    let limit = document.documentElement.clientWidth - 8;
    for (let node = trigger.parentElement; node && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).overflowX !== "visible") { limit = Math.min(limit, node.getBoundingClientRect().right - 8); break; }
    }
    setAlignRight(box.left + panel.offsetWidth > limit && box.right - panel.offsetWidth >= 8);
    const below = window.innerHeight - box.bottom - 12;
    const above = box.top - 12;
    const height = panel.offsetHeight;
    if (height <= below) return undefined;
    const options = panel.querySelector<HTMLElement>(".multi-select__options");
    const fixedPart = height - (options?.offsetHeight ?? 0);
    const up = above > below;
    setOpenUp(up);
    if ((up ? above : below) < height && options) setOptionsMaxHeight(Math.max(120, (up ? above : below) - fixedPart));
    return undefined;
  }, [open]);
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
    {open ? <div className={`multi-select__panel${alignRight ? " multi-select__panel--right" : ""}${openUp ? " multi-select__panel--up" : ""}`} id={listId} ref={panelRef}>
      {searchable ? <input aria-label={`${label}: поиск`} className="multi-select__search" onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} type="search" value={query} /> : null}
      <div aria-labelledby={labelId} className="multi-select__options" role="group" style={optionsMaxHeight ? { maxHeight: optionsMaxHeight } : undefined}>
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
