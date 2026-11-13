import React, { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type UIEvent } from "react";
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
  /** Сервер отсортировал колонку по местам, заданным вручную: в ней можно ставить карточки на место. */
  readonly manualOrder?: boolean;
}

export interface TaskBoardPage {
  readonly items: readonly TaskApiRecord[];
  readonly total: number;
  /** Колонка пришла в ручном порядке (в базе есть места карточек). */
  readonly manualOrder?: boolean;
}

/** Карточка без места: так её показываем, пока сервер не вернёт настоящее. */
function withoutPlace(task: TaskApiRecord): TaskApiRecord {
  const { boardPosition: _place, ...rest } = task;
  return rest;
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

/** Место карточки в колонке: чем меньше число, тем выше карточка. */
export interface BoardPosition {
  readonly taskId: string;
  readonly position: number;
}

/**
 * Места для карточек, которые ставим в колонку на выбранное место, как в Trello.
 * column: карточки колонки сверху вниз без переносимых; slot: куда ставим (0 значит наверх);
 * after: первая карточка за загруженной частью колонки, если ставим в самый низ загруженного.
 * Расставленные вручную карточки сервер показывает выше остальных. Поэтому, если над местом
 * есть карточки без места, закрепляем и их как стоят, иначе брошенная встала бы над ними.
 * Между двумя карточками с местами ставим посередине, соседей не трогаем.
 */
export function planBoardPositions(
  column: readonly Pick<TaskApiRecord, "id" | "boardPosition">[],
  slot: number,
  movingIds: readonly string[],
  after?: Pick<TaskApiRecord, "boardPosition">
): BoardPosition[] {
  const count = movingIds.length;
  if (count === 0) return [];
  const index = Math.max(0, Math.min(Math.trunc(slot), column.length));
  const above = column.slice(0, index);
  const sequence = (start: number, ids: readonly string[]) => ids.map((taskId, offset) => ({ taskId, position: start + offset }));
  const firstLoose = above.findIndex((task) => task.boardPosition === undefined);
  if (firstLoose >= 0) {
    const base = firstLoose > 0 ? (above[firstLoose - 1]?.boardPosition ?? -1) + 1 : 0;
    return sequence(base, [...above.slice(firstLoose).map((task) => task.id), ...movingIds]);
  }
  const lower = above.at(-1)?.boardPosition;
  const upper = (index < column.length ? column[index] : after)?.boardPosition;
  if (lower === undefined) return upper === undefined ? sequence(0, movingIds) : sequence(upper - count, movingIds);
  if (upper === undefined) return sequence(lower + 1, movingIds);
  const room = (value: number, other: number) => Math.max(1, Math.abs(value), Math.abs(other)) * 1e-9;
  const step = (upper - lower) / (count + 1);
  if (step > room(lower, upper)) return movingIds.map((taskId, offset) => ({ taskId, position: lower + step * (offset + 1) }));
  // Между соседями места не осталось: заново расставляем ровными шагами карточки с местами
  // в загруженной части. Крайние значения прежние, поэтому дальше по колонке порядок не меняется.
  const placedBelow = column.slice(index).filter((task) => task.boardPosition !== undefined);
  const ordered = [...above.map((task) => task.id), ...movingIds, ...placedBelow.map((task) => task.id)];
  const first = above[0]?.boardPosition ?? lower;
  const last = placedBelow.at(-1)?.boardPosition ?? upper;
  // Последняя загруженная карточка остаётся на месте; если её нет (место взяли у следующей
  // за загруженными), все встают строго перед ней.
  const even = (last - first) / Math.max(1, placedBelow.length > 0 ? ordered.length - 1 : ordered.length);
  if (even > room(first, last)) {
    // Последняя загруженная карточка с местом остаётся ровно на своём месте (без ошибки округления).
    return ordered.map((taskId, offset) => ({ taskId, position: placedBelow.length > 0 && offset === ordered.length - 1 ? last : first + even * offset }));
  }
  // Места совпали совсем: ставим шагом 1 вниз от последнего известного, чтобы карточки
  // дальше по колонке (там места больше) остались ниже.
  const end = placedBelow.length > 0 ? last : last - 1;
  return ordered.map((taskId, offset) => ({ taskId, position: end - (ordered.length - 1 - offset) }));
}

interface DropProblem {
  readonly task: TaskApiRecord;
  readonly reason: string;
  readonly tone: "error" | "warning" | "info";
  /** Есть смысл предложить открыть карточку (там можно заполнить данные). */
  readonly openable: boolean;
}

export function TaskBoard({ tasks = [], statuses, equipment, engineers, onOpen, onMove, onReorder, loadColumn, queryKey = "initial", visibleStatus = "", showCompleted = false, hideEngineer = false, engineerMode = false }: {
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
  /** Сохраняет места карточек в колонке. Без него карточку можно перенести в колонку, но не на место в ней. */
  readonly onReorder?: (status: string, positions: readonly BoardPosition[]) => Promise<void>;
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
  // Для обновления колонок после переноса: свежие данные, номер изменения каждой колонки,
  // сколько переносов в ней ещё идёт и номер загрузки доски (меняется вместе с фильтрами).
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const columnVersions = useRef<Record<string, number>>({});
  const pendingMoves = useRef<Record<string, number>>({});
  const loadGeneration = useRef(0);
  // Места сохраняются строго в порядке переносов: иначе ответ раннего переноса мог бы
  // прийти позже и затереть места, расставленные следующим.
  const saveTurn = useRef<Promise<void>>(Promise.resolve());
  // Колонки, где перенос ещё узнаёт место следующей карточки: пока план не готов, места
  // на экране старые, поэтому новую перестановку в этой колонке не начинаем.
  const lookups = useRef<Set<string>>(new Set());
  // Свежие загрузчик и колонки: обновление после переноса читает доску с текущими фильтрами.
  const loadColumnRef = useRef(loadColumn);
  loadColumnRef.current = loadColumn;
  const touchColumn = (code: string) => { columnVersions.current[code] = (columnVersions.current[code] ?? 0) + 1; };
  // Задача, которую сейчас перетаскивают.
  const [draggedIds, setDraggedIds] = useState<readonly string[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Куда встанут карточки, если отпустить сейчас: колонка и номер места среди остальных карточек.
  const [dropSlot, setDropSlot] = useState<{ readonly code: string; readonly index: number } | null>(null);
  const dropSlotRef = useRef(dropSlot);
  const updateSlot = (next: { readonly code: string; readonly index: number } | null) => {
    const current = dropSlotRef.current;
    if (current?.code === next?.code && current?.index === next?.index) return;
    dropSlotRef.current = next;
    setDropSlot(next);
  };
  // Высота перетаскиваемой карточки: место под неё в колонке такой же высоты.
  const [dragHeight, setDragHeight] = useState(0);
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  const columnSignature = columns.map((status) => status.code ?? status.id).join("|");

  useEffect(() => {
    if (!loadColumn || columns.length === 0) return undefined;
    let current = true;
    loadGeneration.current += 1;
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
      // Колонка изменилась: начатое до этого обновление перечитает её заново, а не откатит догрузку.
      touchColumn(code);
      setPages((state) => {
        const latest = state[code] ?? current;
        const ids = new Set(latest.items.map((task) => task.id));
        return { ...state, [code]: { items: [...latest.items, ...next.items.filter((task) => !ids.has(task.id))], total: next.total, loading: false, loadingMore: false, ...(latest.manualOrder ? { manualOrder: true } : {}) } };
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
    touchColumn(from);
    touchColumn(to);
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

  /**
   * Ставит карточки на выбранное место колонки: перед карточкой beforeId или в конец загруженной части.
   * Из прежних колонок убирает. Повторный вызов с той же группой ничего не задваивает.
   */
  const placeGroup = (to: string, group: readonly BoardEntry[], beforeId: string | undefined, places: ReadonlyMap<string, number> = new Map()) => {
    if (!loadColumn || group.length === 0) return;
    touchColumn(to);
    for (const entry of group) if (entry.source !== to) touchColumn(entry.source);
    const empty: ColumnPage = { items: [], total: 0, loading: false, loadingMore: false };
    setPages((state) => {
      const next: Record<string, ColumnPage> = { ...state };
      for (const entry of group) {
        if (entry.source === to) continue;
        const source = next[entry.source] ?? empty;
        if (!source.items.some((item) => item.id === entry.task.id)) continue;
        next[entry.source] = { ...source, items: source.items.filter((item) => item.id !== entry.task.id), total: Math.max(0, source.total - 1) };
      }
      const target = next[to] ?? empty;
      const groupIds = new Set(group.map((entry) => entry.task.id));
      const present = new Set(target.items.map((item) => item.id));
      const added = group.filter((entry) => !present.has(entry.task.id)).length;
      // Места из плана сразу видны на доске: следующий перенос считает от них, а не от старых.
      const placeOf = (task: TaskApiRecord, moved: boolean): TaskApiRecord => {
        const place = places.get(task.id);
        if (place !== undefined) return { ...task, boardPosition: place };
        return moved ? withoutPlace(task) : task;
      };
      const rest = target.items.filter((item) => !groupIds.has(item.id)).map((item) => placeOf(item, false));
      const at = beforeId ? rest.findIndex((item) => item.id === beforeId) : -1;
      const index = at >= 0 ? at : rest.length;
      const placed = group.map((entry) => placeOf({ ...entry.task, status: to }, entry.source !== to));
      next[to] = { ...target, items: [...rest.slice(0, index), ...placed, ...rest.slice(index)], total: target.total + added };
      return next;
    });
  };

  /** Можно ли поставить карточку на выбранное место в колонке, а не просто в колонку. */
  const canReorder = (code: string): boolean => {
    if (!onReorder || !loadColumn) return false;
    // Колонка ещё грузится или пришла без ручного порядка (в базе его нет): места не показываем.
    const page = pages[code];
    if (!page || page.loading || page.manualOrder !== true || lookups.current.has(code)) return false;
    const status = columns.find((item) => (item.code ?? item.id) === code);
    if (!status || isCompletedBoardStatus(status)) return false;
    // Задачу на проверке инженер уже не меняет, порядок в этой колонке тоже.
    return !(engineerMode && code === "under_review");
  };

  /** Порядок карточек на доске: по колонкам слева направо, в колонке сверху вниз. */
  const boardOrder = (left: BoardEntry, right: BoardEntry) => (columnCodes.indexOf(left.source) - columnCodes.indexOf(right.source))
    || (itemsFor(left.source).findIndex((task) => task.id === left.task.id) - itemsFor(right.source).findIndex((task) => task.id === right.task.id));

  /**
   * После переноса перечитываем уже загруженную часть колонок: сервер сортирует задачи по-своему,
   * и без этого догрузка со смещением пропустила бы карточки. Пока в колонке идёт другой перенос,
   * не трогаем её: обновит тот перенос, что закончится последним. Если колонку поменяли, пока
   * шёл запрос (перенос, догрузка), перечитываем ещё раз. Смена фильтров отменяет обновление.
   */
  const refreshColumn = async (code: string, generation: number, attempt = 0): Promise<void> => {
    const load = loadColumnRef.current;
    if (!load || generation !== loadGeneration.current || (pendingMoves.current[code] ?? 0) > 0) return;
    const version = columnVersions.current[code] ?? 0;
    const limit = Math.max(COLUMN_PAGE_SIZE, pagesRef.current[code]?.items.length ?? 0);
    let page: TaskBoardPage;
    try {
      page = await load(code, 0, limit);
    } catch {
      // Не обновилось: на доске остаётся то, что показали сразу после переноса.
      return;
    }
    if (generation !== loadGeneration.current || (pendingMoves.current[code] ?? 0) > 0) return;
    if (version !== (columnVersions.current[code] ?? 0)) {
      if (attempt < 3) await refreshColumn(code, generation, attempt + 1);
      return;
    }
    setPages((state) => ({ ...state, [code]: { items: page.items, total: page.total, loading: false, loadingMore: false, ...(page.manualOrder ? { manualOrder: true } : {}) } }));
  };
  /**
   * Перечитывает колонки доски такой, какая она сейчас: если за время переноса сменили фильтры,
   * колонки читаются уже с новыми фильтрами, а пропавшие с доски не трогаем.
   */
  const refreshColumns = async (codes: readonly string[]) => {
    const generation = loadGeneration.current;
    const shown = new Set(Object.keys(pagesRef.current));
    await Promise.all([...new Set(codes)].filter((code) => shown.has(code)).map((code) => refreshColumn(code, generation)));
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

  /**
   * Переносит задачи в колонку (с доски приходит одна). Каждая проверяется отдельно.
   * slot: место среди остальных карточек колонки, как в Trello. Без него задача встаёт наверх,
   * а после обновления колонки по сортировке доски.
   */
  const moveTasks = async (taskIds: readonly string[], targetStatus: string, slot?: number) => {
    setDraggedIds([]);
    setDropTarget(null);
    updateSlot(null);
    const found = taskIds.map(findEntry).filter((entry): entry is BoardEntry => Boolean(entry));
    const reorder = slot !== undefined && canReorder(targetStatus);
    const staying = reorder ? found.filter((entry) => entry.source === targetStatus && !moving.has(entry.task.id)) : [];
    const entries = found.filter((entry) => entry.source !== targetStatus && !moving.has(entry.task.id));
    // Уже лежит в этой колонке, а места нет: переносить нечего.
    if (entries.length === 0 && staying.length === 0) return;
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
    // Очередь сохранения мест занимаем сразу, в порядке переносов, и только если места сохраняем.
    const saves = reorder && Boolean(onReorder);
    const previousSave = saves ? saveTurn.current : Promise.resolve();
    let releaseSave: () => void = () => undefined;
    if (saves) saveTurn.current = new Promise<void>((resolve) => { releaseSave = () => resolve(); });
    // Места в колонке считаем по тому, что видно на доске до переноса.
    const landing = [...staying, ...direct, ...checked].sort(boardOrder);
    const landingIds = new Set(landing.map((entry) => entry.task.id));
    const moved = new Set<string>();
    const working = [...direct, ...checked];
    const directIds = new Set(direct.map((entry) => entry.task.id));
    // Колонки, которые меняет этот перенос: пока он идёт, их не перечитываем.
    const touched = [...new Set([targetStatus, ...working.map((entry) => entry.source)])];
    for (const code of touched) pendingMoves.current[code] = (pendingMoves.current[code] ?? 0) + 1;
    const dragged = new Set(found.map((entry) => entry.task.id));
    const loaded = itemsFor(targetStatus);
    const rest = loaded.filter((task) => !dragged.has(task.id));
    const index = Math.max(0, Math.min(slot ?? 0, rest.length));
    const beforeId = reorder ? rest[index]?.id : undefined;
    let plan: BoardPosition[] = [];
    let places: ReadonlyMap<string, number> = new Map();
    // Что уже стоит на новом месте: переставленные в колонке и перенесённые без проверки.
    const placedIds = new Set([...staying, ...direct].map((entry) => entry.task.id));
    const placeLanded = () => placeGroup(targetStatus, landing.filter((entry) => placedIds.has(entry.task.id)), beforeId, places);
    // Сразу показываем карточки на новом месте; на сервер места уйдут, когда сменятся этапы.
    if (reorder) placeLanded();
    else for (const entry of direct) shiftLocal(withoutPlace(entry.task), entry.source, targetStatus);
    if (working.length > 0) setMoving((state) => new Set([...state, ...working.map((entry) => entry.task.id)]));
    try {
      if (reorder && landing.length > 0) {
        let after: TaskApiRecord | undefined;
        // Ставим в самый низ загруженной части, а ниже есть ещё задачи: узнаём место следующей.
        if (index === rest.length && (rest.length === 0 || rest.at(-1)?.boardPosition !== undefined) && loadColumn && loaded.length < totalFor(targetStatus)) {
          lookups.current.add(targetStatus);
          try {
            after = await loadColumn(targetStatus, loaded.length, 1).then((page) => page.items[0]).catch(() => undefined);
          } finally {
            lookups.current.delete(targetStatus);
          }
        }
        plan = planBoardPositions(rest, index, landing.map((entry) => entry.task.id), after);
        places = new Map(plan.map((item) => [item.taskId, item.position]));
        placeLanded();
      }
      // Каждый ответ применяем сразу: отказ возвращает задачу, не дожидаясь остальных.
      await Promise.all(working.map(async (entry) => {
        try {
          await onMove(entry.task.id, targetStatus);
          moved.add(entry.task.id);
          // Проверенный перенос показываем, только когда сервер согласился.
          if (!directIds.has(entry.task.id)) {
            if (reorder) { placedIds.add(entry.task.id); placeLanded(); }
            else shiftLocal(withoutPlace(entry.task), entry.source, targetStatus);
          }
        } catch (moveError) {
          if (directIds.has(entry.task.id)) {
            placedIds.delete(entry.task.id);
            // Обратно с прежним местом: на сервере задача осталась там, где была.
            shiftLocal(entry.task, targetStatus, entry.source);
          }
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
      // Места сохраняем, когда этапы уже сменились: место действует только в своём этапе.
      // Вместе с ними закрепляем карточки без места над выбранным местом.
      const savedIds = new Set(landing.filter((entry) => entry.source === targetStatus || moved.has(entry.task.id)).map((entry) => entry.task.id));
      // Ждём сохранение предыдущего переноса, но не дольше 20 секунд: зависший запрос
      // не должен останавливать доску.
      await Promise.race([previousSave, new Promise<void>((resolve) => { window.setTimeout(resolve, 20_000); })]);
      if (reorder && onReorder && savedIds.size > 0) {
        try {
          await onReorder(targetStatus, plan.filter((item) => savedIds.has(item.taskId) || !landingIds.has(item.taskId)));
        } catch (orderError) {
          toast.warning(orderError instanceof Error ? orderError.message : "Не получилось сохранить порядок карточек", { title: "Порядок не сохранился" });
        }
      }
    } finally {
      releaseSave();
      for (const code of touched) pendingMoves.current[code] = Math.max(0, (pendingMoves.current[code] ?? 0) - 1);
    }
    // Порядок и счётчики колонок как на сервере: перенесённые и возвращённые задачи на своих местах.
    void refreshColumns(touched);
    if (entries.length > 0) report(problems, moved.size, entries.length, targetStatus);
  };

  const startDrag = (event: DragEvent<HTMLElement>, taskId: string) => {
    setDraggedIds([taskId]);
    setDragHeight(event.currentTarget.getBoundingClientRect().height);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", taskId);
  };

  const draggedEntries = draggedIds.map(findEntry).filter((entry): entry is BoardEntry => Boolean(entry));

  /** Номер места под курсором среди карточек колонки, не считая перетаскиваемых. */
  const slotFromPointer = (column: HTMLElement, clientY: number): number => {
    let index = 0;
    for (const card of column.querySelectorAll<HTMLElement>("[data-board-card]")) {
      if (draggedIds.includes(card.dataset.boardCard ?? "")) continue;
      const rect = card.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) break;
      index += 1;
    }
    return index;
  };

  const trackSlot = (event: DragEvent<HTMLElement>, code: string) => {
    // Место показываем, только если хоть одна карточка сюда встанет: уже лежит в колонке
    // или её можно перенести сразу. Если нужна карточка задачи (инженер, отмена), места нет.
    const lands = draggedEntries.some((entry) => entry.source === code
      || ["move", "check"].includes(boardDropDecision(entry.task, entry.source, code, engineerMode).kind));
    // Колонка закрыта для переносимых сюда карточек (её видно бледной): места тоже нет.
    const incoming = draggedEntries.filter((entry) => entry.source !== code);
    const blocked = incoming.length > 0 && incoming.every((entry) => boardDropDecision(entry.task, entry.source, code, engineerMode).kind === "no");
    if (!lands || blocked || !canReorder(code)) {
      if (dropSlotRef.current?.code === code) updateSlot(null);
      return;
    }
    const index = slotFromPointer(event.currentTarget, event.clientY);
    // Одну карточку отпускают там же, где она стоит: ничего не изменится, место не показываем.
    const own = draggedEntries.length === 1 && draggedEntries[0]?.source === code
      ? itemsFor(code).findIndex((task) => task.id === draggedEntries[0]?.task.id)
      : -1;
    updateSlot(index === own ? null : { code, index });
  };

  const renderCard = (task: TaskApiRecord) => {
    const device = equipment.find((item) => item.id === task.equipmentId);
    const engineer = engineers.find((item) => item.id === task.engineerId);
    const isMoving = moving.has(task.id);
    return <article aria-busy={isMoving} className={`task-board-card${task.isOverdue ? " task-board-card--overdue" : ""}${draggedIds.includes(task.id) ? " task-board-card--dragging" : ""}`} data-board-card={task.id} draggable={!isMoving} key={task.id} onDragEnd={() => { setDraggedIds([]); setDropTarget(null); updateSlot(null); }} onDragStart={(event) => startDrag(event, task.id)}>
      <button className="task-board-card__open" onClick={() => onOpen(task.id)} type="button">
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
  };

  return <div className="task-board" aria-label="Доска задач">{columns.map((status) => {
    const code = status.code ?? status.id;
    const items = itemsFor(code);
    const total = totalFor(code);
    const page = pages[code];
    const terminal = (status.attributes as Readonly<Record<string, string | number | boolean | null>>)["isTerminal"] === true;
    // Колонка недоступна, если ни одну из перетаскиваемых задач сюда перенести нельзя.
    const incoming = draggedEntries.filter((entry) => entry.source !== code);
    const blocked = incoming.length > 0 && incoming.every((entry) => boardDropDecision(entry.task, entry.source, code, engineerMode).kind === "no");
    const slotIndex = dropSlot?.code === code && !blocked ? dropSlot.index : -1;
    const slotNode = <div aria-hidden="true" className="task-board__slot" key="drop-slot" style={dragHeight > 0 ? { height: `${Math.round(dragHeight)}px` } : undefined} />;
    // Карточки и место, куда встанут перетаскиваемые (как в Trello). Перетаскиваемые остаются
    // бледными на старом месте и в счёт мест не входят.
    const nodes: ReactNode[] = [];
    let restIndex = 0;
    for (const task of items) {
      if (!draggedIds.includes(task.id)) {
        if (restIndex === slotIndex) nodes.push(slotNode);
        restIndex += 1;
      }
      nodes.push(renderCard(task));
    }
    if (slotIndex >= 0 && slotIndex >= restIndex) nodes.push(slotNode);
    return <section className={`task-board__column task-board__column--${code}${dropTarget === code && incoming.length > 0 && !blocked ? " task-board__column--drop" : ""}${blocked ? " task-board__column--blocked" : ""}`} key={status.id} onDragEnter={() => setDropTarget(code)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; trackSlot(event, code); }} onDragLeave={(event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      // Safari не сообщает, куда ушёл курсор: если он ещё над колонкой, это переход между карточками.
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX > box.left && event.clientX < box.right && event.clientY > box.top && event.clientY < box.bottom) return;
      setDropTarget(null);
      if (dropSlotRef.current?.code === code) updateSlot(null);
    }} onDrop={(event) => { event.preventDefault(); const ids = draggedIds.length > 0 ? draggedIds : [event.dataTransfer.getData("text/plain")].filter(Boolean); const place = dropSlotRef.current?.code === code ? dropSlotRef.current.index : undefined; if (ids.length > 0) void moveTasks(ids, code, place); }}>
      <header><div><span className="task-board__title"><span aria-hidden="true" className={`task-board__dot task-board__dot--${tone(code, terminal)}`} />{status.name}</span><strong>{total}</strong></div></header>
      <div className="task-board__cards" onScroll={(event) => handleScroll(code, event)}>
        {page?.loading ? <p className="task-board__empty">Загружаем задачи…</p> : null}
        {nodes}
        {!page?.loading && items.length === 0 && slotIndex < 0 ? <p className="task-board__empty">В этом статусе пока нет задач.</p> : null}
        {page?.loadingMore ? <p className="task-board__loading-more">Загружаем ещё…</p> : null}
        {page?.error ? <button className="task-board__retry" onClick={() => void retryColumn(code)} type="button">{page.error} · Повторить</button> : null}
        {!page?.loading && items.length < total ? <button className="task-board__more" onClick={() => void loadMore(code)} type="button">Показать ещё {Math.min(COLUMN_PAGE_SIZE, total - items.length)}</button> : null}
      </div>
    </section>;
  })}</div>;
}
