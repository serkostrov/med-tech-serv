import React from "react";
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
export function EngineerPicker({ items, value, onChange, state = "ready" }: {
  readonly items: readonly AssignmentSuggestionRecord[];
  readonly value: string;
  readonly onChange: (engineerId: string) => void;
  /** Пока подсказка грузится, «инженеров нет» писать рано. */
  readonly state?: "loading" | "ready";
}) {
  if (state === "loading" && items.length === 0) {
    return <ResourceState description="Подождите, список инженеров сейчас появится." status="loading" title="Считаем занятость инженеров" />;
  }
  if (items.length === 0) {
    return <p className="form-hint">Активных инженеров нет. Добавьте их в разделе «Инженеры».</p>;
  }
  return (
    <div aria-label="Инженеры" className="engineer-picker" role="listbox">
      {items.map((item) => {
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
}
