import { MultiSelect } from "./MultiSelect.js";
import { filterValues, joinFilterValues } from "./filter-values.js";
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { m2Api, type StockReservationRecord } from "./m2-api.js";
import { RegistryPagination, registryPageOffset, usePageSize } from "./RegistryPagination.js";
import { Button, ConfirmationDialog, DataTableShell, FilterBar, MetricCard, PageIntro, PageTabs, ResourceState, Select, StatusBadge, ViewSwitch, toast } from "./ui.js";
import { ReservationBoard } from "./ReservationBoard.js";
import { formatDisplayDate } from "./date-format.js";
import { formatRussianCount } from "./equipment-changes.js";
import { companyDateTimeText } from "./task-dates.js";
import { ReservationSteps } from "./TaskReservations.js";
import { engineerReservationsFileName, engineerReservationsWorkbook } from "./reservation-export.js";
import { downloadWorkbook, registryFileName, reservationRegistrySheets } from "./registry-export.js";
import { XLSX_MIME } from "./xlsx.js";
import {
  EMPTY_RESERVATION_FILTERS,
  RESERVATION_STATUS_LABELS,
  RESERVATION_STATUS_TONES,
  availableReservationActions,
  filterReservations,
  hasReservationFilters,
  issueBlockReason,
  lastReservationStep,
  reservationFilterOptions,
  reservationIssuedAt,
  reservationQuantityText,
  reservationSummary,
  reservationTaskNote,
  reservationsByEngineer,
  type ReservationAction,
  type ReservationFilters
} from "./reservations.js";

type ReservationsTab = "active" | "closed" | "engineers";
type ReservationsView = "board" | "list";
type ConfirmedAction = Exclude<ReservationAction, "ready">;

const ACTION_LABELS: Readonly<Record<ReservationAction, string>> = {
  ready: "Собрано",
  issue: "Выдать инженеру",
  cancel: "Снять резерв",
  return: "Вернули на склад"
};

const CONFIRM_TEXT: Readonly<Record<ConfirmedAction, { readonly title: string; readonly confirm: string; readonly tone: "danger" | "primary" }>> = {
  issue: { title: "Выдать запчасть?", confirm: "Выдать", tone: "primary" },
  cancel: { title: "Снять резерв?", confirm: "Снять резерв", tone: "danger" },
  return: { title: "Запчасть вернули на склад?", confirm: "Принять на склад", tone: "primary" }
};

function confirmDescription(reservation: StockReservationRecord, action: ConfirmedAction): ReactNode {
  const what = `${reservation.articleNumber} · ${reservationQuantityText(reservation)}`;
  if (action === "issue") return <>{what} получит {reservation.engineerName ?? "инженер задачи"}{reservation.taskNumber ? <> по задаче {reservation.taskNumber}</> : null}. Запчасть спишется со склада.</>;
  if (action === "cancel") return <>Резерв {reservation.number} снимется, запчасть {reservation.articleNumber} снова станет доступна для других задач.</>;
  return <>{what} вернётся в остаток и снова станет доступна.</>;
}

/**
 * Окно склада: запчасти, зарезервированные под задачи. Кладовщик собирает запчасть,
 * выдаёт её инженеру задачи и принимает обратно, если она не пригодилась.
 */
export function ReservationsPage() {
  // Доска или список, как у задач. На доске видны все состояния сразу, поэтому вкладок там нет.
  const [view, setView] = useState<ReservationsView>("board");
  const viewRef = useRef<ReservationsView>("board");
  const [tab, setTab] = useState<ReservationsTab>("active");
  // Вкладка для перезагрузки после действия: замыкание могло запомнить прежнюю.
  const tabRef = useRef<ReservationsTab>("active");
  const [items, setItems] = useState<readonly StockReservationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ readonly reservation: StockReservationRecord; readonly action: ConfirmedAction } | null>(null);
  // Сколько вернули: всё выданное или часть (0066). Один поставил, второй вернул — так тоже бывает.
  const [returnDraft, setReturnDraft] = useState("");
  // Два разных файла с одной вкладки: реестр резервов и список «у кого что на руках».
  // Флаги раздельные, иначе на вкладке «У инженеров» обе кнопки сразу писали бы
  // «Готовим файл…», и было бы не понять, какая из них работает.
  const [exporting, setExporting] = useState(false);
  const [exportingEngineers, setExportingEngineers] = useState(false);
  // Условия в полях и условия, по которым сейчас отобран список: как в других реестрах,
  // набранное применяется по «Показать». Резервы уже загружены, поэтому отбираем на месте.
  const [filters, setFilters] = useState<ReservationFilters>(EMPTY_RESERVATION_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<ReservationFilters>(EMPTY_RESERVATION_FILTERS);
  // Пока окно подтверждения закрывается, в нём остаётся прежний текст, а не пустой заголовок.
  const lastConfirming = useRef(confirming);
  if (confirming) lastConfirming.current = confirming;
  const shown = confirming ?? lastConfirming.current;
  // Ответ на старую вкладку не должен затереть список новой.
  const loadTurn = useRef(0);

  /**
   * Доске нужны все состояния сразу: читаем действующие и закрытые резервы вместе.
   * Списку хватает одной вкладки, как было.
   */
  const reload = async (nextTab = tabRef.current, nextView = viewRef.current) => {
    const turn = ++loadTurn.current;
    setLoading(true);
    setLoadError(null);
    try {
      // Два запроса подряд, а не параллельно: в старой базе без истории шагов первый
      // ответ подсказывает второму, что из запроса убрать. Параллельные запросы отключили
      // бы истории на два шага сразу и увели имена авторов со всех экранов.
      const next = nextView === "board"
        ? [...await m2Api.stockReservations("active"), ...await m2Api.stockReservations("closed")]
          // Снятого резерва на доске нет: такой колонки нет, и в фильтр по состоянию он не попадёт.
          .filter((item) => item.status !== "cancelled")
        : await m2Api.stockReservations(nextTab === "closed" ? "closed" : "active");
      if (turn === loadTurn.current) setItems(next);
    } catch (error) {
      if (turn === loadTurn.current) setLoadError(error instanceof Error ? error.message : "Не получилось загрузить резервы");
    } finally {
      if (turn === loadTurn.current) setLoading(false);
    }
  };
  useEffect(() => {
    void reload("active");
    void m2Api.hasPermission("warehouse.write").then(setCanWrite).catch(() => setCanWrite(false));
  }, []);

  const resetFilters = () => {
    setFilters(EMPTY_RESERVATION_FILTERS);
    setAppliedFilters(EMPTY_RESERVATION_FILTERS);
  };

  const changeTab = (next: ReservationsTab) => {
    tabRef.current = next;
    setTab(next);
    setItems([]);
    // Условия сбрасываем: на другой вкладке и состояния, и задачи с инженерами уже другие.
    resetFilters();
    void reload(next);
  };

  const changeView = (next: ReservationsView) => {
    viewRef.current = next;
    setView(next);
    setItems([]);
    // На доске и в списке наборы резервов разные: условия отбора начинаем заново.
    resetFilters();
    void reload(tabRef.current, next);
  };

  /** Действие, затем свежий список; кнопки снова доступны только после обновления списка. */
  const run = async (reservation: StockReservationRecord, action: ReservationAction) => {
    setBusyId(reservation.id);
    try {
      if (action === "ready") await m2Api.markStockReservationReady(reservation.id);
      else if (action === "issue") await m2Api.issueStockReservation(reservation.id);
      else if (action === "cancel") await m2Api.cancelStockReservation(reservation.id);
      else {
        const part = returnQuantity(reservation);
        await m2Api.returnStockReservation(reservation.id, part);
      }
      const what = `${reservation.articleNumber} · ${reservationQuantityText(reservation)}`;
      if (action === "ready") toast.success(issueBlockReason(reservation) ? `Собрано: ${what}` : `Собрано: ${what}. Можно выдавать инженеру`);
      else if (action === "issue") toast.success(`Выдано: ${what}. Получил: ${reservation.engineerName ?? "инженер задачи"}`);
      else if (action === "cancel") toast.success(`Резерв ${reservation.number} снят, запчасть снова доступна`);
      else {
        const part = returnQuantity(reservation);
        toast.success(part === undefined ? `Принято на склад: ${what}` : `Принято на склад: ${reservation.articleNumber} · ${part} из ${reservation.quantity}. Остальное у инженера`);
      }
    } finally {
      await reload();
      setBusyId(null);
    }
  };

  /**
   * Количество для возврата: undefined — всё выданное. Ошибка ввода бросается
   * и показывается прямо в окне подтверждения.
   */
  const returnQuantity = (reservation: StockReservationRecord): number | undefined => {
    if (reservation.quantity <= 1) return undefined;
    const value = Number(returnDraft.replace(/\s/gu, "").replace(",", "."));
    if (!returnDraft.trim() || !Number.isFinite(value) || value <= 0) throw new Error("Укажите, сколько вернули: число больше нуля");
    if (value > reservation.quantity) throw new Error(`Выдано ${reservation.quantity}: вернуть больше нельзя`);
    return value === reservation.quantity ? undefined : value;
  };

  const runFromRow = (reservation: StockReservationRecord, action: ReservationAction) => {
    if (action === "return") setReturnDraft(String(reservation.quantity).replace(".", ","));
    if (action !== "ready") { setConfirming({ reservation, action }); return; }
    void run(reservation, action).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не получилось выполнить действие"));
  };

  // Карточки сверху считаем по всему загруженному, а не по отбору: это сводка склада, как на «Складе».
  // Закрытые резервы в неё всё равно не попадают, поэтому на доске она считается так же.
  const summary = reservationSummary(view === "board" || tab === "active" ? items : []);
  const showActions = canWrite && tab === "active";
  const counting = loading && items.length === 0;
  const options = useMemo(() => reservationFilterOptions(items), [items]);
  const visible = useMemo(() => filterReservations(items, appliedFilters), [items, appliedFilters]);
  // Постранично, как задачи и приборы (просьба 17.11): «показывать по 25 / 50 / 100».
  const { pageSize, setPageSize } = usePageSize("reservations");
  const [pageIndex, setPageIndex] = useState(0);
  useEffect(() => { setPageIndex(0); }, [appliedFilters, tab, view]);
  const pageRows = useMemo(() => visible.slice(registryPageOffset(pageIndex, pageSize), registryPageOffset(pageIndex + 1, pageSize)), [visible, pageIndex, pageSize]);
  const filtered = hasReservationFilters(appliedFilters);
  const groups = view === "list" && tab === "engineers" ? reservationsByEngineer(visible) : [];
  const issuedCount = groups.reduce((total, group) => total + group.items.length, 0);

  const applyFilters = (next = filters) => {
    setFilters(next);
    setAppliedFilters(next);
  };

  // Выгрузка того, что сейчас на вкладке: по строке на каждую выданную запчасть.
  const exportEngineers = async () => {
    setExportingEngineers(true);
    try {
      const url = URL.createObjectURL(new Blob([(await engineerReservationsWorkbook(visible)) as BlobPart], { type: XLSX_MIME }));
      const link = document.createElement("a");
      link.href = url;
      link.download = engineerReservationsFileName();
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success(`В файле ${formatRussianCount(issuedCount, ["запчасть", "запчасти", "запчастей"])} у ${formatRussianCount(groups.length, ["инженера", "инженеров", "инженеров"])}`, { title: "Файл выгружен" });
    } catch (exportError) {
      toast.error(exportError instanceof Error ? exportError.message : "Не получилось выгрузить файл", { title: "Файл не выгрузился" });
    } finally {
      setExportingEngineers(false);
    }
  };

  // Выгрузка реестра резервов со всей цепочкой: состояние, задача, кому выдали, когда.
  // Читаем все резервы страницами, а не только те 500 (или 100 закрытых), что держит
  // окно на экране, и применяем к ним тот же отбор, что виден сейчас. Набор берём по
  // виду, а не по вкладке: вкладки есть только у списка, а доска показывает
  // действующие и закрытые разом, кроме снятых, — файл должен совпадать с экраном.
  const exportRegistry = async () => {
    setExporting(true);
    try {
      const loaded = view === "board"
        ? [...await m2Api.allStockReservations("active"), ...await m2Api.allStockReservations("closed")]
            .filter((item) => item.status !== "cancelled")
        : await m2Api.allStockReservations(tab === "closed" ? "closed" : "active");
      const rows = filterReservations(loaded, appliedFilters);
      if (rows.length === 0) {
        toast.warning("По этому отбору резервов нет: выгружать нечего", { title: "Выгружать нечего" });
        return;
      }
      await downloadWorkbook(reservationRegistrySheets(rows), registryFileName("Резервы"));
      toast.success(`В файле ${formatRussianCount(rows.length, ["резерв", "резерва", "резервов"])}`, { title: "Резервы выгружены" });
    } catch (exportError) {
      toast.error(exportError instanceof Error ? exportError.message : "Не получилось выгрузить резервы", { title: "Файл не выгрузился" });
    } finally {
      setExporting(false);
    }
  };

  return <>
    <PageIntro
      actions={<Button busy={exporting} busyLabel="Готовим файл…" disabled={loading} onClick={() => void exportRegistry()} variant="secondary">Скачать в Excel</Button>}
      description="Запчасти под задачи: собрать, выдать инженеру, принять обратно."
      title="Резервы"
      titleAside={<ViewSwitch items={[{ value: "board", label: "Доска" }, { value: "list", label: "Список" }]} label="Как показать резервы" onValueChange={changeView} value={view} />}
    />
    {/* На доске те же числа в заголовках колонок — карточки сверху только у списка. */}
    {view === "list" && tab === "active" ? <div className="metric-grid metric-grid--three">
      <MetricCard icon="inventory" label="Ждут сборки" tone="yellow" value={counting ? "…" : String(summary.toCollect)} />
      <MetricCard icon="reservations" label="Собраны, можно выдавать" value={counting ? "…" : String(summary.ready)} />
      <MetricCard icon="engineers" label="У инженеров" tone="purple" value={counting ? "…" : String(summary.withEngineers)} />
    </div> : null}
    {/* На доске все состояния стоят колонками, вкладки ей не нужны. */}
    {view === "list" ? <PageTabs items={[{ value: "active", label: "Действующие" }, { value: "engineers", label: "У инженеров" }, { value: "closed", label: "Закрытые" }]} label="Резервы" onValueChange={changeTab} value={tab} /> : null}
    <FilterBar loading={loading} onReset={() => applyFilters(EMPTY_RESERVATION_FILTERS)} onSubmit={() => applyFilters()}>
      <label className="filter-field--search">Поиск<input onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Резерв, любой артикул, запчасть, задача" type="search" value={filters.search} /></label>
      {/* На вкладке «У инженеров» все резервы выданы: выбирать состояние там не из чего. */}
      {view === "list" && tab === "engineers" ? null : <MultiSelect label="Состояние" onChange={(next) => setFilters((current) => ({ ...current, status: joinFilterValues(next) }))} options={options.statuses} value={filterValues(filters.status)} />}
      <MultiSelect label="Инженер" onChange={(next) => setFilters((current) => ({ ...current, engineer: joinFilterValues(next) }))} options={options.engineers} searchPlaceholder="Фамилия инженера" value={filterValues(filters.engineer)} />
      <MultiSelect label="Задача" onChange={(next) => setFilters((current) => ({ ...current, taskNumber: joinFilterValues(next) }))} options={options.tasks} searchPlaceholder="Номер задачи" value={filterValues(filters.taskNumber)} />
      <MultiSelect label="Запчасть" onChange={(next) => setFilters((current) => ({ ...current, partId: joinFilterValues(next) }))} options={options.parts} searchPlaceholder="Артикул или название" value={filterValues(filters.partId)} />
    </FilterBar>
    {view === "board" ? <>
      {loadError ? <ResourceState description={loadError} onRetry={() => void reload()} status="error" title="Резервы не загрузились" />
        : !loading && visible.length === 0 ? <ResourceState
          description={filtered ? "Измените условия или сбросьте фильтры." : "Когда под задачу зарезервируют запчасть, она появится на доске."}
          status={filtered ? "filtered-empty" : "empty"}
          title={filtered ? "Резервов по этим условиям нет" : "Резервов пока нет"}
        />
        : <>
          <p className="reservation-board__note">{canWrite
            ? "Перенесите карточку в соседнюю колонку: собрать, выдать инженеру, принять обратно."
            : "Собирать и выдавать запчасти может кладовщик."
          } Старые закрытые — в «Списке».</p>
          <ReservationBoard busyId={busyId} canWrite={canWrite} items={visible} loading={loading} onAction={runFromRow} />
        </>}
    </> : tab === "engineers" ? <DataTableShell
      action={items.length ? <Button busy={exportingEngineers} busyLabel="Готовим файл…" disabled={issuedCount === 0} onClick={() => void exportEngineers()} variant="secondary">Скачать «У инженеров»</Button> : undefined}
      meta={loading ? undefined : `${formatRussianCount(issuedCount, ["запчасть", "запчасти", "запчастей"])} у ${formatRussianCount(groups.length, ["инженера", "инженеров", "инженеров"])}`}
      title="Запчасти у инженеров"
    >
      {loadError ? <ResourceState description={loadError} onRetry={() => void reload()} status="error" title="Резервы не загрузились" />
        : loading && items.length === 0 ? <ResourceState description="Подождите, резервы сейчас появятся." status="loading" title="Загружаем резервы" />
        : groups.length === 0 ? <ResourceState description={filtered ? "Измените условия или сбросьте фильтры." : "Как только кладовщик выдаст запчасть инженеру, она появится здесь."} status={filtered ? "filtered-empty" : "empty"} title={filtered ? "Запчастей по этим условиям нет" : "На руках у инженеров ничего нет"} />
        : <div className="engineer-reservations">{groups.map((group) => <section className="engineer-reservations__group" key={group.engineerName}>
          <header className="engineer-reservations__head">
            <h3>{group.engineerName}</h3>
            <span>{formatRussianCount(group.items.length, ["запчасть", "запчасти", "запчастей"])} · дольше всех {formatRussianCount(group.oldestDays, ["день", "дня", "дней"])}</span>
          </header>
          <ul className="engineer-reservations__list">{group.items.map(({ reservation, days }) => <li key={reservation.id}>
            <div className="engineer-reservations__part">
              <strong>{reservation.articleNumber}</strong>
              <span>{reservation.partName}</span>
              {/* Состояние запчасти уже входит в reservationQuantityText («2 шт. · новая»), второй раз не пишем. */}
              <small>{reservation.number} · {reservationQuantityText(reservation)}{reservation.taskNumber ? ` · задача ${reservation.taskNumber}` : ""}</small>
            </div>
            <div className="engineer-reservations__when">
              {/* Кто и когда выдал — одной подписью: последний шаг здесь всегда выдача, и его время то же самое. */}
              <small className="reservation-steps__last">{["Выдана " + companyDateTimeText(reservationIssuedAt(reservation)), lastReservationStep(reservation)?.actorName].filter(Boolean).join(" · ")}</small>
              <ReservationSteps reservation={reservation} showLast={false} />
            </div>
            <span className={`engineer-reservations__days${days >= 14 ? " engineer-reservations__days--long" : ""}`}>{formatRussianCount(days, ["день", "дня", "дней"])}</span>
          </li>)}</ul>
        </section>)}</div>}
    </DataTableShell> : <DataTableShell meta={loading ? undefined : `${visible.length}${filtered ? ` из ${items.length}` : ""} ${tab === "active" ? "в работе" : "последних"}`} title={tab === "active" ? "Резервы в работе" : "Закрытые резервы"}>
      {loadError ? <ResourceState description={loadError} onRetry={() => void reload()} status="error" title="Резервы не загрузились" />
        : loading && items.length === 0 ? <ResourceState description="Подождите, резервы сейчас появятся." status="loading" title="Загружаем резервы" />
        : visible.length === 0 ? <ResourceState description={filtered ? "Измените условия или сбросьте фильтры." : tab === "active" ? "Когда под задачу зарезервируют запчасть, она появится здесь." : "Выданные, возвращённые и снятые резервы появятся здесь."} status={filtered ? "filtered-empty" : "empty"} title={filtered ? "Резервов по этим условиям нет" : tab === "active" ? "Резервов в работе нет" : "Закрытых резервов пока нет"} />
        : <div className="reservations-container"><div className="table-scroll"><table className="data-table reservations-table">
          <thead><tr>
            <th>Резерв</th><th>Запчасть</th><th>Количество</th><th>Задача</th><th>Инженер</th><th>Состояние</th>
            {showActions ? <th><span className="sr-only">Действия</span></th> : null}
          </tr></thead>
          <tbody>{pageRows.map((reservation) => {
            const actions = availableReservationActions(reservation);
            const busy = busyId === reservation.id;
            const blocked = issueBlockReason(reservation);
            const note = reservationTaskNote(reservation);
            return <tr key={reservation.id}>
              <td data-label="Резерв"><strong className="reservations-table__nowrap">{reservation.number}</strong><small className="reservations-table__date">{formatDisplayDate(tab === "active" ? reservation.createdAt : reservation.updatedAt)}</small></td>
              <td className="reservations-table__wide" data-label="Запчасть"><strong>{reservation.articleNumber}</strong><span className="reservations-table__name">{reservation.partName}</span></td>
              <td className="reservations-table__nowrap" data-label="Количество">{reservationQuantityText(reservation)}</td>
              <td data-label="Задача">{reservation.taskNumber ? <><strong className="reservations-table__nowrap">{reservation.taskNumber}</strong>{reservation.taskTitle ? <span className="reservations-table__name">{reservation.taskTitle}</span> : null}{note ? <span className="reservations-table__note">{note}</span> : null}</> : "—"}</td>
              <td data-label="Инженер">{reservation.issuedToName ?? reservation.engineerName ?? (reservation.taskNumber ? <span className="reservations-table__none">Не назначен</span> : "—")}</td>
              <td className="reservations-table__wide" data-label="Состояние"><StatusBadge tone={RESERVATION_STATUS_TONES[reservation.status]}>{RESERVATION_STATUS_LABELS[reservation.status]}</StatusBadge><ReservationSteps reservation={reservation} /></td>
              {showActions ? <td className="reservations-table__wide"><div className="table-actions reservations-table__actions">{actions.map((action) => <Button
                busy={busy && action !== "cancel"}
                busyLabel="Сохраняем…"
                className="button--compact"
                disabled={busyId !== null || (action === "issue" && Boolean(blocked))}
                key={action}
                onClick={() => runFromRow(reservation, action)}
                title={action === "issue" ? blocked : undefined}
                variant={action === "cancel" ? "ghost" : action === "return" ? "secondary" : "primary"}
              >{ACTION_LABELS[action]}</Button>)}</div></td> : null}
            </tr>;
          })}</tbody>
        </table></div><RegistryPagination ariaLabel="Страницы списка резервов" onPageChange={setPageIndex} onPageSizeChange={(size) => { setPageSize(size); setPageIndex(0); }} pageIndex={pageIndex} pageSize={pageSize} total={visible.length} /></div>}
    </DataTableShell>}
    <ConfirmationDialog
      confirmLabel={shown ? CONFIRM_TEXT[shown.action].confirm : ""}
      description={shown ? (shown.action === "return" && shown.reservation.quantity > 1
        ? <>{confirmDescription(shown.reservation, shown.action)}
          <label className="reservation-return-quantity">Сколько вернули
            <input inputMode="decimal" onChange={(event) => setReturnDraft(event.target.value)} value={returnDraft} />
            <small>Выдано {shown.reservation.quantity}. Если вернули не всё, остальное останется у инженера.</small>
          </label></>
        : confirmDescription(shown.reservation, shown.action)) : null}
      onConfirm={async () => { if (confirming) await run(confirming.reservation, confirming.action); }}
      onOpenChange={(open) => { if (!open) setConfirming(null); }}
      open={Boolean(confirming)}
      title={shown ? CONFIRM_TEXT[shown.action].title : ""}
      tone={shown ? CONFIRM_TEXT[shown.action].tone : "primary"}
    />
  </>;
}
