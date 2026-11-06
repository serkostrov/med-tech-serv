import React, { useEffect, useMemo, useState, type FormEvent } from "react";
import { AddEquipmentDialog } from "./AddEquipmentDialog.js";
import {
  equipmentTreeCategories,
  equipmentTreeManufacturers,
  equipmentTreeModelNames,
  equipmentTreeSerials,
  toEquipmentTreeModels,
  type EquipmentTreeItem,
  type EquipmentTreeManufacturer,
  type EquipmentTreeModel,
  type EquipmentTreeSelection,
  type EquipmentTreeUnit
} from "./equipment-tree.js";
import type { SiteOption } from "./customer-selection.js";
import {
  m2Api,
  type EquipmentApiRecord,
  type EquipmentPassportReferences
} from "./m2-api.js";
import { Button, CardHeader, ResourceState, toast } from "./ui.js";

type TreeColumnId = "category" | "manufacturer" | "model" | "serial";

const EMPTY_REFERENCES: EquipmentPassportReferences = {
  manufacturers: [],
  models: [],
  guaranteeCategories: [],
  statuses: []
};

const COLUMN_META: Readonly<Record<TreeColumnId, { readonly title: string; readonly empty: string; readonly hint: string }>> = {
  category: {
    title: "Категория",
    empty: "Категорий пока нет",
    hint: "Сначала выберите категорию"
  },
  manufacturer: {
    title: "Производитель",
    empty: "В этой категории нет производителей",
    hint: "Выберите категорию слева"
  },
  model: {
    title: "Название прибора",
    empty: "У производителя нет моделей в этой категории",
    hint: "Выберите производителя слева"
  },
  serial: {
    title: "Серийный номер",
    empty: "Приборов с S/N пока нет — нажмите «Добавить»",
    hint: "Выберите название прибора слева"
  }
};

function TreeColumn({
  id,
  items,
  selectedId,
  locked,
  onSelect
}: {
  readonly id: TreeColumnId;
  readonly items: readonly EquipmentTreeItem[];
  readonly selectedId?: string;
  readonly locked: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const meta = COLUMN_META[id];
  return (
    <section aria-label={meta.title} className={`equipment-tree__column${locked ? " is-locked" : ""}`}>
      <header className="equipment-tree__column-head">
        <strong>{meta.title}</strong>
        {!locked ? <span>{items.length}</span> : null}
      </header>
      {locked ? (
        <p className="equipment-tree__placeholder">{meta.hint}</p>
      ) : items.length === 0 ? (
        <p className="equipment-tree__placeholder">{meta.empty}</p>
      ) : (
        <ul className="equipment-tree__list">
          {items.map((item) => {
            const selected = item.id === selectedId;
            return (
              <li key={item.id}>
                <button
                  aria-current={selected ? "true" : undefined}
                  className={`equipment-tree__item${selected ? " is-selected" : ""}`}
                  onClick={() => onSelect(item.id)}
                  type="button"
                >
                  <span className="equipment-tree__item-main">
                    <strong>{item.label}</strong>
                    {item.meta ? <small>{item.meta}</small> : null}
                  </span>
                  {id !== "serial" ? (
                    <span className="equipment-tree__item-count" title={String(item.count)}>
                      {item.count}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function toUnits(equipment: readonly EquipmentApiRecord[]): readonly EquipmentTreeUnit[] {
  return equipment.map((item) => ({
    id: item.id,
    serialNumber: item.serialNumber,
    modelId: item.modelId,
    manufacturerId: item.manufacturerId,
    site: item.site,
    payer: item.payer,
    status: item.status,
    statusName: item.statusName
  }));
}

export function EquipmentTreePage() {
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<readonly EquipmentTreeModel[]>([]);
  const [manufacturers, setManufacturers] = useState<readonly EquipmentTreeManufacturer[]>([]);
  const [units, setUnits] = useState<readonly EquipmentTreeUnit[]>([]);
  const [equipment, setEquipment] = useState<readonly EquipmentApiRecord[]>([]);
  const [references, setReferences] = useState<EquipmentPassportReferences>(EMPTY_REFERENCES);
  const [sites, setSites] = useState<readonly SiteOption[]>([]);
  const [selection, setSelection] = useState<EquipmentTreeSelection>({});
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [manufacturerId, setManufacturerId] = useState("");
  const [modelId, setModelId] = useState("");

  const reload = async () => {
    const [modelValues, manufacturerValues, loadedEquipment, passport, loadedSites] = await Promise.all([
      m2Api.listCatalogValues("equipment-models"),
      m2Api.listCatalogValues("manufacturers"),
      m2Api.listEquipment(),
      m2Api.passportReferences(),
      m2Api.listSites()
    ]);
    setModels(toEquipmentTreeModels(modelValues));
    setManufacturers(manufacturerValues.map((item) => ({
      id: item.id,
      name: item.name,
      isActive: item.isActive
    })));
    setEquipment(loadedEquipment);
    setUnits(toUnits(loadedEquipment));
    setReferences(passport);
    setSites(loadedSites);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reload()
      .catch((loadError: unknown) => {
        if (!cancelled) {
          toast.error(loadError instanceof Error ? loadError.message : "Не получилось загрузить ветвление приборов");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = useMemo(() => equipmentTreeCategories(models, units), [models, units]);
  const manufacturerItems = useMemo(
    () => equipmentTreeManufacturers(models, manufacturers, selection.categoryKey, units),
    [models, manufacturers, selection.categoryKey, units]
  );
  const modelItems = useMemo(
    () => equipmentTreeModelNames(models, selection.categoryKey, selection.manufacturerId, units),
    [models, selection.categoryKey, selection.manufacturerId, units]
  );
  const serialItems = useMemo(
    () => equipmentTreeSerials(units, selection.modelId),
    [units, selection.modelId]
  );
  const availableModels = useMemo(
    () => references.models.filter((item) => item.manufacturerId === manufacturerId),
    [references.models, manufacturerId]
  );

  useEffect(() => {
    if (!formOpen) return;
    const preferredManufacturer = selection.manufacturerId
      && references.manufacturers.some((item) => item.id === selection.manufacturerId)
      ? selection.manufacturerId
      : references.manufacturers[0]?.id ?? "";
    const preferredModel = selection.modelId
      && references.models.some((item) => item.id === selection.modelId && item.manufacturerId === preferredManufacturer)
      ? selection.modelId
      : references.models.find((item) => item.manufacturerId === preferredManufacturer)?.id ?? "";
    setManufacturerId(preferredManufacturer);
    setModelId(preferredModel);
    setFormError(null);
  }, [formOpen, references, selection.manufacturerId, selection.modelId]);

  const selectCategory = (categoryKey: string) => {
    setSelection((current) => (
      current.categoryKey === categoryKey
        ? current
        : { categoryKey }
    ));
  };

  const selectManufacturer = (nextManufacturerId: string) => {
    setSelection((current) => ({ categoryKey: current.categoryKey, manufacturerId: nextManufacturerId }));
  };

  const selectModel = (nextModelId: string) => {
    setSelection((current) => ({
      categoryKey: current.categoryKey,
      manufacturerId: current.manufacturerId,
      modelId: nextModelId
    }));
  };

  const selectSerial = (equipmentId: string) => {
    setSelection((current) => ({ ...current, equipmentId }));
  };

  const openCreate = () => {
    setFormError(null);
    setFormOpen(true);
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
    if (equipment.some((item) => item.serialNumber.replace(/\s+/gu, "").toLocaleLowerCase("ru-RU") === serialNumber.replace(/\s+/gu, "").toLocaleLowerCase("ru-RU"))) {
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
      await reload();
      setSelection({
        ...(selection.categoryKey ? { categoryKey: selection.categoryKey } : {}),
        manufacturerId: created.manufacturerId ?? nextManufacturerId,
        modelId: created.modelId ?? nextModelId,
        equipmentId: created.id
      });
      setFormOpen(false);
      toast.success("Прибор добавлен");
    } catch (createError) {
      setFormError(createError instanceof Error ? createError.message : "Не получилось добавить прибор");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <ResourceState description="Собираем категории, производителей, модели и серийные номера." status="loading" title="Загружаем ветвление приборов" />;
  }

  if (categories.length === 0 && equipment.length === 0) {
    return (
      <>
        <ResourceState
          description="Добавьте первый прибор — ветвление появится автоматически."
          status="empty"
          title="Ветвление приборов пока пустое"
        />
        <div className="equipment-tree__empty-action">
          <Button icon="plus" onClick={openCreate}>Добавить</Button>
        </div>
        <AddEquipmentDialog
          availableModels={availableModels}
          error={formError}
          manufacturerId={manufacturerId}
          modelId={modelId}
          onManufacturerChange={changeManufacturer}
          onModelChange={setModelId}
          onOpenChange={setFormOpen}
          onReferencesChange={(passport) => {
            setReferences(passport);
            void reload().catch(() => {
              /* список диалога уже обновлён */
            });
          }}
          onSubmit={submitCreate}
          open={formOpen}
          references={references}
          saving={saving}
          sites={sites}
        />
      </>
    );
  }

  return (
    <>
      <section className="card equipment-tree">
        <CardHeader
          action={<Button icon="plus" onClick={openCreate}>Добавить</Button>}
          title="Ветвление приборов"
        />
        <div className="equipment-tree__columns" role="group" aria-label="Категория, производитель, название и серийный номер">
          <TreeColumn
            id="category"
            items={categories}
            locked={false}
            onSelect={selectCategory}
            selectedId={selection.categoryKey}
          />
          <TreeColumn
            id="manufacturer"
            items={manufacturerItems}
            locked={!selection.categoryKey}
            onSelect={selectManufacturer}
            selectedId={selection.manufacturerId}
          />
          <TreeColumn
            id="model"
            items={modelItems}
            locked={!selection.manufacturerId}
            onSelect={selectModel}
            selectedId={selection.modelId}
          />
          <TreeColumn
            id="serial"
            items={serialItems}
            locked={!selection.modelId}
            onSelect={selectSerial}
            selectedId={selection.equipmentId}
          />
        </div>
      </section>
      <AddEquipmentDialog
        availableModels={availableModels}
        error={formError}
        manufacturerId={manufacturerId}
        modelId={modelId}
        onManufacturerChange={changeManufacturer}
        onModelChange={setModelId}
        onOpenChange={setFormOpen}
        onReferencesChange={(passport) => {
          setReferences(passport);
          void reload().catch(() => {
            /* список диалога уже обновлён */
          });
        }}
        onSubmit={submitCreate}
        open={formOpen}
        references={references}
        saving={saving}
        sites={sites}
      />
    </>
  );
}
