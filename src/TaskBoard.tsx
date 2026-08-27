import React, { useEffect, useMemo, useState, type DragEvent, type UIEvent } from "react";
import type { EquipmentApiRecord, ReferenceCatalogValue, TaskApiRecord } from "./m2-api.js";
import { TASK_STATUS_LABELS } from "./domain/task-status.js";
import { StatusBadge, type StatusTone } from "./ui.js";

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
  if (status === "closed") return "success";
  if (status === "cancelled" || terminal) return "neutral";
  if (status === "in_progress") return "purple";
  if (status === "under_review") return "info";
  return "warning";
}

function isCompletedBoardStatus(status: ReferenceCatalogValue): boolean {
  const code = status.code ?? status.id;
  if (code === "closed" || code === "cancelled") return true;
  return (status.attributes as Readonly<Record<string, string | number | boolean | null>>)["isTerminal"] === true;
}

export function TaskBoard({ tasks = [], statuses, equipment, engineers, onOpen, onMove, loadColumn, queryKey = "initial", visibleStatus = "", showCompleted = false }: {
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
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  const columnSignature = columns.map((status) => status.code ?? status.id).join("|");

  useEffect(() => {
    if (!loadColumn || columns.length === 0) return undefined;
    let current = true;
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

  const move = async (taskId: string, targetStatus: string) => {
    const sourceStatus = columns.map((status) => status.code ?? status.id).find((code) => itemsFor(code).some((task) => task.id === taskId));
    if (!sourceStatus || sourceStatus === targetStatus || moving.has(taskId)) return;
    const task = itemsFor(sourceStatus).find((item) => item.id === taskId);
    if (!task) return;
    const before = pages;
    setMoving((state) => new Set(state).add(taskId));
    if (loadColumn) {
      setPages((state) => ({
        ...state,
        [sourceStatus]: { ...(state[sourceStatus] ?? { items: [], total: 0, loading: false, loadingMore: false }), items: (state[sourceStatus]?.items ?? []).filter((item) => item.id !== taskId), total: Math.max(0, (state[sourceStatus]?.total ?? 0) - 1) },
        [targetStatus]: { ...(state[targetStatus] ?? { items: [], total: 0, loading: false, loadingMore: false }), items: [{ ...task, status: targetStatus }, ...(state[targetStatus]?.items ?? [])], total: (state[targetStatus]?.total ?? 0) + 1 }
      }));
    }
    try {
      await onMove(taskId, targetStatus);
    } catch {
      if (loadColumn) setPages(before);
    } finally {
      setMoving((state) => { const next = new Set(state); next.delete(taskId); return next; });
      setDraggedId(null);
      setDropTarget(null);
    }
  };

  const startDrag = (event: DragEvent<HTMLElement>, taskId: string) => {
    setDraggedId(taskId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", taskId);
  };

  return <div className="task-board" aria-label="Доска задач">{columns.map((status) => {
    const code = status.code ?? status.id;
    const items = itemsFor(code);
    const total = totalFor(code);
    const page = pages[code];
    const terminal = (status.attributes as Readonly<Record<string, string | number | boolean | null>>)["isTerminal"] === true;
    return <section className={`task-board__column task-board__column--${code}${dropTarget === code ? " task-board__column--drop" : ""}`} key={status.id} onDragEnter={() => setDropTarget(code)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }} onDrop={(event) => { event.preventDefault(); const taskId = event.dataTransfer.getData("text/plain") || draggedId; if (taskId) void move(taskId, code); }}>
      <header><div><StatusBadge tone={tone(code, terminal)}>{status.name}</StatusBadge><strong>{total}</strong></div><span>{terminal ? "Дальше не двигается" : "Перетащите задачу сюда"}</span></header>
      <div className="task-board__cards" onScroll={(event) => handleScroll(code, event)}>
        {page?.loading ? <p className="task-board__empty">Загружаем задачи…</p> : null}
        {items.map((task) => {
          const device = equipment.find((item) => item.id === task.equipmentId);
          const engineer = engineers.find((item) => item.id === task.engineerId);
          const isMoving = moving.has(task.id);
          return <article aria-busy={isMoving} className={`task-board-card${task.isOverdue ? " task-board-card--overdue" : ""}${draggedId === task.id ? " task-board-card--dragging" : ""}`} draggable={!isMoving} key={task.id} onDragEnd={() => { setDraggedId(null); setDropTarget(null); }} onDragStart={(event) => startDrag(event, task.id)}>
            <button className="task-board-card__open" onClick={() => onOpen(task.id)} type="button"><span>{task.number}{task.priority === "urgent" ? <i>Срочно</i> : null}</span><strong>{task.title}</strong><small>{task.customer?.siteName ?? "Площадка не выбрана"}</small><dl><div><dt>Прибор</dt><dd>{device ? `${device.model} · ${device.serialNumber}` : "Не выбран"}</dd></div><div><dt>Инженер</dt><dd>{engineer?.fullName ?? "Не назначен"}</dd></div></dl></button>
          </article>;
        })}
        {!page?.loading && items.length === 0 ? <p className="task-board__empty">В этом статусе пока нет задач.</p> : null}
        {page?.loadingMore ? <p className="task-board__loading-more">Загружаем ещё…</p> : null}
        {page?.error ? <button className="task-board__retry" onClick={() => void retryColumn(code)} type="button">{page.error} · Повторить</button> : null}
        {!page?.loading && items.length < total ? <button className="task-board__more" onClick={() => void loadMore(code)} type="button">Показать ещё {Math.min(COLUMN_PAGE_SIZE, total - items.length)}</button> : null}
      </div>
    </section>;
  })}</div>;
}
