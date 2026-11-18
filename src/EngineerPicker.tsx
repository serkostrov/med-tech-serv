import React, { useState } from "react";
import type { AssignmentSuggestionRecord } from "./m2-api.js";
import { periodLoadText } from "./engineer-calendar.js";
import { ResourceState } from "./ui.js";

/**
 * Выбор инженера с подсказкой: компетенция по прибору и занятость в дни задачи.
 * Один список и в карточке задачи, и в окне календаря — иначе подписи расходятся,
 * и в двух местах системы одно и то же называется по-разному.
 *
 * Подсказка ничего не запрещает: перегруженный инженер остаётся в списке, просто ниже.
 * Порядок задаёт rankAssignmentCandidates, здесь только показ.
 */
/** С какого числа инженеров над списком появляется поиск (встреча 18.11: «если больше 10»). */
export const ENGINEER_SEARCH_FROM = 11;

/** Поиск по ФИО без учёта регистра и «ё»: «кузн» находит «Кузнецова Мария Олеговна». */
export function matchesEngineerQuery(fullName: string, query: string): boolean {
  const norm = (value: string) => value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ").trim();
  const want = norm(query);
  return want === "" || norm(fullName).includes(want);
}

export function EngineerPicker({ items, value, onChange, state = "ready" }: {
  readonly items: readonly AssignmentSuggestionRecord[];
  readonly value: string;
  readonly onChange: (engineerId: string) => void;
  /** Пока подсказка грузится, «инженеров нет» писать рано. */
  readonly state?: "loading" | "ready";
}) {
  const [query, setQuery] = useState("");
  if (state === "loading" && items.length === 0) {
    return <ResourceState description="Подождите, список инженеров сейчас появится." status="loading" title="Считаем занятость инженеров" />;
  }
  if (items.length === 0) {
    return <p className="form-hint">Активных инженеров нет. Добавьте их в разделе «Инженеры».</p>;
  }
  const searchable = items.length >= ENGINEER_SEARCH_FROM;
  const shown = searchable ? items.filter((item) => matchesEngineerQuery(item.fullName, query)) : items;
  const list = (
    <div aria-label="Инженеры" className="engineer-picker" role="listbox">
      {shown.length === 0 ? <p className="form-hint">Никого не нашли. Проверьте фамилию.</p> : null}
      {shown.map((item) => {
        const selected = item.engineerId === value;
        const hints = [
          item.previouslyWorkedWithEquipment ? "работал с таким прибором" : null,
          item.load ? periodLoadText(item.load) : item.isAvailable ? "свободен" : "занят"
        ].filter(Boolean).join(" · ");
        return (
          <button
            aria-selected={selected}
            className={`engineer-picker__option${selected ? " is-selected" : ""}${item.load?.isOverloaded ? " engineer-picker__option--overloaded" : ""}`}
            key={item.engineerId}
            onClick={() => onChange(item.engineerId)}
            role="option"
            type="button"
          >
            <strong>{item.fullName}</strong>
            <span>{hints}</span>
          </button>
        );
      })}
    </div>
  );
  if (!searchable) return list;
  return <div className="engineer-picker-search">
    <input aria-label="Найти инженера" autoComplete="off" className="engineer-picker-search__input" onChange={(event) => setQuery(event.target.value)} placeholder={`Найти по фамилии · всего ${items.length}`} type="search" value={query} />
    {list}
  </div>;
}
