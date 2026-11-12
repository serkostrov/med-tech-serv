import React, { useEffect, useMemo, useRef, useState, type DragEvent, type UIEvent } from "react";
import type { EquipmentApiRecord, ReferenceCatalogValue, TaskApiRecord } from "./m2-api.js";
import { TASK_STATUS_LABELS, TASK_STATUS_TONES, TASK_STATUS_TRANSITIONS } from "./domain/task-status.js";
import { toast, type StatusTone } from "./ui.js";

const COLUMN_PAGE_SIZE = 12;

interface ColumnPage {
  readonly items: readonly TaskApiRecord[];
  readonly total: number;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error?: string;
}

export interface TaskBoardPage {
  readonly items: readonly TaskApiRecord[];
  readonly total: number;
}

function tone(status: string, terminal: boolean): StatusTone {
  return TASK_STATUS_TONES[status] ?? (terminal ? "neutral" : "warning");
}

function isCompletedBoardStatus(status: ReferenceCatalogValue): boolean {
  const code = status.code ?? status.id;
  if (code === "closed" || code === "cancelled") return true;
  return (status.attributes as Readonly<Record<string, string | number | boolean | null>>)["isTerminal"] === true;
}

function initials(name: string): string {
  return name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

/** «Иванов Пётр Алексеевич» → «Иванов П. А.» */
function shortName(name: string): string {
  const [last, ...rest] = name.split(/\s+/u).filter(Boolean);
  return [last, ...rest.map((part) => `${part[0]}.`)].join(" ");
}

function shortDate(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "");
}

export type BoardDropDecision =
  | { readonly kind: "move" }
  /** Перенос с проверкой на сервере: на проверку уходит только задача с заполненным результатом. */
  | { readonly kind: "check" }
  /** Нужны данные или решение в карточке задачи: задача остаётся на месте, показываем, что сделать. */
  | { readonly kind: "card"; readonly reason: string }
  | { readonly kind: "no" };

/**
 * Что будет, если бросить задачу в колонку: сменить этап, сменить с проверкой (на проверку),
 * подсказать, что сделать в карточке (инженер, причина, проверка акта), или ничего (этап не следующий).
 * Карточку сами не открываем: человек остаётся на доске и решает, открыть ли её.
 */
export function boardDropDecision(task: Pick<TaskApiRecord, "engineerId">, from: string, to: string, engineerMode = false): BoardDropDecision {
  if (from === to || !(TASK_STATUS_TRANSITIONS[from] ?? []).includes(to)) return { kind: "no" };
  // Инженер не закрывает и не возвращает задачу с проверки: это решает координатор.
  if (engineerMode && from === "under_review") return { kind: "no" };
  if (to === "assigned" && !task.engineerId) return { kind: "card", reason: "Сначала выберите инженера: откройте задачу и нажмите «Назначить инженера»" };
  if (to === "cancelled") return { kind: "card", reason: "Отменить задачу можно в её карточке, указав причину" };
  if (from === "under_review") return { kind: "card", reason: "Сначала проверьте акт и фото в карточке задачи, там кнопки «Проверено — закрыть» и «На доработку»" };
  if (to === "under_review") return { kind: "check" };
  return { kind: "move" };
}

/** Почему задачу нельзя перенести в колонку (для «card» и «no»). */
function dropProblemText(decision: BoardDropDecision, from: string, to: string, engineerMode: boolean): string {
  if (decision.kind === "card") return decision.reason;
  if (engineerMode && from === "under_review") return "Задача на проверке у координатора. Если нужно что-то исправить, он вернёт её вам";
  return `Из «${TASK_STATUS_LABELS[from] ?? from}» сразу в «${TASK_STATUS_LABELS[to] ?? to}» нельзя, только в следующий этап`;
}

/** 1 задача, 2 задачи, 5 задач. */
export function tasksWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "задач";
  if (ones === 1) return "задача";
  if (ones >= 2 && ones <= 4) return "задачи";
  return "задач";
}

interface BoardEntry {
  readonly task: TaskApiRecord;
  readonly source: string;
}

interface DropProblem {
  readonly task: TaskApiRecord;
  readonly reason: string;
  readonly tone: "error" | "warning" | "info";
  /** Есть смысл предложить открыть карточку (там можно заполнить данные). */
  readonly openable: boolean;
}

export function TaskBoard({ tasks = [], statuses, equipment, engineers, onOpen, onMove, loadColumn, queryKey = "initial", visibleStatus = "", showCompleted = false, hideEngineer = false, engineerMode = false }: {
  /** Доска инженера: с «На проверке» задачу не двигает. */
  readonly engineerMode?: boolean;
  /** На доске инженера строка «Инженер» лишняя: все задачи его. */
  readonly hideEngineer?: boolean;
  readonly tasks?: readonly TaskApiRecord[];
  readonly statuses: readonly ReferenceCatalogValue[];
  readonly equipment: readonly EquipmentApiRecord[];
  readonly engineers: readonly { readonly id: string; readonly fullName: string }[];
  readonly onOpen: (id: string) => void;
  readonly onMove: (id: string, status: string) => Promise<void>;
  readonly loadColumn?: (status: string, offset: number, limit: number) => Promise<TaskBoardPage>;
  readonly queryKey?: string;
  readonly visibleStatus?: string;
  readonly showCompleted?: boolean;
}) {
  const activeStatuses = useMemo(() => statuses.filter((status) => status.isActive)
    .sort((left, right) => Number(left.attributes.sortOrder ?? 0) - Number(right.attributes.sortOrder ?? 0)), [statuses]);
  const known = useMemo(() => new Set(activeStatuses.map((status) => status.code ?? status.id)), [activeStatuses]);
  const missing = useMemo(() => [...new Set(tasks.map((task) => task.status).filter((status) => !known.has(status)))].map((status) => ({
    id: status, code: status, name: TASK_STATUS_LABELS[status] ?? "Статус", isActive: true, attributes: {}
  } satisfies ReferenceCatalogValue)), [known, tasks]);
  const columns = useMemo(() => [...activeStatuses, ...missing].filter((status) => {
    const code = status.code ?? status.id;
    if (visibleStatus) return code === visibleStatus;
    if (!showCompleted && isCompletedBoardStatus(status)) return false;
    return true;
  }), [activeStatuses, missing, showCompleted, visibleStatus]);
  const [pages, setPages] = useState<Readonly<Record<string, ColumnPage>>>({});
  // Свежие колонки для обновления после переноса; номер версии отбрасывает устаревшие ответы.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const boardVersion = useRef(0);
  // Задачи, которые сейчас перетаскивают (одну или все отмеченные).
  const [draggedIds, setDraggedIds] = useState<readonly string[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  // Отмеченные задачи: их можно перетащить в колонку все вместе.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const columnSignature = columns.map((status) => status.code ?? status.id).join("|");

  // Другие фильтры или обновление доски: прежний выбор больше не относится к тому, что на экране.
  useEffect(() => { setSelected(new Set()); }, [queryKey, columnSignature]);
  // Esc снимает выбор, если он не закрывает окно и не сбрасывает поле ввода.
  useEffect(() => {
    if (selected.size === 0) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='listbox']")) return;
      if (document.querySelector("[role='dialog']")) return;
      setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size]);

  useEffect(() => {
    if (!loadColumn || columns.length === 0) return undefined;
    let current = true;
    boardVersion.current += 1;
    const codes = columns.map((status) => status.code ?? status.id);
    setPages(Object.fromEntries(codes.map((code) => [code, { items: [], total: 0, loading: true, loadingMore: false }] satisfies readonly [string, ColumnPage])));
    void Promise.all(codes.map(async (code) => {
      try {
        const page = await loadColumn(code, 0, COLUMN_PAGE_SIZE);
        if (current) setPages((state) => ({ ...state, [code]: { ...page, loading: false, loadingMore: false } }));
      } catch (loadError) {
        if (current) setPages((state) => ({ ...state, [code]: { items: [], total: 0, loading: false, loadingMore: false, error: loadError instanceof Error ? loadError.message : "Не получилось загрузить задачи" } }));
      }
    }));
    return () => { current = false; };
  }, [queryKey, columnSignature]);

  const itemsFor = (code: string) => loadColumn ? (pages[code]?.items ?? []) : tasks.filter((task) => task.status === code);
  const totalFor = (code: string) => loadColumn ? (pages[code]?.total ?? 0) : tasks.filter((task) => task.status === code).length;

  const loadMore = async (code: string) => {
    if (!loadColumn) return;
    const current = pages[code];
    if (!current || current.loading || current.loadingMore || current.items.length >= current.total) return;
    setPages((state) => ({ ...state, [code]: { ...current, loadingMore: true } }));
    try {
      const next = await loadColumn(code, current.items.length, COLUMN_PAGE_SIZE);
      setPages((state) => {
        const latest = state[code] ?? current;
        const ids = new Set(latest.items.map((task) => task.id));
        return { ...state, [code]: { items: [...latest.items, ...next.items.filter((task) => !ids.has(task.id))], total: next.total, loading: false, loadingMore: false } };
      });
    } catch (loadError) {
      setPages((state) => ({ ...state, [code]: { ...(state[code] ?? current), loadingMore: false, error: loadError instanceof Error ? loadError.message : "Не получилось загрузить ещё задачи" } }));
    }
  };

  const retryColumn = async (code: string) => {
    if (!loadColumn) return;
    setPages((state) => ({ ...state, [code]: { items: [], total: 0, loading: true, loadingMore: false } }));
    try {
      const page = await loadColumn(code, 0, COLUMN_PAGE_SIZE);
      setPages((state) => ({ ...state, [code]: { ...page, loading: false, loadingMore: false } }));
    } catch (loadError) {
      setPages((state) => ({ ...state, [code]: { items: [], total: 0, loading: false, loadingMore: false, error: loadError instanceof Error ? loadError.message : "Не получилось загрузить задачи" } }));
    }
  };

  const handleScroll = (code: string, event: UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96) void loadMore(code);
  };

  const columnCodes = columns.map((status) => status.code ?? status.id);
  const findEntry = (taskId: string): BoardEntry | undefined => {
    for (const code of columnCodes) {
      const task = itemsFor(code).find((item) => item.id === taskId);
      if (task) return { task, source: code };
    }
    return undefined;
  };

  // Сразу показываем задачу в новой колонке; при отказе сервера возвращаем обратно.
  const shiftLocal = (task: TaskApiRecord, from: string, to: string) => {
    if (!loadColumn) return;
    boardVersion.current += 1;
    const empty: ColumnPage = { items: [], total: 0, loading: false, loadingMore: false };
    setPages((state) => {
      const source = state[from] ?? empty;
      const target = state[to] ?? empty;
      return {
        ...state,
        [from]: { ...source, items: source.items.filter((item) => item.id !== task.id), total: Math.max(0, source.total - 1) },
        [to]: { ...target, items: [{ ...task, status: to }, ...target.items.filter((item) => item.id !== task.id)], total: target.total + 1 }
      };
    });
  };

  const toggleSelected = (taskId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
    return next;
  });

  /**
   * После переноса перечитываем уже загруженную часть колонок: сервер сортирует задачи по-своему,
   * и без этого догрузка со смещением пропустила бы карточки. Если за это время доску
   * снова поменяли, ответ устарел и не применяется (следующее обновление придёт само).
   */
  const refreshColumns = async (codes: readonly string[]) => {
    if (!loadColumn) return;
    const version = boardVersion.current;
    await Promise.all([...new Set(codes)].map(async (code) => {
      const limit = Math.max(COLUMN_PAGE_SIZE, pagesRef.current[code]?.items.length ?? 0);
      try {
        const page = await loadColumn(code, 0, limit);
        if (version !== boardVersion.current) return;
        setPages((state) => ({ ...state, [code]: { items: page.items, total: page.total, loading: false, loadingMore: false } }));
      } catch {
        // Не обновилось: на доске остаётся то, что показали сразу после переноса.
      }
    }));
  };

  const report = (problems: readonly DropProblem[], moved: number, attempted: number, targetStatus: string) => {
    if (attempted === 1) {
      const problem = problems[0];
      if (!problem) return;
      const options = problem.openable ? { action: { label: "Открыть задачу", onClick: () => onOpen(problem.task.id) } } : {};
      if (problem.tone === "info") toast.info(problem.reason, options);
      else if (problem.tone === "warning") toast.warning(problem.reason, options);
      else toast.error(problem.reason, options);
      return;
    }
    const target = TASK_STATUS_LABELS[targetStatus] ?? targetStatus;
    if (problems.length === 0) {
      toast.success(`Перенесено в «${target}»: ${moved} ${tasksWord(moved)}`);
      return;
    }
    // Одинаковые причины одной строкой: «З-1, З-2: Сначала выберите инженера».
    const byReason = new Map<string, string[]>();
    for (const problem of problems) byReason.set(problem.reason, [...(byReason.get(problem.reason) ?? []), problem.task.number]);
    const groups = [...byReason];
    const lines = groups.slice(0, 3).map(([reason, numbers]) => `${numbers.join(", ")}: ${reason}`);
    // Остальные причины не расписываем, но номера задач называем все.
    const rest = groups.slice(3).flatMap(([, numbers]) => numbers);
    const more = rest.length ? `. Также не перенесены: ${rest.join(", ")}` : "";
    toast.error(`${lines.join(". ")}${more}.`, { title: `Перенесено ${moved} из ${attempted}`, durationMs: 12000 });
  };

  /** Переносит одну или несколько задач в колонку. Каждая задача проверяется отдельно. */
  const moveTasks = async (taskIds: readonly string[], targetStatus: string) => {
    setDraggedIds([]);
    setDropTarget(null);
    const found = taskIds.map(findEntry).filter((entry): entry is BoardEntry => Boolean(entry));
    // Уже лежат в этой колонке: переносить нечего, с выбора снимаем.
    const alreadyThere = new Set(found.filter((entry) => entry.source === targetStatus).map((entry) => entry.task.id));
    const entries = found.filter((entry) => entry.source !== targetStatus && !moving.has(entry.task.id));
    if (entries.length === 0) {
      if (alreadyThere.size) setSelected((current) => new Set([...current].filter((id) => !alreadyThere.has(id))));
      return;
    }
    const problems: DropProblem[] = [];
    const direct: BoardEntry[] = [];
    const checked: BoardEntry[] = [];
    for (const entry of entries) {
      const decision = boardDropDecision(entry.task, entry.source, targetStatus, engineerMode);
      if (decision.kind === "move") direct.push(entry);
      else if (decision.kind === "check") checked.push(entry);
      else problems.push({
        task: entry.task,
        reason: dropProblemText(decision, entry.source, targetStatus, engineerMode),
        tone: decision.kind === "card" ? "error" : engineerMode && entry.source === "under_review" ? "info" : "warning",
        openable: decision.kind === "card"
      });
    }
    const moved = new Set<string>();
    const working = [...direct, ...checked];
    if (working.length > 0) {
      for (const entry of direct) shiftLocal(entry.task, entry.source, targetStatus);
      setMoving((state) => new Set([...state, ...working.map((entry) => entry.task.id)]));
      const directIds = new Set(direct.map((entry) => entry.task.id));
      // Каждый ответ применяем сразу: отказ возвращает задачу, не дожидаясь остальных.
      await Promise.all(working.map(async (entry) => {
        try {
          await onMove(entry.task.id, targetStatus);
          moved.add(entry.task.id);
          // Проверенный перенос показываем, только когда сервер согласился.
          if (!directIds.has(entry.task.id)) shiftLocal(entry.task, entry.source, targetStatus);
        } catch (moveError) {
          if (directIds.has(entry.task.id)) shiftLocal({ ...entry.task, status: targetStatus }, targetStatus, entry.source);
          problems.push({
            task: entry.task,
            reason: moveError instanceof Error ? moveError.message : "Не получилось изменить этап",
            tone: "error",
            openable: true
          });
        } finally {
          setMoving((state) => { const next = new Set(state); next.delete(entry.task.id); return next; });
        }
      }));
      // Порядок и счётчики колонок как на сервере: перенесённые и возвращённые задачи на своих местах.
      void refreshColumns([targetStatus, ...working.map((entry) => entry.source)]);
    }
    // С выбора снимаем перенесённые и те, что уже лежали в колонке; не перенесённые и другие остаются.
    setSelected((current) => new Set([...current].filter((id) => !moved.has(id) && !alreadyThere.has(id))));
    report(problems, moved.size, entries.length, targetStatus);
  };

  const startDrag = (event: DragEvent<HTMLElement>, taskId: string) => {
    // Тянем отмеченную задачу: переносим все отмеченные. Иначе только эту.
    const ids = selected.has(taskId) ? [...selected].filter((id) => findEntry(id)) : [taskId];
    setDraggedIds(ids);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", ids.join(","));
    if (ids.length > 1 && typeof document !== "undefined") {
      // Под курсором видно, сколько задач переносим.
      const ghost = document.createElement("div");
      ghost.className = "task-board-drag-ghost";
      ghost.textContent = `${ids.length} ${tasksWord(ids.length)}`;
      document.body.appendChild(ghost);
      event.dataTransfer.setDragImage(ghost, 18, 18);
      window.setTimeout(() => ghost.remove(), 0);
    }
  };

  const draggedEntries = draggedIds.map(findEntry).filter((entry): entry is BoardEntry => Boolean(entry));

  return <>
    {selected.size > 0 ? <div className="task-board-selection" role="status">
      <strong>Выбрано: {selected.size} {tasksWord(selected.size)}</strong>
      <span>Перетащите любую из них в нужную колонку, перенесутся все</span>
      <button className="text-button" onClick={() => setSelected(new Set())} type="button">Снять выбор</button>
    </div> : null}
    <div className="task-board" aria-label="Доска задач">{columns.map((status) => {
    const code = status.code ?? status.id;
    const items = itemsFor(code);
    const total = totalFor(code);
    const page = pages[code];
    const terminal = (status.attributes as Readonly<Record<string, string | number | boolean | null>>)["isTerminal"] === true;
    // Колонка недоступна, если ни одну из перетаскиваемых задач сюда перенести нельзя.
    const incoming = draggedEntries.filter((entry) => entry.source !== code);
    const blocked = incoming.length > 0 && incoming.every((entry) => boardDropDecision(entry.task, entry.source, code, engineerMode).kind === "no");
    return <section className={`task-board__column task-board__column--${code}${dropTarget === code && incoming.length > 0 && !blocked ? " task-board__column--drop" : ""}${blocked ? " task-board__column--blocked" : ""}`} key={status.id} onDragEnter={() => setDropTarget(code)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }} onDrop={(event) => { event.preventDefault(); const ids = draggedIds.length > 0 ? draggedIds : (event.dataTransfer.getData("text/plain") || "").split(",").filter(Boolean); if (ids.length > 0) void moveTasks(ids, code); }}>
      <header><div><span className="task-board__title"><span aria-hidden="true" className={`task-board__dot task-board__dot--${tone(code, terminal)}`} />{status.name}</span><strong>{total}</strong></div></header>
      <div className="task-board__cards" onScroll={(event) => handleScroll(code, event)}>
        {page?.loading ? <p className="task-board__empty">Загружаем задачи…</p> : null}
        {items.map((task) => {
          const device = equipment.find((item) => item.id === task.equipmentId);
          const engineer = engineers.find((item) => item.id === task.engineerId);
          const isMoving = moving.has(task.id);
          const isSelected = selected.has(task.id);
          return <article aria-busy={isMoving} className={`task-board-card${task.isOverdue ? " task-board-card--overdue" : ""}${draggedIds.includes(task.id) ? " task-board-card--dragging" : ""}${isSelected ? " task-board-card--selected" : ""}${selected.size > 0 ? " task-board-card--selecting" : ""}`} draggable={!isMoving} key={task.id} onDragEnd={() => { setDraggedIds([]); setDropTarget(null); }} onDragStart={(event) => startDrag(event, task.id)}>
            <label className="task-board-card__select" title="Отметьте несколько задач и перетащите их вместе">
              <input aria-label={`Отметить задачу ${task.number}`} checked={isSelected} onChange={() => toggleSelected(task.id)} type="checkbox" />
            </label>
            <button className="task-board-card__open" onClick={(event) => {
              // Cmd, Ctrl или Shift + клик отмечает задачу, не открывая её.
              if (event.metaKey || event.ctrlKey || event.shiftKey) { event.preventDefault(); toggleSelected(task.id); return; }
              onOpen(task.id);
            }} type="button">
              <span className="task-board-card__top">{task.number}{task.priority === "urgent" ? <i>Срочно</i> : null}</span>
              <strong>{task.title}</strong>
              <small>{[task.customer?.siteName ?? "Площадка не выбрана", task.equipmentLabel ? `${task.equipmentLabel.model ?? "Прибор"} · ${task.equipmentLabel.serialNumber}` : device ? `${device.model} · ${device.serialNumber}` : null].filter(Boolean).join(" · ")}</small>
              <span className="task-board-card__foot">
                {hideEngineer ? null : (() => {
                  const name = task.engineerName ?? engineer?.fullName;
                  return name ? <><span aria-hidden="true" className="task-board-card__ava">{initials(name)}</span><span className="task-board-card__eng" title={name}>{shortName(name)}</span></> : <><span aria-hidden="true" className="task-board-card__ava task-board-card__ava--none">?</span><span className="task-board-card__eng task-board-card__eng--none">Не назначен</span></>;
                })()}
                {task.periodTo ? <span className={`task-board-card__due${task.isOverdue ? " task-board-card__due--late" : ""}`}>{task.isOverdue ? "просрочена" : `до ${shortDate(task.periodTo)}`}</span> : null}
              </span>
            </button>
          </article>;
        })}
        {!page?.loading && items.length === 0 ? <p className="task-board__empty">В этом статусе пока нет задач.</p> : null}
        {page?.loadingMore ? <p className="task-board__loading-more">Загружаем ещё…</p> : null}
        {page?.error ? <button className="task-board__retry" onClick={() => void retryColumn(code)} type="button">{page.error} · Повторить</button> : null}
        {!page?.loading && items.length < total ? <button className="task-board__more" onClick={() => void loadMore(code)} type="button">Показать ещё {Math.min(COLUMN_PAGE_SIZE, total - items.length)}</button> : null}
      </div>
    </section>;
  })}</div>
  </>;
}
