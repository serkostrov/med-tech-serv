import React, { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import type { BulkTaskCommandResponse, EngineerTaskListItem, EngineerTaskListResponse, EquipmentHistoryEvent, EquipmentMeterReading, MailInboxRecord, NotificationJournalRecord, NotificationTemplateResponse, TaskPartPosition } from "./types.js";
import {
  getDefaultView,
  getRoleNavigation,
  roleLabels,
  taskIdFromPathname,
  taskPathname,
  type AppRole,
  type NavigationId,
  type NavigationItem
} from "./navigation.js";
import { hasEquipmentSerialConflict } from "./equipment-passport.js";
import { referenceEditPayload } from "./reference-edit.js";
import {
  formatEquipmentAssignmentChange,
  formatEquipmentAssignmentDate,
  formatRussianCount,
  localDateTimeInputValue,
  localDateTimeToIso,
  type EquipmentAssignmentKind,
  type NewEquipmentAssignmentChange
} from "./equipment-changes.js";
import {
  equipmentHistoryDescription,
  equipmentHistoryEventLabel,
  type ManualEquipmentHistoryDraft
} from "./equipment-history.js";
import {
  EMPTY_EQUIPMENT_REGISTRY_FILTERS,
  type EquipmentRegistryFilters
} from "./equipment-registry.js";
import {
  M2ApiError,
  m2Api,
  type ApiSessionUser,
  type EquipmentApiRecord,
  type EquipmentCardResponse,
  type EquipmentPassportReferences,
  type InvoiceApiRecord,
  type ReferenceCatalogDescriptor,
  type ReferenceCatalogValue,
  type TaskCardResponse,
  type TaskApiRecord
} from "./m2-api.js";
import { WorkAct } from "./WorkAct.js";
import { buildWorkAct, type WorkActEquipmentRow, type WorkActWorkRow } from "./work-act.js";
import { ClosureReview } from "./ClosureReview.js";
import { MaintenancePlanPage } from "./MaintenancePlan.js";
import { taskCalendarDate } from "./task-dates.js";
import { RegistryPagination, registryPageOffset } from "./RegistryPagination.js";
import {
  EngineersPage as OperationsEngineersPage,
  ReportsPage as OperationsReportsPage,
  WarehousePage as OperationsWarehousePage
} from "./OperationsPages.js";
import { TaskBoard } from "./TaskBoard.js";
import { CustomerReferencesPage } from "./CustomerReferencesPage.js";
import { AccessAdminPage } from "./AccessAdminPage.js";
import type { PayerOption, SiteOption } from "./customer-selection.js";
import {
  Button,
  IconButton,
  CardHeader,
  ConfirmationDialog,
  DataTableShell,
  DatePicker,
  DateTimePicker,
  Dialog,
  DialogForm,
  EntityDetailHeader,
  EntityDetailToolbar,
  Field,
  FilterBar,
  Icon,
  Input,
  MetricCard,
  PageTabs,
  PageIntro,
  ResourceState,
  StatusBadge,
  type StatusTone,
  Select,
  toast
} from "./ui.js";
import { formatDisplayDate } from "./date-format.js";
import { TASK_STATUS_LABELS } from "./domain/task-status.js";
import { toTechnicalCode } from "./slug.js";
import { AppShell } from "./components/app-shell.js";

const FILE_KIND_LABELS: Readonly<Record<string, string>> = {
  act: "Фото акта",
  photo: "Фото",
  video: "Видео",
  document: "Документ"
};

function taskStatusTone(status: string): StatusTone {
  if (status === "closed") return "success";
  if (status === "under_review") return "info";
  if (status === "in_progress") return "purple";
  if (status === "cancelled") return "neutral";
  return "warning";
}

function formatTaskDate(value: string | undefined, withTime = false): string {
  if (!value) return "Не указано";
  return formatDisplayDate(value, withTime) || value;
}

function formatTaskDateRange(from: string | undefined, to: string | undefined, withTime = false): string {
  if (!from && !to) return "Не указано";
  return `${formatTaskDate(from, withTime)} — ${formatTaskDate(to, withTime)}`;
}

function TaskFlag({ value }: { readonly value: boolean | undefined }) {
  if (value === undefined) return <span className="task-flag task-flag--empty">Не заполнено</span>;
  return <span className={`task-flag task-flag--${value ? "yes" : "no"}`}>{value ? "Да" : "Нет"}</span>;
}

function taskJournalDescription(event: TaskCardResponse["journal"][number]): string {
  if (event.description) return event.description;
  if (event.action === "created") return "Задача создана";
  if (event.action === "assigned") return "Назначен инженер";
  if (event.toStatus) {
    return `${TASK_STATUS_LABELS[event.fromStatus ?? ""] ?? "—"} → ${TASK_STATUS_LABELS[event.toStatus] ?? "—"}`;
  }
  return "Изменены данные задачи";
}

function TaskTable({ tasks, equipment, engineers, onOpen, selectedTaskIds, onToggle, onToggleAll, filtered = false }: {
  readonly tasks: readonly TaskApiRecord[];
  readonly equipment: readonly EquipmentApiRecord[];
  readonly engineers: readonly { readonly id: string; readonly fullName: string }[];
  readonly onOpen: (id: string) => void;
  readonly selectedTaskIds: ReadonlySet<string>;
  readonly onToggle: (id: string, selected: boolean) => void;
  readonly onToggleAll: (selected: boolean) => void;
  readonly filtered?: boolean;
}) {
  const allSelected = tasks.length > 0 && tasks.every((task) => selectedTaskIds.has(task.id));
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th className="task-select-cell" scope="col"><input aria-label="Выбрать все задачи на странице" checked={allSelected} onChange={(event) => onToggleAll(event.target.checked)} type="checkbox" /></th>
            <th scope="col">№ задачи</th>
            <th scope="col">Задача</th>
            <th scope="col">Площадка</th>
            <th scope="col">Прибор</th>
            <th scope="col">Срок</th>
            <th scope="col">Инженер</th>
            <th scope="col">Статус</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const device = equipment.find((item) => item.id === task.equipmentId);
            return (
            <tr className="task-registry-row" key={task.id} onClick={() => onOpen(task.id)}>
              <td className="task-select-cell" onClick={(event) => event.stopPropagation()}><input aria-label={`Выбрать задачу ${task.number}`} checked={selectedTaskIds.has(task.id)} onChange={(event) => onToggle(task.id, event.target.checked)} type="checkbox" /></td>
              <td><button className="text-button" onClick={() => onOpen(task.id)} type="button"><strong>{task.number}</strong></button></td>
              <td><strong>{task.title}</strong></td>
              <td>{task.customer?.siteName ?? "Не выбрана"}</td>
              <td className="muted">{device ? `${device.model} · S/N ${device.serialNumber}` : "Не выбран"}</td>
              <td>{formatTaskDate(task.periodTo)}{task.priority === "urgent" ? <span className="urgent-label">срочно</span> : null}{task.isOverdue ? <span className="status-badge status-badge--danger">просрочена</span> : null}</td>
              <td>{engineers.find((engineer) => engineer.id === task.engineerId)?.fullName ?? (task.engineerId ? "Инженер" : "Не назначен")}</td>
              <td><StatusBadge tone={taskStatusTone(task.status)}>{TASK_STATUS_LABELS[task.status] ?? "Статус"}</StatusBadge></td>
            </tr>
          );})}
          {tasks.length === 0 ? <tr><td colSpan={8}><ResourceState description={filtered ? "Измените условия или сбросьте фильтры." : "Создайте заявку — она появится в списке и на доске."} status={filtered ? "filtered-empty" : "empty"} title={filtered ? "Задач по этим условиям нет" : "Задач пока нет"} /></td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

function equipmentSearchHaystack(item: EquipmentApiRecord): string {
  return [item.serialNumber, item.manufacturer, item.model, item.site, item.organization, item.payer]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("ru-RU");
}

function filterEquipmentOptions(items: readonly EquipmentApiRecord[], query: string): readonly EquipmentApiRecord[] {
  const normalized = query.trim().toLocaleLowerCase("ru-RU");
  if (!normalized) return items;
  return items.filter((item) => equipmentSearchHaystack(item).includes(normalized));
}

function TaskCreationForm({ open, equipment, workTypes, initialTitle = "", initialWorkTypeCode, onOpenChange, onCreated }: {
  readonly open: boolean;
  readonly equipment: readonly EquipmentApiRecord[];
  readonly workTypes: readonly ReferenceCatalogValue[];
  readonly initialTitle?: string;
  readonly initialWorkTypeCode?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (task: TaskApiRecord) => Promise<void>;
}) {
  const activeWorkTypes = workTypes.filter((item) => item.isActive);
  const defaultWorkType = initialWorkTypeCode || activeWorkTypes[0]?.code || activeWorkTypes[0]?.id || "diagnostics";
  const [equipmentId, setEquipmentId] = useState("");
  const [workTypeCode, setWorkTypeCode] = useState(defaultWorkType);
  const [priority, setPriority] = useState<"planned" | "urgent">("planned");
  const [callDate, setCallDate] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [equipmentQuery, setEquipmentQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const selectedEquipment = equipment.find((item) => item.id === equipmentId);
  const filteredEquipment = useMemo(() => filterEquipmentOptions(equipment, equipmentQuery), [equipment, equipmentQuery]);

  useEffect(() => {
    if (!open) return;
    setWorkTypeCode(defaultWorkType);
  }, [defaultWorkType, open]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [pickerOpen]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [equipmentQuery, pickerOpen]);

  const applyEquipment = (device: EquipmentApiRecord | undefined) => {
    setEquipmentId(device?.id ?? "");
  };

  const selectEquipment = (device: EquipmentApiRecord) => {
    applyEquipment(device);
    setEquipmentQuery("");
    setPickerOpen(false);
  };

  const changeEquipment = () => {
    applyEquipment(undefined);
    setEquipmentQuery("");
    setPickerOpen(true);
  };

  const onEquipmentKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setPickerOpen(true);
      setHighlightIndex((current) => Math.min(current + 1, Math.max(filteredEquipment.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setPickerOpen(true);
      setHighlightIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const highlighted = filteredEquipment[highlightIndex];
      if (pickerOpen && highlighted) {
        event.preventDefault();
        selectEquipment(highlighted);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setPickerOpen(false);
    }
  };

  const fail = (message: string) => {
    toast.warning(message);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    if (!title) return fail("Укажите название задачи");
    if (!selectedEquipment) return fail("Выберите прибор из списка");
    if (!selectedEquipment.siteId) return fail("У прибора нет площадки. Укажите место установки в паспорте прибора.");
    if (!selectedEquipment.payerId) return fail("У прибора нет плательщика. Укажите плательщика в паспорте прибора.");
    if (!periodFrom || !periodTo) return fail("Укажите период выполнения: даты «с» и «по»");
    if (periodFrom > periodTo) return fail("Начало периода не может быть позже конца");
    setBusy(true);
    try {
      const task = await m2Api.createTask({
        title,
        workTypeCode,
        priority,
        equipmentId: selectedEquipment.id,
        siteId: selectedEquipment.siteId,
        payerId: selectedEquipment.payerId,
        periodFrom: taskCalendarDate(periodFrom),
        periodTo: taskCalendarDate(periodTo),
        ...(callDate ? { callDate: taskCalendarDate(callDate) } : {})
      });
      await onCreated(task);
    } catch (createError) {
      toast.error(createError instanceof Error ? createError.message : "Не получилось создать задачу");
    } finally {
      setBusy(false);
    }
  };

  return <DialogForm busy={busy} description="Площадка и плательщик берутся из паспорта прибора. Задайте их там, если ещё не указаны." onOpenChange={onOpenChange} onSubmit={submit} open={open} size="lg" submitLabel="Создать задачу" title="Новая задача">
      <label className="field-wide">Название задачи *<input autoFocus defaultValue={initialTitle} maxLength={200} name="title" placeholder="Например, диагностика анализатора" required /></label>
      <label>Вид работ *<Select onChange={(event) => setWorkTypeCode(event.target.value)} required value={workTypeCode}>{activeWorkTypes.map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label>
      <label className="task-priority-check">
        <input
          checked={priority === "urgent"}
          onChange={(event) => setPriority(event.target.checked ? "urgent" : "planned")}
          type="checkbox"
        />
        <span className="task-priority-check__text">
          <strong>Срочная</strong>
          <small>Реакция до 24 ч · иначе плановая</small>
        </span>
      </label>
      <div className="equipment-picker field-wide">
        <span className="equipment-picker__label">Прибор *</span>
        {selectedEquipment ? (
          <div className="equipment-picker__selected">
            <p className="equipment-picker__result">
              <strong>{selectedEquipment.manufacturer} {selectedEquipment.model}</strong>
              <span>S/N {selectedEquipment.serialNumber} · {selectedEquipment.site ?? "площадка не указана"} · {selectedEquipment.payer ?? "плательщик не указан"}</span>
            </p>
            <Button onClick={changeEquipment} type="button" variant="secondary">Сменить</Button>
          </div>
        ) : (
          <div className="equipment-combobox" ref={pickerRef}>
            <input
              aria-autocomplete="list"
              aria-controls="equipment-combobox-list"
              aria-expanded={pickerOpen}
              aria-label="Поиск прибора"
              onChange={(event) => {
                setEquipmentQuery(event.target.value);
                setPickerOpen(true);
              }}
              onFocus={() => setPickerOpen(true)}
              onKeyDown={onEquipmentKeyDown}
              placeholder="S/N, модель или производитель"
              role="combobox"
              type="search"
              value={equipmentQuery}
            />
            {pickerOpen ? (
              <ul className="equipment-combobox__list" id="equipment-combobox-list" role="listbox">
                {filteredEquipment.length === 0 ? <li className="equipment-combobox__empty">Приборов по этому запросу нет</li> : null}
                {filteredEquipment.map((item, index) => (
                  <li key={item.id} role="presentation">
                    <button
                      aria-selected={index === highlightIndex}
                      className={index === highlightIndex ? "is-active" : undefined}
                      onClick={() => selectEquipment(item)}
                      onMouseEnter={() => setHighlightIndex(index)}
                      role="option"
                      type="button"
                    >
                      <strong>{item.manufacturer} {item.model}</strong>
                      <span>S/N {item.serialNumber} · {item.site ?? item.organization ?? "площадка не указана"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="equipment-picker__hint">Начните вводить S/N или модель — список отфильтруется.</p>
          </div>
        )}
        {selectedEquipment && (!selectedEquipment.siteId || !selectedEquipment.payerId) ? (
          <p className="form-hint">Сначала укажите { !selectedEquipment.siteId && !selectedEquipment.payerId ? "площадку и плательщика" : !selectedEquipment.siteId ? "площадку" : "плательщика"} в паспорте прибора.</p>
        ) : null}
      </div>
      <div className="dialog-form-row-3">
        <label>Дата вызова<DatePicker onChange={setCallDate} value={callDate} /></label>
        <label>Период с *<DatePicker onChange={setPeriodFrom} required value={periodFrom} /></label>
        <label>Период по *<DatePicker onChange={setPeriodTo} required value={periodTo} /></label>
      </div>
  </DialogForm>;
}

export function TaskCard({ card, workTypes = [], onBack, onChanged, onOpenRelated, initialTab = "overview" }: {
  readonly card: TaskCardResponse;
  readonly workTypes?: readonly ReferenceCatalogValue[];
  readonly onBack: () => void;
  readonly onChanged: () => Promise<void>;
  readonly onOpenRelated: (id: string) => Promise<void>;
  readonly initialTab?: "overview" | "result" | "materials" | "history";
}) {
  const [suggestions, setSuggestions] = useState<readonly { readonly engineerId: string; readonly fullName: string }[]>([]);
  const [engineerId, setEngineerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionDialog, setActionDialog] = useState<"cancel" | "return_for_rework" | null>(null);
  const [actOpen, setActOpen] = useState(false);
  const [actRowsEditing, setActRowsEditing] = useState(false);
  const [overviewEditing, setOverviewEditing] = useState(false);
  const [detailTab, setDetailTab] = useState<"overview" | "result" | "materials" | "history">(initialTab);
  const task = card.task;
  type PartDraft = Omit<TaskPartPosition, "id" | "quantity"> & { readonly key: string; readonly quantity: string };
  const toPartDrafts = (parts: readonly TaskPartPosition[]): readonly PartDraft[] => parts.map((part) => ({
    key: part.id,
    articleNumber: part.articleNumber,
    name: part.name,
    quantity: String(part.quantity),
    condition: part.condition
  }));
  const [partDrafts, setPartDrafts] = useState<readonly PartDraft[]>(() => toPartDrafts(card.parts));
  const [partsEditing, setPartsEditing] = useState(false);
  const initialAct = buildWorkAct(card);
  const [actEquipmentRows, setActEquipmentRows] = useState<readonly WorkActEquipmentRow[]>(initialAct.equipment);
  const [actWorkRows, setActWorkRows] = useState<readonly WorkActWorkRow[]>(initialAct.works);
  const canAssign = card.availableActions.some((action) => action.code === "assign");
  const canCloseReview = card.availableActions.some((action) => action.code === "verify_closure" || action.code === "close");
  const canReturnReview = card.availableActions.some((action) => action.code === "return_for_rework");

  useEffect(() => {
    if (!partsEditing) setPartDrafts(toPartDrafts(card.parts));
  }, [card.parts, task.id, partsEditing]);

  useEffect(() => {
    const next = buildWorkAct(card);
    setActEquipmentRows(next.equipment);
    setActWorkRows(next.works);
  }, [task.id]);

  useEffect(() => {
    if (!canAssign || !card.equipment) return;
    void m2Api.taskAssignmentSuggestions(task.id, card.equipment.manufacturer, card.equipment.model)
      .then((items) => {
        setSuggestions(items);
        setEngineerId(items[0]?.engineerId ?? "");
      })
      .catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить список инженеров"));
  }, [task.id, canAssign, card.equipment?.id]);

  const perform = async (code: string, suppliedComment?: string) => {
    setBusy(true);
    setFormError(null);
    try {
      if (code === "assign") {
        if (!engineerId) throw new Error("Выберите инженера");
        await m2Api.assignTask(task.id, engineerId);
      } else if (code === "verify_closure") {
        await m2Api.acceptTaskClosure(task.id, "Проверено координатором");
      } else if (code === "cancel") {
        if (!suppliedComment?.trim()) throw new Error("Укажите причину отмены задачи");
        await m2Api.transitionTask(task.id, "cancelled", { cancellationReason: suppliedComment.trim() });
      } else if (code === "return_for_rework") {
        if (!suppliedComment?.trim()) throw new Error("Укажите, что нужно доработать инженеру");
        await m2Api.transitionTask(task.id, "in_progress", { reworkComment: suppliedComment.trim() });
      } else {
        const target = card.availableActions.find((action) => action.code === code)?.targetStatus;
        if (target) await m2Api.transitionTask(task.id, target);
      }
      await onChanged();
      return true;
    } catch (actionError) {
      toast.error(actionError instanceof Error ? actionError.message : "Не получилось изменить задачу");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const updatePartDraft = (index: number, patch: Partial<Omit<PartDraft, "key">>) => {
    setPartDrafts((current) => current.map((part, partIndex) => partIndex === index ? { ...part, ...patch } : part));
  };
  const addPartDraft = () => {
    setPartDrafts((current) => [...current, {
      key: `new-${Date.now()}-${current.length}`,
      articleNumber: "",
      name: "",
      quantity: "1",
      condition: "N"
    }]);
    setPartsEditing(true);
  };
  const saveParts = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const items = partDrafts.map((part) => ({
        articleNumber: part.articleNumber,
        name: part.name,
        quantity: Number(part.quantity.replace(",", ".")),
        condition: part.condition
      }));
      const stored = await m2Api.replaceTaskParts(task.id, items);
      setPartDrafts(toPartDrafts(stored.items));
      setPartsEditing(false);
      await onChanged();
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "Не получилось сохранить запчасти");
    } finally {
      setBusy(false);
    }
  };

  const saveOverview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const data = new FormData(event.currentTarget);
      const periodFrom = taskCalendarDate(String(data.get("periodFrom") ?? ""));
      const periodTo = taskCalendarDate(String(data.get("periodTo") ?? ""));
      const callDate = taskCalendarDate(String(data.get("callDate") ?? ""));
      const visitValue = String(data.get("visitDate") ?? "").trim();
      await m2Api.updateTaskOverview(task.id, {
        title: String(data.get("title") ?? "").trim(),
        workTypeCode: String(data.get("workTypeCode") ?? "").trim(),
        priority: data.get("urgent") === "on" ? "urgent" : "planned",
        periodFrom,
        periodTo,
        callDate,
        ...(visitValue ? { visitDate: taskCalendarDate(visitValue) } : {})
      });
      setOverviewEditing(false);
      await onChanged();
    } catch (saveError) {
      const text = saveError instanceof Error ? saveError.message : "Не получилось сохранить задачу";
      setFormError(text);
      toast.error(text);
    } finally {
      setBusy(false);
    }
  };

  const workTypeLabel = card.workType?.name ? `${card.workType.name}${task.workModifier ? ` · ${task.workModifier}` : ""}` : "—";
  const meterLabel = task.meterReading ?? card.closure?.meterReading;
  const contactDetails = [task.customer?.contactPhone, task.customer?.contactEmail].filter(Boolean).join(" · ");
  const canCancel = card.availableActions.some((action) => action.code === "cancel");
  const workflowActions = card.availableActions.filter((action) => action.code !== "assign" && action.code !== "cancel" && (task.status !== "under_review" || (action.code !== "verify_closure" && action.code !== "close" && action.code !== "return_for_rework")));
  const overviewHeaderActions = (card.canEditOverview || canCancel) ? <>
    {card.canEditOverview ? <Button onClick={() => { setFormError(null); setOverviewEditing(true); }} variant="secondary">Изменить задачу</Button> : null}
    {canCancel ? <IconButton disabled={busy} icon="trash" label="Удалить задачу" onClick={() => setActionDialog("cancel")} variant="danger" /> : null}
  </> : undefined;
  if (actOpen) return <WorkAct act={buildWorkAct(card, { equipment: actEquipmentRows, works: actWorkRows })} onBack={() => setActOpen(false)} />;
  return <>
    <EntityDetailToolbar actions={<Button onClick={() => setActOpen(true)} variant="secondary">Открыть акт</Button>} backLabel="К списку задач" onBack={onBack} />
    <EntityDetailHeader aside={<StatusBadge tone={taskStatusTone(task.status)}>{card.status.name}</StatusBadge>} description={`${card.workType?.name ?? "Вид работ не указан"} · ${task.customer?.siteName ?? "Площадка не указана"}`} meta={task.isOverdue ? <span className="entity-detail-heading__overdue">Срок истёк</span> : undefined} title={task.title} />
    <PageTabs items={[{ value: "overview", label: "Обзор" }, { value: "result", label: "Результат и акт" }, { value: "materials", label: "Файлы и запчасти", badge: card.files.length + card.parts.length }, { value: "history", label: "История", badge: card.journal.length }]} label="Разделы карточки задачи" onValueChange={setDetailTab} value={detailTab} />
    {detailTab === "overview" ? <section className="card task-card-summary">
      <CardHeader action={overviewHeaderActions} meta="Основные параметры" title="О задаче" />
      <div className="task-card-grid">
        <div className="task-overview-groups">
          <div className="task-field-group">
            <h3>Сроки и работы</h3>
            <dl className="task-field-grid">
              <div><dt>Вид работ</dt><dd className={card.workType?.name ? undefined : "is-empty"}>{workTypeLabel}</dd></div>
              <div><dt>Период</dt><dd className={task.periodFrom || task.periodTo ? undefined : "is-empty"}>{formatTaskDateRange(task.periodFrom, task.periodTo)}</dd></div>
              <div><dt>Дата вызова</dt><dd className={task.callDate ? undefined : "is-empty"}>{formatTaskDate(task.callDate)}</dd></div>
              <div><dt>Дата выезда</dt><dd className={task.visitDate ? undefined : "is-empty"}>{formatTaskDate(task.visitDate)}</dd></div>
              <div><dt>Окончание работ</dt><dd className={task.completedAt ? undefined : "is-empty"}>{formatTaskDate(task.completedAt, true)}</dd></div>
              <div><dt>Время работ</dt><dd className={task.workStartedAt || task.workFinishedAt ? undefined : "is-empty"}>{formatTaskDateRange(task.workStartedAt, task.workFinishedAt, true)}</dd></div>
              <div><dt>Часы</dt><dd className={task.hours === undefined ? "is-empty" : undefined}>{task.hours ?? "—"}</dd></div>
            </dl>
          </div>
          <div className="task-field-group">
            <h3>Клиент и исполнитель</h3>
            <dl className="task-field-grid">
              <div><dt>Площадка</dt><dd className={task.customer?.siteName ? undefined : "is-empty"}>{task.customer?.siteName ?? "—"}{task.customer?.address ? <small>{task.customer.address}</small> : null}</dd></div>
              <div><dt>Контакт</dt><dd className={task.customer?.contactFullName ? undefined : "is-empty"}>{task.customer?.contactFullName ?? "—"}{contactDetails ? <small>{contactDetails}</small> : null}</dd></div>
              <div><dt>Плательщик</dt><dd className={task.customer?.payerName ? undefined : "is-empty"}>{task.customer?.payerName ?? "—"}</dd></div>
              <div><dt>Инженер</dt><dd className={card.engineer ? undefined : "is-empty"}>{card.engineer?.fullName ?? "Не назначен"}</dd></div>
              <div><dt>Договор</dt><dd className={task.contractNumber || task.contractId ? undefined : "is-empty"}>{task.contractNumber ?? task.contractId ?? "—"}</dd></div>
            </dl>
          </div>
          <div className="task-field-group">
            <h3>Связи</h3>
            <dl className="task-field-grid">
              <div><dt>Первичная задача</dt><dd className={task.primaryTaskId ? undefined : "is-empty"}>{task.primaryTaskId ? <button className="text-button" onClick={() => void onOpenRelated(task.primaryTaskId!)} type="button">{task.primaryTaskNumber ?? task.primaryTaskId}</button> : "—"}</dd></div>
              <div><dt>Задача-продолжение</dt><dd className={task.continuationTaskId ? undefined : "is-empty"}>{task.continuationTaskId ? <button className="text-button" onClick={() => void onOpenRelated(task.continuationTaskId!)} type="button">{task.continuationTaskNumber ?? task.continuationTaskId}</button> : "—"}</dd></div>
              <div><dt>Из плана ТО</dt><dd><TaskFlag value={task.isMaintenancePlan} /></dd></div>
              <div><dt>Показание счётчика</dt><dd className={meterLabel === undefined ? "is-empty" : undefined}>{meterLabel ?? "—"}</dd></div>
            </dl>
          </div>
          {canAssign || workflowActions.length > 0 ? <div className="task-workflow-bar">
            {canAssign ? <div className="assignment-control"><Select aria-label="Инженер" onChange={(event) => setEngineerId(event.target.value)} value={engineerId}><option value="">Выберите инженера</option>{suggestions.map((item) => <option key={item.engineerId} value={item.engineerId}>{item.fullName}</option>)}</Select><Button disabled={busy || !engineerId} onClick={() => void perform("assign")}>Назначить инженера</Button></div> : null}
            {workflowActions.map((action) => <Button disabled={busy} key={action.code} onClick={() => action.code === "return_for_rework" ? setActionDialog(action.code) : void perform(action.code)} variant={action.code === "return_for_rework" ? "secondary" : "primary"}>{action.label}</Button>)}
          </div> : null}
        </div>
        <aside className="task-equipment-panel">
          <h3>Прибор</h3>
          {card.equipment ? <>
            <strong>{card.equipment.manufacturer} {card.equipment.model}</strong>
            <span>S/N {card.equipment.serialNumber}</span>
            <span className="task-equipment-panel__status">{card.equipment.statusName ?? card.equipment.status}</span>
            <span>{card.equipment.site ?? "Место не указано"}</span>
          </> : <span className="is-empty">Прибор не найден</span>}
        </aside>
      </div>
    </section> : null}
    {detailTab === "overview" && task.status === "under_review" ? <ClosureReview
      busy={busy}
      canClose={canCloseReview}
      canReturn={canReturnReview}
      card={card}
      onClose={async () => { await perform(card.availableActions.some((action) => action.code === "verify_closure") ? "verify_closure" : "close"); }}
      onOpenAct={() => setActOpen(true)}
      onReturn={async (comment) => { await perform("return_for_rework", comment); }}
    /> : null}
    {detailTab === "result" ? <section className="card task-result-card">
      <CardHeader action={<Button onClick={() => setActRowsEditing(true)} variant="secondary">Редактировать акт</Button>} meta="Поля акта и закрытия" title="Результат работ" />
      <div className="task-result-body">
        <dl className="task-narrative-list">
          <div><dt>Причина вызова</dt><dd className={task.callReason ? undefined : "is-empty"}>{task.callReason ?? "Не заполнено"}</dd></div>
          <div><dt>Описание работ</dt><dd className={task.workDescription ? undefined : "is-empty"}>{task.workDescription ?? "Не заполнено"}</dd></div>
          <div><dt>Рекомендации</dt><dd className={task.recommendations ? undefined : "is-empty"}>{task.recommendations ?? "Не заполнено"}</dd></div>
          <div><dt>Замечания пользователя</dt><dd className={task.userRemarks ? undefined : "is-empty"}>{task.userRemarks ?? "Не заполнено"}</dd></div>
        </dl>
        <div className="task-flag-grid" role="list">
          <article role="listitem"><span>Работы выполнены полностью</span><TaskFlag value={task.workCompleted ?? card.closure?.workCompleted} /></article>
          <article role="listitem"><span>Аппарат исправен и допущен</span><TaskFlag value={task.apparatusApproved ?? card.closure?.apparatusApproved} /></article>
          <article role="listitem"><span>Претензий нет</span><TaskFlag value={task.customerHasNoClaims ?? card.closure?.customerHasNoClaims} /></article>
          <article role="listitem"><span>Продолжение первичной заявки</span><TaskFlag value={task.continuedInPrimary} /></article>
        </div>
      </div>
    </section> : null}
    <Dialog footer={<><Button onClick={() => setActRowsEditing(false)} variant="secondary">Сохранить строки</Button><Button onClick={() => setActOpen(true)}>Открыть акт</Button></>} onOpenChange={setActRowsEditing} open={actRowsEditing} size="lg" title="Данные печатного акта"><section className="work-act-row-editor work-act-row-editor--dialog">
      <h3>Оборудование</h3>
      <div className="work-act-row-editor__list">{actEquipmentRows.map((item, index) => <div className="work-act-row-editor__equipment" key={`equipment-${index}`}><input aria-label={`Наименование прибора ${index + 1}`} onChange={(event) => setActEquipmentRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row))} placeholder="Наименование прибора" value={item.name} /><input aria-label={`Серийный номер прибора ${index + 1}`} onChange={(event) => setActEquipmentRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, serialNumber: event.target.value } : row))} placeholder="Серийный номер" value={item.serialNumber} /><input aria-label={`Показание счётчика прибора ${index + 1}`} inputMode="decimal" onChange={(event) => setActEquipmentRows((current) => current.map((row, rowIndex) => {
        if (rowIndex !== index) return row;
        const { meterReading: _meterReading, ...withoutMeter } = row;
        return event.target.value === "" ? withoutMeter : { ...row, meterReading: Number(event.target.value) };
      }))} placeholder="Счётчик" step="any" type="number" value={item.meterReading ?? ""} /><button aria-label={`Удалить прибор ${index + 1}`} className="task-parts-editor__remove" onClick={() => setActEquipmentRows((current) => current.filter((_, rowIndex) => rowIndex !== index))} type="button">×</button></div>)}</div>
      <button className="task-parts-add" onClick={() => setActEquipmentRows((current) => [...current, { name: "", serialNumber: "" }])} type="button">Добавить прибор</button>
      <h3>Выполненные работы</h3>
      <div className="work-act-row-editor__list">{actWorkRows.map((item, index) => <div className="work-act-row-editor__work" key={`work-${index}`}><input aria-label={`Вид работ ${index + 1}`} onChange={(event) => setActWorkRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row))} placeholder="Вид работ" value={item.name} /><Select aria-label={`Модификатор работ ${index + 1}`} onChange={(event) => setActWorkRows((current) => current.map((row, rowIndex) => {
        if (rowIndex !== index) return row;
        const { modifier: _modifier, ...withoutModifier } = row;
        return event.target.value ? { ...row, modifier: event.target.value as "G" | "N" } : withoutModifier;
      }))} value={item.modifier ?? ""}><option value="">Без модификатора</option><option value="G">Г · гарантийные</option><option value="N">Н · неправильная эксплуатация</option></Select><input aria-label={`Часы работ ${index + 1}`} inputMode="decimal" onChange={(event) => setActWorkRows((current) => current.map((row, rowIndex) => {
        if (rowIndex !== index) return row;
        const { hours: _hours, ...withoutHours } = row;
        return event.target.value === "" ? withoutHours : { ...row, hours: Number(event.target.value) };
      }))} min="0" placeholder="Часы" step="any" type="number" value={item.hours ?? ""} /><button aria-label={`Удалить вид работ ${index + 1}`} className="task-parts-editor__remove" onClick={() => setActWorkRows((current) => current.filter((_, rowIndex) => rowIndex !== index))} type="button">×</button></div>)}</div>
      <button className="task-parts-add" onClick={() => setActWorkRows((current) => [...current, { name: "" }])} type="button">Добавить вид работ</button>
    </section></Dialog>
    {detailTab === "materials" ? <div className="task-card-columns">
      <section className="card">
        <CardHeader meta={`${card.files.length} файлов`} title="Файлы" />
        <div className="task-card-panel">
          {card.files.length > 0 ? <div className="task-card-list">{card.files.map((file) => <a href={file.url ?? "#"} key={file.id}><strong>{file.originalName}</strong><span>{FILE_KIND_LABELS[file.kind] ?? "Файл"} · {(file.byteSize / 1024).toFixed(1)} КБ</span></a>)}</div> : <div className="task-empty"><Icon name="open" size={22} /><p>Файлов пока нет. Инженер приложит акт и фото при закрытии.</p></div>}
        </div>
      </section>
      <section className="card task-parts-card">
        <CardHeader action={card.canEditParts ? <Button onClick={() => setPartsEditing((value) => !value)} variant="secondary">{partsEditing ? "Отменить" : "Редактировать"}</Button> : undefined} meta={`${card.parts.length} позиций`} title="Использованные запчасти" />
        {partsEditing ? <Dialog footer={<><Button disabled={busy} onClick={() => setPartsEditing(false)} variant="secondary">Отмена</Button><Button busy={busy} form="task-parts-editor-form" type="submit">Сохранить позиции</Button></>} onOpenChange={setPartsEditing} open={partsEditing} size="lg" title="Использованные запчасти"><form className="task-parts-editor" id="task-parts-editor-form" onSubmit={(event) => void saveParts(event)}><div className="task-parts-editor__head"><span>Артикул</span><span>Наименование</span><span>Количество</span><span>Г/Н/Б</span><span /></div>{partDrafts.map((part, index) => <div className="task-parts-editor__row" key={part.key}><input aria-label={`Артикул позиции ${index + 1}`} onChange={(event) => updatePartDraft(index, { articleNumber: event.target.value })} required value={part.articleNumber} /><input aria-label={`Наименование позиции ${index + 1}`} onChange={(event) => updatePartDraft(index, { name: event.target.value })} required value={part.name} /><input aria-label={`Количество позиции ${index + 1}`} inputMode="decimal" min="0.001" onChange={(event) => updatePartDraft(index, { quantity: event.target.value })} required step="0.001" type="number" value={part.quantity} /><Select aria-label={`Состояние позиции ${index + 1}`} onChange={(event) => updatePartDraft(index, { condition: event.target.value as TaskPartPosition["condition"] })} value={part.condition}><option value="G">Г · гарантийная</option><option value="N">Н · новая</option><option value="B">Б · б/у</option></Select><button aria-label={`Удалить позицию ${index + 1}`} className="task-parts-editor__remove" onClick={() => setPartDrafts((current) => current.filter((_, partIndex) => partIndex !== index))} type="button">×</button></div>)}{partDrafts.length === 0 ? <p className="muted">Добавьте хотя бы одну позицию или сохраните пустой список.</p> : null}<button className="task-parts-add" onClick={addPartDraft} type="button">+ Добавить позицию</button></form></Dialog> : <div className="task-card-panel">
          {card.parts.length > 0 ? <div className="task-card-list">{card.parts.map((part) => <div key={part.id}><strong>{part.articleNumber} · {part.name}</strong><span>{part.quantity} шт. · {part.condition === "G" ? "Г · гарантийная" : part.condition === "N" ? "Н · новая" : "Б · б/у"}</span></div>)}</div> : <div className="task-empty"><Icon name="info" size={22} /><p>Запчасти не указаны. Добавьте позиции, если на выезде использовали детали.</p></div>}
          {card.canEditParts ? <button className="task-parts-add" onClick={addPartDraft} type="button">+ Добавить позицию</button> : null}
        </div>}
      </section>
    </div> : null}
    {detailTab === "history" ? <section className="card">
      <CardHeader meta="Кто, что и когда" title="Журнал задачи" />
      {card.journal.length > 0 ? <div className="task-journal">{card.journal.map((event) => {
        const description = taskJournalDescription(event);
        return <article className="task-journal__item" key={event.id}>
          <div aria-hidden="true" className="task-journal__rail"><span className="task-journal__dot" /></div>
          <div className="task-journal__content">
            <header>
              <time dateTime={event.occurredAt}>{formatTaskDate(event.occurredAt, true)}</time>
              <strong>{event.actorName ?? "Автоматически"}</strong>
              {event.toStatus ? <p className="task-journal__status"><span>{TASK_STATUS_LABELS[event.fromStatus ?? ""] ?? "—"}</span><span aria-hidden="true">→</span><span>{TASK_STATUS_LABELS[event.toStatus] ?? "—"}</span></p> : <p>{description}</p>}
            </header>
            {event.comment ? <p className="task-journal__note">{event.comment}</p> : null}
          </div>
        </article>;
      })}</div> : <div className="task-empty"><Icon name="clock" size={22} /><p>Записей в журнале пока нет. Действия по задаче появятся здесь.</p></div>}
    </section> : null}
    <DialogForm busy={busy} description="Изменятся название, вид работ, срочность и даты заявки." error={formError} key={`overview-edit-${task.id}-${overviewEditing ? "open" : "closed"}`} onOpenChange={setOverviewEditing} onSubmit={saveOverview} open={overviewEditing} size="lg" submitLabel="Сохранить изменения" title="Основные параметры задачи"><label className="field-wide">Название<input defaultValue={task.title} maxLength={200} name="title" required /></label><label>Вид работ<Select defaultValue={task.workTypeCode ?? card.workType?.code ?? ""} name="workTypeCode" required>{workTypes.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label><label className="task-priority-check"><input defaultChecked={task.priority === "urgent"} name="urgent" type="checkbox" value="on" /><span className="task-priority-check__text"><strong>Срочная</strong><small>Реакция до 24 ч · иначе плановая</small></span></label><div className="dialog-form-row-3"><label>Дата вызова<DatePicker defaultValue={task.callDate?.slice(0, 10)} name="callDate" required /></label><label>Период с<DatePicker defaultValue={task.periodFrom?.slice(0, 10)} name="periodFrom" required /></label><label>Период по<DatePicker defaultValue={task.periodTo?.slice(0, 10)} name="periodTo" required /></label></div><label>Дата выезда<DatePicker defaultValue={task.visitDate?.slice(0, 10)} name="visitDate" /></label></DialogForm>
    <DialogForm busy={busy} danger={actionDialog === "cancel"} description={actionDialog === "cancel" ? "Задача будет отменена. Укажите причину — она попадёт в журнал." : "Заявка вернётся инженеру. Напишите, что нужно доработать."} onOpenChange={(open) => { if (!open) setActionDialog(null); }} onSubmit={async (event) => { event.preventDefault(); const comment = String(new FormData(event.currentTarget).get("comment") ?? ""); if (actionDialog && await perform(actionDialog, comment)) setActionDialog(null); }} open={actionDialog !== null} submitLabel={actionDialog === "cancel" ? "Отменить задачу" : "Вернуть инженеру"} title={actionDialog === "cancel" ? "Отмена задачи" : "Возврат на доработку"}><label className="field-wide">{actionDialog === "cancel" ? "Причина отмены" : "Что нужно доработать"}<textarea autoFocus maxLength={1000} name="comment" required rows={4} /></label></DialogForm>
  </>;
}

interface TaskRegistryFilters {
  readonly search: string;
  readonly status: string;
  readonly engineerId: string;
  readonly siteId: string;
  readonly workTypeCode: string;
  readonly priority: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly overdue: boolean;
  readonly sort: "deadline_asc" | "deadline_desc" | "updated_asc" | "updated_desc";
}

const EMPTY_TASK_FILTERS: TaskRegistryFilters = { search: "", status: "", engineerId: "", siteId: "", workTypeCode: "", priority: "", periodFrom: "", periodTo: "", overdue: false, sort: "updated_desc" };

const mailStatusLabels: Readonly<Record<MailInboxRecord["status"], string>> = {
  pending: "Новое", parsed: "Распознано", converted: "Создана задача", ignored: "Не требует работы", failed: "Ошибка разбора"
};

function MailInboxTab({ onCreateTask, onOpenTask }: { readonly onCreateTask: (mail: MailInboxRecord) => void; readonly onOpenTask: (taskId: string) => void }) {
  const pageSize = 25;
  const [items, setItems] = useState<readonly MailInboxRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [filters, setFilters] = useState({ search: "", status: "" });
  const [loading, setLoading] = useState(true);
  const [ignoreTarget, setIgnoreTarget] = useState<MailInboxRecord | null>(null);
  const reload = async (nextFilters = filters, nextPage = pageIndex) => {
    setLoading(true);
    try {
      const page = await m2Api.mailInbox({ ...nextFilters, limit: pageSize, offset: registryPageOffset(nextPage, pageSize) });
      setItems(page.items); setTotal(page.total);
    } catch (loadError) {
      toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить письма", { title: "Письма не загрузились" });
    } finally { setLoading(false); }
  };
  useEffect(() => { void reload({ search: "", status: "" }, 0); }, []);
  const apply = async () => { setPageIndex(0); await reload(filters, 0); };
  const statusTone = (status: MailInboxRecord["status"]): StatusTone => status === "converted" ? "success" : status === "failed" ? "danger" : status === "ignored" ? "neutral" : status === "parsed" ? "info" : "warning";
  return <>
    <FilterBar loading={loading} onReset={() => { const reset = { search: "", status: "" }; setFilters(reset); setPageIndex(0); void reload(reset, 0); }} onSubmit={apply}><label>Поиск<input onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Отправитель или тема" type="search" value={filters.search} /></label><label>Статус<Select onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))} value={filters.status}><option value="">Все</option>{Object.entries(mailStatusLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</Select></label></FilterBar>
    <DataTableShell meta={`${items.length} из ${total}`} title="Входящие письма">{loading && items.length === 0 ? <ResourceState description="Подождите, входящие сейчас появятся." status="loading" title="Загружаем письма" /> : items.length === 0 ? <ResourceState description={filters.search || filters.status ? "Измените поиск или сбросьте фильтры." : "Новые письма с заявками появятся здесь. Можно создать задачу вручную."} status={filters.search || filters.status ? "filtered-empty" : "empty"} title={filters.search || filters.status ? "Писем по этим условиям нет" : "Входящих писем нет"} /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Получено</th><th>Отправитель</th><th>Тема</th><th>Что распознано</th><th>Статус</th><th><span className="sr-only">Действия</span></th></tr></thead><tbody>{items.map((mail) => <tr key={mail.id}><td>{formatTaskDate(mail.receivedAt, true)}</td><td>{mail.sender}</td><td><strong>{mail.subject || "Без темы"}</strong></td><td>{mail.summary ?? mail.equipmentSerial ?? "—"}{mail.confidence !== undefined ? <small className="mail-confidence">{Math.round(mail.confidence * 100)}%</small> : null}</td><td><StatusBadge tone={statusTone(mail.status)}>{mailStatusLabels[mail.status]}</StatusBadge></td><td><div className="table-actions">{mail.taskId ? <IconButton icon="open" label="Открыть задачу" onClick={() => onOpenTask(mail.taskId!)} /> : mail.status !== "ignored" ? <><IconButton icon="plus" label="Создать задачу" onClick={() => onCreateTask(mail)} variant="secondary" /><IconButton icon="ignore" label="Не требует работы" onClick={() => setIgnoreTarget(mail)} /></> : <IconButton icon="restore" label="Вернуть в работу" onClick={() => void m2Api.updateMailInbox(mail.id, { status: "pending" }).then(() => reload())} />}</div></td></tr>)}</tbody></table></div>}<RegistryPagination ariaLabel="Страницы входящих писем" onPageChange={(next) => { setPageIndex(next); void reload(filters, next); }} pageIndex={pageIndex} pageSize={pageSize} total={total} /></DataTableShell>
    <ConfirmationDialog confirmLabel="Не требует работы" description={ignoreTarget ? <>Письмо «{ignoreTarget.subject || "Без темы"}» останется в журнале. Его можно будет вернуть в работу.</> : null} onConfirm={async () => { if (!ignoreTarget) return; await m2Api.updateMailInbox(ignoreTarget.id, { status: "ignored" }); await reload(); }} onOpenChange={(open) => { if (!open) setIgnoreTarget(null); }} open={Boolean(ignoreTarget)} title="Письмо не требует работы?" />
  </>;
}

function CoordinatorTasks({ initialTaskId, onTaskRouteChange }: {
  readonly initialTaskId: string | undefined;
  readonly onTaskRouteChange: (taskId?: string) => void;
}) {
  const pageSize = 100;
  const [tasks, setTasks] = useState<readonly TaskApiRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [equipment, setEquipment] = useState<readonly EquipmentApiRecord[]>([]);
  const [sites, setSites] = useState<readonly SiteOption[]>([]);
  const [workTypes, setWorkTypes] = useState<readonly ReferenceCatalogValue[]>([]);
  const [taskStatuses, setTaskStatuses] = useState<readonly ReferenceCatalogValue[]>([]);
  const [engineers, setEngineers] = useState<readonly { readonly id: string; readonly fullName: string }[]>([]);
  const [registryView, setRegistryView] = useState<"board" | "list" | "mail">("board");
  const [showCompletedBoard, setShowCompletedBoard] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskCard, setTaskCard] = useState<TaskCardResponse | null>(null);
  const [filters, setFilters] = useState<TaskRegistryFilters>(EMPTY_TASK_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<TaskRegistryFilters>(EMPTY_TASK_FILTERS);
  const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkEngineerId, setBulkEngineerId] = useState("");
  const [bulkPeriodFrom, setBulkPeriodFrom] = useState("");
  const [bulkPeriodTo, setBulkPeriodTo] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [mailDraft, setMailDraft] = useState<MailInboxRecord | null>(null);
  const reloadTasks = async (currentFilters = appliedFilters, targetPageIndex = pageIndex) => {
    setLoading(true);
    try {
      const page = await m2Api.tasksPage({
        ...(currentFilters.search ? { search: currentFilters.search } : {}), ...(currentFilters.status ? { status: currentFilters.status } : {}),
        ...(currentFilters.engineerId ? { engineerId: currentFilters.engineerId } : {}), ...(currentFilters.siteId ? { siteId: currentFilters.siteId } : {}),
        ...(currentFilters.workTypeCode ? { workTypeCode: currentFilters.workTypeCode } : {}),
        ...(currentFilters.priority ? { priority: currentFilters.priority as "urgent" | "planned" } : {}),
        ...(currentFilters.periodFrom ? { periodFrom: currentFilters.periodFrom } : {}), ...(currentFilters.periodTo ? { periodTo: currentFilters.periodTo } : {}),
        ...(currentFilters.overdue ? { overdue: true } : {}), sort: currentFilters.sort,
        limit: pageSize, offset: registryPageOffset(targetPageIndex, pageSize)
      });
      setTasks(page.items); setTotal(page.total);
    } finally {
      setLoading(false);
    }
  };
  const applyFilters = async (nextFilters = filters) => {
    setFilters(nextFilters); setAppliedFilters(nextFilters); setSelectedTaskIds(new Set()); setPageIndex(0);
    try { await reloadTasks(nextFilters, 0); }
    catch (loadError) { toast.error(loadError instanceof Error ? loadError.message : "Не получилось обновить список"); }
  };
  const changePage = async (nextPageIndex: number) => {
    setPageIndex(nextPageIndex);
    try {
      await reloadTasks(appliedFilters, nextPageIndex);
    } catch (loadError) {
      toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить список задач");
    }
  };
  const finishBulk = async (report: BulkTaskCommandResponse) => {
    setSelectedTaskIds(new Set(report.failures.map((failure) => failure.taskId)));
    if (report.failureCount) {
      toast.warning(`Обновлено ${report.successCount}, не получилось ${report.failureCount}.`);
    }
    await reloadTasks();
  };
  const bulkAssign = async () => {
    if (!bulkEngineerId) { toast.warning("Выберите инженера для массового назначения"); return; }
    setBulkBusy(true);
    try { await finishBulk(await m2Api.bulkAssignTasks([...selectedTaskIds], bulkEngineerId)); }
    catch (bulkError) { toast.error(bulkError instanceof Error ? bulkError.message : "Не получилось назначить инженера"); }
    finally { setBulkBusy(false); }
  };
  const bulkChangePeriod = async () => {
    if (!bulkPeriodFrom || !bulkPeriodTo) { toast.warning("Для массовой смены периода заполните обе даты"); return; }
    if (bulkPeriodFrom > bulkPeriodTo) { toast.warning("Начало периода не может быть позже конца"); return; }
    setBulkBusy(true);
    try {
      await finishBulk(await m2Api.bulkChangeTaskPeriod(
        [...selectedTaskIds], `${bulkPeriodFrom}T00:00:00.000Z`, `${bulkPeriodTo}T00:00:00.000Z`
      ));
    } catch (bulkError) { toast.error(bulkError instanceof Error ? bulkError.message : "Не получилось сменить срок"); }
    finally { setBulkBusy(false); }
  };
  const toggleTask = (id: string, selected: boolean) => setSelectedTaskIds((current) => {
    const next = new Set(current);
    if (selected) next.add(id); else next.delete(id);
    return next;
  });
  const openTask = async (id: string, updateRoute = true) => {
    const loaded = await m2Api.taskCard(id);
    setSelectedTaskId(id);
    setTaskCard(loaded);
    if (updateRoute) onTaskRouteChange(id);
  };
  const loadBoardColumn = async (status: string, offset: number, limit: number) => {
    const page = await m2Api.tasksPage({
      ...(appliedFilters.search ? { search: appliedFilters.search } : {}),
      status,
      ...(appliedFilters.engineerId ? { engineerId: appliedFilters.engineerId } : {}),
      ...(appliedFilters.siteId ? { siteId: appliedFilters.siteId } : {}),
      ...(appliedFilters.workTypeCode ? { workTypeCode: appliedFilters.workTypeCode } : {}),
      ...(appliedFilters.priority ? { priority: appliedFilters.priority as "urgent" | "planned" } : {}),
      ...(appliedFilters.periodFrom ? { periodFrom: appliedFilters.periodFrom } : {}),
      ...(appliedFilters.periodTo ? { periodTo: appliedFilters.periodTo } : {}),
      ...(appliedFilters.overdue ? { overdue: true } : {}),
      sort: appliedFilters.sort,
      limit,
      offset
    });
    return { items: page.items, total: page.total };
  };
  useEffect(() => {
    Promise.all([m2Api.tasksPage({ limit: pageSize, offset: 0 }), m2Api.listEquipment(), m2Api.listSites(), m2Api.listCatalogValues("work-types"), m2Api.listCatalogValues("task-statuses"), m2Api.listTaskEngineers()])
      .then(([taskPage, loadedEquipment, loadedSites, loadedWorkTypes, loadedTaskStatuses, loadedEngineers]) => {
        setTasks(taskPage.items); setTotal(taskPage.total); setEquipment(loadedEquipment); setSites(loadedSites); setWorkTypes(loadedWorkTypes); setTaskStatuses(loadedTaskStatuses); setEngineers(loadedEngineers);
      }).catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить задачи"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (initialTaskId && initialTaskId === selectedTaskId && taskCard) return;
    if (!initialTaskId) {
      setSelectedTaskId(null);
      setTaskCard(null);
      return;
    }
    void openTask(initialTaskId, false)
      .catch((loadError: unknown) => {
        setSelectedTaskId(null);
        setTaskCard(null);
        toast.error(loadError instanceof Error ? loadError.message : "Не получилось открыть задачу");
      });
  }, [initialTaskId]);
  if (selectedTaskId && taskCard) return <TaskCard card={taskCard} onBack={() => { setSelectedTaskId(null); setTaskCard(null); onTaskRouteChange(); }} onChanged={async () => { await Promise.all([reloadTasks(), openTask(selectedTaskId, false)]); }} onOpenRelated={async (id) => { await openTask(id); }} workTypes={workTypes} />;
  return (
    <>
      <PageIntro
        actions={<Button icon="plus" onClick={() => setFormOpen(true)}>Создать задачу</Button>}
        description="Создайте заявку, назначьте инженера или откройте карточку, чтобы проверить работу."
        title="Задачи"
      />
      <div className="task-view-toolbar">
        <PageTabs items={[{ value: "board", label: "Доска" }, { value: "list", label: "Список" }, { value: "mail", label: "Письма" }]} label="Как показать задачи" onValueChange={(value) => { setRegistryView(value); setSelectedTaskIds(new Set()); setShowCompletedBoard(false); }} value={registryView} />
        {registryView === "board" ? (
          <Button
            aria-pressed={showCompletedBoard}
            onClick={() => setShowCompletedBoard((current) => !current)}
            variant={showCompletedBoard ? "primary" : "secondary"}
          >
            Завершенные
          </Button>
        ) : null}
      </div>

      <TaskCreationForm equipment={equipment} {...(mailDraft?.subject ? { initialTitle: mailDraft.subject } : {})} {...(mailDraft?.workTypeCode ? { initialWorkTypeCode: mailDraft.workTypeCode } : {})} key={mailDraft?.id ?? "manual-task"} onOpenChange={(open) => { setFormOpen(open); if (!open) setMailDraft(null); }} onCreated={async (task) => { if (mailDraft) await m2Api.updateMailInbox(mailDraft.id, { status: "converted", taskId: task.id }); await reloadTasks(); setFormOpen(false); setMailDraft(null); await openTask(task.id); }} open={formOpen} workTypes={workTypes} />

      {registryView !== "mail" ? <FilterBar loading={loading} onReset={() => void applyFilters(EMPTY_TASK_FILTERS)} onSubmit={() => applyFilters()}><label className="filter-field--search">Поиск<input onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Номер или название" type="search" value={filters.search} /></label><label>Статус<Select onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value, overdue: false }))} value={filters.status}><option value="">Все</option>{taskStatuses.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label><label>Инженер<Select onChange={(event) => setFilters((current) => ({ ...current, engineerId: event.target.value }))} value={filters.engineerId}><option value="">Все</option>{engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.fullName}</option>)}</Select></label><label>Площадка<Select onChange={(event) => setFilters((current) => ({ ...current, siteId: event.target.value }))} value={filters.siteId}><option value="">Все</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</Select></label><label>Вид работ<Select onChange={(event) => setFilters((current) => ({ ...current, workTypeCode: event.target.value }))} value={filters.workTypeCode}><option value="">Все</option>{workTypes.map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label><label>Срочность<Select onChange={(event) => setFilters((current) => ({ ...current, priority: event.target.value }))} value={filters.priority}><option value="">Все</option><option value="urgent">Срочные</option><option value="planned">Плановые</option></Select></label><label>Период с<DatePicker onChange={(periodFrom) => setFilters((current) => ({ ...current, periodFrom }))} value={filters.periodFrom} /></label><label>Период по<DatePicker onChange={(periodTo) => setFilters((current) => ({ ...current, periodTo }))} value={filters.periodTo} /></label><label>Сортировка<Select onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value as TaskRegistryFilters["sort"] }))} value={filters.sort}><option value="updated_desc">Сначала обновлённые</option><option value="updated_asc">Сначала давно обновлённые</option><option value="deadline_asc">По сроку ↑</option><option value="deadline_desc">По сроку ↓</option></Select></label></FilterBar> : null}

      {registryView === "list" && selectedTaskIds.size > 0 ? <section className="card task-bulk-actions"><CardHeader meta={`Выбрано: ${selectedTaskIds.size}`} title="Действия с выбранными задачами" /><div className="task-bulk-actions__grid"><label>Инженер<Select aria-label="Инженер для выбранных задач" onChange={(event) => setBulkEngineerId(event.target.value)} value={bulkEngineerId}><option value="">Выберите инженера</option>{engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.fullName}</option>)}</Select></label><Button busy={bulkBusy} busyLabel="Назначаем…" disabled={!bulkEngineerId} onClick={() => void bulkAssign()}>Назначить инженера</Button><label>Период с<DatePicker onChange={setBulkPeriodFrom} value={bulkPeriodFrom} /></label><label>Период по<DatePicker onChange={setBulkPeriodTo} value={bulkPeriodTo} /></label><Button busy={bulkBusy} busyLabel="Сохраняем…" disabled={!bulkPeriodFrom || !bulkPeriodTo} onClick={() => void bulkChangePeriod()} variant="secondary">Сменить срок</Button></div></section> : null}

      {registryView === "board" ? <TaskBoard engineers={engineers} equipment={equipment} loadColumn={loadBoardColumn} onMove={async (id, status) => { try { await m2Api.transitionTask(id, status); } catch (moveError) { const message = moveError instanceof Error ? moveError.message : "Не получилось изменить статус"; toast.error(message); throw moveError; } }} onOpen={(id) => void openTask(id).catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось открыть задачу"))} queryKey={JSON.stringify(appliedFilters)} showCompleted={showCompletedBoard} statuses={taskStatuses} tasks={tasks} visibleStatus={appliedFilters.status} /> : registryView === "list" ? <div className="workspace-grid workspace-grid--tasks workspace-grid--single">
        <section className="card card--table" aria-labelledby="tasks-table-title">
          <CardHeader headingId="tasks-table-title" meta={`${tasks.length} из ${total}`} title="Все задачи" />
          {loading && tasks.length === 0
            ? <ResourceState description="Подождите, список сейчас появится." status="loading" title="Загружаем задачи" />
            : <TaskTable engineers={engineers} equipment={equipment} filtered={Boolean(appliedFilters.search || appliedFilters.status || appliedFilters.engineerId || appliedFilters.siteId || appliedFilters.workTypeCode || appliedFilters.priority || appliedFilters.periodFrom || appliedFilters.periodTo || appliedFilters.overdue)} onOpen={(id) => void openTask(id).catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось открыть задачу"))} onToggle={toggleTask} onToggleAll={(selected) => setSelectedTaskIds((current) => { const next = new Set(current); for (const task of tasks) { if (selected) next.add(task.id); else next.delete(task.id); } return next; })} selectedTaskIds={selectedTaskIds} tasks={tasks} />}
          <RegistryPagination ariaLabel="Страницы списка задач" onPageChange={(next) => void changePage(next)} pageIndex={pageIndex} pageSize={pageSize} total={total} />
        </section>

      </div> : <MailInboxTab onCreateTask={(mail) => { setMailDraft(mail); setFormOpen(true); }} onOpenTask={(taskId) => void openTask(taskId)} />}
    </>
  );
}

interface EquipmentUiRecord {
  readonly id: string;
  readonly model: string;
  readonly manufacturer: string;
  readonly manufacturerId: string;
  readonly serial: string;
  readonly guarantee: string;
  readonly guaranteeCategoryId: string;
  readonly modelId: string;
  readonly organization: string;
  readonly place: string;
  readonly siteId: string;
  readonly payer: string;
  readonly payerId: string;
  readonly status: string;
  readonly statusCode: string;
  readonly tone: StatusTone;
  readonly next: string;
  readonly notes: string;
  readonly lastMeterReading?: number;
  readonly files: readonly string[];
  readonly meterReadings: readonly EquipmentMeterReading[];
  readonly meterReadingsTotal: number;
  readonly history: readonly EquipmentHistoryEvent[];
  readonly historyTotal: number;
}

const EMPTY_PASSPORT_REFERENCES: EquipmentPassportReferences = {
  manufacturers: [], models: [], guaranteeCategories: [], statuses: []
};

function equipmentStatusTone(status: string): StatusTone {
  if (status === "В эксплуатации") return "success";
  if (status === "Требует ремонта") return "warning";
  if (status === "Списан") return "neutral";
  return "info";
}

function equipmentUiRecord(record: EquipmentApiRecord, card?: EquipmentCardResponse): EquipmentUiRecord {
  const statusName = record.statusName ?? record.status;
  return {
    id: record.id,
    serial: record.serialNumber,
    manufacturerId: record.manufacturerId ?? "",
    manufacturer: record.manufacturer,
    modelId: record.modelId ?? "",
    model: record.model,
    guaranteeCategoryId: record.guaranteeCategoryId ?? "",
    guarantee: record.guaranteeCategory ?? "Не указана",
    organization: record.organization ?? "Не указана",
    siteId: record.siteId ?? "",
    place: record.site ?? "Не указана",
    payerId: record.payerId ?? "",
    payer: record.payer ?? "Не указан",
    statusCode: record.status,
    status: statusName,
    tone: equipmentStatusTone(statusName),
    next: "—",
    notes: record.notes ?? "",
    ...(record.lastMeterReading !== undefined ? { lastMeterReading: record.lastMeterReading } : {}),
    files: card?.files.map((file) => file.originalName) ?? [],
    meterReadings: card?.meterReadings.items ?? [],
    meterReadingsTotal: card?.meterReadings.total ?? 0,
    history: card?.history.items ?? [],
    historyTotal: card?.history.total ?? 0
  };
}

function EquipmentPassportForm({
  records,
  record,
  references,
  open,
  onOpenChange,
  onSave
}: {
  readonly records: readonly EquipmentUiRecord[];
  readonly record?: EquipmentUiRecord;
  readonly references: EquipmentPassportReferences;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (record: EquipmentUiRecord, files: readonly File[]) => Promise<void>;
}) {
  const firstManufacturer = references.manufacturers[0];
  const [manufacturerId, setManufacturerId] = useState(record?.manufacturerId || firstManufacturer?.id || "");
  const firstModel = references.models.find((item) => item.manufacturerId === manufacturerId);
  const [modelId, setModelId] = useState(record?.modelId || firstModel?.id || "");
  const [selectedFiles, setSelectedFiles] = useState<readonly File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const availableModels = references.models.filter((item) => item.manufacturerId === manufacturerId);

  const changeManufacturer = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextManufacturerId = event.target.value;
    setManufacturerId(nextManufacturerId);
    setModelId(references.models.find((item) => item.manufacturerId === nextManufacturerId)?.id ?? "");
  };

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    setSelectedFiles(Array.from(event.target.files ?? []));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const serial = String(data.get("serialNumber") ?? "").trim();
    if (hasEquipmentSerialConflict(records, serial, record?.id)) {
      setError("Прибор с таким S/N уже существует. Регистр и пробелы при проверке не учитываются.");
      return;
    }
    const manufacturer = references.manufacturers.find((item) => item.id === manufacturerId);
    const model = references.models.find((item) => item.id === modelId);
    const guaranteeCategoryId = String(data.get("guaranteeCategoryId") ?? "");
    const guarantee = references.guaranteeCategories.find((item) => item.id === guaranteeCategoryId);
    const statusCode = String(data.get("status") ?? "");
    const status = references.statuses.find((item) => item.code === statusCode);
    if (!manufacturer || !model || !guarantee || !status) {
      setError("Выберите значения из серверных справочников");
      return;
    }
    try {
      await onSave({
        id: record?.id ?? "",
        serial,
        manufacturerId,
        manufacturer: manufacturer.name,
        modelId,
        model: model.name,
        guaranteeCategoryId,
        guarantee: guarantee.name,
        organization: record?.organization ?? "Не указана",
        statusCode,
        status: status.name,
        tone: equipmentStatusTone(status.name),
        siteId: record?.siteId ?? "",
        place: record?.place ?? "Не указана",
        payerId: record?.payerId ?? "",
        payer: record?.payer ?? "Не указан",
        next: record?.next ?? "—",
        notes: String(data.get("notes") ?? "").trim(),
        ...(record?.lastMeterReading !== undefined ? { lastMeterReading: record.lastMeterReading } : {}),
        files: record?.files ?? [],
        meterReadings: record?.meterReadings ?? [],
        meterReadingsTotal: record?.meterReadingsTotal ?? 0,
        history: record?.history ?? [],
        historyTotal: record?.historyTotal ?? 0
      }, selectedFiles);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не получилось сохранить паспорт");
    }
  };

  return (
    <DialogForm
      description="Поля со звёздочкой обязательны."
      error={error}
      onOpenChange={onOpenChange}
      onSubmit={submit}
      open={open}
      size="lg"
      submitLabel={record ? "Сохранить изменения" : "Создать паспорт"}
      title={record ? "Изменить паспорт" : "Новый прибор"}
    >
      <label className="field-wide">S/N *<input autoFocus defaultValue={record?.serial} maxLength={200} name="serialNumber" placeholder="Например, BS620-001" required /><small>Серийный номер должен быть уникальным. Пробелы не учитываются.</small></label>
      <label>Производитель *<Select name="manufacturerId" onChange={changeManufacturer} required value={manufacturerId}>{references.manufacturers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      <label>Модель *<Select name="modelId" onChange={(event) => setModelId(event.target.value)} required value={modelId}>{availableModels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      <label>Категория гарантии *<Select defaultValue={record?.guaranteeCategoryId || references.guaranteeCategories[0]?.id} name="guaranteeCategoryId" required>{references.guaranteeCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      <label>Статус *<Select defaultValue={record?.statusCode || references.statuses[0]?.code} name="status" required>{references.statuses.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</Select></label>
      <label className="field-wide">Примечания<textarea defaultValue={record?.notes} maxLength={5000} name="notes" placeholder="Служебные сведения о приборе" rows={3} /></label>
      <label className="field-wide field-file">Файлы<span className="field-file__control"><input accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" multiple name="files" onChange={chooseFiles} type="file" /></span><small>{selectedFiles.length ? `Выбрано: ${selectedFiles.map((file) => file.name).join(", ")}` : record?.files.length ? `Уже прикреплено: ${record.files.join(", ")}` : "Документы, фото или видео прибора"}</small></label>
    </DialogForm>
  );
}

function EquipmentAssignmentForm({
  kind,
  record,
  options,
  open,
  onOpenChange,
  onApply
}: {
  readonly kind: EquipmentAssignmentKind;
  readonly record: EquipmentUiRecord;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onApply: (change: NewEquipmentAssignmentChange) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const currentId = kind === "site_change" ? record.siteId : record.payerId;
  const available = options.filter((option) => option.id !== currentId);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const targetId = String(data.get("targetId") ?? "");
    const target = options.find((option) => option.id === targetId);
    if (!target) {
      setError(kind === "site_change" ? "Выберите площадку" : "Выберите плательщика");
      return;
    }
    try {
      await onApply({
        kind,
        targetId: target.id,
        targetName: target.name,
        occurredAt: localDateTimeToIso(String(data.get("occurredAt") ?? "")),
        comment: String(data.get("comment") ?? "")
      });
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : "Не получилось сохранить изменение");
    }
  };
  return (
    <DialogForm
      description={`Сейчас: ${kind === "site_change" ? record.place : record.payer}`}
      error={error}
      onOpenChange={onOpenChange}
      onSubmit={submit}
      open={open}
      submitLabel={kind === "site_change" ? "Сменить место" : "Сменить плательщика"}
      title={kind === "site_change" ? "Смена места установки" : "Смена плательщика"}
    >
      <label>{kind === "site_change" ? "Новая площадка" : "Новый плательщик"} *<Select defaultValue={available[0]?.id} name="targetId" required>{available.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</Select></label>
      <label>Когда произошло *<DateTimePicker defaultValue={localDateTimeInputValue()} name="occurredAt" required /></label>
      <label className="field-wide">Комментарий *<textarea maxLength={2000} name="comment" placeholder="Причина перемещения или смены плательщика" required rows={3} /></label>
    </DialogForm>
  );
}

function ManualEquipmentHistoryForm({
  record,
  open,
  onOpenChange,
  onAdd
}: {
  readonly record: EquipmentUiRecord;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdd: (draft: ManualEquipmentHistoryDraft) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await onAdd({
        occurredAt: localDateTimeToIso(String(data.get("occurredAt") ?? "")),
        summary: String(data.get("summary") ?? ""),
        client: String(data.get("client") ?? ""),
        description: String(data.get("description") ?? "")
      });
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : "Не получилось добавить запись");
    }
  };
  return (
    <DialogForm
      description="Запись займёт своё место в общей хронологии."
      error={error}
      onOpenChange={onOpenChange}
      onSubmit={submit}
      open={open}
      size="lg"
      submitLabel="Добавить в историю"
      title="Прошлое событие прибора"
    >
      <label>Дата и время события *<DateTimePicker name="occurredAt" required /></label>
      <label>Вид / название события *<input maxLength={200} name="summary" placeholder="Например, диагностика" required /></label>
      <label className="field-wide">Клиент на дату события *<input defaultValue={record.place} maxLength={500} name="client" required /></label>
      <label className="field-wide">Исходное описание<textarea maxLength={50000} name="description" placeholder="Можно оставить пустым, если описания в источнике не было" rows={7} /></label>
    </DialogForm>
  );
}

function AssignmentHistorySection({
  title,
  events,
  empty
}: {
  readonly title: string;
  readonly events: readonly EquipmentHistoryEvent[];
  readonly empty: string;
}) {
  return (
    <section className="card equipment-card-section">
      <CardHeader meta={formatRussianCount(events.length, ["запись", "записи", "записей"])} title={title} />
      <div className="equipment-card-section__list">
        {events.map((event) => <article key={event.id}>
          <time dateTime={event.occurredAt}>{formatEquipmentAssignmentDate(event.occurredAt)}</time>
          <strong>{formatEquipmentAssignmentChange(event)}</strong>
          <span>{event.comment || event.description || "Без комментария"}</span>
        </article>)}
        {events.length === 0 ? <p>{empty}</p> : null}
      </div>
    </section>
  );
}

function EquipmentCard({
  record,
  readOnly,
  onBack,
  onEdit,
  onApply,
  onAddManual,
  onLoadMoreHistory,
  onLoadMoreMeterReadings,
  sites,
  payers
}: {
  readonly record: EquipmentUiRecord;
  readonly readOnly: boolean;
  readonly onBack: () => void;
  readonly onEdit?: () => void;
  readonly onApply: (change: NewEquipmentAssignmentChange) => Promise<void>;
  readonly onAddManual: (draft: ManualEquipmentHistoryDraft) => Promise<void>;
  readonly onLoadMoreHistory: () => Promise<void>;
  readonly onLoadMoreMeterReadings: () => Promise<void>;
  readonly sites: readonly SiteOption[];
  readonly payers: readonly PayerOption[];
}) {
  const [changeKind, setChangeKind] = useState<EquipmentAssignmentKind | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"overview" | "movements" | "payers" | "meters" | "files" | "history">("overview");
  const siteChanges = record.history.filter((event) => event.eventType === "site_change");
  const payerChanges = record.history.filter((event) => event.eventType === "payer_change");
  const placeUnset = record.place === "Не указана";
  const payerUnset = record.payer === "Не указан";
  const organizationUnset = record.organization === "Не указана";
  const apply = async (change: NewEquipmentAssignmentChange) => {
    await onApply(change);
    setChangeKind(null);
  };
  return (
    <div className="equipment-card-view">
      <EntityDetailToolbar
        actions={readOnly || !onEdit ? undefined : <Button onClick={onEdit} variant="secondary">Изменить паспорт</Button>}
        backLabel="К списку приборов"
        onBack={onBack}
      />
      <EntityDetailHeader
        aside={<StatusBadge tone={record.tone}>{record.status}</StatusBadge>}
        description={<>{record.manufacturer}<span aria-hidden="true"> · </span><span className="equipment-serial">S/N {record.serial}</span></>}
        title={record.model}
      />
      <PageTabs items={[
        { value: "overview", label: "Обзор" },
        { value: "movements", label: "Перемещения", badge: siteChanges.length },
        { value: "payers", label: "Плательщики", badge: payerChanges.length },
        { value: "meters", label: "Счётчик", badge: record.meterReadingsTotal },
        { value: "files", label: "Файлы", badge: record.files.length },
        { value: "history", label: "История", badge: record.historyTotal }
      ]} label="Разделы карточки прибора" onValueChange={setDetailTab} value={detailTab} />
      {detailTab === "overview" ? <section className="equipment-overview">
        <div className="equipment-overview__stats">
          <article>
            <span>Место установки</span>
            <strong className={placeUnset ? "is-empty" : undefined}>{record.place}</strong>
            {readOnly ? null : <Button className="button--compact" onClick={() => setChangeKind("site_change")} variant="secondary">{placeUnset ? "Указать место" : "Сменить место"}</Button>}
          </article>
          <article>
            <span>Плательщик</span>
            <strong className={payerUnset ? "is-empty" : undefined}>{record.payer}</strong>
            {readOnly ? null : <Button className="button--compact" onClick={() => setChangeKind("payer_change")} variant="secondary">{payerUnset ? "Указать плательщика" : "Сменить плательщика"}</Button>}
          </article>
          <article>
            <span>Последнее показание</span>
            <strong className={record.lastMeterReading === undefined ? "is-empty" : undefined}>{record.lastMeterReading === undefined ? "Не указано" : record.lastMeterReading.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}</strong>
            <small>{record.lastMeterReading === undefined ? "Появится после принятого закрытия задачи" : "Обновляется после принятого закрытия"}</small>
          </article>
        </div>
        <section className="card">
          <CardHeader title="Паспорт" />
          <dl className="detail-list equipment-overview__details">
            <div><dt>Организация</dt><dd className={organizationUnset ? "is-empty" : undefined}>{record.organization}</dd></div>
            <div><dt>Категория гарантии</dt><dd>{record.guarantee}</dd></div>
            <div className="equipment-overview__notes"><dt>Примечания</dt><dd className={record.notes ? undefined : "is-empty"}>{record.notes || "Не указаны"}</dd></div>
          </dl>
        </section>
      </section> : null}
      {changeKind ? <EquipmentAssignmentForm kind={changeKind} onApply={apply} onOpenChange={(open) => { if (!open) setChangeKind(null); }} open options={changeKind === "site_change" ? sites : payers} record={record} /> : null}
      {detailTab === "movements" ? <AssignmentHistorySection empty="Перемещений пока нет. Они появятся после смены места установки." events={siteChanges} title="Перемещения" /> : null}
      {detailTab === "payers" ? <AssignmentHistorySection empty="Смен плательщика пока нет. Они появятся после смены плательщика." events={payerChanges} title="История плательщиков" /> : null}
      {detailTab === "meters" ? <section className="card equipment-card-section">
          <CardHeader meta={`${record.meterReadings.length} из ${record.meterReadingsTotal}`} title="Показания счётчика" />
          <div className="equipment-card-section__list">
            {record.meterReadings.map((reading) => <article key={reading.id}>
              <time dateTime={reading.measuredAt}>{formatEquipmentAssignmentDate(reading.measuredAt)}</time>
              <strong>{reading.reading.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}</strong>
              <span>Задача: {reading.taskId} · {reading.author.name}</span>
            </article>)}
            {record.meterReadings.length === 0 ? <p>Показаний счётчика пока нет. Они появятся после принятого закрытия задачи.</p> : null}
          </div>
          {record.meterReadings.length < record.meterReadingsTotal ? <Button className="equipment-load-more" onClick={() => void onLoadMoreMeterReadings()} variant="secondary">Показать ещё показания</Button> : null}
        </section> : null}
      {detailTab === "files" ? <section className="card equipment-card-section">
          <CardHeader meta={`${record.files.length} файлов`} title="Файлы" />
          <div className="equipment-card-section__list equipment-card-files">
            {record.files.map((file) => <article key={file}><Icon name="info" size={16} /><strong>{file}</strong></article>)}
            {record.files.length === 0 ? <p>К прибору пока не прикреплены файлы. Их можно добавить в паспорте.</p> : null}
          </div>
        </section> : null}
      {detailTab === "history" ? <section className="card equipment-history" aria-labelledby="equipment-history-title">
          <CardHeader action={!readOnly ? <Button icon="plus" onClick={() => setManualOpen(true)} variant="secondary">Добавить прошлое событие</Button> : undefined} headingId="equipment-history-title" meta={`${record.history.length} из ${record.historyTotal} · новые сверху`} title="История прибора" />
        <div className="equipment-history__list">
          {record.history.map((event) => <article className="equipment-history__event" key={event.id}>
            <time dateTime={event.occurredAt}>{formatEquipmentAssignmentDate(event.occurredAt)}</time>
            <div>
              <span className={`equipment-history__kind equipment-history__kind--${event.eventType}`}>{equipmentHistoryEventLabel(event.eventType)}</span>
              <h3>{event.summary}</h3>
              <small>Клиент: {event.client || "не указан"}</small>
              <p className={event.description ? undefined : "equipment-history__description--empty"}>{equipmentHistoryDescription(event)}</p>
              {event.attachment ? <small>Файл: {event.attachment.name}</small> : null}
              {event.author ? <small>Автор: {event.author.name}</small> : null}
            </div>
          </article>)}
          {record.history.length === 0 ? <p className="equipment-history__empty">Истории пока нет. Закрытые задачи, перемещения и прошлые события появятся здесь.</p> : null}
        </div>
        {record.history.length < record.historyTotal ? <Button className="equipment-load-more" onClick={() => void onLoadMoreHistory()} variant="secondary">Показать ещё события</Button> : null}
      </section> : null}
      <ManualEquipmentHistoryForm onAdd={async (draft) => { await onAddManual(draft); setManualOpen(false); }} onOpenChange={setManualOpen} open={manualOpen} record={record} />
    </div>
  );
}

function EquipmentPage({ engineer = false }: { readonly engineer?: boolean }) {
  const pageSize = 50;
  const [records, setRecords] = useState<readonly EquipmentUiRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [references, setReferences] = useState<EquipmentPassportReferences>(EMPTY_PASSPORT_REFERENCES);
  const [sites, setSites] = useState<readonly SiteOption[]>([]);
  const [payers, setPayers] = useState<readonly PayerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<EquipmentRegistryFilters>(EMPTY_EQUIPMENT_REGISTRY_FILTERS);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [siteChangeId, setSiteChangeId] = useState<string | null>(null);
  const editingRecord = records.find((record) => record.id === editingId);
  const selectedRecord = records.find((record) => record.id === selectedId);
  const siteChangeRecord = records.find((record) => record.id === siteChangeId);
  const changeFilter = (name: keyof EquipmentRegistryFilters, value: string) => {
    setFilters((current) => ({ ...current, [name]: value }));
    setPageIndex(0);
  };

  const refreshRegistry = async () => {
    const page = await m2Api.equipmentPage({
      limit: pageSize,
      offset: pageIndex * pageSize,
      ...(filters.search ? { search: filters.search } : {}),
      ...(filters.manufacturer ? { manufacturer: filters.manufacturer } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.site ? { site: filters.site } : {}),
      ...(filters.payer ? { payer: filters.payer } : {})
    });
    setRecords(page.items.map((item) => equipmentUiRecord(item)));
    setTotal(page.total);
  };

  useEffect(() => {
    const shell = document.querySelector(".main-shell");
    if (shell instanceof HTMLElement) shell.scrollTop = 0;
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    Promise.all([m2Api.passportReferences(), m2Api.listSites(), m2Api.listPayers()])
      .then(([loadedReferences, loadedSites, loadedPayers]) => {
        if (!active) return;
        setReferences(loadedReferences);
        setSites(loadedSites);
        setPayers(loadedPayers);
      })
      .catch((error: unknown) => {
        if (active) toast.error(error instanceof Error ? error.message : "Не получилось загрузить приборы");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      m2Api.equipmentPage({
        limit: pageSize,
        offset: pageIndex * pageSize,
        ...(filters.search ? { search: filters.search } : {}),
        ...(filters.manufacturer ? { manufacturer: filters.manufacturer } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.site ? { site: filters.site } : {}),
        ...(filters.payer ? { payer: filters.payer } : {})
      }).then((page) => {
        if (!active) return;
        setRecords(page.items.map((item) => equipmentUiRecord(item)));
        setTotal(page.total);
      }).catch((error: unknown) => {
        if (active) toast.error(error instanceof Error ? error.message : "Не получилось загрузить приборы");
      }).finally(() => { if (active) setLoading(false); });
    }, filters.search ? 250 : 0);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [filters, pageIndex]);

  const save = async (next: EquipmentUiRecord, files: readonly File[]) => {
    const input = {
      serialNumber: next.serial,
      manufacturerId: next.manufacturerId,
      modelId: next.modelId,
      guaranteeCategoryId: next.guaranteeCategoryId,
      status: next.statusCode,
      notes: next.notes
    };
    const stored = editingRecord
      ? await m2Api.updateEquipment(editingRecord.id, input)
      : await m2Api.createEquipment(input);
    let uploadWarning: string | undefined;
    if (files.length > 0) {
      try {
        await m2Api.uploadEquipmentFiles(stored.id, files);
      } catch (uploadError) {
        uploadWarning = uploadError instanceof Error ? uploadError.message : "Не получилось загрузить файлы";
      }
    }
    await refreshRegistry();
    setFormOpen(false);
    setEditingId(null);
    if (uploadWarning) toast.warning(uploadWarning);
  };

  const openCreate = () => {
    setEditingId(null);
    setFormOpen(true);
  };

  const openEdit = (id: string) => {
    setEditingId(id);
    setFormOpen(true);
  };

  const openCard = async (id: string) => {
    try {
      const card = await m2Api.equipmentCard(id);
      const detailed = equipmentUiRecord(card.passport, card);
      setRecords((items) => items.some((item) => item.id === id)
        ? items.map((item) => item.id === id ? detailed : item)
        : [detailed, ...items]);
      setSelectedId(id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не получилось открыть паспорт прибора");
    }
  };

  const applyAssignmentTo = async (record: EquipmentUiRecord, change: NewEquipmentAssignmentChange) => {
    await m2Api.changeEquipmentAssignment(record.id, change.kind, {
      targetId: change.targetId,
      occurredAt: change.occurredAt,
      comment: change.comment
    });
    if (selectedId === record.id) await openCard(record.id);
    else await refreshRegistry();
  };

  const applyAssignment = async (change: NewEquipmentAssignmentChange) => {
    if (!selectedRecord) throw new Error("Прибор не выбран");
    await applyAssignmentTo(selectedRecord, change);
  };

  const addManualHistoryRecord = async (draft: ManualEquipmentHistoryDraft) => {
    if (!selectedRecord) throw new Error("Прибор не выбран");
    await m2Api.addEquipmentHistory(selectedRecord.id, {
      occurredAt: draft.occurredAt,
      summary: draft.summary,
      client: draft.client,
      description: draft.description
    });
    await openCard(selectedRecord.id);
  };

  const loadMoreHistory = async () => {
    if (!selectedRecord) return;
    try {
      const page = await m2Api.equipmentHistoryPage(selectedRecord.id, selectedRecord.history.length);
      setRecords((items) => items.map((item) => item.id === selectedRecord.id ? {
        ...item,
        history: [...item.history, ...page.items],
        historyTotal: page.total
      } : item));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не получилось загрузить историю");
    }
  };

  const loadMoreMeterReadings = async () => {
    if (!selectedRecord) return;
    try {
      const page = await m2Api.equipmentMeterReadingsPage(selectedRecord.id, selectedRecord.meterReadings.length);
      setRecords((items) => items.map((item) => item.id === selectedRecord.id ? {
        ...item,
        meterReadings: [...item.meterReadings, ...page.items],
        meterReadingsTotal: page.total
      } : item));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не получилось загрузить показания");
    }
  };

  if (selectedRecord) {
    return (
      <>
        <EquipmentCard key={selectedRecord.id} onAddManual={addManualHistoryRecord} onApply={applyAssignment} onBack={() => setSelectedId(null)} {...(engineer ? {} : { onEdit: () => openEdit(selectedRecord.id) })} onLoadMoreHistory={loadMoreHistory} onLoadMoreMeterReadings={loadMoreMeterReadings} payers={payers} readOnly={engineer} record={selectedRecord} sites={sites} />
        {!engineer ? <EquipmentPassportForm key={editingId ?? "card-edit"} onOpenChange={(open) => { setFormOpen(open); if (!open) setEditingId(null); }} onSave={save} open={formOpen} references={references} {...(editingRecord ? { record: editingRecord } : {})} records={records} /> : null}
      </>
    );
  }

  const filteredEmpty = Boolean(filters.search || filters.manufacturer || filters.status || filters.site || filters.payer);
  const initialLoading = loading && records.length === 0;

  return (
    <>
      <PageIntro
        actions={engineer ? undefined : <Button icon="plus" onClick={openCreate}>Добавить прибор</Button>}
        description={engineer ? "Приборы с ваших заявок и их история обслуживания." : "Найдите прибор, откройте паспорт или добавьте новый."}
        title={engineer ? "Мои приборы" : "Приборы"}
      />
      {!engineer ? <EquipmentPassportForm key={editingId ?? "new"} onOpenChange={(open) => { setFormOpen(open); if (!open) setEditingId(null); }} onSave={save} open={formOpen} references={references} {...(editingRecord ? { record: editingRecord } : {})} records={records} /> : null}
      {!engineer && siteChangeRecord ? <EquipmentAssignmentForm kind="site_change" onApply={async (change) => { await applyAssignmentTo(siteChangeRecord, change); setSiteChangeId(null); }} onOpenChange={(open) => { if (!open) setSiteChangeId(null); }} open options={sites} record={siteChangeRecord} /> : null}
      <section className="card equipment-registry-tools" aria-labelledby="equipment-search-title">
        <div className="search-row">
          <label className="search-field" htmlFor="equipment-search">
            <Icon name="search" size={18} />
            <span className="sr-only" id="equipment-search-title">Поиск приборов</span>
            <input id="equipment-search" onChange={(event) => changeFilter("search", event.target.value)} placeholder="Серийный номер, модель или организация" type="search" value={filters.search} />
          </label>
          {initialLoading ? null : <span className="muted search-hint">{total} приборов</span>}
        </div>
        <div className="equipment-registry-filters" aria-label="Фильтры списка приборов">
          <label>Производитель<Select onChange={(event) => changeFilter("manufacturer", event.target.value)} value={filters.manufacturer}><option value="">Все производители</option>{references.manufacturers.map((value) => <option key={value.id}>{value.name}</option>)}</Select></label>
          <label>Статус<Select onChange={(event) => changeFilter("status", event.target.value)} value={filters.status}><option value="">Все статусы</option>{references.statuses.map((value) => <option key={value.code} value={value.code}>{value.name}</option>)}</Select></label>
          <label>Площадка<Select onChange={(event) => changeFilter("site", event.target.value)} value={filters.site}><option value="">Все площадки</option>{sites.map((value) => <option key={value.id}>{value.name}</option>)}</Select></label>
          <label>Плательщик<Select onChange={(event) => changeFilter("payer", event.target.value)} value={filters.payer}><option value="">Все плательщики</option>{payers.map((value) => <option key={value.id}>{value.name}</option>)}</Select></label>
          <Button onClick={() => { setFilters(EMPTY_EQUIPMENT_REGISTRY_FILTERS); setPageIndex(0); }} variant="secondary">Сбросить</Button>
        </div>
      </section>
      <section className="card card--table" aria-labelledby="equipment-table-title">
        <CardHeader headingId="equipment-table-title" meta="История пишется при каждом закрытии задачи" title="Все приборы" />
        {initialLoading
          ? <ResourceState description="Подождите, список приборов сейчас появится." status="loading" title="Загружаем приборы" />
          : <>
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th scope="col">Модель</th><th scope="col">S/N</th><th scope="col">Производитель</th><th scope="col">Место установки</th><th scope="col">Плательщик</th><th scope="col">Статус</th><th scope="col">Ближайшее действие</th>{engineer ? null : <th scope="col"><span className="sr-only">Действия</span></th>}</tr></thead>
                <tbody>
                  {records.map((record) => <tr className="data-table__selectable" key={record.id} onClick={() => void openCard(record.id)}>
                    <td><strong>{record.model}</strong><div className="muted">{record.guarantee}</div></td>
                    <td>{record.serial}</td>
                    <td>{record.manufacturer}</td>
                    <td>{record.place}</td>
                    <td>{record.payer}</td>
                    <td><StatusBadge tone={record.tone}>{record.status}</StatusBadge></td>
                    <td>{record.next}</td>
                    {engineer ? null : <td onClick={(event) => event.stopPropagation()}><div className="table-actions equipment-registry-actions"><IconButton icon="relocate" label="Сменить место" onClick={() => setSiteChangeId(record.id)} /><IconButton icon="edit" label="Изменить паспорт" onClick={() => openEdit(record.id)} /></div></td>}
                  </tr>)}
                  {records.length === 0 ? <tr><td className="equipment-registry-empty" colSpan={engineer ? 7 : 8}><ResourceState description={filteredEmpty ? "Измените поиск или сбросьте фильтры." : engineer ? "Приборы с ваших заявок появятся здесь." : "Добавьте прибор, чтобы вести паспорт и историю обслуживания."} status={filteredEmpty ? "filtered-empty" : "empty"} title={filteredEmpty ? "Приборы не найдены" : "Приборов пока нет"} /></td></tr> : null}
                </tbody>
              </table>
            </div>
            <RegistryPagination ariaLabel="Страницы списка приборов" onPageChange={setPageIndex} pageIndex={pageIndex} pageSize={pageSize} total={total} />
          </>}
      </section>
    </>
  );
}

function NotificationsPage() {
  const pageSize = 50;
  const [items, setItems] = useState<readonly NotificationJournalRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [filters, setFilters] = useState({ channel: "email", status: "", eventCode: "", recipient: "" });
  const [loading, setLoading] = useState(true);
  const reload = async (current = filters, targetPageIndex = pageIndex) => {
    setLoading(true);
    try {
      const page = await m2Api.notifications({
        ...current,
        limit: pageSize,
        offset: registryPageOffset(targetPageIndex, pageSize)
      });
      setItems(page.items);
      setTotal(page.total);
    } catch (loadError) {
      toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить уведомления");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, []);
  const changeFilter = (key: keyof typeof filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };
  const changePage = (nextPageIndex: number) => {
    setPageIndex(nextPageIndex);
    void reload(filters, nextPageIndex);
  };
  const statusLabel: Readonly<Record<string, string>> = {
    queued: "В очереди", sending: "Отправка начата", sent: "Отправлено", delivered: "Доставлено", failed: "Ошибка", cancelled: "Отменено"
  };
  const eventLabel: Readonly<Record<string, string>> = {
    task_application_accepted: "Заявка принята", task_engineer_assigned: "Инженер назначен",
    task_engineer_accepted: "Инженер принял", task_work_completed: "Работы завершены",
    task_rework_requested: "Возврат на доработку", task_overdue: "Просрочка"
  };
  const tone = (status: string): StatusTone => status === "failed" ? "danger" : status === "delivered" || status === "sent" ? "success" : "warning";
  return <><PageIntro description="Какие письма и сообщения уже ушли клиентам и сотрудникам." title="Уведомления" />
    <FilterBar loading={loading} onReset={() => { const reset = { channel: "email", status: "", eventCode: "", recipient: "" }; setFilters(reset); setPageIndex(0); void reload(reset, 0); }} onSubmit={() => { setPageIndex(0); return reload(filters, 0); }}>
      <label>Канал<Select onChange={(event) => changeFilter("channel", event.target.value)} value={filters.channel}><option value="">Все каналы</option><option value="email">E-mail</option><option value="telegram">Telegram</option><option value="max">MAX</option><option value="sms">СМС</option></Select></label>
      <label>Событие<Select onChange={(event) => changeFilter("eventCode", event.target.value)} value={filters.eventCode}><option value="">Все события</option>{Object.entries(eventLabel).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</Select></label>
      <label>Статус<Select onChange={(event) => changeFilter("status", event.target.value)} value={filters.status}><option value="">Все статусы</option>{Object.entries(statusLabel).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</Select></label>
      <label>Адресат<input onChange={(event) => changeFilter("recipient", event.target.value)} placeholder="Имя или e-mail" type="search" value={filters.recipient} /></label>
    </FilterBar>
    <section className="card notification-list" aria-label="Лента уведомлений">{loading && items.length === 0 ? <ResourceState description="Подождите, письма сейчас появятся." status="loading" title="Загружаем уведомления" /> : items.map((notification) => <article className={`notification-item${notification.status === "failed" ? " notification-item--failed" : ""}`} key={notification.id}><span className="notification-item__icon"><Icon name="bell" size={17} /></span><div><div className="notification-item__meta"><strong>{notification.recipientAddress}</strong><span>{formatDisplayDate(notification.createdAt, true)}</span><StatusBadge tone={tone(notification.status)}>{statusLabel[notification.status] ?? "Статус"}</StatusBadge></div><h2>{notification.subject || eventLabel[notification.eventCode] || "Письмо"}</h2><p className="notification-item__event">{eventLabel[notification.eventCode] ?? "Событие"} · попыток отправки: {notification.attempts}</p><p className="notification-item__body">{notification.body}</p>{notification.diagnosticError ? <div className="notification-item__error" role="alert"><strong>Почему не ушло:</strong> {notification.diagnosticError}<code>{notification.lastError}</code></div> : null}</div></article>)}{!loading && items.length === 0 ? <ResourceState description={filters.status || filters.eventCode || filters.recipient ? "Измените условия или сбросьте фильтры." : "Письма появятся здесь, когда система отправит сообщения по заявкам."} status={filters.status || filters.eventCode || filters.recipient ? "filtered-empty" : "empty"} title={filters.status || filters.eventCode || filters.recipient ? "Уведомлений по этим условиям нет" : "Уведомлений пока нет"} /> : null}<RegistryPagination ariaLabel="Страницы журнала уведомлений" onPageChange={changePage} pageIndex={pageIndex} pageSize={pageSize} total={total} /></section></>;
}

function NotificationTemplatesPage() {
  const [templates, setTemplates] = useState<readonly NotificationTemplateResponse[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NotificationTemplateResponse | null>(null);
  const [deactivating, setDeactivating] = useState<NotificationTemplateResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void m2Api.notificationTemplates()
      .then(setTemplates)
      .catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить шаблоны"))
      .finally(() => setLoading(false));
  }, []);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const data = new FormData(event.currentTarget);
    setSaving(true); setFormError(null);
    try {
      const updated = await m2Api.updateNotificationTemplate(editing.code, {
        subjectTemplate: String(data.get("subjectTemplate") ?? ""),
        bodyTemplate: String(data.get("bodyTemplate") ?? ""),
        isActive: editing.isActive
      });
      setTemplates((current) => current.map((item) => item.code === updated.code ? updated : item));
      setEditing(null);
    } catch (saveError) {
      const text = saveError instanceof Error ? saveError.message : "Шаблон не сохранён";
      setFormError(text);
      toast.error(text);
    } finally { setSaving(false); }
  };
  const setActive = async (template: NotificationTemplateResponse, isActive: boolean) => {
    const updated = await m2Api.updateNotificationTemplate(template.code, { subjectTemplate: template.subjectTemplate, bodyTemplate: template.bodyTemplate, isActive });
    setTemplates((current) => current.map((item) => item.code === updated.code ? updated : item));
  };
  return <><DataTableShell meta={`${templates.length} шаблонов`} title="Письма по событиям">{loading ? <ResourceState description="Подождите, шаблоны сейчас появятся." status="loading" title="Загружаем шаблоны" /> : templates.length === 0 ? <ResourceState description="Шаблоны появятся, когда администратор настроит письма по событиям." status="empty" title="Шаблонов писем пока нет" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Событие</th><th>Тема</th><th>Состояние</th><th><span className="sr-only">Действия</span></th></tr></thead><tbody>{templates.map((template) => <tr key={template.code}><td><strong>{template.name}</strong></td><td>{template.subjectTemplate || "—"}</td><td><StatusBadge tone={template.isActive ? "success" : "neutral"}>{template.isActive ? "Активен" : "Неактивен"}</StatusBadge></td><td><div className="table-actions"><IconButton icon="edit" label="Изменить шаблон" onClick={() => { setFormError(null); setEditing(template); }} />{template.isActive ? <IconButton icon="disable" label="Отключить" onClick={() => setDeactivating(template)} /> : <IconButton icon="enable" label="Включить" onClick={() => void setActive(template, true)} />}</div></td></tr>)}</tbody></table></div>}</DataTableShell><DialogForm busy={saving} description="Тема и текст уйдут получателю при этом событии. Можно вставить поля из списка ниже." error={formError} onOpenChange={(open) => { if (!open) setEditing(null); }} onSubmit={save} open={Boolean(editing)} size="lg" submitLabel="Сохранить шаблон" title={editing?.name ?? "Шаблон письма"}><label className="field-wide">Тема<input autoFocus defaultValue={editing?.subjectTemplate} maxLength={300} name="subjectTemplate" /></label><label className="field-wide">Текст<textarea defaultValue={editing?.bodyTemplate} maxLength={10000} name="bodyTemplate" required rows={8} /></label>{editing ? <p className="field-wide notification-template__variables">Можно вставить в письмо: {editing.allowedVariables.map((variable) => `{{${variable}}}`).join(", ")}</p> : null}</DialogForm><ConfirmationDialog confirmLabel="Отключить" description={deactivating ? <>Шаблон «{deactivating.name}» перестанет создавать новые письма для этого события.</> : null} onConfirm={async () => { if (deactivating) await setActive(deactivating, false); }} onOpenChange={(open) => { if (!open) setDeactivating(null); }} open={Boolean(deactivating)} title="Отключить шаблон?" /></>;
}

function AdminReferencesPage() {
  const [catalogs, setCatalogs] = useState<readonly ReferenceCatalogDescriptor[]>([]);
  const [records, setRecords] = useState<readonly ReferenceCatalogValue[]>([]);
  const [relatedValues, setRelatedValues] = useState<Readonly<Record<string, readonly ReferenceCatalogValue[]>>>({});
  const [selectedKey, setSelectedKey] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingAttributes, setEditingAttributes] = useState<Record<string, string | number | boolean | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deactivating, setDeactivating] = useState<ReferenceCatalogValue | null>(null);
  const selected = catalogs.find((catalog) => catalog.key === selectedKey) ?? catalogs[0];

  const loadCatalog = async (key: string, descriptors = catalogs) => {
    const descriptor = descriptors.find((catalog) => catalog.key === key);
    const relatedKeys = [...new Set(descriptor?.fields.map((field) => field.referenceCatalog).filter((value): value is string => Boolean(value)) ?? [])];
    const [values, ...related] = await Promise.all([m2Api.listCatalogValues(key), ...relatedKeys.map((relatedKey) => m2Api.listCatalogValues(relatedKey))]);
    setRecords(values);
    setRelatedValues((current) => ({ ...current, ...Object.fromEntries(relatedKeys.map((relatedKey, index) => [relatedKey, related[index]?.filter((value) => value.isActive) ?? []])) }));
  };

  useEffect(() => {
    m2Api.listCatalogs().then((items) => {
      setCatalogs(items);
      const first = items[0]?.key ?? "";
      setSelectedKey(first);
      if (first) return loadCatalog(first, items);
      return undefined;
    }).catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить справочники"));
  }, []);

  const selectCatalog = (key: string) => {
    setSelectedKey(key);
    setEditingId(null);
    setFormError(null);
    void loadCatalog(key).catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить список"));
  };

  const saveRecord = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const name = editingName.trim();
    const code = selected.codeRequired ? toTechnicalCode(name, records.map((record) => record.code ?? "")) : "";
    if (!name || (selected.codeRequired && !code)) return;
    setSaving(true); setFormError(null);
    try {
      const attributes = Object.fromEntries(selected.fields.filter((field) => !field.readOnly).map((field) => [field.key, editingAttributes[field.key] ?? null]));
      if (editingId === "new") await m2Api.createCatalogValue(selected.key, { ...(code ? { code } : {}), name, attributes });
      else if (editingId) await m2Api.updateCatalogValue(selected.key, editingId, referenceEditPayload(name, attributes));
      await loadCatalog(selected.key);
      setEditingId(null);
    } catch (writeError) {
      const text = writeError instanceof Error ? writeError.message : "Не получилось сохранить запись";
      setFormError(text);
      toast.error(text);
    } finally { setSaving(false); }
  };

  const beginCreate = () => {
    const maxOrder = records.reduce((max, record) => Math.max(max, Number(record.attributes.sortOrder) || 0), 0);
    setEditingId("new");
    setEditingName("");
    setEditingAttributes({ sortOrder: maxOrder + 10 });
    setFormError(null);
  };

  const beginEdit = (record: ReferenceCatalogValue) => {
    setFormError(null);
    setEditingId(record.id);
    setEditingName(record.name);
    setEditingAttributes({ ...record.attributes });
  };

  const moveRecord = async (record: ReferenceCatalogValue, direction: "up" | "down") => {
    if (!selected) return;
    try {
      const values = await m2Api.moveCatalogValue(selected.key, record.id, direction);
      setRecords(values);
    } catch (writeError) {
      toast.error(writeError instanceof Error ? writeError.message : "Не получилось изменить порядок");
    }
  };

  const removeRecord = async (record: ReferenceCatalogValue) => {
    if (!selected) return;
    try {
      await m2Api.removeCatalogValue(selected.key, record.id);
      await loadCatalog(selected.key);
    } catch (writeError) {
      toast.error(writeError instanceof Error ? writeError.message : "Не получилось скрыть запись");
    }
  };

  const reactivateRecord = async (record: ReferenceCatalogValue) => {
    if (!selected) return;
    try {
      await m2Api.updateCatalogValue(selected.key, record.id, { isActive: true });
      await loadCatalog(selected.key);
    } catch (writeError) {
      toast.error(writeError instanceof Error ? writeError.message : "Не получилось вернуть запись");
    }
  };

  return <>
    <div className="reference-admin-layout">
      <aside className="card reference-admin-nav" aria-label="Доступные справочники">
        <CardHeader meta={`${catalogs.length} справочников`} title="Разделы" />
        <div>{catalogs.map((catalog) => <button aria-current={catalog.key === selected?.key ? "page" : undefined} className={catalog.key === selected?.key ? "reference-admin-nav__item reference-admin-nav__item--active" : "reference-admin-nav__item"} key={catalog.key} onClick={() => selectCatalog(catalog.key)} type="button"><span><strong>{catalog.label}</strong><small>{catalog.description}</small></span></button>)}</div>
      </aside>
      {selected ? <section className="card reference-admin-editor" aria-labelledby="reference-admin-title">
        <CardHeader action={<Button icon="plus" onClick={beginCreate}>Добавить запись</Button>} headingId="reference-admin-title" meta={`${records.filter((record) => record.isActive).length} активных · ${records.filter((record) => !record.isActive).length} неактивных`} title={selected.label} />
        <div className="table-scroll"><table className="data-table reference-admin-table"><thead><tr><th scope="col">Наименование</th><th scope="col">Параметры</th><th scope="col">Состояние</th><th scope="col"><span className="sr-only">Действия</span></th></tr></thead><tbody>{records.map((record, index) => {
          return <tr className={!record.isActive ? "reference-admin-table__inactive" : ""} key={record.id}>
            <td><strong>{record.name}</strong></td>
            <td className="muted">{Object.entries(record.attributes).map(([key, value]) => `${selected.fields.find((field) => field.key === key)?.label ?? key}: ${typeof value === "boolean" ? value ? "да" : "нет" : String(value)}`).join(" · ") || "—"}</td>
            <td><StatusBadge tone={record.isActive ? "success" : "neutral"}>{record.isActive ? "Активно" : "Неактивно"}</StatusBadge></td>
            <td><div className="reference-admin-actions">
              <IconButton disabled={index === 0} icon="moveUp" label="Выше" onClick={() => void moveRecord(record, "up")} />
              <IconButton disabled={index === records.length - 1} icon="moveDown" label="Ниже" onClick={() => void moveRecord(record, "down")} />
              <IconButton icon="edit" label="Изменить" onClick={() => beginEdit(record)} />
              {record.isActive ? <IconButton icon="hide" label="Скрыть" onClick={() => setDeactivating(record)} /> : <IconButton icon="show" label="Показать" onClick={() => void reactivateRecord(record)} />}
            </div></td>
          </tr>;
        })}{records.length === 0 ? <tr><td colSpan={4}><ResourceState description="Нажмите «Добавить запись», чтобы значение появилось в заявках." status="empty" title={`В списке «${selected.label}» пока нет записей`} /></td></tr> : null}</tbody></table></div>
      </section> : null}
    </div>
    <DialogForm busy={saving} description="Запись появится в списке и будет доступна в заявках." error={formError} key={`${selected?.key ?? "catalog"}-${editingId ?? "closed"}`} onOpenChange={(open) => { if (!open) setEditingId(null); }} onSubmit={saveRecord} open={editingId !== null} submitLabel={editingId === "new" ? "Добавить запись" : "Сохранить изменения"} title={editingId === "new" ? `Добавить: ${selected?.label ?? "запись"}` : `Изменить: ${selected?.label ?? "запись"}`}><label className="field-wide">Наименование<input autoFocus onChange={(event) => setEditingName(event.target.value)} required value={editingName} /></label>{selected?.fields.filter((field) => !field.readOnly).map((field) => <label key={field.key}>{field.label}{field.type === "reference" && field.referenceCatalog ? <Select onChange={(event) => setEditingAttributes((current) => ({ ...current, [field.key]: event.target.value || null }))} required={field.required} value={String(editingAttributes[field.key] ?? "")}><option value="">Не выбрано</option>{(relatedValues[field.referenceCatalog] ?? []).map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</Select> : field.type === "boolean" ? <span className="field-check"><input checked={editingAttributes[field.key] === true} onChange={(event) => setEditingAttributes((current) => ({ ...current, [field.key]: event.target.checked }))} type="checkbox" /> Включено</span> : <input onChange={(event) => setEditingAttributes((current) => ({ ...current, [field.key]: field.type === "integer" || field.type === "number" ? (event.target.value === "" ? null : Number(event.target.value)) : event.target.value || null }))} required={field.required} type={field.type === "integer" || field.type === "number" ? "number" : "text"} value={String(editingAttributes[field.key] ?? "")} />}</label>)}</DialogForm>
    <ConfirmationDialog confirmLabel="Скрыть" description={deactivating ? <>«{deactivating.name}» скроется из новых операций. Если запись уже используется, история сохранится.</> : null} onConfirm={async () => { if (deactivating) await removeRecord(deactivating); }} onOpenChange={(open) => { if (!open) setDeactivating(null); }} open={Boolean(deactivating)} title="Скрыть запись?" />
  </>;
}

function ReferencesWorkspace({ notificationTemplates = false }: { readonly notificationTemplates?: boolean }) {
  const [section, setSection] = useState<"catalogs" | "notifications">("catalogs");
  return <>
    <PageIntro description="Виды работ, статусы и модели приборов." title="Справочники" />
    {notificationTemplates ? (
      <PageTabs<"catalogs" | "notifications">
        items={[
          { value: "catalogs", label: "Сервис и приборы" },
          { value: "notifications", label: "Шаблоны писем" }
        ]}
        label="Разделы справочников"
        onValueChange={setSection}
        value={section}
      />
    ) : null}
    {section === "notifications" && notificationTemplates ? <NotificationTemplatesPage /> : <AdminReferencesPage />}
  </>;
}

function CustomersPage() {
  return <>
    <PageIntro description="Площадки, контакты и плательщики для заявок и счетов." title="Клиенты" />
    <CustomerReferencesPage />
  </>;
}

function FinancePage() {
  const [invoices, setInvoices] = useState<readonly InvoiceApiRecord[]>([]);
  const [tasks, setTasks] = useState<readonly TaskApiRecord[]>([]);
  const [equipment, setEquipment] = useState<readonly EquipmentApiRecord[]>([]);
  const [payers, setPayers] = useState<readonly PayerOption[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<readonly string[]>([]);
  const [payerId, setPayerId] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const selectedTasks = tasks.filter((task) => selectedTaskIds.includes(task.id));
  const inheritedPayerIds = [...new Set(selectedTasks.map((task) => equipment.find((item) => item.id === task.equipmentId)?.payerId).filter((value): value is string => Boolean(value)))];
  const inheritedPayerId = inheritedPayerIds.length === 1 ? inheritedPayerIds[0] : "";
  const payerOverridden = Boolean(inheritedPayerId && payerId && payerId !== inheritedPayerId);
  const reload = async () => {
    const [loadedInvoices, loadedTasks, loadedEquipment, loadedPayers] = await Promise.all([
      m2Api.listInvoices(), m2Api.listTasks("closed"), m2Api.listEquipment(), m2Api.listPayers()
    ]);
    setInvoices(loadedInvoices); setTasks(loadedTasks); setEquipment(loadedEquipment); setPayers(loadedPayers);
  };
  useEffect(() => {
    void reload()
      .catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить счета"))
      .finally(() => setLoading(false));
  }, []);
  const openForm = () => {
    setFormError(null);
    setSelectedTaskIds([]);
    setPayerId("");
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setSelectedTaskIds([]);
    setPayerId("");
  };
  const toggleTask = (taskId: string) => {
    const next = selectedTaskIds.includes(taskId) ? selectedTaskIds.filter((id) => id !== taskId) : [...selectedTaskIds, taskId];
    const selected = tasks.filter((task) => next.includes(task.id));
    const nextPayers = [...new Set(selected.map((task) => equipment.find((item) => item.id === task.equipmentId)?.payerId).filter((value): value is string => Boolean(value)))];
    setSelectedTaskIds(next);
    const onlyPayer = nextPayers.length === 1 ? nextPayers[0] : undefined;
    setPayerId(onlyPayer ?? "");
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedTaskIds.length === 0) { setFormError("Выберите хотя бы одну закрытую задачу"); return; }
    if (inheritedPayerIds.length > 1) { setFormError("У выбранных задач разные плательщики — создайте отдельные счета"); return; }
    const data = new FormData(event.currentTarget);
    setSaving(true);
    setFormError(null);
    try {
      await m2Api.createInvoice({
        taskIds: selectedTaskIds,
        ...(payerId ? { payerId } : {}),
        ...(payerOverridden ? { payerOverrideReason: String(data.get("payerOverrideReason") ?? "").trim() } : {})
      });
      await reload(); closeForm();
    } catch (createError) {
      const text = createError instanceof Error ? createError.message : "Не получилось создать счёт";
      setFormError(text);
      toast.error(text);
    }
    finally { setSaving(false); }
  };
  const invoiceTone = (status: InvoiceApiRecord["status"]): StatusTone => status === "transferred_to_1c" ? "success" : status === "issued" ? "purple" : status === "cancelled" ? "neutral" : "warning";
  const invoiceLabel: Readonly<Record<InvoiceApiRecord["status"], string>> = { draft: "Черновик", issued: "Выставлен", transferred_to_1c: "Передан в 1С", cancelled: "Отменён" };
  const canCreateInvoice = selectedTaskIds.length > 0 && Boolean(payerId) && inheritedPayerIds.length <= 1;
  return <><PageIntro actions={<Button icon="plus" onClick={openForm}>Выставить счёт</Button>} description="Выберите закрытые задачи — плательщик подставится из прибора. Если нужен другой, укажите причину." title="Счета" />
    <DialogForm busy={saving} description="Счёт создастся по выбранным закрытым задачам. Плательщик подставится из прибора." error={formError} onOpenChange={(open) => { if (open) openForm(); else closeForm(); }} onSubmit={submit} open={formOpen} submitDisabled={!canCreateInvoice} submitLabel="Создать счёт" title="Новый счёт">
      <div className="invoice-form">
        <div className="invoice-form__section">
          <span className="invoice-form__label" id="invoice-tasks-label">Закрытые задачи{tasks.length > 0 ? " *" : ""}</span>
          {tasks.length === 0
            ? <p className="invoice-form__empty">Закрытых задач для выставления счёта нет. Когда задача будет закрыта, она появится здесь.</p>
            : <div aria-labelledby="invoice-tasks-label" className="workflow-task-picker" role="group">{tasks.map((task) => <label key={task.id}><input checked={selectedTaskIds.includes(task.id)} onChange={() => toggleTask(task.id)} type="checkbox" /> <span><strong>{task.number}</strong> · {task.title}<small>{task.customer?.siteName ?? "Без площадки"}</small></span></label>)}</div>}
          {tasks.length > 0 ? <p className="form-hint">{selectedTaskIds.length === 0 ? "Выберите хотя бы одну закрытую задачу." : selectedTaskIds.length === 1 ? "Выбрана 1 задача." : `Выбрано задач: ${selectedTaskIds.length}.`}</p> : null}
        </div>
        <label>Плательщик
          <Select disabled={selectedTaskIds.length === 0} onChange={(event) => setPayerId(event.target.value)} required={selectedTaskIds.length > 0} value={payerId}>
            <option value="">{selectedTaskIds.length === 0 ? "Сначала выберите задачу" : "Не выбран"}</option>
            {payers.map((payer) => <option key={payer.id} value={payer.id}>{payer.name}</option>)}
          </Select>
          {selectedTaskIds.length === 0 ? <span className="form-hint">Подставится из прибора выбранной задачи.</span> : inheritedPayerIds.length > 1 ? <span className="form-hint">У выбранных задач разные плательщики — создайте отдельные счета.</span> : payerOverridden ? null : inheritedPayerId ? <span className="form-hint">Подставлен из прибора.</span> : null}
        </label>
        {payerOverridden ? <label>Почему другой плательщик *<textarea name="payerOverrideReason" required rows={2} /></label> : null}
      </div>
    </DialogForm>
    <div className="metric-grid metric-grid--three">
      <MetricCard detail="ещё не выставлены" icon="finance" label="Черновики счетов" tone="blue" value={String(invoices.filter((item) => item.status === "draft").length)} />
      <MetricCard detail="ожидают передачи" icon="mail" label="Выставлено" tone="purple" value={String(invoices.filter((item) => item.status === "issued").length)} />
      <MetricCard detail="передано в 1С" icon="check" label="Закрыто" tone="green" value={String(invoices.filter((item) => item.status === "transferred_to_1c").length)} />
    </div>
    <section className="card card--table"><CardHeader meta={`${invoices.length} документов`} title="Последние счета" />{loading && invoices.length === 0 ? <ResourceState description="Подождите, счета сейчас появятся." status="loading" title="Загружаем счета" /> : invoices.length === 0 ? <ResourceState description="Выставьте счёт по закрытой задаче — он появится в этом списке." status="empty" title="Счетов пока нет" /> : <div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">Номер</th><th scope="col">Задачи</th><th scope="col">Плательщик</th><th scope="col">Статус</th></tr></thead><tbody>{invoices.map((invoice) => <tr key={invoice.id}><td><strong>{invoice.number}</strong></td><td>{invoice.taskIds.map((id) => tasks.find((task) => task.id === id)?.number ?? id).join(", ")}</td><td>{invoice.payer.name}</td><td><StatusBadge tone={invoiceTone(invoice.status)}>{invoiceLabel[invoice.status]}</StatusBadge></td></tr>)}</tbody></table></div>}</section></>;
}

function CoordinatorWorkspace({ view, taskRouteId, onTaskRouteChange }: {
  readonly view: NavigationId;
  readonly taskRouteId: string | undefined;
  readonly onTaskRouteChange: (taskId?: string) => void;
}) {
  switch (view) {
    case "tasks": return <CoordinatorTasks initialTaskId={taskRouteId} onTaskRouteChange={onTaskRouteChange} />;
    case "maintenance": return <MaintenancePlanPage />;
    case "equipment": return <EquipmentPage />;
    case "engineers": return <OperationsEngineersPage />;
    case "warehouse": return <OperationsWarehousePage />;
    case "notifications": return <NotificationsPage />;
    case "reports": return <OperationsReportsPage />;
    case "customers": return <CustomersPage />;
    case "references": return <ReferencesWorkspace />;
    case "finance": return <FinancePage />;
    default: return <CoordinatorTasks initialTaskId={taskRouteId} onTaskRouteChange={onTaskRouteChange} />;
  }
}

function AdminWorkspace({ view, taskRouteId, onTaskRouteChange }: {
  readonly view: NavigationId;
  readonly taskRouteId: string | undefined;
  readonly onTaskRouteChange: (taskId?: string) => void;
}) {
  if (view === "access") return <AccessAdminPage />;
  if (view === "references") return <ReferencesWorkspace notificationTemplates />;
  return <CoordinatorWorkspace onTaskRouteChange={onTaskRouteChange} taskRouteId={taskRouteId} view={view} />;
}

function engineerDate(value: string | undefined): string {
  if (!value) return "Не указана";
  return formatDisplayDate(value) || value;
}

function engineerPeriod(from: string | undefined, to: string | undefined): string {
  if (!from && !to) return "Не указан";
  if (!from || !to || from === to) return engineerDate(from ?? to);
  return `${engineerDate(from)} — ${engineerDate(to)}`;
}

function engineerTaskCount(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  const noun = mod100 >= 11 && mod100 <= 14 ? "задач"
    : mod10 === 1 ? "задача"
      : mod10 >= 2 && mod10 <= 4 ? "задачи" : "задач";
  return `${count} ${noun}`;
}

function EngineerTaskCard({ task }: { readonly task: EngineerTaskListItem }) {
  const equipment = [task.equipment.manufacturer, task.equipment.model].filter(Boolean).join(" ");
  return <article className={`mobile-task-card${task.isNew ? " mobile-task-card--new" : ""}`}>
    <div className="mobile-task-card__top"><div className="mobile-task-card__badges">{task.isNew ? <span className="new-task-label">Новая</span> : null}<StatusBadge tone={taskStatusTone(task.status)}>{TASK_STATUS_LABELS[task.status] ?? "Статус"}</StatusBadge></div>{task.isOverdue ? <span className="urgent-label">Просрочена</span> : task.priority === "urgent" ? <span className="urgent-label">Срочная</span> : null}</div>
    <p className="mobile-task-card__number">{task.number}</p><h2>{task.title}</h2>
    <div className="mobile-task-card__site"><strong>{task.site.name}</strong><address>{task.site.address}</address></div>
    <dl className="detail-list"><div><dt>Период</dt><dd>{engineerPeriod(task.dates.periodFrom, task.dates.periodTo)}</dd></div><div><dt>Вызов</dt><dd>{engineerDate(task.dates.call)}</dd></div>{task.dates.visit ? <div><dt>Выезд</dt><dd>{engineerDate(task.dates.visit)}</dd></div> : null}<div><dt>Прибор</dt><dd>{equipment || "Прибор не указан"}<span>S/N {task.equipment.serialNumber}</span></dd></div></dl>
    <Button type="button" variant="secondary">Открыть задачу</Button>
  </article>;
}

function EngineerTasks({ user }: { readonly user: ApiSessionUser }) {
  const [page, setPage] = useState<EngineerTaskListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void m2Api.engineerTasks().then((loaded) => {
      if (active) setPage(loaded);
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Не получилось загрузить задачи");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [reload]);
  const initials = user.fullName.split(" ").map((part) => part[0]).join("").slice(0, 2);
  return <>
    <PageIntro description="Ваши выезды: адрес, прибор и сроки." title="Мои задачи" />
    <section aria-label="Профиль инженера" className="engineer-identity"><span className="avatar">{initials}</span><div><strong>{user.fullName}</strong><span>Инженер</span></div></section>
    <section aria-busy={loading} aria-labelledby="engineer-task-list-title"><div className="section-heading"><div><h2 id="engineer-task-list-title">Назначенные выезды</h2></div>{page ? <span className="muted">{engineerTaskCount(page.total)}</span> : null}</div>
      {loading ? <div className="mobile-task-list" role="status"><span className="sr-only">Загрузка задач…</span><div className="mobile-task-skeleton" /><div className="mobile-task-skeleton" /></div> : null}
      {!loading && error ? <div className="mobile-task-error" role="alert"><strong>Список не загрузился</strong><span>{error}</span><Button onClick={() => setReload((value) => value + 1)} variant="secondary">Повторить</Button></div> : null}
      {!loading && !error && page?.items.length === 0 ? <ResourceState description="Когда координатор назначит задачу, она появится здесь." status="empty" title="Назначенных выездов пока нет" /> : null}
      {!loading && !error && page ? <div className="mobile-task-list">{page.items.map((task) => <EngineerTaskCard key={task.id} task={task} />)}</div> : null}
    </section>
  </>;
}

function EngineerWorkspace({ view, user }: { readonly view: NavigationId; readonly user: ApiSessionUser }) {
  switch (view) {
    case "tasks": return <EngineerTasks user={user} />;
    case "equipment": return <EquipmentPage engineer />;
    case "notifications": return <NotificationsPage />;
    default: return <EngineerTasks user={user} />;
  }
}

function WarehouseWorkspace({ view }: { readonly view: NavigationId }) {
  switch (view) {
    case "warehouse": return <OperationsWarehousePage />;
    case "notifications": return <NotificationsPage />;
    default: return <OperationsWarehousePage />;
  }
}

function groupNavigation(items: readonly NavigationItem[]) {
  return items.reduce<Array<{ readonly label: string; readonly items: readonly NavigationItem[] }>>((groups, item) => {
    const existing = groups.find((group) => group.label === item.group);
    if (existing) {
      const index = groups.indexOf(existing);
      groups[index] = { ...existing, items: [...existing.items, item] };
      return groups;
    }
    groups.push({ label: item.group, items: [item] });
    return groups;
  }, []);
}

function appRoleForApiRole(role: string, accessRoleKey?: string): AppRole {
  const keys = [accessRoleKey, role];
  if (keys.includes("admin")) return "admin";
  if (keys.includes("engineer")) return "engineer";
  if (keys.includes("warehouse")) return "warehouse";
  return "coordinator";
}

const navigationPermission: Partial<Record<NavigationId, string>> = {
  tasks: "tasks.read", maintenance: "tasks.assign", equipment: "equipment.read", engineers: "tasks.assign",
  warehouse: "warehouse.read", reservations: "warehouse.read", inventory: "warehouse.read", handoff: "warehouse.write",
  notifications: "notifications.read", reports: "reports.read", customers: "references.read", references: "references.read", finance: "finance.read",
  access: "users.read"
};

function navigationForSession(role: AppRole, user: ApiSessionUser | null | undefined): readonly NavigationItem[] {
  const items = getRoleNavigation(role);
  if (role === "admin") return items;
  return items.filter((item) => {
    if (!user?.permissions) return true;
    if (item.id === "access") return user.permissions.some((permission) => permission === "users.read" || permission === "roles.write");
    return user.permissions.includes(navigationPermission[item.id] ?? "");
  });
}

function LoginPage({ onLogin }: { readonly onLogin: (user: ApiSessionUser) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setLoading(true); setError(null);
    try {
      onLogin(await m2Api.login(String(data.get("email") ?? ""), String(data.get("password") ?? "")));
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Не получилось войти");
    } finally {
      setLoading(false);
    }
  };
  return (
    <main className="login-page">
      <section aria-labelledby="login-title" className="login-card">
        <div className="login-brand">
          <span aria-hidden="true" className="brand-mark">МТ</span>
          <div>
            <strong>МедТехСервис</strong>
            <span>сервис медицинской техники</span>
          </div>
        </div>
        <header>
          <h1 id="login-title">Вход</h1>
          <p>Войдите, чтобы работать с заявками, приборами и складом.</p>
        </header>
        <form aria-busy={loading} onSubmit={submit}>
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          <Field label="E-mail" required>
            <Input autoComplete="username" autoFocus disabled={loading} name="email" required type="email" />
          </Field>
          <Field label="Пароль" required>
            <Input autoComplete="current-password" disabled={loading} name="password" required type="password" />
          </Field>
          <Button busy={loading} busyLabel="Входим…" type="submit">Войти</Button>
        </form>
      </section>
    </main>
  );
}

function App() {
  const [sessionUser, setSessionUser] = useState<ApiSessionUser | null | undefined>(undefined);
  const [role, setRole] = useState<AppRole>("coordinator");
  const [activeView, setActiveView] = useState<NavigationId>(getDefaultView("coordinator"));
  const [taskRouteId, setTaskRouteId] = useState<string | undefined>(() =>
    typeof window === "undefined" ? undefined : taskIdFromPathname(window.location.pathname));
  const navigation = navigationForSession(role, sessionUser);
  const groups = groupNavigation(navigation);
  const activeItem = navigation.find((item) => item.id === activeView) ?? navigation[0];

  useEffect(() => {
    m2Api.session().then((user) => {
      const nextRole = appRoleForApiRole(user.role, user.accessRoleKey);
      const nextNavigation = navigationForSession(nextRole, user);
      setSessionUser(user);
      setRole(nextRole);
      setActiveView(taskRouteId && nextNavigation.some((item) => item.id === "tasks") ? "tasks" : nextNavigation[0]?.id ?? getDefaultView(nextRole));
    }).catch((error: unknown) => {
      if (error instanceof M2ApiError && error.status === 401) setSessionUser(null);
      else setSessionUser(null);
    });
  }, []);

  useEffect(() => {
    const restoreRoute = () => {
      const taskId = taskIdFromPathname(window.location.pathname);
      setTaskRouteId(taskId);
      if (taskId) setActiveView("tasks");
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);

  const navigate = (id: NavigationId) => {
    setActiveView(id);
    setTaskRouteId(undefined);
    if (window.location.pathname !== "/") window.history.pushState(null, "", "/");
  };

  const changeTaskRoute = (taskId?: string) => {
    setTaskRouteId(taskId);
    const pathname = taskId ? taskPathname(taskId) : "/";
    if (window.location.pathname !== pathname) window.history.pushState(null, "", pathname);
  };

  const acceptLogin = (user: ApiSessionUser) => {
    const nextRole = appRoleForApiRole(user.role, user.accessRoleKey);
    const nextNavigation = navigationForSession(nextRole, user);
    setSessionUser(user);
    setRole(nextRole);
    setActiveView(nextNavigation[0]?.id ?? getDefaultView(nextRole));
  };

  if (sessionUser === undefined) {
    return <main className="login-page"><div className="session-loading" role="status"><Icon name="clock" /><span>Проверяем вход…</span></div></main>;
  }
  if (sessionUser === null) return <LoginPage onLogin={acceptLogin} />;

  return (
    <AppShell
      activeId={activeItem?.id}
      currentPageLabel={activeItem?.label}
      groups={groups}
      onLogout={() => { void m2Api.logout().finally(() => setSessionUser(null)); }}
      onNavigate={navigate}
      userMeta={sessionUser.accessRoleName ?? roleLabels[role]}
      userName={sessionUser.fullName}
    >
      {navigation.length === 0 ? <ResourceState description="У вашей роли нет рабочих разделов. Попросите администратора открыть доступ." status="empty" title="Нет доступных разделов" /> : null}
      {navigation.length > 0 && role === "coordinator" ? <CoordinatorWorkspace onTaskRouteChange={changeTaskRoute} taskRouteId={taskRouteId} view={activeView} /> : null}
      {navigation.length > 0 && role === "engineer" ? <EngineerWorkspace user={sessionUser} view={activeView} /> : null}
      {navigation.length > 0 && role === "warehouse" ? <WarehouseWorkspace view={activeView} /> : null}
      {navigation.length > 0 && role === "admin" ? <AdminWorkspace onTaskRouteChange={changeTaskRoute} taskRouteId={taskRouteId} view={activeView} /> : null}
    </AppShell>
  );
}

export { App };
