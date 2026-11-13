import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { m2Api, type StockReservationRecord } from "./m2-api.js";
import { Button, ConfirmationDialog, DataTableShell, MetricCard, PageIntro, PageTabs, ResourceState, StatusBadge, toast } from "./ui.js";
import { formatDisplayDate } from "./date-format.js";
import { formatRussianCount } from "./equipment-changes.js";
import { companyDateTimeText } from "./task-dates.js";
import { ReservationSteps } from "./TaskReservations.js";
import { engineerReservationsFileName, engineerReservationsWorkbook } from "./reservation-export.js";
import { XLSX_MIME } from "./xlsx.js";
import {
  RESERVATION_CONDITION_LABELS,
  RESERVATION_STATUS_LABELS,
  RESERVATION_STATUS_TONES,
  availableReservationActions,
  issueBlockReason,
  reservationIssuedAt,
  reservationQuantityText,
  reservationSummary,
  reservationTaskNote,
  reservationsByEngineer,
  type ReservationAction
} from "./reservations.js";

type ReservationsTab = "active" | "closed" | "engineers";
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
  const [tab, setTab] = useState<ReservationsTab>("active");
  // Вкладка для перезагрузки после действия: замыкание могло запомнить прежнюю.
  const tabRef = useRef<ReservationsTab>("active");
  const [items, setItems] = useState<readonly StockReservationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ readonly reservation: StockReservationRecord; readonly action: ConfirmedAction } | null>(null);
  const [exporting, setExporting] = useState(false);
  // Пока окно подтверждения закрывается, в нём остаётся прежний текст, а не пустой заголовок.
  const lastConfirming = useRef(confirming);
  if (confirming) lastConfirming.current = confirming;
  const shown = confirming ?? lastConfirming.current;
  // Ответ на старую вкладку не должен затереть список новой.
  const loadTurn = useRef(0);

  const reload = async (nextTab = tabRef.current) => {
    const turn = ++loadTurn.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await m2Api.stockReservations(nextTab === "closed" ? "closed" : "active");
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

  const changeTab = (next: ReservationsTab) => {
    tabRef.current = next;
    setTab(next);
    setItems([]);
    void reload(next);
  };

  /** Действие, затем свежий список; кнопки снова доступны только после обновления списка. */
  const run = async (reservation: StockReservationRecord, action: ReservationAction) => {
    setBusyId(reservation.id);
    try {
      if (action === "ready") await m2Api.markStockReservationReady(reservation.id);
      else if (action === "issue") await m2Api.issueStockReservation(reservation.id);
      else if (action === "cancel") await m2Api.cancelStockReservation(reservation.id);
      else await m2Api.returnStockReservation(reservation.id);
      const what = `${reservation.articleNumber} · ${reservationQuantityText(reservation)}`;
      if (action === "ready") toast.success(issueBlockReason(reservation) ? `Собрано: ${what}` : `Собрано: ${what}. Можно выдавать инженеру`);
      else if (action === "issue") toast.success(`Выдано: ${what}. Получил: ${reservation.engineerName ?? "инженер задачи"}`);
      else if (action === "cancel") toast.success(`Резерв ${reservation.number} снят, запчасть снова доступна`);
      else toast.success(`Принято на склад: ${what}`);
    } finally {
      await reload();
      setBusyId(null);
    }
  };

  const runFromRow = (reservation: StockReservationRecord, action: ReservationAction) => {
    if (action !== "ready") { setConfirming({ reservation, action }); return; }
    void run(reservation, action).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не получилось выполнить действие"));
  };

  const summary = reservationSummary(tab === "active" ? items : []);
  const showActions = canWrite && tab === "active";
  const counting = loading && items.length === 0;
  const groups = tab === "engineers" ? reservationsByEngineer(items) : [];
  const issuedCount = groups.reduce((total, group) => total + group.items.length, 0);

  // Выгрузка того, что сейчас на вкладке: по строке на каждую выданную запчасть.
  const exportEngineers = async () => {
    setExporting(true);
    try {
      const url = URL.createObjectURL(new Blob([(await engineerReservationsWorkbook(items)) as BlobPart], { type: XLSX_MIME }));
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
      setExporting(false);
    }
  };

  return <>
    <PageIntro description="Запчасти под задачи: собрать, выдать инженеру, принять обратно." title="Резервы" />
    {tab === "active" ? <div className="metric-grid metric-grid--three">
      <MetricCard icon="inventory" label="Ждут сборки" tone="yellow" value={counting ? "…" : String(summary.toCollect)} />
      <MetricCard icon="reservations" label="Собраны, можно выдавать" value={counting ? "…" : String(summary.ready)} />
      <MetricCard icon="engineers" label="У инженеров" tone="purple" value={counting ? "…" : String(summary.withEngineers)} />
    </div> : null}
    <PageTabs items={[{ value: "active", label: "Действующие" }, { value: "engineers", label: "У инженеров" }, { value: "closed", label: "Закрытые" }]} label="Резервы" onValueChange={changeTab} value={tab} />
    {tab === "engineers" ? <DataTableShell
      action={items.length ? <Button busy={exporting} busyLabel="Готовим файл…" disabled={issuedCount === 0} onClick={() => void exportEngineers()} variant="secondary">Скачать в Excel</Button> : undefined}
      meta={loading ? undefined : `${formatRussianCount(issuedCount, ["запчасть", "запчасти", "запчастей"])} у ${formatRussianCount(groups.length, ["инженера", "инженеров", "инженеров"])}`}
      title="Запчасти у инженеров"
    >
      {loadError ? <ResourceState description={loadError} onRetry={() => void reload()} status="error" title="Резервы не загрузились" />
        : loading && items.length === 0 ? <ResourceState description="Подождите, резервы сейчас появятся." status="loading" title="Загружаем резервы" />
        : groups.length === 0 ? <ResourceState description="Как только кладовщик выдаст запчасть инженеру, она появится здесь." status="empty" title="На руках у инженеров ничего нет" />
        : <div className="engineer-reservations">{groups.map((group) => <section className="engineer-reservations__group" key={group.engineerName}>
          <header className="engineer-reservations__head">
            <h3>{group.engineerName}</h3>
            <span>{formatRussianCount(group.items.length, ["запчасть", "запчасти", "запчастей"])} · дольше всех {formatRussianCount(group.oldestDays, ["день", "дня", "дней"])}</span>
          </header>
          <ul className="engineer-reservations__list">{group.items.map(({ reservation, days }) => <li key={reservation.id}>
            <div className="engineer-reservations__part">
              <strong>{reservation.articleNumber}</strong>
              <span>{reservation.partName}</span>
              <small>{reservation.number} · {reservationQuantityText(reservation)} · {RESERVATION_CONDITION_LABELS[reservation.condition]}{reservation.taskNumber ? ` · задача ${reservation.taskNumber}` : ""}</small>
            </div>
            <div className="engineer-reservations__when">
              <small className="reservation-steps__last">Выдана {companyDateTimeText(reservationIssuedAt(reservation))}</small>
              <ReservationSteps reservation={reservation} />
            </div>
            <span className={`engineer-reservations__days${days >= 14 ? " engineer-reservations__days--long" : ""}`}>{formatRussianCount(days, ["день", "дня", "дней"])}</span>
          </li>)}</ul>
        </section>)}</div>}
    </DataTableShell> : <DataTableShell meta={loading ? undefined : `${items.length} ${tab === "active" ? "в работе" : "последних"}`} title={tab === "active" ? "Резервы в работе" : "Закрытые резервы"}>
      {loadError ? <ResourceState description={loadError} onRetry={() => void reload()} status="error" title="Резервы не загрузились" />
        : loading && items.length === 0 ? <ResourceState description="Подождите, резервы сейчас появятся." status="loading" title="Загружаем резервы" />
        : items.length === 0 ? <ResourceState description={tab === "active" ? "Когда под задачу зарезервируют запчасть, она появится здесь." : "Выданные, возвращённые и снятые резервы появятся здесь."} status="empty" title={tab === "active" ? "Резервов в работе нет" : "Закрытых резервов пока нет"} />
        : <div className="reservations-container"><div className="table-scroll"><table className="data-table reservations-table">
          <thead><tr>
            <th>Резерв</th><th>Запчасть</th><th>Количество</th><th>Задача</th><th>Инженер</th><th>Состояние</th>
            {showActions ? <th><span className="sr-only">Действия</span></th> : null}
          </tr></thead>
          <tbody>{items.map((reservation) => {
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
        </table></div></div>}
    </DataTableShell>}
    <ConfirmationDialog
      confirmLabel={shown ? CONFIRM_TEXT[shown.action].confirm : ""}
      description={shown ? confirmDescription(shown.reservation, shown.action) : null}
      onConfirm={async () => { if (confirming) await run(confirming.reservation, confirming.action); }}
      onOpenChange={(open) => { if (!open) setConfirming(null); }}
      open={Boolean(confirming)}
      title={shown ? CONFIRM_TEXT[shown.action].title : ""}
      tone={shown ? CONFIRM_TEXT[shown.action].tone : "primary"}
    />
  </>;
}
