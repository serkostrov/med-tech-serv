import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AddEquipmentDialog } from "./AddEquipmentDialog.js";
import type { SiteOption } from "./customer-selection.js";
import { EQUIPMENT_OPTIONS_LIMIT, equipmentOptionMeta, equipmentOptionTitle, filterEquipmentOptions } from "./equipment-options.js";
import { m2Api, type EquipmentApiRecord, type EquipmentPassportReferences } from "./m2-api.js";
import { Button, toast } from "./ui.js";

const EMPTY_REFERENCES: EquipmentPassportReferences = {
  manufacturers: [],
  models: [],
  guaranteeCategories: [],
  statuses: []
};

export function EquipmentFolderPicker({
  equipment,
  onSelect,
  allowCreate = true
}: {
  readonly equipment: readonly EquipmentApiRecord[];
  readonly onSelect: (device: EquipmentApiRecord) => void;
  /** Кнопка «Новый» с созданием прибора; в плане ТО прибор только выбирают из уже заведённых. */
  readonly allowCreate?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [liveEquipment, setLiveEquipment] = useState(equipment);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [references, setReferences] = useState<EquipmentPassportReferences>(EMPTY_REFERENCES);
  const [sites, setSites] = useState<readonly SiteOption[]>([]);
  const [manufacturerId, setManufacturerId] = useState("");
  const [modelId, setModelId] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  // Прокручиваем к выделенной строке только при ходьбе стрелками, а не при наведении мышью.
  const scrollToActive = useRef(false);

  const [equipmentLoading, setEquipmentLoading] = useState(false);
  const [equipmentLoaded, setEquipmentLoaded] = useState(false);
  useEffect(() => {
    // Не затираем уже загруженный список пустым или частичным значением из формы.
    setLiveEquipment((current) => {
      if (equipment.length === 0) return current;
      const known = new Set(current.map((item) => item.id));
      return [...current, ...equipment.filter((item) => !known.has(item.id))];
    });
  }, [equipment]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEquipmentLoading(true);
    void m2Api.listEquipment()
      .then((items) => {
        if (!cancelled) { setLiveEquipment(items); setEquipmentLoaded(true); }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить приборы");
      })
      .finally(() => {
        if (!cancelled) setEquipmentLoading(false);
      });
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!formOpen) return;
    const preferredManufacturer = references.manufacturers[0]?.id ?? "";
    const preferredModel = references.models.find((item) => item.manufacturerId === preferredManufacturer)?.id ?? "";
    setManufacturerId(preferredManufacturer);
    setModelId(preferredModel);
    setFormError(null);
  }, [formOpen, references]);

  const availableModels = useMemo(
    () => references.models.filter((item) => item.manufacturerId === manufacturerId),
    [references.models, manufacturerId]
  );

  // Сразу список приборов, без папок: площадка, модель, заводской номер. Ввод сужает список.
  const options = useMemo(() => filterEquipmentOptions(liveEquipment, query), [liveEquipment, query]);
  // Список мог сократиться (догрузка, поиск): выделение всегда внутри него.
  const lastIndex = options.items.length - 1;
  const activeIndex = lastIndex < 0 ? -1 : Math.min(highlightIndex, lastIndex);
  const activeDevice = activeIndex < 0 ? undefined : options.items[activeIndex];

  useEffect(() => {
    setHighlightIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open || !scrollToActive.current) return;
    scrollToActive.current = false;
    listRef.current?.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const chooseEquipment = (equipmentId: string) => {
    const device = liveEquipment.find((item) => item.id === equipmentId);
    if (!device) return;
    onSelect(device);
    setQuery("");
    setOpen(false);
  };

  const openCreate = () => {
    setOpen(false);
    setFormError(null);
    setFormOpen(true);
    void Promise.all([m2Api.passportReferences(), m2Api.listSites()])
      .then(([passport, loadedSites]) => {
        setReferences(passport);
        setSites(loadedSites);
      })
      .catch((loadError: unknown) => {
        toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить справочники прибора");
      });
  };

  const changeManufacturer = (nextManufacturerId: string) => {
    setManufacturerId(nextManufacturerId);
    setModelId(references.models.find((item) => item.manufacturerId === nextManufacturerId)?.id ?? "");
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const data = new FormData(event.currentTarget);
    const serialNumber = String(data.get("serialNumber") ?? "").trim();
    const nextManufacturerId = String(data.get("manufacturerId") || manufacturerId).trim();
    const nextModelId = String(data.get("modelId") || modelId).trim();
    const guaranteeCategoryId = String(
      data.get("guaranteeCategoryId") || references.guaranteeCategories[0]?.id || ""
    ).trim();
    const status = String(data.get("status") || references.statuses[0]?.code || "in_use").trim();
    const siteId = String(data.get("siteId") ?? "").trim();
    const payerId = String(data.get("payerId") ?? "").trim();
    if (!serialNumber) {
      setFormError("Укажите серийный номер");
      return;
    }
    if (liveEquipment.some((item) => item.serialNumber.replace(/\s+/gu, "").toLocaleLowerCase("ru-RU") === serialNumber.replace(/\s+/gu, "").toLocaleLowerCase("ru-RU"))) {
      setFormError("Прибор с таким S/N уже существует");
      return;
    }
    if (!nextManufacturerId || !nextModelId || !guaranteeCategoryId || !status) {
      setFormError("Выберите производителя, модель, категорию гарантии и статус");
      return;
    }
    if (!siteId || !payerId) {
      setFormError("Выберите площадку и плательщика");
      return;
    }
    setManufacturerId(nextManufacturerId);
    setModelId(nextModelId);
    setSaving(true);
    setFormError(null);
    try {
      const created = await m2Api.createEquipment({
        serialNumber,
        manufacturerId: nextManufacturerId,
        modelId: nextModelId,
        guaranteeCategoryId,
        status,
        siteId,
        payerId,
        notes: String(data.get("notes") ?? "").trim() || null
      });
      setLiveEquipment((current) => [...current, created]);
      setFormOpen(false);
      onSelect(created);
      setQuery("");
      toast.success("Прибор добавлен");
    } catch (createError) {
      setFormError(createError instanceof Error ? createError.message : "Не получилось добавить прибор");
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      scrollToActive.current = true;
      setHighlightIndex((current) => Math.max(0, Math.min(Math.min(current, lastIndex) + 1, lastIndex)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      scrollToActive.current = true;
      setHighlightIndex((current) => Math.max(Math.min(current, lastIndex) - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      // Enter в поиске прибора никогда не отправляет окно целиком: пока список грузится
      // или пуст, так ушла бы форма со старым прибором.
      event.preventDefault();
      if (open && activeDevice) chooseEquipment(activeDevice.id);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      className="equipment-combobox"
      onBlur={(event) => {
        // Фокус ушёл из поля и кнопки «Новый» (Tab дальше по форме): список закрываем.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      ref={rootRef}
    >
      <div className="equipment-combobox__picker">
        <div className="equipment-combobox__search-row">
          <input
            aria-activedescendant={open && activeDevice ? `${listId}-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={open}
            aria-label="Поиск прибора"
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Нажмите и выберите прибор или введите S/N"
            role="combobox"
            type="search"
            value={query}
          />
          {allowCreate ? <Button icon="plus" onClick={openCreate} type="button" variant="secondary">Новый</Button> : null}
        </div>
        {open ? (
          <div
            className="equipment-combobox__list"
            // Клик по списку не уводит фокус из поля: список не закрывается, выбор стрелками продолжается.
            onMouseDown={(event) => event.preventDefault()}
            onWheel={(event) => event.stopPropagation()}
            ref={listRef}
            // Браузер иначе делает прокручиваемый список отдельной остановкой Tab: по списку ходят стрелками из поля.
            tabIndex={-1}
          >
            <div aria-label="Приборы" id={listId} role="listbox">
              {options.items.map((device, index) => (
                <button
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? "equipment-option is-active" : "equipment-option"}
                  id={`${listId}-${index}`}
                  key={device.id}
                  onClick={() => chooseEquipment(device.id)}
                  onMouseEnter={() => { scrollToActive.current = false; setHighlightIndex(index); }}
                  role="option"
                  tabIndex={-1}
                  type="button"
                >
                  <strong>{equipmentOptionTitle(device)}</strong>
                  <span>{equipmentOptionMeta(device)}</span>
                </button>
              ))}
            </div>
            {options.items.length === 0 ? (
              <p className="equipment-combobox__empty">
                {equipmentLoading && !equipmentLoaded
                  ? "Загружаем приборы…"
                  : liveEquipment.length === 0
                  ? allowCreate ? "Приборов пока нет. Нажмите «Новый», чтобы добавить прибор." : "Приборов пока нет. Добавьте прибор в разделе «Приборы»."
                  : "Приборов по этому запросу нет"}
              </p>
            ) : null}
            {options.total > options.items.length ? (
              <p className="equipment-combobox__more">Показаны первые {EQUIPMENT_OPTIONS_LIMIT} из {options.total}. Введите S/N, модель или площадку, чтобы найти нужный.</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {allowCreate ? <AddEquipmentDialog
        availableModels={availableModels}
        error={formError}
        manufacturerId={manufacturerId}
        modelId={modelId}
        onManufacturerChange={changeManufacturer}
        onModelChange={setModelId}
        onOpenChange={setFormOpen}
        onReferencesChange={setReferences}
        onSubmit={submitCreate}
        open={formOpen}
        references={references}
        saving={saving}
        sites={sites}
      /> : null}
    </div>
  );
}
