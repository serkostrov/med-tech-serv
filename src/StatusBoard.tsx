import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { BoardScroller } from "./BoardScroller.js";

/**
 * Доска по статусам для разделов без перетаскивания: счета, приборы, план ТО по месяцам.
 * Просьба 17.11: «всё, что можно разбить по статусам, надо разбивать». Колонки и карточки
 * выглядят как на доске задач; карточка открывает запись, статус меняется в её карточке.
 */
export interface StatusBoardColumn {
  readonly key: string;
  readonly title: string;
  /** Цвет полоски и точки колонки. */
  readonly color: string;
  /** Колонка вне отбора (фильтр по статусу): видна бледной, без запроса. */
  readonly outside?: boolean;
}

export interface StatusBoardPage<Item> {
  readonly items: readonly Item[];
  readonly total: number;
}

interface ColumnState<Item> {
  readonly items: readonly Item[];
  readonly total: number;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error?: string;
}

export const STATUS_BOARD_PAGE_SIZE = 30;

export function StatusBoard<Item>({ columns, load, queryKey, itemKey, renderCard, renderLinks, onOpen, label, emptyText = "Здесь пока пусто.", pageSize = STATUS_BOARD_PAGE_SIZE, focusKey }: {
  /** Ссылки внизу карточки (задачи, инженер): вне кнопки карточки, у них свой переход. */
  readonly renderLinks?: (item: Item) => ReactNode;
  /** Колонка, к которой доска прокручивается при открытии (текущий месяц в плане ТО). */
  readonly focusKey?: string;
  readonly columns: readonly StatusBoardColumn[];
  /** Страница колонки: смещение и размер. Для локальных данных — срез уже загруженного списка. */
  readonly load: (columnKey: string, offset: number, limit: number) => Promise<StatusBoardPage<Item>>;
  /** Меняется вместе с фильтрами: доска перечитывает колонки. */
  readonly queryKey: string;
  readonly itemKey: (item: Item) => string;
  readonly renderCard: (item: Item) => ReactNode;
  readonly onOpen: (item: Item) => void;
  readonly label: string;
  readonly emptyText?: string;
  readonly pageSize?: number;
}) {
  const [state, setState] = useState<Readonly<Record<string, ColumnState<Item>>>>({});
  const boardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusKey) return;
    const board = boardRef.current;
    const column = board?.querySelector<HTMLElement>(`[data-column-key="${focusKey}"]`);
    if (board && column) board.scrollLeft = Math.max(0, column.offsetLeft - board.offsetLeft - 12);
  }, [focusKey]);
  const signature = columns.map((column) => `${column.key}${column.outside ? "!" : ""}`).join("|");

  useEffect(() => {
    let current = true;
    setState(Object.fromEntries(columns.map((column) => [column.key, { items: [], total: 0, loading: !column.outside, loadingMore: false }])));
    void Promise.all(columns.filter((column) => !column.outside).map(async (column) => {
      try {
        const page = await load(column.key, 0, pageSize);
        if (current) setState((prev) => ({ ...prev, [column.key]: { items: page.items, total: page.total, loading: false, loadingMore: false } }));
      } catch (loadError) {
        if (current) setState((prev) => ({ ...prev, [column.key]: { items: [], total: 0, loading: false, loadingMore: false, error: loadError instanceof Error ? loadError.message : "Не получилось загрузить" } }));
      }
    }));
    return () => { current = false; };
  }, [queryKey, signature]);

  const loadMore = async (key: string) => {
    const column = state[key];
    if (!column || column.loading || column.loadingMore || column.items.length >= column.total) return;
    setState((prev) => ({ ...prev, [key]: { ...column, loadingMore: true } }));
    try {
      const page = await load(key, column.items.length, pageSize);
      setState((prev) => {
        const latest = prev[key] ?? column;
        const known = new Set(latest.items.map(itemKey));
        return { ...prev, [key]: { items: [...latest.items, ...page.items.filter((item) => !known.has(itemKey(item)))], total: page.total, loading: false, loadingMore: false } };
      });
    } catch (loadError) {
      setState((prev) => ({ ...prev, [key]: { ...column, loadingMore: false, error: loadError instanceof Error ? loadError.message : "Не получилось загрузить" } }));
    }
  };

  return <BoardScroller><div aria-label={label} className="task-board status-board" ref={boardRef}>{columns.map((column) => {
    const page = state[column.key];
    const items = page?.items ?? [];
    const total = page?.total ?? 0;
    return <section className={`task-board__column status-board__column${column.outside ? " task-board__column--outside" : ""}`} data-column-key={column.key} key={column.key} style={{ "--stage-color": column.color } as React.CSSProperties}>
      <header><div><span className="task-board__title"><span aria-hidden="true" className="task-board__dot" />{column.title}</span><strong>{column.outside ? 0 : total}</strong></div></header>
      <div className="task-board__cards">
        {page?.loading ? <p className="task-board__empty">Загружаем…</p> : null}
        {items.map((item) => <article className="task-board-card status-board-card" key={itemKey(item)}>
          <button className="task-board-card__open" onClick={() => onOpen(item)} type="button">{renderCard(item)}</button>
          {renderLinks ? <div className="status-board-card__links">{renderLinks(item)}</div> : null}
        </article>)}
        {!page?.loading && items.length === 0 && !page?.error ? <p className="task-board__empty">{column.outside ? "Не входит в отбор" : emptyText}</p> : null}
        {page?.error ? <p className="task-board__empty">{page.error}</p> : null}
        {page?.loadingMore ? <p className="task-board__loading-more">Загружаем ещё…</p> : null}
        {page && !page.loading && items.length < total ? <button className="task-board__more" onClick={() => void loadMore(column.key)} type="button">Показать ещё {Math.min(pageSize, total - items.length)}</button> : null}
      </div>
    </section>;
  })}</div></BoardScroller>;
}

/** Локальный список как страницы колонок: для счетов, которые и так загружены целиком. */
export function localStatusPage<Item>(items: readonly Item[], matches: (item: Item) => boolean, offset: number, limit: number): StatusBoardPage<Item> {
  const filtered = items.filter(matches);
  return { items: filtered.slice(offset, offset + limit), total: filtered.length };
}
