import React, { useMemo, useState, type KeyboardEvent } from "react";
import { Button, Select } from "./ui.js";
import {
  MAX_MODEL_LINE_LENGTH,
  cleanModelLine,
  competencyKey,
  competencyLabel,
  sortCompetencies,
  type EngineerCompetency
} from "./engineer-competencies.js";

export interface CompetencyReferences {
  readonly manufacturers: readonly { readonly id: string; readonly name: string }[];
  readonly models: readonly { readonly id: string; readonly manufacturerId: string; readonly name: string }[];
}

/** Что набрано в строке добавления, но ещё не стало тегом. */
export interface CompetencyDraft {
  readonly manufacturerId: string;
  readonly modelLine: string;
}

/** Сколько моделей производителя показываем кнопками: остальные находятся вводом линейки. */
const MODEL_SUGGESTIONS_LIMIT = 8;

/**
 * Компетенции инженера тегами «Производитель · линейка»: у тега кнопка «убрать», новый
 * добавляется выбором производителя из справочника и линейки (или модели из справочника).
 */
export function EngineerCompetencyEditor({
  value,
  onChange,
  draft,
  onDraftChange,
  references,
  referencesState,
  canAdd
}: {
  readonly value: readonly EngineerCompetency[];
  readonly onChange: (next: readonly EngineerCompetency[]) => void;
  readonly draft: CompetencyDraft;
  readonly onDraftChange: (next: CompetencyDraft) => void;
  readonly references: CompetencyReferences;
  readonly referencesState: "loading" | "ready" | "error";
  /** Отключённому инженеру база новых компетенций не даёт: только убрать лишние. */
  readonly canAdd: boolean;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const keys = useMemo(() => new Set(value.map(competencyKey)), [value]);
  const manufacturer = references.manufacturers.find((item) => item.id === draft.manufacturerId);
  const typed = cleanModelLine(draft.modelLine).toLocaleLowerCase("ru-RU");
  const suggestions = useMemo(() => manufacturer
    ? references.models
      .filter((model) => model.manufacturerId === manufacturer.id
        && (!typed || model.name.toLocaleLowerCase("ru-RU").includes(typed))
        && !keys.has(competencyKey({ manufacturerId: manufacturer.id, modelLine: model.name })))
      .slice(0, MODEL_SUGGESTIONS_LIMIT)
    : [], [keys, manufacturer, references.models, typed]);

  const add = (line: string) => {
    const modelLine = cleanModelLine(line);
    if (!manufacturer) { setProblem("Выберите производителя из справочника"); return; }
    if (!modelLine) { setProblem("Впишите линейку или выберите модель из списка ниже"); return; }
    const item: EngineerCompetency = { manufacturerId: manufacturer.id, manufacturer: manufacturer.name, modelLine };
    const key = competencyKey(item);
    if (keys.has(key)) {
      const same = value.find((other) => competencyKey(other) === key) ?? item;
      setProblem(`«${competencyLabel(same)}» уже есть`);
      return;
    }
    onChange(sortCompetencies([...value, item]));
    // Производитель остаётся выбранным: так удобно добавить несколько его линеек подряд.
    onDraftChange({ manufacturerId: manufacturer.id, modelLine: "" });
    setProblem(null);
  };

  const remove = (item: EngineerCompetency) => {
    const key = competencyKey(item);
    onChange(value.filter((other) => competencyKey(other) !== key));
  };

  const onLineKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter добавляет тег, а не отправляет всю карточку.
    if (event.key !== "Enter") return;
    event.preventDefault();
    add(draft.modelLine);
  };

  const unavailable = referencesState === "error"
    ? "Справочник производителей не загрузился. Закройте окно и откройте снова."
    : referencesState === "ready" && references.manufacturers.length === 0
      ? "В справочнике нет производителей. Добавьте их в разделе «Справочники»."
      : null;

  return (
    <div className="competency-editor">
      {value.length > 0 ? (
        <ul aria-label="Компетенции инженера" className="competency-editor__chips">
          {value.map((item, index) => {
            const label = competencyLabel(item) || "Компетенция";
            return (
              <li className="competency-chip" key={`${competencyKey(item)}-${index}`}>
                <span>{label}</span>
                <button aria-label={`Убрать «${label}»`} className="competency-chip__remove" onClick={() => remove(item)} type="button">×</button>
              </li>
            );
          })}
        </ul>
      ) : <p className="competency-editor__empty">Компетенций пока нет.</p>}

      {!canAdd ? (
        <p className="form-hint">Инженер отключён: новые компетенции не добавить, лишние можно убрать.</p>
      ) : unavailable ? (
        <p className="form-hint">{unavailable}</p>
      ) : (
        <>
          <div className="competency-editor__add">
            <label className="competency-editor__maker">
              Производитель
              <Select
                disabled={referencesState !== "ready"}
                onChange={(event) => { onDraftChange({ manufacturerId: event.target.value, modelLine: draft.modelLine }); setProblem(null); }}
                value={draft.manufacturerId}
              >
                <option value="">{referencesState === "loading" ? "Загружаем справочник…" : "Выберите производителя"}</option>
                {references.manufacturers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </Select>
            </label>
            <label className="competency-editor__line">
              Линейка
              <input
                maxLength={MAX_MODEL_LINE_LENGTH}
                onChange={(event) => { onDraftChange({ manufacturerId: draft.manufacturerId, modelLine: event.target.value }); setProblem(null); }}
                onKeyDown={onLineKeyDown}
                placeholder="Например, BC или BC-6800"
                value={draft.modelLine}
              />
            </label>
            <Button icon="plus" onClick={() => add(draft.modelLine)} variant="secondary">Добавить</Button>
          </div>
          {suggestions.length > 0 ? (
            <div className="competency-editor__models">
              <span>Модели {manufacturer?.name} в справочнике:</span>
              <ul>
                {suggestions.map((model) => (
                  <li key={model.id}>
                    <button className="competency-editor__model" onClick={() => add(model.name)} type="button">+ {model.name}</button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {problem
            ? <p className="competency-editor__problem" role="alert">{problem}</p>
            : <p className="form-hint">Линейка — начало названия модели: «BC» подходит к BC-5000 и BC-6800. По производителю и линейке CRM подсказывает, кого назначить на прибор.</p>}
        </>
      )}
    </div>
  );
}
