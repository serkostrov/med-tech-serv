import React, { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { BulkTaskCommandResponse, EngineerTaskListItem, EngineerTaskListResponse, EquipmentFileResponse, EquipmentHistoryEvent, EquipmentMeterReading, MailInboxRecord, NotificationJournalRecord, NotificationTemplateResponse, TaskPartPosition } from "./types.js";
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
import { FileDropField } from "./FileDropField.js";
import { FileGallery } from "./FileGallery.js";
import {
  EngineersPage as OperationsEngineersPage,
  ReportsPage as OperationsReportsPage,
  WarehousePage as OperationsWarehousePage
} from "./OperationsPages.js";
import { TaskBoard } from "./TaskBoard.js";
import { CustomerReferencesPage } from "./CustomerReferencesPage.js";
import { EquipmentTreePage } from "./EquipmentTreePage.js";
import { EquipmentFolderPicker } from "./EquipmentFolderPicker.js";
import { PartsMultiPicker, type SelectedTaskPart } from "./PartsMultiPicker.js";
import { AccessAdminPage } from "./AccessAdminPage.js";
import type { PayerOption, SiteOption } from "./customer-selection.js";
import { sitePeople } from "./site-people.js";
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
  ViewSwitch,
  PageIntro,
  ResourceState,
  StatusBadge,
  type StatusTone,
  Select,
  toast
} from "./ui.js";
import { formatDisplayDate, todayIsoDate } from "./date-format.js";
import { TASK_STATUS_LABELS, TASK_STATUS_TONES } from "./domain/task-status.js";
import { toTechnicalCode } from "./slug.js";
import { AppShell } from "./components/app-shell.js";
import { Skeleton } from "./components/ui/skeleton.js";

const FILE_KIND_LABELS: Readonly<Record<string, string>> = {
  act: "Фото акта",
  photo: "Фото",
  video: "Видео",
  document: "Документ",
  mail_attachment: "Из письма клиента"
};

function taskStatusTone(status: string): StatusTone {
  return TASK_STATUS_TONES[status] ?? "warning";
}

function formatTaskDate(value: string | undefined, withTime = false): string {
  if (!value) return "Не указано";
  return formatDisplayDate(value, withTime) || value;
}

function formatTaskDateRange(from: string | undefined, to: string | undefined, withTime = false): string {
  if (!from && !to) return "Не указано";
  return `${formatTaskDate(from, withTime)} — ${formatTaskDate(to, withTime)}`;
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

// Событие журнала простыми словами: что произошло с задачей.
function journalTitle(event: TaskCardResponse["journal"][number]): string {
  const from = event.fromStatus;
  const to = event.toStatus;
  if (!to) return taskJournalDescription(event);
  if (!from) return "Задача создана";
  if (to === "assigned") return from === "assigned" ? "Сменён инженер" : "Назначен инженер";
  if (to === "in_progress") return from === "under_review" ? "Возвращена на доработку" : "Принята в работу";
  if (to === "under_review") return "Передана на проверку";
  if (to === "closed") return "Проверена и закрыта";
  if (to === "cancelled") return "Отменена";
  if (to === "new") return from === "planned" ? "Отмечена как новая" : "Задача создана";
  return `Этап: ${TASK_STATUS_LABELS[to] ?? to}`;
}

/** История задачи лентой по дням: что произошло, кто и когда, комментарий отдельно. */
function TaskHistory({ journal }: { readonly journal: TaskCardResponse["journal"] }) {
  if (journal.length === 0) return <div className="task-section__empty"><p>Записей пока нет. Здесь появятся все действия по задаче.</p></div>;
  const days = new Map<string, TaskCardResponse["journal"][number][]>();
  for (const event of journal) {
    const day = formatTaskDate(event.occurredAt);
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  return <div className="task-history">
    {[...days.entries()].map(([day, events]) => <section className="task-history__day" key={day}>
      <h4>{day}</h4>
      <ol>
        {events.map((event) => <li className="task-history__item" key={event.id}>
          <span aria-hidden="true" className={`task-history__dot task-history__dot--${event.toStatus ? taskStatusTone(event.toStatus) : "neutral"}`} />
          <div className="task-history__body">
            <div className="task-history__line">
              <strong>{journalTitle(event)}</strong>
              {event.toStatus ? <StatusBadge tone={taskStatusTone(event.toStatus)}>{TASK_STATUS_LABELS[event.toStatus] ?? event.toStatus}</StatusBadge> : null}
              <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time>
            </div>
            <span className="task-history__actor">{event.actorName ?? "Система"}</span>
            {event.comment ? <p className="task-history__comment">{event.comment}</p> : null}
          </div>
        </li>)}
      </ol>
    </section>)}
  </div>;
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
              <td><button className="text-button" onClick={(event) => { event.stopPropagation(); onOpen(task.id); }} type="button"><strong>{task.number}</strong></button></td>
              <td><strong>{task.title}</strong></td>
              <td>{task.customer?.siteName ?? "Не выбрана"}</td>
              <td className="muted">{task.equipmentLabel ? `${task.equipmentLabel.model ?? "Прибор"} · S/N ${task.equipmentLabel.serialNumber}` : device ? `${device.model} · S/N ${device.serialNumber}` : task.equipmentId ? "Прибор" : "Не выбран"}</td>
              <td>{formatTaskDate(task.periodTo)}{task.priority === "urgent" ? <span className="urgent-label">срочно</span> : null}{task.isOverdue ? <span className="status-badge status-badge--orange task-overdue-badge">просрочена</span> : null}</td>
              <td>{task.engineerName ?? engineers.find((engineer) => engineer.id === task.engineerId)?.fullName ?? (task.engineerId ? "Инженер" : "Не назначен")}</td>
              <td><StatusBadge tone={taskStatusTone(task.status)}>{TASK_STATUS_LABELS[task.status] ?? "Статус"}</StatusBadge></td>
            </tr>
          );})}
          {tasks.length === 0 ? <tr><td colSpan={8}><ResourceState description={filtered ? "Измените условия или сбросьте фильтры." : "Создайте заявку — она появится в списке и на доске."} status={filtered ? "filtered-empty" : "empty"} title={filtered ? "Задач по этим условиям нет" : "Задач пока нет"} /></td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

function TaskCreationForm({ open, equipment, sites, workTypes, engineers = [], canAssignEngineer = false, initialTitle = "", initialWorkTypeCode, initialComment = "", initialEquipment, mail, onOpenChange, onCreated, onEquipmentAttached }: {
  readonly open: boolean;
  /** Инженеры для необязательного назначения сразу при создании. */
  readonly engineers?: readonly { readonly id: string; readonly fullName: string }[];
  /** Назначать инженера при создании может только роль с правом назначения. */
  readonly canAssignEngineer?: boolean;
  readonly initialComment?: string;
  /** Прибор, найденный по S/N из письма: подставляется сразу, его можно сменить. */
  readonly initialEquipment?: EquipmentApiRecord;
  /** Письмо, из которого создаётся задача: показываем его текст рядом с формой. */
  readonly mail?: MailInboxRecord;
  readonly equipment: readonly EquipmentApiRecord[];
  readonly sites: readonly SiteOption[];
  readonly workTypes: readonly ReferenceCatalogValue[];
  readonly initialTitle?: string;
  readonly initialWorkTypeCode?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (task: TaskApiRecord) => Promise<void>;
  readonly onEquipmentAttached?: (device: EquipmentApiRecord) => void;
}) {
  const activeWorkTypes = workTypes.filter((item) => item.isActive);
  const defaultWorkType = initialWorkTypeCode || activeWorkTypes[0]?.code || activeWorkTypes[0]?.id || "diagnostics";
  const [equipmentId, setEquipmentId] = useState("");
  const [workTypeCode, setWorkTypeCode] = useState(defaultWorkType);
  const [priority, setPriority] = useState<"planned" | "urgent">("planned");
  const [initiatorContactId, setInitiatorContactId] = useState("");
  const [siteContactId, setSiteContactId] = useState("");
  // Сроки по умолчанию: вызов сегодня, срочная до завтра, плановая за неделю. Их можно поменять.
  const plusDays = (days: number) => { const date = new Date(); date.setDate(date.getDate() + days); return todayIsoDate(date); };
  const [callDate, setCallDate] = useState(() => todayIsoDate());
  const [periodFrom, setPeriodFrom] = useState(() => todayIsoDate());
  const [periodTo, setPeriodTo] = useState(() => plusDays(7));
  const [periodTouched, setPeriodTouched] = useState(false);
  const [partsOpen, setPartsOpen] = useState(false);
  const [engineerId, setEngineerId] = useState("");
  const [selectedParts, setSelectedParts] = useState<readonly SelectedTaskPart[]>([]);
  const [partsWarranty, setPartsWarranty] = useState(false);
  const [partsForSale, setPartsForSale] = useState(false);
  const [pickingEquipment, setPickingEquipment] = useState(true);
  const [createdEquipment, setCreatedEquipment] = useState<EquipmentApiRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const equipmentOptions = useMemo(() => {
    if (!createdEquipment) return equipment;
    const index = equipment.findIndex((item) => item.id === createdEquipment.id);
    if (index < 0) return [...equipment, createdEquipment];
    return equipment.map((item, i) => (i === index ? createdEquipment : item));
  }, [equipment, createdEquipment]);
  const selectedEquipment = equipmentOptions.find((item) => item.id === equipmentId) ?? (
    createdEquipment?.id === equipmentId ? createdEquipment : undefined
  );
  const contactChoices = useMemo(() => {
    const choices: {
      readonly contactId: string;
      readonly siteId: string;
      readonly siteName: string;
      readonly payerId?: string;
      readonly fullName: string;
      readonly isPrimary: boolean;
    }[] = [];
    for (const site of sites.filter((item) => item.isActive)) {
      for (const person of sitePeople(site)) {
        if (!person.isActive || !person.contactId) continue;
        choices.push({
          contactId: person.contactId,
          siteId: site.id,
          siteName: site.name,
          ...(person.payerId ? { payerId: person.payerId } : {}),
          fullName: person.fullName,
          isPrimary: person.isPrimary
        });
      }
    }
    return choices;
  }, [sites]);
  const showSiteInContactLabel = useMemo(
    () => new Set(contactChoices.map((item) => item.siteId)).size > 1,
    [contactChoices]
  );

  useEffect(() => {
    if (!open) return;
    setWorkTypeCode(defaultWorkType);
  }, [defaultWorkType, open]);

  useEffect(() => {
    if (!open) return;
    setPickingEquipment(!equipmentId);
  }, [open, equipmentId]);

  useEffect(() => {
    if (!open || !initialEquipment) return;
    rememberEquipment(initialEquipment);
    // Только при открытии формы с этим прибором; смена прибора дальше — за координатором.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialEquipment?.id]);

  useEffect(() => {
    if (open) return;
    setCallDate(todayIsoDate()); setPeriodFrom(todayIsoDate()); setPeriodTo(plusDays(7)); setPeriodTouched(false); setPartsOpen(false);
    setPriority("planned");
    setEngineerId("");
    setSelectedParts([]);
    setPartsWarranty(false);
    setPartsForSale(false);
    setCreatedEquipment(null);
    setEquipmentId("");
    setInitiatorContactId("");
    setSiteContactId("");
    setPickingEquipment(true);
  }, [open]);

  const applyEquipment = (device: EquipmentApiRecord | undefined) => {
    setEquipmentId(device?.id ?? "");
    const primary = device?.siteId
      ? contactChoices.find((item) => item.siteId === device.siteId && item.isPrimary)
        ?? contactChoices.find((item) => item.siteId === device.siteId)
      : undefined;
    setInitiatorContactId("");
    setSiteContactId(primary?.contactId ?? "");
  };

  const rememberEquipment = (device: EquipmentApiRecord, contacts?: { readonly initiatorContactId?: string; readonly siteContactId?: string }) => {
    setCreatedEquipment(device);
    setEquipmentId(device.id);
    setPickingEquipment(false);
    if (contacts) {
      setInitiatorContactId(contacts.initiatorContactId ?? "");
      setSiteContactId(contacts.siteContactId ?? "");
    } else {
      const primary = device.siteId
        ? contactChoices.find((item) => item.siteId === device.siteId && item.isPrimary)
          ?? contactChoices.find((item) => item.siteId === device.siteId)
        : undefined;
      setInitiatorContactId("");
      setSiteContactId(primary?.contactId ?? "");
    }
    onEquipmentAttached?.(device);
  };

  const selectEquipment = (device: EquipmentApiRecord) => {
    rememberEquipment(device);
  };

  const changeEquipment = () => {
    applyEquipment(undefined);
    setPickingEquipment(true);
  };

  const resolvePayerId = (choice: (typeof contactChoices)[number]): string | undefined => {
    if (choice.payerId) return choice.payerId;
    return sites.find((item) => item.id === choice.siteId)?.payers.find((item) => item.isActive)?.id;
  };

  const ensureEquipmentForContact = async (choice: (typeof contactChoices)[number]): Promise<EquipmentApiRecord | null> => {
    if (!selectedEquipment) return null;
    const payerId = resolvePayerId(choice);
    if (!payerId) {
      toast.warning("У выбранного человека нет плательщика. Укажите его в справочнике «Клиенты».");
      return null;
    }
    let device = selectedEquipment;
    const happenedAt = localDateTimeToIso(localDateTimeInputValue());
    if (device.siteId !== choice.siteId) {
      device = await m2Api.changeEquipmentAssignment(device.id, "site_change", {
        targetId: choice.siteId,
        occurredAt: happenedAt,
        comment: "Площадка по клиенту при создании задачи"
      });
    }
    if (device.payerId !== payerId) {
      device = await m2Api.changeEquipmentAssignment(device.id, "payer_change", {
        targetId: payerId,
        occurredAt: happenedAt,
        comment: "Плательщик по клиенту при создании задачи"
      });
    }
    return device;
  };

  const selectClient = async (contactId: string) => {
    if (!contactId) {
      setSiteContactId("");
      return;
    }
    const choice = contactChoices.find((item) => item.contactId === contactId);
    if (!choice || busy) return;
    setBusy(true);
    try {
      const device = await ensureEquipmentForContact(choice);
      if (!device) return;
      const initiatorSameSite = !initiatorContactId
        || contactChoices.find((item) => item.contactId === initiatorContactId)?.siteId === choice.siteId;
      rememberEquipment(device, {
        siteContactId: contactId,
        ...(initiatorSameSite ? { initiatorContactId } : {})
      });
    } catch (assignError) {
      toast.error(assignError instanceof Error ? assignError.message : "Не получилось сохранить клиента");
    } finally {
      setBusy(false);
    }
  };

  const selectInitiator = async (contactId: string) => {
    if (!contactId) {
      setInitiatorContactId("");
      return;
    }
    const choice = contactChoices.find((item) => item.contactId === contactId);
    if (!choice || busy) return;
    if (siteContactId) {
      const client = contactChoices.find((item) => item.contactId === siteContactId);
      if (client && client.siteId !== choice.siteId) {
        toast.warning("Инициатор должен быть с той же площадки, что и клиент");
        return;
      }
    }
    setBusy(true);
    try {
      const device = await ensureEquipmentForContact(choice);
      if (!device) return;
      rememberEquipment(device, {
        initiatorContactId: contactId,
        siteContactId: siteContactId || choice.contactId
      });
    } catch (assignError) {
      toast.error(assignError instanceof Error ? assignError.message : "Не получилось сохранить инициатора");
    } finally {
      setBusy(false);
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
    if (!selectedEquipment) {
      // Открываем список приборов сразу, чтобы было понятно, где выбирать.
      document.querySelector<HTMLInputElement>("input[aria-label=\"Поиск прибора\"]")?.focus();
      return fail("Выберите прибор: нажмите на поле «Прибор» и выберите его из списка");
    }
    if (!selectedEquipment.siteId || !selectedEquipment.payerId) {
      return fail("Выберите клиента или инициатора — так задаются площадка и плательщик прибора");
    }
    if (!periodFrom || !periodTo) return fail("Укажите период выполнения: даты «с» и «по»");
    if (periodFrom > periodTo) return fail("Начало периода не может быть позже конца");
    const comment = String(data.get("comment") ?? "").trim();
    setBusy(true);
    try {
      const task = await m2Api.createTask({
        title,
        workTypeCode,
        priority,
        equipmentId: selectedEquipment.id,
        siteId: selectedEquipment.siteId,
        payerId: selectedEquipment.payerId,
        ...(initiatorContactId ? { initiatorContactId } : {}),
        ...(siteContactId ? { siteContactId } : {}),
        periodFrom: taskCalendarDate(periodFrom),
        periodTo: taskCalendarDate(periodTo),
        ...(callDate ? { callDate: taskCalendarDate(callDate) } : {}),
        ...(comment ? { callReason: comment } : {})
      });
      let created = task;
      if (engineerId) {
        try { created = await m2Api.assignTask(task.id, engineerId); }
        catch (assignError) { toast.warning(`Задача создана, но инженер не назначен: ${assignError instanceof Error ? assignError.message : "ошибка"}. Назначьте в карточке.`); }
      }
      if (selectedParts.length > 0) {
        // Задача уже создана: ошибка запчастей не должна выглядеть как «не создана», иначе повтор создаст дубль.
        await m2Api.replaceTaskParts(task.id, selectedParts.map((part) => ({
          articleNumber: part.articleNumber,
          name: part.name,
          quantity: part.quantity,
          condition: partsWarranty ? "G" : "N",
          ...(partsForSale ? { forSale: true } : {})
        }))).catch((partsError: unknown) => toast.warning(`Задача ${task.number} создана, но запчасти не сохранились: ${partsError instanceof Error ? partsError.message : "ошибка"}. Добавьте их в карточке.`));
      }
      await onCreated(created);
    } catch (createError) {
      toast.error(createError instanceof Error ? createError.message : "Не получилось создать задачу");
    } finally {
      setBusy(false);
    }
  };

  const contactPlaceholder = !selectedEquipment
    ? "Сначала выберите прибор"
    : contactChoices.length === 0
      ? "Нет людей в справочнике «Клиенты»"
      : "Не выбран";

  // Сначала люди с площадки прибора. Выбор человека с другой площадки переносит прибор туда, это подписано.
  const orderedContacts = [...contactChoices].sort((left, right) => Number(left.siteId !== selectedEquipment?.siteId) - Number(right.siteId !== selectedEquipment?.siteId));
  const contactLabel = (person: (typeof contactChoices)[number]) => {
    const base = showSiteInContactLabel ? `${person.fullName} · ${person.siteName}` : person.fullName;
    return selectedEquipment?.siteId && person.siteId !== selectedEquipment.siteId ? `${base} (прибор переедет на эту площадку)` : base;
  };

  const changePriority = (urgent: boolean) => {
    setPriority(urgent ? "urgent" : "planned");
    // Пока срок не меняли руками, подстраиваем его под срочность.
    if (!periodTouched) { setPeriodFrom(todayIsoDate()); setPeriodTo(plusDays(urgent ? 1 : 7)); }
  };

  return <DialogForm busy={busy} description={mail ? "Поля заполнены по письму. Проверьте их: после создания клиенту уйдёт автоответ с номером заявки." : "Выберите прибор, и клиент с плательщиком подставятся сами. Поля со звёздочкой обязательны."} onOpenChange={onOpenChange} onSubmit={submit} open={open} size="lg" submitLabel="Создать задачу" title={mail ? "Задача из письма" : "Новая задача"}>
      {mail ? <MailSourcePanel mail={mail} /> : null}
      <h3 className="task-form-step field-wide"><span>1</span>Прибор</h3>
      <div className="equipment-picker field-wide">
        <span className="equipment-picker__label">Прибор *</span>
        {selectedEquipment && !pickingEquipment ? (
          <div className="equipment-picker__selected">
            <p className="equipment-picker__result">
              <strong>{selectedEquipment.manufacturer} {selectedEquipment.model}</strong>
              <span>S/N {selectedEquipment.serialNumber} · {selectedEquipment.site ?? "площадка не указана"} · {selectedEquipment.payer ?? "плательщик не указан"}</span>
            </p>
            <Button onClick={changeEquipment} type="button" variant="secondary">Сменить</Button>
          </div>
        ) : (
          <EquipmentFolderPicker equipment={equipmentOptions} onSelect={selectEquipment} />
        )}
      </div>
      <h3 className="task-form-step field-wide"><span>2</span>Клиент</h3>
      <label>Клиент (контакт на площадке)
        <Select
          disabled={!selectedEquipment || contactChoices.length === 0}
          onChange={(event) => void selectClient(event.target.value)}
          value={siteContactId}
        >
          <option value="">{contactPlaceholder}</option>
          {orderedContacts.map((person) => (
            <option key={`client-${person.contactId}`} value={person.contactId}>
              {contactLabel(person)}
            </option>
          ))}
        </Select>
      </label>
      <label>Кто обратился (инициатор)
        <Select
          disabled={!selectedEquipment || contactChoices.length === 0}
          onChange={(event) => void selectInitiator(event.target.value)}
          value={initiatorContactId}
        >
          <option value="">{contactPlaceholder}</option>
          {orderedContacts.map((person) => (
            <option key={`initiator-${person.contactId}`} value={person.contactId}>
              {contactLabel(person)}
            </option>
          ))}
        </Select>
      </label>
      <h3 className="task-form-step field-wide"><span>3</span>Что сделать</h3>
      <label className="field-wide">Название задачи *<input defaultValue={initialTitle} maxLength={200} name="title" placeholder="Например, не включается анализатор" required /></label>
      <label>Вид работ *<Select onChange={(event) => setWorkTypeCode(event.target.value)} required value={workTypeCode}>{activeWorkTypes.map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label>
      <label className="task-priority-check">
        <input
          checked={priority === "urgent"}
          onChange={(event) => changePriority(event.target.checked)}
          type="checkbox"
        />
        <span className="task-priority-check__text">
          <strong>Срочная</strong>
          <small>Выезд в течение 24 часов</small>
        </span>
      </label>
      <label className="field-wide">Причина вызова (со слов клиента)<textarea defaultValue={initialComment} maxLength={2000} name="comment" placeholder="Что случилось с прибором. Инженер увидит это в акте и сможет уточнить" rows={3} /></label>
      <h3 className="task-form-step field-wide"><span>4</span>Сроки и исполнитель</h3>
      <div className="dialog-form-row-3">
        <label>Дата вызова<DatePicker onChange={setCallDate} value={callDate} /></label>
        <label>Выполнить с *<DatePicker onChange={(value) => { setPeriodTouched(true); setPeriodFrom(value); }} required value={periodFrom} /></label>
        <label>Выполнить до *<DatePicker onChange={(value) => { setPeriodTouched(true); setPeriodTo(value); }} required value={periodTo} /></label>
      </div>
      {canAssignEngineer && engineers.length ? <label className="field-wide">Инженер (можно назначить позже)<Select onChange={(event) => setEngineerId(event.target.value)} value={engineerId}><option value="">Назначу позже</option>{engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.fullName}</option>)}</Select></label> : null}
      {partsOpen || selectedParts.length > 0 ? <div className="equipment-picker field-wide">
        <span className="equipment-picker__label">Запчасти для выезда</span>
        <PartsMultiPicker
          forSale={partsForSale}
          onChange={setSelectedParts}
          onForSaleChange={setPartsForSale}
          onWarrantyChange={setPartsWarranty}
          value={selectedParts}
          warranty={partsWarranty}
        />
      </div> : <button className="task-form-add field-wide" onClick={() => setPartsOpen(true)} type="button">+ Добавить запчасти со склада (необязательно)</button>}
  </DialogForm>;
}

export function TaskCard({ card, workTypes = [], onBack, onChanged, onOpenRelated, initialTab = "overview" }: {
  readonly card: TaskCardResponse;
  readonly workTypes?: readonly ReferenceCatalogValue[];
  readonly onBack: () => void;
  readonly onChanged: () => Promise<void>;
  readonly onOpenRelated: (id: string) => Promise<void>;
  readonly initialTab?: "overview" | "result" | "materials" | "parts" | "history";
}) {
  const [suggestions, setSuggestions] = useState<readonly {
    readonly engineerId: string;
    readonly fullName: string;
    readonly isAvailable: boolean;
    readonly previouslyWorkedWithEquipment: boolean;
  }[]>([]);
  const [engineerId, setEngineerId] = useState("");
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionDialog, setActionDialog] = useState<"cancel" | "return_for_rework" | null>(null);
  const [actOpen, setActOpen] = useState(false);
  const [actRowsEditing, setActRowsEditing] = useState(false);
  const [resultEditing, setResultEditing] = useState(false);
  const [overviewEditing, setOverviewEditing] = useState(false);
  // Вкладки карточки: работа и акт (результат и файлы), запчасти отдельно, история.
  const [detailTab, setDetailTab] = useState<"work" | "parts" | "history">(initialTab === "history" ? "history" : initialTab === "parts" ? "parts" : "work");
  const [resultCatalogs, setResultCatalogs] = useState<{ readonly reasons: readonly ReferenceCatalogValue[]; readonly workTypes: readonly ReferenceCatalogValue[] }>({ reasons: [], workTypes: [] });
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
  // Сменить инженера можно, пока задача не на проверке: например, если назначенный заболел.
  const canReassign = card.canReassign === true;
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
    if ((!canAssign && !canReassign) || !card.equipment) return;
    void m2Api.taskAssignmentSuggestions(task.id, card.equipment.manufacturer, card.equipment.model)
      .then((items) => {
        const ranked = [...items].sort((left, right) => {
          if (left.previouslyWorkedWithEquipment !== right.previouslyWorkedWithEquipment) {
            return left.previouslyWorkedWithEquipment ? -1 : 1;
          }
          if (left.isAvailable !== right.isAvailable) return left.isAvailable ? -1 : 1;
          return left.fullName.localeCompare(right.fullName, "ru");
        });
        setSuggestions(ranked);
        setEngineerId(ranked.find((item) => item.engineerId !== card.engineer?.id)?.engineerId ?? ranked[0]?.engineerId ?? "");
      })
      .catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить список инженеров"));
  }, [task.id, canAssign, canReassign, card.equipment?.id]);

  useEffect(() => {
    // Справочники для формы результата грузим, когда её открывают.
    if (!resultEditing) return;
    void Promise.all([m2Api.listCatalogValues("task-reasons"), m2Api.listCatalogValues("work-types")])
      .then(([reasons, types]) => setResultCatalogs({ reasons: reasons.filter((item) => item.isActive), workTypes: types }))
      .catch(() => toast.warning("Не получилось загрузить справочник причин. Обновите страницу, если списка нет."));
  }, [resultEditing]);
  const hoursRequired = (resultCatalogs.workTypes.length ? resultCatalogs.workTypes : workTypes)
    .find((item) => (item.code ?? item.id) === (task.workTypeCode ?? card.workType?.code))?.attributes.requiresHours === true;

  const perform = async (code: string, suppliedComment?: string) => {
    setBusy(true);
    setFormError(null);
    try {
      if (code === "assign") {
        if (!engineerId) throw new Error("Выберите инженера");
        if (canReassign) await m2Api.reassignTask(task.id, engineerId);
        else await m2Api.assignTask(task.id, engineerId);
        setAssignDialogOpen(false);
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
        if (!target) throw new Error("Это действие сейчас недоступно");
        await m2Api.transitionTask(task.id, target);
      }
      // Подтверждение сразу после действия: оно уже выполнено, даже если обновление экрана не удастся.
      const engineerName = suggestions.find((item) => item.engineerId === engineerId)?.fullName;
      const done: Readonly<Record<string, string>> = {
        assign: engineerName ? `Инженер назначен: ${engineerName}` : "Инженер назначен",
        verify_closure: "Работа принята, задача закрыта",
        close: "Задача закрыта",
        cancel: "Задача отменена",
        return_for_rework: "Задача возвращена инженеру на доработку"
      };
      toast.success(done[code] ?? "Статус задачи изменён");
      try {
        await onChanged();
      } catch (refreshError) {
        toast.warning(refreshError instanceof Error ? `Действие выполнено, но экран не обновился: ${refreshError.message}` : "Действие выполнено, обновите страницу");
      }
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

  // Текущее фото акта: то, что записано в закрытии, иначе последнее загруженное.
  const latestActFile = card.files.find((file) => file.id === card.closure?.actFileId) ?? [...card.files].reverse().find((file) => file.kind === "act");
  const photoCount = card.files.filter((file) => file.kind === "photo").length;
  const videoCount = card.files.filter((file) => file.kind === "video").length;
  const mediaQuotaError = (photos: number, videos: number): string | null => {
    if (photoCount + photos > 10) return `К задаче можно приложить не больше 10 фото. Уже есть ${photoCount}, можно добавить ещё ${Math.max(0, 10 - photoCount)}.`;
    if (videoCount + videos > 2) return `К задаче можно приложить не больше 2 видео. Уже есть ${videoCount}, можно добавить ещё ${Math.max(0, 2 - videoCount)}.`;
    return null;
  };

  const saveResult = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const data = new FormData(event.currentTarget);
      const existingActId = card.closure?.actFileId ?? latestActFile?.id;
      const actFiles = data.getAll("actPhoto").filter((item): item is File => item instanceof File && item.size > 0);
      const media = data.getAll("fieldMedia").filter((item): item is File => item instanceof File && item.size > 0);
      const videos = media.filter((file) => file.type.startsWith("video/"));
      const photos = media.filter((file) => !file.type.startsWith("video/"));
      // Лимит базы: 10 фото и 2 видео на задачу. Проверяем до сохранения, чтобы не загрузить часть.
      const quotaError = mediaQuotaError(photos.length, videos.length);
      if (quotaError) throw new Error(quotaError);
      const numberField = (name: string) => String(data.get(name) ?? "").trim() === "" ? null : Number(String(data.get(name)).replace(",", "."));
      const reasonCode = String(data.get("reasonCode") ?? "") || null;
      const workModifier = (String(data.get("workModifier") ?? "") || null) as "G" | "N" | null;
      const payload = {
        callReason: String(data.get("callReason") ?? "").trim(),
        workDescription: String(data.get("workDescription") ?? "").trim(),
        recommendations: String(data.get("recommendations") ?? "").trim(),
        userRemarks: String(data.get("userRemarks") ?? "").trim(),
        workCompleted: data.get("workCompleted") === "on",
        apparatusApproved: data.get("apparatusApproved") === "on",
        customerHasNoClaims: data.get("customerHasNoClaims") === "on",
        continuedInPrimary: data.get("continuedInPrimary") === "on",
        // Отправляем только то, что поменяли: так не сотрём значение, которого нет в списке.
        ...(data.has("reasonCode") && reasonCode !== (task.reasonCode ?? card.reason?.code ?? null) ? { reasonCode } : {}),
        ...(data.has("workModifier") && workModifier !== (task.workModifier ?? null) ? { workModifier } : {}),
        ...(data.has("meterReading") && numberField("meterReading") !== (task.meterReading ?? null) ? { meterReading: numberField("meterReading") } : {}),
        ...(data.has("hours") && numberField("hours") !== (task.hours ?? null) ? { hours: numberField("hours") } : {})
      };
      // Сначала текст: если база его не примет, файлы не загрузятся зря.
      await m2Api.updateTaskResult(task.id, { ...payload, ...(existingActId ? { actFileId: existingActId } : {}) });
      try {
        if (actFiles.length) {
          const uploaded = await m2Api.uploadTaskFiles(task.id, actFiles, "act");
          const actFileId = [...uploaded].reverse().find((file) => file.kind === "act")?.id;
          if (actFileId) await m2Api.updateTaskResult(task.id, { ...payload, actFileId });
        }
        if (photos.length) await m2Api.uploadTaskFiles(task.id, photos, "photo");
        if (videos.length) await m2Api.uploadTaskFiles(task.id, videos, "video");
      } catch (uploadError) {
        // Текст уже сохранён: закрываем форму и показываем, что есть, чтобы повтор не дублировал файлы.
        setResultEditing(false);
        toast.warning(`Результат сохранён, но часть файлов не загрузилась: ${uploadError instanceof Error ? uploadError.message : "ошибка"}. Проверьте вкладку «Работа и акт» и догрузите недостающие.`);
        await onChanged();
        return;
      }
      setResultEditing(false);
      await onChanged();
    } catch (saveError) {
      const text = saveError instanceof Error ? saveError.message : "Не получилось сохранить результат";
      setFormError(text);
      toast.error(text);
    } finally {
      setBusy(false);
    }
  };

  const uploadTaskMaterials = async (event: ChangeEvent<HTMLInputElement>, kind?: "act" | "photo" | "video" | "document") => {
    const selected = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!selected.length) return;
    const kindOf = (file: File) => kind ?? (file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "photo" : "document");
    const quotaError = mediaQuotaError(selected.filter((file) => kindOf(file) === "photo").length, selected.filter((file) => kindOf(file) === "video").length);
    if (quotaError) { toast.warning(quotaError); return; }
    setBusy(true);
    try {
      const groups = new Map<"act" | "photo" | "video" | "document", File[]>();
      for (const file of selected) {
        const resolved = kind ?? (
          file.type.startsWith("video/") ? "video"
            : file.type.startsWith("image/") ? "photo"
              : "document"
        );
        const bucket = groups.get(resolved) ?? [];
        bucket.push(file);
        groups.set(resolved, bucket);
      }
      for (const [fileKind, files] of groups) {
        await m2Api.uploadTaskFiles(task.id, files, fileKind);
      }
      await onChanged();
    } catch (uploadError) {
      toast.error(uploadError instanceof Error ? uploadError.message : "Не получилось загрузить файлы");
    } finally {
      setBusy(false);
    }
  };

  // Результат правит инженер задачи (пока она в работе) или координатор с полным правом на задачи.
  const canEditResult = card.canSubmitResult === true || card.canSetWorkModifier === true;
  const canUploadFiles = card.canUploadFiles === true || canEditResult;

  const workTypeLabel = card.workType?.name ? `${card.workType.name}${task.workModifier ? ` · ${task.workModifier}` : ""}` : "—";
  const meterLabel = task.meterReading ?? card.closure?.meterReading;
  const contactDetails = [task.customer?.contactPhone, task.customer?.contactEmail].filter(Boolean).join(" · ");
  const canCancel = card.availableActions.some((action) => action.code === "cancel");
  const workflowActions = card.availableActions.filter((action) => action.code !== "assign" && action.code !== "cancel" && (task.status !== "under_review" || (action.code !== "verify_closure" && action.code !== "close" && action.code !== "return_for_rework")));
  // Править задачу целиком, видеть плательщика и договор: только координатор (tasks.write).
  // Ограничения только для инженера этой задачи; координатор и инициатор работают как раньше.
  const engineerOnly = card.isTaskEngineer === true && card.canSetWorkModifier !== true;
  const canManageTask = card.canEditOverview === true && !engineerOnly;
  // Плательщик и договор: по праву на финансы, в том числе в закрытых задачах (для счёта).
  const showFinance = card.canSeeFinance === true;
  // Инженер добавляет файлы и запчасти, когда принял задачу; координатор в любой открытой задаче.
  const canEditPartsNow = card.canEditParts === true && (!engineerOnly || task.status === "in_progress");
  const canAddFilesNow = canUploadFiles && (!engineerOnly || task.status === "in_progress");
  // Что делать дальше по задаче: одна понятная подсказка и главные кнопки над вкладками.
  const hasActPhoto = Boolean(latestActFile);
  // Результат заполняет инженер задачи; координатор может дописать его за инженера.
  const isTaskEngineer = card.canSubmitResult === true;
  const needsResult = task.status === "in_progress" && canEditResult;
  const resultFilled = Boolean(task.callReason?.trim() && task.workDescription?.trim());
  const reworkNote = task.status === "in_progress" && task.reworkComment ? task.reworkComment : undefined;
  const nextStep: { readonly title: string; readonly hint: string; readonly tone?: "warning" } | null =
    canAssign ? { title: "Назначьте инженера", hint: "Задача ждёт исполнителя. После назначения инженер получит уведомление." }
      : workflowActions.some((action) => action.code === "accept") ? (card.isTaskEngineer ? { title: "Примите задачу", hint: "Подтвердите, что берёте задачу в работу. Координатор увидит, что вы приступили." } : { title: `Задача ждёт, когда инженер${card.engineer ? ` ${card.engineer.fullName}` : ""} её примет`, hint: "Принять за инженера можно, если он подтвердил выезд по телефону." })
        : reworkNote && isTaskEngineer ? { title: "Задачу вернули на доработку", hint: `Что исправить: ${reworkNote}. Поправьте результат или фото и снова передайте на проверку.`, tone: "warning" }
          : workflowActions.some((action) => action.code === "submit_for_review") && resultFilled ? { title: "Всё заполнено, можно передать на проверку", hint: "Координатор проверит акт и фото и закроет задачу." }
            : needsResult && isTaskEngineer ? { title: "Заполните результат работ", hint: hasActPhoto ? "Опишите причину вызова и работы, отметьте пункты акта. Потом появится кнопка «Передать на проверку»." : "Опишите работы и загрузите фото подписанного акта. Потом появится кнопка «Передать на проверку»." }
              : needsResult ? { title: `Задача в работе у инженера${card.engineer ? ` ${card.engineer.fullName}` : ""}`, hint: reworkNote ? `Возвращена на доработку: ${reworkNote}` : "Инженер заполнит результат и передаст задачу на проверку. При необходимости результат можно дописать за него." }
                : workflowActions.some((action) => action.code === "activate") ? { title: "Задача запланирована", hint: "Когда подойдёт срок, отметьте её как новую, чтобы назначить инженера." }
                  : task.status === "under_review" && !canCloseReview && !canReturnReview ? { title: "Задача на проверке", hint: "Координатор проверяет акт и фото. Если нужно что-то исправить, задача вернётся с комментарием." }
                    : workflowActions.length ? { title: "Следующий шаг", hint: "Выберите действие по задаче." }
                      : null;
  // Строки печатной формы правятся из самой печатной формы (кнопка «Строки акта»).
  const actRowsDialog = (
    <Dialog description="Строки нужны только для печатной формы акта и в задаче не сохраняются. Заполните их перед печатью." footer={<Button onClick={() => setActRowsEditing(false)}>Готово</Button>} onOpenChange={setActRowsEditing} open={actRowsEditing} size="lg" title="Строки печатного акта"><section className="work-act-row-editor work-act-row-editor--dialog">
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
  );
  if (actOpen) return <><WorkAct act={buildWorkAct(card, { equipment: actEquipmentRows, works: actWorkRows })} onBack={() => setActOpen(false)} onEditRows={() => setActRowsEditing(true)} />{actRowsDialog}</>;
  return <>
    <EntityDetailToolbar actions={<Button onClick={() => setActOpen(true)} variant="secondary">Акт для печати</Button>} backLabel="К задачам" onBack={onBack} />
    <header className="task-head">
      <div className="task-head__meta">
        <span className="task-head__number">{task.number}</span>
        <StatusBadge tone={taskStatusTone(task.status)}>{card.status.name}</StatusBadge>
        {task.priority === "urgent" ? <span className="task-head__flag task-head__flag--urgent">Срочная</span> : null}
        {task.isOverdue ? <span className="task-head__flag task-head__flag--late">Срок истёк</span> : null}
      </div>
      <h1>{task.title}</h1>
      <p>{[card.workType?.name, task.customer?.siteName].filter(Boolean).join(" · ")}</p>
    </header>
    {nextStep ? <section aria-label="Следующий шаг" className={`task-next-step${nextStep.tone === "warning" ? " task-next-step--warning" : ""}`}>
      <div className="task-next-step__text"><strong>{nextStep.title}</strong><span>{nextStep.hint}</span></div>
      <div className="task-next-step__actions">
        {needsResult ? <Button onClick={() => { setFormError(null); setResultEditing(true); }} variant={workflowActions.length || !isTaskEngineer ? "secondary" : "primary"}>{!isTaskEngineer ? "Заполнить результат за инженера" : resultFilled ? "Изменить результат и фото" : "Заполнить результат и фото"}</Button> : null}
        {canAssign ? <Button disabled={busy || suggestions.length === 0} onClick={() => setAssignDialogOpen(true)}>Назначить инженера</Button> : null}
        {workflowActions.filter((action) => action.code !== "submit_for_review" || resultFilled).map((action) => <Button busy={busy} disabled={busy} key={action.code} onClick={() => void perform(action.code)}>{action.label}</Button>)}
      </div>
    </section> : null}
    {task.status === "under_review" && (canCloseReview || canReturnReview) ? <ClosureReview
      busy={busy}
      canClose={canCloseReview}
      canReturn={canReturnReview}
      card={card}
      onClose={async () => { await perform(card.availableActions.some((action) => action.code === "verify_closure") ? "verify_closure" : "close"); }}
      onOpenAct={() => setActOpen(true)}
      onReturn={async (comment) => { await perform("return_for_rework", comment); }}
    /> : null}
    <div className="task-layout">
      <div className="task-layout__main">
        {task.callReason ? <section className="task-brief" aria-label="Что случилось"><h2>Что случилось</h2><p>{task.callReason}</p></section> : null}
        <PageTabs items={[{ value: "work", label: "Работа и акт", badge: card.files.length }, { value: "parts", label: "Запчасти", badge: card.parts.length }, { value: "history", label: "История", badge: card.journal.length }]} label="Разделы карточки задачи" onValueChange={setDetailTab} value={detailTab} />
        {detailTab === "work" ? <div className="task-work">
          <section className="task-section" aria-labelledby={`task-result-${task.id}`}>
            <header className="task-section__head">
              <h3 id={`task-result-${task.id}`}>Результат работ</h3>
              {canEditResult && resultFilled ? <Button onClick={() => { setFormError(null); setResultEditing(true); }} variant="secondary">Изменить результат</Button> : null}
            </header>
            {resultFilled ? <>
              <dl className="task-doc">
                <div><dt>Что сделано</dt><dd>{task.workDescription}</dd></div>
                {task.recommendations ? <div><dt>Рекомендации</dt><dd>{task.recommendations}</dd></div> : null}
                {task.userRemarks ? <div><dt>Замечания пользователя</dt><dd>{task.userRemarks}</dd></div> : null}
                {card.reason ? <div><dt>Причина неисправности</dt><dd>{card.reason.name}</dd></div> : null}
                {task.workModifier ? <div><dt>Гарантия</dt><dd>{task.workModifier === "G" ? "Г, гарантийная работа" : "Н, неправильная эксплуатация"}</dd></div> : null}
                {task.hours !== undefined ? <div><dt>Часы работы</dt><dd>{task.hours}</dd></div> : null}
                {meterLabel !== undefined ? <div><dt>Показание счётчика</dt><dd>{meterLabel}</dd></div> : null}
              </dl>
              <ul className="task-checks" aria-label="Отметки акта">
                {([["Работы выполнены полностью", task.workCompleted ?? card.closure?.workCompleted], ["Аппарат исправен и допущен", task.apparatusApproved ?? card.closure?.apparatusApproved], ["Заказчик претензий не имеет", task.customerHasNoClaims ?? card.closure?.customerHasNoClaims], ["Продолжение первичной заявки", task.continuedInPrimary]] as const).map(([label, value]) => <li className={value ? "task-checks__on" : undefined} key={label}><span aria-hidden="true">{value ? "✓" : ""}</span>{label}{value ? null : <small>не отмечено</small>}</li>)}
              </ul>
            </> : <div className="task-section__empty">
              <p>{task.status === "in_progress" ? (isTaskEngineer ? "Опишите, что сделано, отметьте пункты акта и приложите фото подписанного акта." : "Инженер ещё не заполнил результат.") : task.status === "assigned" || task.status === "new" || task.status === "planned" ? "Результат заполняется, когда инженер примет задачу в работу." : "Результат не заполнен."}</p>
              {canEditResult && task.status === "in_progress" ? <Button onClick={() => { setFormError(null); setResultEditing(true); }} variant={isTaskEngineer ? "primary" : "secondary"}>{isTaskEngineer ? "Заполнить результат" : "Заполнить за инженера"}</Button> : null}
            </div>}
          </section>
          <section className="task-section" aria-labelledby={`task-files-${task.id}`}>
            <header className="task-section__head">
              <h3 id={`task-files-${task.id}`}>Фото и файлы</h3>
              {canAddFilesNow ? <div className="task-section__actions">
                <label className={`button button--secondary task-upload-button${busy ? " is-disabled" : ""}`}><input accept="image/jpeg,image/png,image/webp,image/heic,image/heif" disabled={busy} onChange={(event) => void uploadTaskMaterials(event, "act")} type="file" />{hasActPhoto ? "Заменить фото акта" : "Загрузить фото акта"}</label>
                <label className={`button button--primary task-upload-button${busy ? " is-disabled" : ""}`}><input accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx" disabled={busy} multiple onChange={(event) => void uploadTaskMaterials(event)} type="file" /><Icon name="plus" size={16} />{busy ? "Загружаем…" : "Добавить фото и видео"}</label>
              </div> : null}
            </header>
            <div className="task-files">
              <div className="task-files__group">
                <h4>Фото подписанного акта</h4>
                <FileGallery emptyText={task.status === "in_progress" ? "Ещё не загружено. Без него задачу нельзя передать на проверку." : "Не загружено."} files={latestActFile ? [latestActFile] : []} />
              </div>
              <div className="task-files__group">
                <h4>Фото и видео с выезда <small>{photoCount} из 10 фото, {videoCount} из 2 видео</small></h4>
                <FileGallery emptyText="Пока нет. Можно выбрать сразу несколько файлов." files={card.files.filter((file) => file.kind === "photo" || file.kind === "video")} />
              </div>
              {card.files.some((file) => file.kind !== "photo" && file.kind !== "video" && file.id !== latestActFile?.id) ? <div className="task-files__group">
                <h4>Документы, письма и прежние фото акта</h4>
                <FileGallery files={card.files.filter((file) => file.kind !== "photo" && file.kind !== "video" && file.id !== latestActFile?.id)} />
              </div> : null}
            </div>
          </section>
        </div> : null}
        {detailTab === "parts" ? <section className="task-section" aria-labelledby={`task-parts-${task.id}`}>
          <header className="task-section__head">
            <h3 id={`task-parts-${task.id}`}>Запчасти</h3>
            {canEditPartsNow ? <div className="task-section__actions">
              {card.parts.length > 0 ? <Button onClick={() => setPartsEditing(true)} variant="secondary">Изменить список</Button> : null}
              <Button icon="plus" onClick={addPartDraft}>Добавить запчасть</Button>
            </div> : null}
          </header>
          {card.parts.length > 0
            ? <div className="table-scroll"><table className="data-table task-parts-table"><thead><tr><th scope="col">Артикул</th><th scope="col">Наименование</th><th className="numeric" scope="col">Количество</th><th scope="col">Состояние</th></tr></thead><tbody>
              {card.parts.map((part) => <tr key={part.id}><td><strong>{part.articleNumber}</strong></td><td>{part.name}{part.forSale ? <small>для продажи</small> : null}</td><td className="numeric">{part.quantity}</td><td>{part.condition === "G" ? "Г, гарантийная" : part.condition === "N" ? "Н, новая" : "Б, б/у"}</td></tr>)}
            </tbody></table></div>
            : <div className="task-section__empty"><p>{canEditPartsNow ? "Запчасти не добавлены. Добавьте, если использовали детали на выезде." : "Запчасти на этой задаче не использовались."}</p></div>}
        </section> : null}
        {detailTab === "history" ? <section className="task-section" aria-label="История задачи"><TaskHistory journal={card.journal} /></section> : null}
      </div>
      <aside className="task-layout__aside" aria-label="Свойства задачи">
        <section className="task-props">
          <header className="task-props__head"><h2>Свойства</h2>{canManageTask ? <Button onClick={() => { setFormError(null); setOverviewEditing(true); }} variant="ghost">Изменить</Button> : null}</header>
          <dl>
            <div><dt>Инженер</dt><dd>{card.engineer?.fullName ?? <span className="is-empty">Не назначен</span>}{canReassign ? <button className="text-button" disabled={busy || suggestions.length === 0} onClick={() => setAssignDialogOpen(true)} type="button">Сменить</button> : canAssign ? <button className="text-button" disabled={busy || suggestions.length === 0} onClick={() => setAssignDialogOpen(true)} type="button">Назначить</button> : null}</dd></div>
            <div><dt>Срок</dt><dd>{task.periodFrom || task.periodTo ? formatTaskDateRange(task.periodFrom, task.periodTo) : <span className="is-empty">Не указан</span>}</dd></div>
            <div><dt>Срочность</dt><dd>{task.priority === "urgent" ? "Срочная" : "Плановая"}</dd></div>
            <div><dt>Вид работ</dt><dd>{workTypeLabel}</dd></div>
            {task.callDate ? <div><dt>Дата вызова</dt><dd>{formatTaskDate(task.callDate)}</dd></div> : null}
            {task.visitDate ? <div><dt>Дата выезда</dt><dd>{formatTaskDate(task.visitDate)}</dd></div> : null}
            {task.workStartedAt || task.workFinishedAt ? <div><dt>Время работ</dt><dd>{task.workStartedAt && task.workFinishedAt ? formatTaskDateRange(task.workStartedAt, task.workFinishedAt, true) : task.workStartedAt ? `с ${formatTaskDate(task.workStartedAt, true)}` : `до ${formatTaskDate(task.workFinishedAt, true)}`}</dd></div> : null}
            {task.completedAt ? <div><dt>Окончание</dt><dd>{formatTaskDate(task.completedAt, true)}</dd></div> : null}
          </dl>
          <dl>
            <div><dt>Прибор</dt><dd>{card.equipment ? <>{card.equipment.manufacturer} {card.equipment.model}<small>S/N {card.equipment.serialNumber}{card.equipment.statusName || card.equipment.status ? ` · ${card.equipment.statusName ?? card.equipment.status}` : ""}</small></> : <span className="is-empty">Не выбран</span>}</dd></div>
            <div><dt>Площадка</dt><dd>{task.customer?.siteName ?? <span className="is-empty">Не указана</span>}{task.customer?.address ? <small>{task.customer.address}</small> : null}</dd></div>
            {task.customer?.contactFullName || contactDetails ? <div><dt>Контакт</dt><dd>{task.customer?.contactFullName ?? ""}{contactDetails ? <small className="task-contact-links">{task.customer?.contactPhone ? <a href={`tel:${task.customer.contactPhone.replace(/[^\d+]/gu, "")}`}>{task.customer.contactPhone}</a> : null}{task.customer?.contactEmail ? <a href={`mailto:${task.customer.contactEmail}`}>{task.customer.contactEmail}</a> : null}</small> : null}</dd></div> : null}
            {task.initiator?.fullName || task.initiatorName ? <div><dt>Обратился</dt><dd>{task.initiator?.fullName ?? task.initiatorName}</dd></div> : null}
            {showFinance && task.customer?.payerName ? <div><dt>Плательщик</dt><dd>{task.customer.payerName}</dd></div> : null}
            {showFinance && (task.contractNumber || task.contractId) ? <div><dt>Договор</dt><dd>{task.contractNumber ?? task.contractId}</dd></div> : null}
          </dl>
          {task.primaryTaskId || task.continuationTaskId || task.isMaintenancePlan ? <dl>
            {task.primaryTaskId ? <div><dt>Первичная</dt><dd><button className="text-button" onClick={() => void onOpenRelated(task.primaryTaskId!)} type="button">{task.primaryTaskNumber ?? task.primaryTaskId}</button></dd></div> : null}
            {task.continuationTaskId ? <div><dt>Продолжение</dt><dd><button className="text-button" onClick={() => void onOpenRelated(task.continuationTaskId!)} type="button">{task.continuationTaskNumber ?? task.continuationTaskId}</button></dd></div> : null}
            {task.isMaintenancePlan ? <div><dt>План ТО</dt><dd>Создана по плану</dd></div> : null}
          </dl> : null}
          {canCancel ? <button className="task-props__cancel" disabled={busy} onClick={() => setActionDialog("cancel")} type="button">Отменить задачу</button> : null}
        </section>
      </aside>
    </div>
    <DialogForm
      busy={busy}
      description="Эти данные попадут в акт и нужны, чтобы передать задачу на проверку."
      error={formError}
      key={`result-edit-${task.id}-${resultEditing ? "open" : "closed"}`}
      onOpenChange={setResultEditing}
      onSubmit={saveResult}
      open={resultEditing}
      size="lg"
      submitLabel="Сохранить результат"
      title="Результат работ"
    >
      <label className="field-wide">Причина вызова<textarea defaultValue={task.callReason ?? ""} maxLength={2000} name="callReason" required rows={3} /></label>
      <label className="field-wide">Описание работ<textarea defaultValue={task.workDescription ?? ""} maxLength={4000} name="workDescription" required rows={4} /></label>
      <label className="field-wide">Рекомендации<textarea defaultValue={task.recommendations ?? ""} maxLength={2000} name="recommendations" rows={3} /></label>
      <label className="field-wide">Замечания пользователя<textarea defaultValue={task.userRemarks ?? ""} maxLength={2000} name="userRemarks" rows={3} /></label>
      <label>Причина неисправности<Select defaultValue={task.reasonCode ?? card.reason?.code ?? ""} name="reasonCode"><option value="">Не выбрана</option>{card.reason && !resultCatalogs.reasons.some((item) => (item.code ?? item.id) === card.reason?.code) ? <option value={card.reason.code}>{card.reason.name}</option> : null}{resultCatalogs.reasons.map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label>
      {card.canSetWorkModifier ? <label>Гарантия или неправильная эксплуатация<Select defaultValue={task.workModifier ?? ""} name="workModifier"><option value="">Обычная работа</option><option value="G">Г, гарантийная</option><option value="N">Н, неправильная эксплуатация</option></Select></label> : null}
      {task.equipmentId ? <label>Показание счётчика<input defaultValue={task.meterReading ?? ""} inputMode="decimal" min="0" name="meterReading" placeholder="Если есть на приборе" step="any" type="number" /></label> : null}
      {hoursRequired ? <label>Часы работы<input defaultValue={task.hours ?? ""} inputMode="decimal" min="0.25" name="hours" required step="0.25" type="number" /></label> : null}
      <fieldset className="field-wide result-checks"><legend>Отметки акта</legend>
      <label className="field-check"><input defaultChecked={task.workCompleted ?? card.closure?.workCompleted === true} name="workCompleted" type="checkbox" /><span>Работы выполнены полностью</span></label>
      <label className="field-check"><input defaultChecked={task.apparatusApproved ?? card.closure?.apparatusApproved === true} name="apparatusApproved" type="checkbox" /><span>Аппарат исправен и допущен</span></label>
      <label className="field-check"><input defaultChecked={task.customerHasNoClaims ?? card.closure?.customerHasNoClaims === true} name="customerHasNoClaims" type="checkbox" /><span>Заказчик претензий не имеет</span></label>
      <label className="field-check"><input defaultChecked={task.continuedInPrimary === true} name="continuedInPrimary" type="checkbox" /><span>Продолжение первичной заявки</span></label>
      </fieldset>
      <FileDropField accept="image/jpeg,image/png,image/webp,image/heic,image/heif" hint={hasActPhoto ? "Фото акта уже есть, можно заменить новым" : "Обязательно для передачи на проверку: JPEG, PNG, WebP или HEIC"} name="actPhoto" title="Фото подписанного акта" />
      <FileDropField accept="image/*,video/*" emptyTitle="Перетащите фото и видео сюда" hint={`Необязательно. Можно выбрать сразу несколько: всего до 10 фото и 2 видео на задачу (уже есть ${photoCount} фото и ${videoCount} видео).`} multiple name="fieldMedia" title="Фото и видео с выезда" />
    </DialogForm>
    {partsEditing ? <Dialog footer={<><Button disabled={busy} onClick={() => setPartsEditing(false)} variant="secondary">Отмена</Button><Button busy={busy} form="task-parts-editor-form" type="submit">Сохранить позиции</Button></>} onOpenChange={setPartsEditing} open={partsEditing} size="lg" title="Использованные запчасти"><form className="task-parts-editor" id="task-parts-editor-form" onSubmit={(event) => void saveParts(event)}><div className="task-parts-editor__head"><span>Артикул</span><span>Наименование</span><span>Количество</span><span>Г/Н/Б</span><span /></div>{partDrafts.map((part, index) => <div className="task-parts-editor__row" key={part.key}><input aria-label={`Артикул позиции ${index + 1}`} onChange={(event) => updatePartDraft(index, { articleNumber: event.target.value })} required value={part.articleNumber} /><input aria-label={`Наименование позиции ${index + 1}`} onChange={(event) => updatePartDraft(index, { name: event.target.value })} required value={part.name} /><input aria-label={`Количество позиции ${index + 1}`} inputMode="decimal" min="0.001" onChange={(event) => updatePartDraft(index, { quantity: event.target.value })} required step="0.001" type="number" value={part.quantity} /><Select aria-label={`Состояние позиции ${index + 1}`} onChange={(event) => updatePartDraft(index, { condition: event.target.value as TaskPartPosition["condition"] })} value={part.condition}><option value="G">Г · гарантийная</option><option value="N">Н · новая</option><option value="B">Б · б/у</option></Select><button aria-label={`Удалить позицию ${index + 1}`} className="task-parts-editor__remove" onClick={() => setPartDrafts((current) => current.filter((_, partIndex) => partIndex !== index))} type="button">×</button></div>)}{partDrafts.length === 0 ? <p className="muted">Добавьте хотя бы одну позицию или сохраните пустой список.</p> : null}<button className="task-parts-add" onClick={addPartDraft} type="button">+ Добавить позицию</button></form></Dialog> : null}
    <DialogForm busy={busy} description="Изменятся название, вид работ, срочность и даты заявки." error={formError} key={`overview-edit-${task.id}-${overviewEditing ? "open" : "closed"}`} onOpenChange={setOverviewEditing} onSubmit={saveOverview} open={overviewEditing} size="lg" submitLabel="Сохранить изменения" title="Основные параметры задачи"><label className="field-wide">Название<input defaultValue={task.title} maxLength={200} name="title" required /></label><label>Вид работ<Select defaultValue={task.workTypeCode ?? card.workType?.code ?? ""} name="workTypeCode" required>{workTypes.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label><label className="task-priority-check"><input defaultChecked={task.priority === "urgent"} name="urgent" type="checkbox" value="on" /><span className="task-priority-check__text"><strong>Срочная</strong><small>Реакция до 24 ч · иначе плановая</small></span></label><div className="dialog-form-row-3"><label>Дата вызова<DatePicker defaultValue={task.callDate?.slice(0, 10)} name="callDate" required /></label><label>Период с<DatePicker defaultValue={task.periodFrom?.slice(0, 10)} name="periodFrom" required /></label><label>Период по<DatePicker defaultValue={task.periodTo?.slice(0, 10)} name="periodTo" required /></label></div><label>Дата выезда<DatePicker defaultValue={task.visitDate?.slice(0, 10)} name="visitDate" /></label></DialogForm>
    <DialogForm busy={busy} danger={actionDialog === "cancel"} description={actionDialog === "cancel" ? "Задача будет отменена. Укажите причину — она попадёт в журнал." : "Заявка вернётся инженеру. Напишите, что нужно доработать."} onOpenChange={(open) => { if (!open) setActionDialog(null); }} onSubmit={async (event) => { event.preventDefault(); const comment = String(new FormData(event.currentTarget).get("comment") ?? ""); if (actionDialog && await perform(actionDialog, comment)) setActionDialog(null); }} open={actionDialog !== null} submitLabel={actionDialog === "cancel" ? "Отменить задачу" : "Вернуть инженеру"} title={actionDialog === "cancel" ? "Отмена задачи" : "Возврат на доработку"}><label className="field-wide">{actionDialog === "cancel" ? "Причина отмены" : "Что нужно доработать"}<textarea autoFocus maxLength={1000} name="comment" required rows={4} /></label></DialogForm>
    <Dialog
      busy={busy}
      description="Выберите инженера для назначения на задачу."
      footer={<>
        <Button disabled={busy} onClick={() => setAssignDialogOpen(false)} variant="secondary">Отмена</Button>
        <Button busy={busy} disabled={!engineerId} onClick={() => void perform("assign")}>Назначить</Button>
      </>}
      onOpenChange={setAssignDialogOpen}
      open={assignDialogOpen}
      title={canReassign ? "Смена инженера" : "Выбор инженера"}
    >
      {suggestions.length === 0 ? (
        <p className="form-hint">Инженеров пока нет. Добавьте их в разделе «Инженеры».</p>
      ) : (
        <div className="engineer-picker" role="listbox" aria-label="Инженеры">
          {suggestions.map((item) => {
            const selected = item.engineerId === engineerId;
            const hints = [
              item.previouslyWorkedWithEquipment ? "опыт с прибором" : null,
              item.isAvailable ? "свободен" : "занят"
            ].filter(Boolean).join(" · ");
            return (
              <button
                aria-selected={selected}
                className={`engineer-picker__option${selected ? " is-selected" : ""}`}
                key={item.engineerId}
                onClick={() => setEngineerId(item.engineerId)}
                role="option"
                type="button"
              >
                <strong>{item.fullName}</strong>
                <span>{hints}</span>
              </button>
            );
          })}
        </div>
      )}
    </Dialog>
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

function mailRecognized(mail: MailInboxRecord): string {
  return [mail.client, mail.equipmentLabel ?? mail.equipmentName].filter(Boolean).join(" · ");
}

/** Комментарий задачи из письма: суть и контакт для обратной связи. */
function mailCommentDraft(mail: MailInboxRecord): string {
  const contact = [mail.contactName, mail.contactPhone].filter(Boolean).join(", ");
  return [
    mail.description,
    mail.client ? `Клиент: ${mail.client}` : undefined,
    contact ? `Контакт: ${contact}` : undefined,
    mail.equipmentSerial && !mail.equipmentFound ? `S/N из письма: ${mail.equipmentSerial} (нет в базе)` : undefined,
    `Из письма ${mail.sender}`
  ].filter(Boolean).join("\n").slice(0, 2000);
}

/** Текст письма и что из него распознано: рядом с формой, чтобы сверить. */
function MailSourcePanel({ mail }: { readonly mail: MailInboxRecord }) {
  const facts: Array<[string, string | undefined]> = [
    ["Отправитель", mail.sender],
    ["Клиент", mail.client],
    ["Контакт", [mail.contactName, mail.contactPhone].filter(Boolean).join(", ") || undefined],
    ["Оборудование", mail.equipmentName],
    ["S/N", mail.equipmentSerial ? `${mail.equipmentSerial}${mail.equipmentFound ? " (прибор найден)" : " (такого прибора нет в базе)"}` : undefined]
  ];
  const files = mail.attachments?.length ?? 0;
  return <section className="mail-source field-wide" aria-label="Письмо клиента">
    {mail.lowConfidence || mail.status === "failed" ? <p className="mail-source__warning" role="status">Письмо распознано неуверенно: поля оставлены пустыми, заполните их по тексту письма.</p> : null}
    <dl className="mail-source__facts">{facts.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <details open={Boolean(mail.lowConfidence) || mail.status === "failed"}>
      <summary>Текст письма{files ? ` · вложений: ${files} (перейдут в задачу)` : ""}</summary>
      <pre className="mail-source__body">{mail.body || "Текст письма пустой"}</pre>
    </details>
  </section>;
}

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
    <FilterBar loading={loading} onReset={() => { const reset = { search: "", status: "" }; setFilters(reset); setPageIndex(0); void reload(reset, 0); }} onSubmit={apply}><label className="filter-field--search">Поиск<input onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Отправитель или тема" type="search" value={filters.search} /></label><label>Статус<Select onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))} value={filters.status}><option value="">Все</option>{Object.entries(mailStatusLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</Select></label></FilterBar>
    <DataTableShell meta={`${items.length} из ${total}`} title="Входящие письма">{loading && items.length === 0 ? <ResourceState description="Подождите, входящие сейчас появятся." status="loading" title="Загружаем письма" /> : items.length === 0 ? <ResourceState description={filters.search || filters.status ? "Измените поиск или сбросьте фильтры." : "Новые письма с заявками появятся здесь. Можно создать задачу вручную."} status={filters.search || filters.status ? "filtered-empty" : "empty"} title={filters.search || filters.status ? "Писем по этим условиям нет" : "Входящих писем нет"} /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Получено</th><th>Отправитель</th><th>Тема</th><th>Что распознано</th><th>Статус</th><th><span className="sr-only">Действия</span></th></tr></thead><tbody>{items.map((mail) => <tr key={mail.id}><td>{formatTaskDate(mail.receivedAt, true)}</td><td>{mail.sender}</td><td><strong>{mail.subject || "Без темы"}</strong></td><td><div className="mail-recognized">{mailRecognized(mail) ? <strong>{mailRecognized(mail)}</strong> : null}{mail.equipmentSerial ? <span>S/N {mail.equipmentSerial} <StatusBadge tone={mail.equipmentFound ? "success" : "warning"}>{mail.equipmentFound ? "прибор найден" : "нет в базе"}</StatusBadge></span> : null}<span className="mail-recognized__summary">{mail.description ?? mail.summary ?? (mail.status === "pending" ? "Письмо ещё разбирается" : "—")}</span>{mail.confidence !== undefined && mail.status !== "pending" ? <small className="mail-confidence">уверенность {Math.round(mail.confidence * 100)}%</small> : null}</div></td><td><StatusBadge tone={statusTone(mail.status)}>{mailStatusLabels[mail.status]}</StatusBadge>{mail.status === "converted" ? <small className="mail-autoreply">{mail.autoreplyError ? `Автоответ не ушёл: ${mail.autoreplyError}` : mail.autoreplySent ? "Автоответ отправлен" : "Автоответ в очереди"}</small> : null}</td><td><div className="table-actions">{mail.taskId ? <IconButton icon="open" label="Открыть задачу" onClick={() => onOpenTask(mail.taskId!)} /> : mail.status !== "ignored" ? <><IconButton icon="plus" label="Создать задачу" onClick={() => onCreateTask(mail)} variant="secondary" /><IconButton icon="ignore" label="Не требует работы" onClick={() => setIgnoreTarget(mail)} /></> : <IconButton icon="restore" label="Вернуть в работу" onClick={() => void m2Api.updateMailInbox(mail.id, { status: mail.wasParsed ? "parsed" : "pending" }).then(() => reload())} />}</div></td></tr>)}</tbody></table></div>}<RegistryPagination ariaLabel="Страницы входящих писем" onPageChange={(next) => { setPageIndex(next); void reload(filters, next); }} pageIndex={pageIndex} pageSize={pageSize} total={total} /></DataTableShell>
    <ConfirmationDialog confirmLabel="Не требует работы" description={ignoreTarget ? <>Письмо «{ignoreTarget.subject || "Без темы"}» останется в журнале. Его можно будет вернуть в работу.</> : null} onConfirm={async () => { if (!ignoreTarget) return; await m2Api.updateMailInbox(ignoreTarget.id, { status: "ignored" }); await reload(); }} onOpenChange={(open) => { if (!open) setIgnoreTarget(null); }} open={Boolean(ignoreTarget)} title="Письмо не требует работы?" />
  </>;
}

/** Экран на время загрузки карточки: сразу видно, какая задача открывается. */
function TaskCardLoading({ task, onBack }: { readonly task?: { readonly number?: string; readonly title?: string }; readonly onBack: () => void }) {
  // Тот же каркас, что у открытой карточки: при загрузке ничего не перескакивает.
  return <div aria-busy="true" className="task-card-loading" role="status">
    <EntityDetailToolbar backLabel="К списку задач" onBack={onBack} />
    <EntityDetailHeader description={task?.number ?? ""} title={task?.title ?? "Открываем задачу…"} />
    <span className="sr-only">Открываем задачу</span>
    <div className="task-card-loading__bar"><Skeleton className="skeleton-line skeleton-line--w60" /><Skeleton className="skeleton-line skeleton-line--w30" /></div>
    <div className="task-card-loading__grid">{[0, 1, 2, 3, 4, 5].map((item) => <Skeleton className="task-card-loading__tile" key={item} />)}</div>
  </div>;
}

function CoordinatorTasks({ initialTaskId, onTaskRouteChange }: {
  readonly initialTaskId: string | undefined;
  readonly onTaskRouteChange: (taskId?: string, replace?: boolean) => void;
}) {
  // 25 задач на страницу списка: быстро грузится даже через медленную связь.
  const pageSize = 25;
  const [tasks, setTasks] = useState<readonly TaskApiRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [equipment, setEquipment] = useState<readonly EquipmentApiRecord[]>([]);
  const [sites, setSites] = useState<readonly SiteOption[]>([]);
  const [siteNames, setSiteNames] = useState<readonly { readonly id: string; readonly name: string }[]>([]);
  const [formDataState, setFormDataState] = useState<"idle" | "loading" | "ready">("idle");
  const formDataPromise = useRef<Promise<void> | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const [boardRefresh, setBoardRefresh] = useState(0);
  const [workTypes, setWorkTypes] = useState<readonly ReferenceCatalogValue[]>([]);
  const [taskStatuses, setTaskStatuses] = useState<readonly ReferenceCatalogValue[]>([]);
  const [engineers, setEngineers] = useState<readonly { readonly id: string; readonly fullName: string }[]>([]);
  const [registryView, setRegistryView] = useState<"board" | "list" | "mail">("board");
  const [showCompletedBoard, setShowCompletedBoard] = useState(false);
  const [loading, setLoading] = useState(false);
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
  const [mailEquipment, setMailEquipment] = useState<EquipmentApiRecord | undefined>(undefined);
  const [mailRefresh, setMailRefresh] = useState(0);
  const [canAssignEngineer, setCanAssignEngineer] = useState(false);
  useEffect(() => { void m2Api.hasPermission("tasks.assign").then(setCanAssignEngineer).catch(() => setCanAssignEngineer(false)); }, []);
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
      // И при ошибке: вместо бесконечного индикатора — пустой список и сообщение об ошибке.
      setListLoaded(true);
      setLoading(false);
    }
  };
  // Полные справочники приборов и площадок нужны только форме создания задачи:
  // грузим их при её открытии, а не при каждом заходе в «Задачи».
  const ensureFormData = (): Promise<void> => {
    if (formDataPromise.current) return formDataPromise.current;
    setFormDataState("loading");
    // Приборы форма грузит сама, когда открываешь выбор прибора; здесь нужны только площадки с контактами.
    const promise = m2Api.listSites()
      .then((loadedSites) => { setSites(loadedSites); setFormDataState("ready"); })
      .catch((loadError: unknown) => { formDataPromise.current = null; setFormDataState("idle"); throw loadError; });
    formDataPromise.current = promise;
    return promise;
  };
  const openCreationForm = async () => {
    try { await ensureFormData(); setFormOpen(true); }
    catch (loadError) { setMailDraft(null); toast.error(loadError instanceof Error ? loadError.message : "Не получилось открыть форму создания задачи"); }
  };
  // После изменений обновляем то, что на экране: колонки доски и (если открыт) список.
  const refreshTasks = async () => {
    setBoardRefresh((value) => value + 1);
    if (registryView === "list" || listLoaded) await reloadTasks();
  };
  const applyFilters = async (nextFilters = filters) => {
    setFilters(nextFilters); setAppliedFilters(nextFilters); setSelectedTaskIds(new Set()); setPageIndex(0);
    // На доске колонки перезагрузятся сами по новым фильтрам; список — только если он открыт.
    if (registryView !== "list") { setListLoaded(false); return; }
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
  const openRequest = useRef(0);
  const openInFlight = useRef<{ readonly id: string; readonly promise: Promise<void> } | null>(null);
  const openTask = (id: string, updateRoute = true): Promise<void> => {
    // Повторный клик по той же задаче, пока она грузится, не запускает вторую загрузку.
    // Обновление после действия (updateRoute = false) всегда грузит заново.
    if (updateRoute && openInFlight.current?.id === id) return openInFlight.current.promise;
    const promise = loadTaskCard(id, updateRoute).finally(() => {
      if (openInFlight.current?.promise === promise) openInFlight.current = null;
    });
    openInFlight.current = { id, promise };
    return promise;
  };
  const loadTaskCard = async (id: string, updateRoute: boolean) => {
    // Сразу показываем, что задача открывается, а не ждём молча всю карточку.
    const request = ++openRequest.current;
    const previous = taskCard;
    setSelectedTaskId(id);
    if (previous?.task.id !== id) setTaskCard(null);
    if (updateRoute) onTaskRouteChange(id);
    try {
      const loaded = await m2Api.taskCard(id);
      if (request === openRequest.current) setTaskCard(loaded);
    } catch (loadError) {
      // Ответ устарел (пользователь уже открыл другое): ничего не трогаем.
      if (request !== openRequest.current) return;
      if (previous) {
        // Не удалось обновить или открыть связанную: остаёмся на текущей карточке.
        setSelectedTaskId(previous.task.id);
        setTaskCard(previous);
        if (updateRoute) onTaskRouteChange(previous.task.id, true);
      } else {
        setSelectedTaskId(null);
        setTaskCard(null);
        if (updateRoute) onTaskRouteChange(undefined, true);
      }
      throw loadError;
    }
  };
  const closeTask = () => { openRequest.current += 1; openInFlight.current = null; setSelectedTaskId(null); setTaskCard(null); onTaskRouteChange(); };
  // Ушли со страницы задач: незавершённые загрузки больше ничего не меняют.
  useEffect(() => () => { openRequest.current += 1; }, []);
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
      offset,
      withAttention: false
    });
    return { items: page.items, total: page.total };
  };
  useEffect(() => {
    // Доске нужны только статусы; справочники для фильтров лёгкие. Задачи колонки грузят сами.
    let reported = false;
    const report = (loadError: unknown) => {
      if (reported) return;
      reported = true;
      toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить задачи");
    };
    void m2Api.listCatalogValues("task-statuses").then(setTaskStatuses).catch(report);
    void m2Api.listCatalogValues("work-types").then(setWorkTypes).catch(report);
    void m2Api.listTaskEngineers().then(setEngineers).catch(report);
    void m2Api.listSiteNames().then(setSiteNames).catch(report);
  }, []);
  useEffect(() => {
    // Список задач грузим только когда открыта вкладка «Список».
    if (registryView !== "list" || listLoaded) return;
    void reloadTasks().catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить список задач"));
  }, [registryView]);
  useEffect(() => {
    // Задача уже открыта или открывается по клику: повторно не загружаем.
    if (initialTaskId && initialTaskId === selectedTaskId) return;
    if (!initialTaskId) {
      openRequest.current += 1;
      openInFlight.current = null;
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
  if (selectedTaskId && !taskCard) return <TaskCardLoading onBack={closeTask} task={tasks.find((item) => item.id === selectedTaskId)} />;
  if (selectedTaskId && taskCard) return <TaskCard card={taskCard} onBack={closeTask} onChanged={async () => { await Promise.all([refreshTasks(), openTask(selectedTaskId, false)]); }} onOpenRelated={async (id) => { await openTask(id); }} workTypes={workTypes} />;
  return (
    <>
      <PageIntro
        actions={<Button disabled={formDataState === "loading"} icon="plus" onClick={() => void openCreationForm()}>{formDataState === "loading" ? "Открываем форму…" : "Создать задачу"}</Button>}
        title="Задачи"
        titleAside={<>
          <ViewSwitch items={[{ value: "board", label: "Доска" }, { value: "list", label: "Список" }, { value: "mail", label: "Письма" }]} label="Как показать задачи" onValueChange={(value) => { setRegistryView(value); setSelectedTaskIds(new Set()); setShowCompletedBoard(false); }} value={registryView} />
          {registryView === "board" ? <button aria-pressed={showCompletedBoard} className={`toggle-chip${showCompletedBoard ? " toggle-chip--on" : ""}`} onClick={() => setShowCompletedBoard((current) => !current)} type="button">Закрытые и отменённые</button> : null}
        </>}
      />

      <TaskCreationForm canAssignEngineer={canAssignEngineer} engineers={engineers} equipment={equipment} sites={sites} {...(mailDraft?.subject ? { initialTitle: mailDraft.subject.replace(/^(?:(?:re|fwd?|ответ|пересл)\s*:\s*)+/iu, "").slice(0, 200) } : {})} {...(mailDraft?.workTypeCode ? { initialWorkTypeCode: mailDraft.workTypeCode } : {})} {...(mailDraft && !mailDraft.lowConfidence && mailDraft.status !== "failed" ? { initialComment: mailCommentDraft(mailDraft) } : {})} {...(mailEquipment ? { initialEquipment: mailEquipment } : {})} {...(mailDraft ? { mail: mailDraft } : {})} key={mailDraft?.id ?? "manual-task"} onEquipmentAttached={(device) => setEquipment((current) => current.some((item) => item.id === device.id) ? current : [...current, device])} onOpenChange={(open) => { setFormOpen(open); if (!open) { setMailDraft(null); setMailEquipment(undefined); } }} onCreated={async (task) => {
        const draft = mailDraft;
        // Задача уже создана: форму закрываем сразу, чтобы повторное нажатие не создало вторую.
        setFormOpen(false); setMailDraft(null); setMailEquipment(undefined);
        if (draft) {
          try {
            // Сначала отметка «создана задача»: если письмо уже взял другой координатор, файлы не копируем.
            // После отметки служба отправит клиенту автоответ.
            await m2Api.updateMailInbox(draft.id, { status: "converted", taskId: task.id });
            const failedFiles = await m2Api.attachMailToTask(draft, task.id).catch(() => (draft.attachments?.length ?? 0) + (draft.rawStorageKey ? 1 : 0));
            if (failedFiles > 0) toast.warning(`Не получилось приложить к задаче файлов из письма: ${failedFiles}. Их можно загрузить вручную.`);
            toast.success(`Задача ${task.number} создана из письма. Клиенту уйдёт автоответ с номером заявки.`);
          } catch (mailError) {
            toast.error(mailError instanceof Error ? mailError.message : "Задача создана, но письмо не отмечено", { title: "Задача создана, письмо не отмечено" });
          }
          setMailRefresh((value) => value + 1);
        }
        await refreshTasks(); await openTask(task.id);
      }} open={formOpen} workTypes={workTypes} />

      {registryView !== "mail" ? <FilterBar loading={loading} onReset={() => void applyFilters(EMPTY_TASK_FILTERS)} onSubmit={() => applyFilters()}><label className="filter-field--search">Поиск<input onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Номер или название" type="search" value={filters.search} /></label><label>Статус<Select onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value, overdue: false }))} value={filters.status}><option value="">Все</option>{taskStatuses.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label><label>Инженер<Select onChange={(event) => setFilters((current) => ({ ...current, engineerId: event.target.value }))} value={filters.engineerId}><option value="">Все</option>{engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.fullName}</option>)}</Select></label><label>Площадка<Select onChange={(event) => setFilters((current) => ({ ...current, siteId: event.target.value }))} value={filters.siteId}><option value="">Все</option>{siteNames.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</Select></label><label>Вид работ<Select onChange={(event) => setFilters((current) => ({ ...current, workTypeCode: event.target.value }))} value={filters.workTypeCode}><option value="">Все</option>{workTypes.map((item) => <option key={item.id} value={item.code ?? item.id}>{item.name}</option>)}</Select></label><label>Срочность<Select onChange={(event) => setFilters((current) => ({ ...current, priority: event.target.value }))} value={filters.priority}><option value="">Все</option><option value="urgent">Срочные</option><option value="planned">Плановые</option></Select></label><label>Период с<DatePicker onChange={(periodFrom) => setFilters((current) => ({ ...current, periodFrom }))} value={filters.periodFrom} /></label><label>Период по<DatePicker onChange={(periodTo) => setFilters((current) => ({ ...current, periodTo }))} value={filters.periodTo} /></label><label>Сортировка<Select onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value as TaskRegistryFilters["sort"] }))} value={filters.sort}><option value="updated_desc">Сначала обновлённые</option><option value="updated_asc">Сначала давно обновлённые</option><option value="deadline_asc">По сроку ↑</option><option value="deadline_desc">По сроку ↓</option></Select></label></FilterBar> : null}

      {registryView === "list" && selectedTaskIds.size > 0 ? <section className="card task-bulk-actions"><CardHeader meta={`Выбрано: ${selectedTaskIds.size}`} title="Действия с выбранными задачами" /><div className="task-bulk-actions__grid"><label>Инженер<Select aria-label="Инженер для выбранных задач" onChange={(event) => setBulkEngineerId(event.target.value)} value={bulkEngineerId}><option value="">Выберите инженера</option>{engineers.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.fullName}</option>)}</Select></label><Button busy={bulkBusy} busyLabel="Назначаем…" disabled={!bulkEngineerId} onClick={() => void bulkAssign()}>Назначить инженера</Button><label>Период с<DatePicker onChange={setBulkPeriodFrom} value={bulkPeriodFrom} /></label><label>Период по<DatePicker onChange={setBulkPeriodTo} value={bulkPeriodTo} /></label><Button busy={bulkBusy} busyLabel="Сохраняем…" disabled={!bulkPeriodFrom || !bulkPeriodTo} onClick={() => void bulkChangePeriod()} variant="secondary">Сменить срок</Button></div></section> : null}

      {registryView === "board" ? <TaskBoard engineers={engineers} equipment={equipment} loadColumn={loadBoardColumn} onMove={async (id, status) => { try { await m2Api.transitionTask(id, status); } catch (moveError) { const message = moveError instanceof Error ? moveError.message : "Не получилось изменить статус"; toast.error(message); throw moveError; } }} onOpen={(id) => void openTask(id).catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось открыть задачу"))} queryKey={`${JSON.stringify(appliedFilters)}#${boardRefresh}`} showCompleted={showCompletedBoard} statuses={taskStatuses} tasks={tasks} visibleStatus={appliedFilters.status} /> : registryView === "list" ? <div className="workspace-grid workspace-grid--tasks workspace-grid--single">
        <section className="card card--table" aria-labelledby="tasks-table-title">
          <CardHeader headingId="tasks-table-title" meta={`${tasks.length} из ${total}`} title="Все задачи" />
          {(loading || !listLoaded) && tasks.length === 0
            ? <ResourceState description="Подождите, список сейчас появится." status="loading" title="Загружаем задачи" />
            : <TaskTable engineers={engineers} equipment={equipment} filtered={Boolean(appliedFilters.search || appliedFilters.status || appliedFilters.engineerId || appliedFilters.siteId || appliedFilters.workTypeCode || appliedFilters.priority || appliedFilters.periodFrom || appliedFilters.periodTo || appliedFilters.overdue)} onOpen={(id) => void openTask(id).catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось открыть задачу"))} onToggle={toggleTask} onToggleAll={(selected) => setSelectedTaskIds((current) => { const next = new Set(current); for (const task of tasks) { if (selected) next.add(task.id); else next.delete(task.id); } return next; })} selectedTaskIds={selectedTaskIds} tasks={tasks} />}
          <RegistryPagination ariaLabel="Страницы списка задач" onPageChange={(next) => void changePage(next)} pageIndex={pageIndex} pageSize={pageSize} total={total} />
        </section>

      </div> : <MailInboxTab key={mailRefresh} onCreateTask={(mail) => void (async () => {
        // Прибор по S/N из письма подставляем в форму; если не нашёлся, координатор выберет сам.
        const device = await m2Api.mailEquipment(mail).catch(() => undefined);
        setMailEquipment(device);
        setMailDraft(mail);
        await openCreationForm();
      })()} onOpenTask={(taskId) => void openTask(taskId)} />}
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
  /** Файлы со ссылками: превью и открытие из паспорта. */
  readonly fileRecords: readonly EquipmentFileResponse[];
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
    fileRecords: card?.files ?? [],
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
  const [manufacturerId, setManufacturerId] = useState(record?.manufacturerId ?? "");
  const [modelId, setModelId] = useState(record?.modelId ?? "");
  const [selectedFiles, setSelectedFiles] = useState<readonly File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const availableModels = references.models.filter((item) => item.manufacturerId === manufacturerId);

  useEffect(() => {
    if (!open) return;
    if (record) {
      setManufacturerId(record.manufacturerId ?? "");
      setModelId(record.modelId ?? "");
      setSelectedFiles([]);
      setError(null);
      return;
    }
    const nextManufacturerId = references.manufacturers[0]?.id ?? "";
    const nextModelId = references.models.find((item) => item.manufacturerId === nextManufacturerId)?.id ?? "";
    setManufacturerId(nextManufacturerId);
    setModelId(nextModelId);
    setSelectedFiles([]);
    setError(null);
  }, [open, record, references]);

  useEffect(() => {
    if (!manufacturerId || record) return;
    if (availableModels.some((item) => item.id === modelId)) return;
    setModelId(availableModels[0]?.id ?? "");
  }, [availableModels, manufacturerId, modelId, record]);

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
        fileRecords: record?.fileRecords ?? [],
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
      {events.length > 0 ? <div className="history-feed">{events.map((event) => {
        const previous = event.previousValue?.name?.trim();
        const next = event.newValue?.name?.trim();
        const hasTransition = Boolean(previous || next);
        return <article className="history-feed__item" key={event.id}>
          <div aria-hidden="true" className="history-feed__rail"><span className="history-feed__dot" /></div>
          <div className="history-feed__body">
            <time dateTime={event.occurredAt}>{formatEquipmentAssignmentDate(event.occurredAt)}</time>
            <strong className="history-feed__actor">{event.author?.name ?? "Система"}</strong>
            {hasTransition ? <div className="history-feed__status"><span className="history-feed__chip history-feed__chip--muted">{previous || "—"}</span><span aria-hidden="true" className="history-feed__arrow">→</span><span className="history-feed__chip">{next || "не указано"}</span></div> : <p className="history-feed__text">{formatEquipmentAssignmentChange(event)}</p>}
            {event.comment || event.description ? <p className="history-feed__note">{event.comment || event.description}</p> : null}
          </div>
        </article>;
      })}</div> : <div className="task-empty"><Icon name="clock" size={22} /><p>{empty}</p></div>}
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
  const [detailTab, setDetailTab] = useState<"history" | "meters" | "files" | "movements">("history");
  const [openTasks, setOpenTasks] = useState<readonly TaskApiRecord[] | null>(null);
  const siteChanges = record.history.filter((event) => event.eventType === "site_change");
  const payerChanges = record.history.filter((event) => event.eventType === "payer_change");
  const placeUnset = record.place === "Не указана";
  const payerUnset = record.payer === "Не указан";
  const organizationUnset = record.organization === "Не указана";
  useEffect(() => {
    // Открытые задачи по прибору: главное, что нужно знать о нём сейчас.
    let active = true;
    setOpenTasks(null);
    void m2Api.tasksPage({ equipmentId: record.id, limit: 20, sort: "updated_desc" })
      .then((page) => { if (active) setOpenTasks(page.items.filter((task) => task.status !== "closed" && task.status !== "cancelled")); })
      .catch(() => { if (active) setOpenTasks([]); });
    return () => { active = false; };
  }, [record.id]);
  const openTask = (id: string) => {
    // Переход в раздел задач с открытой карточкой: тот же путь, что у ссылки из письма.
    window.history.pushState(null, "", taskPathname(id));
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const apply = async (change: NewEquipmentAssignmentChange) => {
    await onApply(change);
    setChangeKind(null);
  };
  return (
    <div className="equipment-card-view">
      <EntityDetailToolbar backLabel="К приборам" onBack={onBack} />
      <header className="task-head">
        <div className="task-head__meta">
          <span className="task-head__number">S/N {record.serial}</span>
          <StatusBadge tone={record.tone}>{record.status}</StatusBadge>
        </div>
        <h1>{record.manufacturer} {record.model}</h1>
        <p>{[placeUnset ? null : record.place, record.guarantee === "Не указана" ? null : record.guarantee].filter(Boolean).join(" · ")}</p>
      </header>
      <div className="task-layout">
        <div className="task-layout__main">
          <section className="task-section" aria-labelledby={`equipment-open-tasks-${record.id}`}>
            <header className="task-section__head"><h3 id={`equipment-open-tasks-${record.id}`}>Открытые задачи</h3></header>
            {openTasks === null
              ? <div className="skeleton-row"><Skeleton className="skeleton-row__a" /><Skeleton className="skeleton-row__b" /><Skeleton className="skeleton-row__c" /></div>
              : openTasks.length > 0
                ? <ul className="equipment-tasks">{openTasks.map((task) => <li key={task.id}><button className="equipment-tasks__item" onClick={() => openTask(task.id)} type="button">
                    <span className="equipment-tasks__number">{task.number}</span>
                    <strong>{task.title}</strong>
                    <StatusBadge tone={TASK_STATUS_TONES[task.status] ?? "warning"}>{TASK_STATUS_LABELS[task.status] ?? task.status}</StatusBadge>
                    <small>{task.engineerName ?? "Инженер не назначен"}{task.periodTo ? ` · до ${formatTaskDate(task.periodTo)}` : ""}{task.isOverdue ? " · просрочена" : ""}</small>
                  </button></li>)}</ul>
                : <div className="task-section__empty"><p>Открытых задач по прибору нет.</p></div>}
          </section>
          <PageTabs items={[
            { value: "history", label: "История", badge: record.historyTotal },
            { value: "meters", label: "Счётчик", badge: record.meterReadingsTotal },
            { value: "files", label: "Файлы", badge: record.fileRecords.length },
            { value: "movements", label: "Перемещения", badge: siteChanges.length + payerChanges.length }
          ]} label="Разделы карточки прибора" onValueChange={setDetailTab} value={detailTab} />
          {detailTab === "history" ? <section className="task-section equipment-history" aria-labelledby="equipment-history-title">
            <header className="task-section__head">
              <h3 id="equipment-history-title">История прибора</h3>
              {!readOnly ? <Button icon="plus" onClick={() => setManualOpen(true)} variant="secondary">Добавить прошлое событие</Button> : null}
            </header>
            {record.history.length > 0 ? <ol className="equipment-history-list">{record.history.map((event) => <li className="task-history__item" key={event.id}>
              <span aria-hidden="true" className={`task-history__dot task-history__dot--${event.eventType === "task" ? "success" : event.eventType === "part_replacement" ? "warning" : "info"}`} />
              <div className="task-history__body">
                <div className="task-history__line">
                  <span className={`equipment-history__kind equipment-history__kind--${event.eventType}`}>{equipmentHistoryEventLabel(event.eventType)}</span>
                  <strong>{event.summary}</strong>
                  <time dateTime={event.occurredAt}>{formatEquipmentAssignmentDate(event.occurredAt)}</time>
                </div>
                <span className="task-history__actor">{[event.author?.name ?? "Система", event.client].filter(Boolean).join(" · ")}</span>
                {event.description ? <p className="task-history__comment">{equipmentHistoryDescription(event)}</p> : null}
                {event.attachment ? <span className="task-history__actor">Файл: {event.attachment.name}</span> : null}
              </div>
            </li>)}</ol> : <div className="task-section__empty"><p>Истории пока нет. Закрытые задачи, перемещения и прошлые события появятся здесь.</p></div>}
            {record.history.length < record.historyTotal ? <Button className="equipment-load-more" onClick={() => void onLoadMoreHistory()} variant="secondary">Показать ещё события</Button> : null}
          </section> : null}
          {detailTab === "meters" ? <section className="task-section" aria-labelledby={`equipment-meters-${record.id}`}>
            <header className="task-section__head"><h3 id={`equipment-meters-${record.id}`}>Показания счётчика</h3><span className="muted">{record.meterReadings.length} из {record.meterReadingsTotal}</span></header>
            {record.meterReadings.length > 0 ? <div className="table-scroll"><table className="data-table equipment-meters-table"><thead><tr><th scope="col">Дата</th><th className="numeric" scope="col">Показание</th><th className="numeric" scope="col">Прирост</th><th scope="col">Кто записал</th></tr></thead><tbody>
              {record.meterReadings.map((reading, index) => {
                const previous = record.meterReadings[index + 1];
                const delta = previous ? reading.reading - previous.reading : undefined;
                return <tr key={reading.id}><td>{formatEquipmentAssignmentDate(reading.measuredAt)}</td><td className="numeric"><strong>{reading.reading.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}</strong></td><td className="numeric">{delta === undefined ? "—" : `+${delta.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}`}</td><td>{reading.author.name}</td></tr>;
              })}
            </tbody></table></div> : <div className="task-section__empty"><p>Показаний пока нет. Они появятся после принятого закрытия задачи.</p></div>}
            {record.meterReadings.length < record.meterReadingsTotal ? <Button className="equipment-load-more" onClick={() => void onLoadMoreMeterReadings()} variant="secondary">Показать ещё показания</Button> : null}
          </section> : null}
          {detailTab === "files" ? <section className="task-section" aria-labelledby={`equipment-files-${record.id}`}>
            <header className="task-section__head"><h3 id={`equipment-files-${record.id}`}>Файлы прибора</h3></header>
            <FileGallery emptyText={readOnly ? "К прибору пока не прикреплены файлы." : "К прибору пока не прикреплены файлы. Их можно добавить в паспорте: «Изменить»."} files={record.fileRecords} />
          </section> : null}
          {detailTab === "movements" ? <div className="task-work">
            <AssignmentHistorySection empty="Перемещений пока нет. Они появятся после смены места установки." events={siteChanges} title="Смены места установки" />
            {readOnly ? null : <AssignmentHistorySection empty="Смен плательщика пока нет." events={payerChanges} title="Смены плательщика" />}
          </div> : null}
        </div>
        <aside className="task-layout__aside" aria-label="Паспорт прибора">
          <section className="task-props">
            <header className="task-props__head"><h2>Паспорт</h2>{!readOnly && onEdit ? <Button onClick={onEdit} variant="ghost">Изменить</Button> : null}</header>
            <dl>
              <div><dt>Производитель</dt><dd>{record.manufacturer}</dd></div>
              <div><dt>Модель</dt><dd>{record.model}</dd></div>
              <div><dt>S/N</dt><dd>{record.serial}</dd></div>
              <div><dt>Статус</dt><dd><StatusBadge tone={record.tone}>{record.status}</StatusBadge></dd></div>
              <div><dt>Гарантия</dt><dd>{record.guarantee === "Не указана" ? <span className="is-empty">Не указана</span> : record.guarantee}</dd></div>
            </dl>
            <dl>
              <div><dt>Площадка</dt><dd>{placeUnset ? <span className="is-empty">Не указана</span> : record.place}{readOnly ? null : <button className="text-button" onClick={() => setChangeKind("site_change")} type="button">{placeUnset ? "Указать" : "Сменить"}</button>}</dd></div>
              <div><dt>Организация</dt><dd>{organizationUnset ? <span className="is-empty">Не указана</span> : record.organization}</dd></div>
              {readOnly ? null : <div><dt>Плательщик</dt><dd>{payerUnset ? <span className="is-empty">Не указан</span> : record.payer}<button className="text-button" onClick={() => setChangeKind("payer_change")} type="button">{payerUnset ? "Указать" : "Сменить"}</button></dd></div>}
            </dl>
            <dl>
              <div><dt>Счётчик</dt><dd>{record.lastMeterReading === undefined ? <span className="is-empty">Нет показаний</span> : record.lastMeterReading.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}<small>обновляется после закрытия задачи</small></dd></div>
              {record.notes ? <div><dt>Примечание</dt><dd>{record.notes}</dd></div> : null}
            </dl>
          </section>
        </aside>
      </div>
      {changeKind ? <EquipmentAssignmentForm kind={changeKind} onApply={apply} onOpenChange={(open) => { if (!open) setChangeKind(null); }} open options={changeKind === "site_change" ? sites : payers} record={record} /> : null}
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
      <section className="registry-toolbar" aria-labelledby="equipment-search-title">
        <label className="registry-toolbar__search" htmlFor="equipment-search">
          <span className="sr-only" id="equipment-search-title">Поиск приборов</span>
          <input id="equipment-search" onChange={(event) => changeFilter("search", event.target.value)} placeholder="S/N, модель или организация" type="search" value={filters.search} />
        </label>
        <div className="registry-toolbar__filters" aria-label="Фильтры списка приборов">
          <Select aria-label="Производитель" onChange={(event) => changeFilter("manufacturer", event.target.value)} value={filters.manufacturer}><option value="">Все производители</option>{references.manufacturers.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</Select>
          <Select aria-label="Статус" onChange={(event) => changeFilter("status", event.target.value)} value={filters.status}><option value="">Все статусы</option>{references.statuses.map((value) => <option key={value.code} value={value.code}>{value.name}</option>)}</Select>
          <Select aria-label="Площадка" onChange={(event) => changeFilter("site", event.target.value)} value={filters.site}><option value="">Все площадки</option>{sites.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</Select>
          {engineer ? null : <Select aria-label="Плательщик" onChange={(event) => changeFilter("payer", event.target.value)} value={filters.payer}><option value="">Все плательщики</option>{payers.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</Select>}
          {filteredEmpty ? <Button onClick={() => { setFilters(EMPTY_EQUIPMENT_REGISTRY_FILTERS); setPageIndex(0); }} variant="ghost">Сбросить</Button> : null}
        </div>
      </section>
      <section className="card card--table" aria-labelledby="equipment-table-title">
        <CardHeader headingId="equipment-table-title" {...(initialLoading ? {} : { meta: formatRussianCount(total, ["прибор", "прибора", "приборов"]) })} title={engineer ? "Приборы с ваших задач" : "Все приборы"} />
        {initialLoading
          ? <ResourceState description="Подождите, список приборов сейчас появится." status="loading" title="Загружаем приборы" />
          : <>
            <div className="table-scroll">
              <table className="data-table equipment-registry-table">
                <thead><tr><th scope="col">Прибор</th><th scope="col">S/N</th><th scope="col">Площадка</th>{engineer ? null : <th scope="col">Плательщик</th>}<th scope="col">Статус</th>{engineer ? null : <th scope="col"><span className="sr-only">Действия</span></th>}</tr></thead>
                <tbody>
                  {records.map((record) => <tr className="data-table__selectable" key={record.id} onClick={() => void openCard(record.id)}>
                    <td><strong>{record.manufacturer} {record.model}</strong><small>{record.guarantee}</small></td>
                    <td className="equipment-registry-table__serial">{record.serial}</td>
                    <td>{record.place === "Не указана" ? <span className="muted">Не указана</span> : record.place}</td>
                    {engineer ? null : <td>{record.payer === "Не указан" ? <span className="muted">Не указан</span> : record.payer}</td>}
                    <td><StatusBadge tone={record.tone}>{record.status}</StatusBadge></td>
                    {engineer ? null : <td onClick={(event) => event.stopPropagation()}><div className="table-actions equipment-registry-actions"><Button className="button--compact" onClick={() => setSiteChangeId(record.id)} variant="ghost">Сменить место</Button><IconButton icon="edit" label="Изменить паспорт" onClick={() => openEdit(record.id)} /></div></td>}
                  </tr>)}
                  {records.length === 0 ? <tr><td className="equipment-registry-empty" colSpan={engineer ? 4 : 6}><ResourceState description={filteredEmpty ? "Измените поиск или сбросьте фильтры." : engineer ? "Приборы с ваших заявок появятся здесь." : "Добавьте прибор, чтобы вести паспорт и историю обслуживания."} status={filteredEmpty ? "filtered-empty" : "empty"} title={filteredEmpty ? "Приборы не найдены" : "Приборов пока нет"} /></td></tr> : null}
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
  // По умолчанию все каналы: раньше был выбран только e-mail, и сообщения Telegram были не видны.
  const [filters, setFilters] = useState({ channel: "", status: "", eventCode: "", recipient: "" });
  const [openId, setOpenId] = useState<string | null>(null);
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
  const channelLabel: Readonly<Record<string, string>> = { email: "E-mail", telegram: "Telegram", max: "MAX", sms: "СМС" };
  const filtered = Boolean(filters.status || filters.eventCode || filters.recipient || filters.channel);
  return <><PageIntro title="Уведомления" />
    <FilterBar loading={loading} onReset={() => { const reset = { channel: "", status: "", eventCode: "", recipient: "" }; setFilters(reset); setPageIndex(0); void reload(reset, 0); }} onSubmit={() => { setPageIndex(0); return reload(filters, 0); }}>
      <label>Канал<Select onChange={(event) => changeFilter("channel", event.target.value)} value={filters.channel}><option value="">Все каналы</option><option value="email">E-mail</option><option value="telegram">Telegram</option></Select></label>
      <label>Событие<Select onChange={(event) => changeFilter("eventCode", event.target.value)} value={filters.eventCode}><option value="">Все события</option>{Object.entries(eventLabel).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</Select></label>
      <label>Статус<Select onChange={(event) => changeFilter("status", event.target.value)} value={filters.status}><option value="">Все статусы</option>{Object.entries(statusLabel).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</Select></label>
      <label className="filter-field--search">Адресат<input onChange={(event) => changeFilter("recipient", event.target.value)} placeholder="Имя или e-mail" type="search" value={filters.recipient} /></label>
    </FilterBar>
    <section className="card card--table" aria-label="Журнал уведомлений">
      <CardHeader {...(loading && items.length === 0 ? {} : { meta: `${items.length} из ${total}` })} title="Журнал отправки" />
      {loading && items.length === 0 ? <ResourceState description="Подождите, письма сейчас появятся." status="loading" title="Загружаем уведомления" />
        : items.length === 0 ? <ResourceState description={filtered ? "Измените условия или сбросьте фильтры." : "Письма появятся здесь, когда система отправит сообщения по заявкам."} status={filtered ? "filtered-empty" : "empty"} title={filtered ? "Уведомлений по этим условиям нет" : "Уведомлений пока нет"} />
          : <div className="table-scroll"><table className="data-table notification-table"><thead><tr><th scope="col">Когда</th><th scope="col">Кому</th><th scope="col">О чём</th><th scope="col">Канал</th><th scope="col">Статус</th></tr></thead><tbody>
            {items.map((notification) => {
              const open = openId === notification.id;
              return <React.Fragment key={notification.id}>
                <tr aria-expanded={open} className={`data-table__selectable${notification.status === "failed" ? " notification-table__failed" : ""}`} onClick={() => setOpenId(open ? null : notification.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpenId(open ? null : notification.id); } }} role="button" tabIndex={0}>
                  <td className="notification-table__when">{formatDisplayDate(notification.createdAt, true)}</td>
                  <td>{notification.recipientAddress}</td>
                  <td><strong>{notification.subject || eventLabel[notification.eventCode] || "Письмо"}</strong><small>{eventLabel[notification.eventCode] ?? "Событие склада"}{notification.attempts > 1 ? ` · попыток: ${notification.attempts}` : ""}</small></td>
                  <td>{channelLabel[notification.channel] ?? notification.channel}</td>
                  <td><StatusBadge tone={tone(notification.status)}>{statusLabel[notification.status] ?? "Статус"}</StatusBadge></td>
                </tr>
                {open ? <tr className="notification-table__detail"><td colSpan={5}>
                  <p className="notification-table__body">{notification.body}</p>
                  {notification.diagnosticError ? <div className="notification-item__error" role="alert"><strong>Почему не ушло:</strong> {notification.diagnosticError}</div> : null}
                </td></tr> : null}
              </React.Fragment>;
            })}
          </tbody></table></div>}
      <RegistryPagination ariaLabel="Страницы журнала уведомлений" onPageChange={changePage} pageIndex={pageIndex} pageSize={pageSize} total={total} />
    </section></>;
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
            <td className="muted">{Object.entries(record.attributes).filter(([key]) => key !== "sortOrder").map(([key, value]) => `${selected.fields.find((field) => field.key === key)?.label ?? key}: ${typeof value === "boolean" ? value ? "да" : "нет" : String(value)}`).join(" · ") || "—"}</td>
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
  const [section, setSection] = useState<"catalogs" | "equipment" | "notifications">("catalogs");
  const tabItems = [
    { value: "catalogs" as const, label: "Работы и статусы" },
    { value: "equipment" as const, label: "Приборы" },
    ...(notificationTemplates ? [{ value: "notifications" as const, label: "Шаблоны писем" }] : [])
  ];
  return <>
    <PageIntro description="Сервисные справочники и ветвление приборов: категория → производитель → название → S/N." title="Справочники" />
    <PageTabs<"catalogs" | "equipment" | "notifications">
      items={tabItems}
      label="Разделы справочников"
      onValueChange={setSection}
      value={section}
    />
    {section === "notifications" && notificationTemplates
      ? <NotificationTemplatesPage />
      : section === "equipment"
        ? <EquipmentTreePage />
        : <AdminReferencesPage />}
  </>;
}

function CustomersPage() {
  return <>
    <PageIntro title="Клиенты" />
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
  readonly onTaskRouteChange: (taskId?: string, replace?: boolean) => void;
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
  readonly onTaskRouteChange: (taskId?: string, replace?: boolean) => void;
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

function EngineerTaskCard({ task, onOpen }: {
  readonly task: EngineerTaskListItem;
  readonly onOpen: (id: string) => void;
}) {
  const equipment = [task.equipment.manufacturer, task.equipment.model].filter(Boolean).join(" ");
  const serial = task.equipment.serialNumber?.trim();
  return <button
    className={`mobile-task-card${task.isNew ? " mobile-task-card--new" : ""}`}
    onClick={() => onOpen(task.id)}
    type="button"
  >
    <div className="mobile-task-card__top">
      <div className="mobile-task-card__badges">
        {task.isNew ? <span className="new-task-label">Новая</span> : null}
        <StatusBadge tone={taskStatusTone(task.status)}>{TASK_STATUS_LABELS[task.status] ?? "Статус"}</StatusBadge>
      </div>
      {task.isOverdue ? <span className="urgent-label">Просрочена</span> : task.priority === "urgent" ? <span className="urgent-label">Срочная</span> : null}
    </div>
    <div className="mobile-task-card__heading">
      <span className="mobile-task-card__number">{task.number}</span>
      <strong className="mobile-task-card__title">{task.title}</strong>
    </div>
    <div className="mobile-task-card__site">
      <strong>{task.site.name}</strong>
      {task.site.address ? <span>{task.site.address}</span> : null}
    </div>
    <dl className="mobile-task-card__meta">
      <div><dt>Период</dt><dd>{engineerPeriod(task.dates.periodFrom, task.dates.periodTo)}</dd></div>
      <div><dt>Вызов</dt><dd>{engineerDate(task.dates.call)}</dd></div>
      {task.dates.visit ? <div><dt>Выезд</dt><dd>{engineerDate(task.dates.visit)}</dd></div> : null}
      <div><dt>Прибор</dt><dd>{equipment || "Не указан"}{serial ? <span>S/N {serial}</span> : null}</dd></div>
    </dl>
  </button>;
}

// Этапы доски инженера: от назначения до закрытия. Закрытые видны всегда, отдельной колонкой.
const ENGINEER_BOARD_STATUSES: readonly ReferenceCatalogValue[] = (["assigned", "in_progress", "under_review", "closed"] as const).map((code, index) => ({
  id: code, code, name: TASK_STATUS_LABELS[code] ?? code, isActive: true,
  attributes: { sortOrder: index, ...(code === "closed" ? { isTerminal: true } : {}) }
}));

function EngineerTasks({ user, initialTaskId, onTaskRouteChange }: {
  readonly user: ApiSessionUser;
  readonly initialTaskId: string | undefined;
  readonly onTaskRouteChange: (taskId?: string, replace?: boolean) => void;
}) {
  const [page, setPage] = useState<EngineerTaskListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<"board" | "list">("board");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskCard, setTaskCard] = useState<TaskCardResponse | null>(null);
  const openRequest = useRef(0);
  const openInFlight = useRef<{ readonly id: string; readonly promise: Promise<void> } | null>(null);
  const openTask = (id: string, updateRoute = true): Promise<void> => {
    // Повторный клик по той же задаче, пока она грузится, не запускает вторую загрузку.
    // Обновление после действия (updateRoute = false) всегда грузит заново.
    if (updateRoute && openInFlight.current?.id === id) return openInFlight.current.promise;
    const promise = loadTaskCard(id, updateRoute).finally(() => {
      if (openInFlight.current?.promise === promise) openInFlight.current = null;
    });
    openInFlight.current = { id, promise };
    return promise;
  };
  const loadTaskCard = async (id: string, updateRoute: boolean) => {
    const request = ++openRequest.current;
    const previous = taskCard;
    setSelectedTaskId(id);
    if (previous?.task.id !== id) setTaskCard(null);
    if (updateRoute) onTaskRouteChange(id);
    try {
      const loaded = await m2Api.taskCard(id);
      if (request === openRequest.current) setTaskCard(loaded);
    } catch (loadError) {
      if (request !== openRequest.current) return;
      if (previous) {
        setSelectedTaskId(previous.task.id);
        setTaskCard(previous);
        if (updateRoute) onTaskRouteChange(previous.task.id, true);
      } else {
        setSelectedTaskId(null);
        setTaskCard(null);
        if (updateRoute) onTaskRouteChange(undefined, true);
      }
      throw loadError;
    }
  };
  const closeTask = () => { openRequest.current += 1; openInFlight.current = null; setSelectedTaskId(null); setTaskCard(null); onTaskRouteChange(); };
  // Ушли со страницы задач: незавершённые загрузки больше ничего не меняют.
  useEffect(() => () => { openRequest.current += 1; }, []);
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
  useEffect(() => {
    if (initialTaskId && initialTaskId === selectedTaskId) return;
    if (!initialTaskId) {
      openRequest.current += 1;
      openInFlight.current = null;
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
  if (selectedTaskId && !taskCard) {
    return <TaskCardLoading onBack={closeTask} task={page?.items.find((item) => item.id === selectedTaskId)} />;
  }
  if (selectedTaskId && taskCard) {
    return <TaskCard
      card={taskCard}
      onBack={closeTask}
      onChanged={async () => {
        setReload((value) => value + 1);
        await openTask(selectedTaskId, false);
      }}
      onOpenRelated={async (id) => { await openTask(id); }}
    />;
  }
  const openFromList = (id: string) => void openTask(id).catch((loadError: unknown) => toast.error(loadError instanceof Error ? loadError.message : "Не получилось открыть задачу"));
  return <>
    <PageIntro title="Мои задачи" titleAside={<ViewSwitch items={[{ value: "board", label: "Доска" }, { value: "list", label: "Список" }]} label="Как показать задачи" onValueChange={(next) => { setView(next); setReload((value) => value + 1); }} value={view} />} />
    {view === "board" ? <TaskBoard
      engineers={[]}
      equipment={[]}
      loadColumn={async (status, offset, limit) => {
        const page = await m2Api.tasksPage({ engineerId: user.id, status, sort: status === "closed" ? "updated_desc" : "deadline_asc", limit, offset });
        return { items: page.items, total: page.total };
      }}
      onMove={async (id, status) => {
        try { await m2Api.transitionTask(id, status); }
        catch (moveError) { toast.error(moveError instanceof Error ? moveError.message : "Не получилось изменить этап"); throw moveError; }
      }}
      onOpen={openFromList}
      engineerMode
      hideEngineer
      queryKey={`engineer#${reload}`}
      showCompleted
      statuses={ENGINEER_BOARD_STATUSES}
    /> : null}
    {view === "list" ? <section aria-busy={loading} aria-labelledby="engineer-task-list-title"><div className="section-heading"><div><h2 id="engineer-task-list-title">Назначенные выезды</h2></div>{page ? <span className="muted">{engineerTaskCount(page.total)}</span> : null}</div>
      {loading ? <div className="mobile-task-list" role="status"><span className="sr-only">Загрузка задач…</span><div className="mobile-task-skeleton" /><div className="mobile-task-skeleton" /></div> : null}
      {!loading && error ? <div className="mobile-task-error" role="alert"><strong>Список не загрузился</strong><span>{error}</span><Button onClick={() => setReload((value) => value + 1)} variant="secondary">Повторить</Button></div> : null}
      {!loading && !error && page?.items.length === 0 ? <ResourceState description="Когда координатор назначит задачу, она появится здесь." status="empty" title="Назначенных выездов пока нет" /> : null}
      {!loading && !error && page ? <div className="mobile-task-list">{page.items.map((task) => <EngineerTaskCard key={task.id} onOpen={openFromList} task={task} />)}</div> : null}
    </section> : null}
  </>;
}

function EngineerWorkspace({ view, user, taskRouteId, onTaskRouteChange }: {
  readonly view: NavigationId;
  readonly user: ApiSessionUser;
  readonly taskRouteId: string | undefined;
  readonly onTaskRouteChange: (taskId?: string, replace?: boolean) => void;
}) {
  switch (view) {
    case "tasks": return <EngineerTasks initialTaskId={taskRouteId} onTaskRouteChange={onTaskRouteChange} user={user} />;
    case "equipment": return <EquipmentPage engineer />;
    case "notifications": return <NotificationsPage />;
    default: return <EngineerTasks initialTaskId={taskRouteId} onTaskRouteChange={onTaskRouteChange} user={user} />;
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
  const [taskRouteId, setTaskRouteId] = useState<string | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    // Обновление страницы возвращает на доску; карточку по ссылке (из письма) открываем как раньше.
    const navigationEntry = window.performance?.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (navigationEntry?.type === "reload" && taskIdFromPathname(window.location.pathname)) {
      window.history.replaceState(null, "", "/");
      return undefined;
    }
    return taskIdFromPathname(window.location.pathname);
  });
  // Каждый клик по разделу в меню открывает его с начала (у задач это доска, а не список или карточка).
  const [navigationKey, setNavigationKey] = useState(0);
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
    setNavigationKey((value) => value + 1);
    setTaskRouteId(undefined);
    if (window.location.pathname !== "/") window.history.pushState(null, "", "/");
  };

  const changeTaskRoute = (taskId?: string, replace = false) => {
    setTaskRouteId(taskId);
    const pathname = taskId ? taskPathname(taskId) : "/";
    if (window.location.pathname === pathname) return;
    // Откат после неудачного открытия не оставляет лишний шаг в истории браузера.
    if (replace) window.history.replaceState(null, "", pathname);
    else window.history.pushState(null, "", pathname);
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
      {navigation.length > 0 && role === "coordinator" ? <CoordinatorWorkspace key={navigationKey} onTaskRouteChange={changeTaskRoute} taskRouteId={taskRouteId} view={activeView} /> : null}
      {navigation.length > 0 && role === "engineer" ? <EngineerWorkspace key={navigationKey} onTaskRouteChange={changeTaskRoute} taskRouteId={taskRouteId} user={sessionUser} view={activeView} /> : null}
      {navigation.length > 0 && role === "warehouse" ? <WarehouseWorkspace key={navigationKey} view={activeView} /> : null}
      {navigation.length > 0 && role === "admin" ? <AdminWorkspace key={navigationKey} onTaskRouteChange={changeTaskRoute} taskRouteId={taskRouteId} view={activeView} /> : null}
    </AppShell>
  );
}

export { App };
