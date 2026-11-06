import React, { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AddEquipmentDialog } from "./AddEquipmentDialog.js";
import {
  buildEquipmentFolderTree,
  equipmentFolderSearchExpandedIds,
  filterEquipmentFolderTree,
  flattenVisibleEquipmentFolders,
  toEquipmentTreeModels,
  type EquipmentFolderNode,
  type EquipmentTreeManufacturer,
  type EquipmentTreeModel,
  type EquipmentTreeUnit
} from "./equipment-tree.js";
import type { SiteOption } from "./customer-selection.js";
import { m2Api, type EquipmentApiRecord, type EquipmentPassportReferences } from "./m2-api.js";
import { Button, toast } from "./ui.js";

const EMPTY_REFERENCES: EquipmentPassportReferences = {
  manufacturers: [],
  models: [],
  guaranteeCategories: [],
  statuses: []
};

function toUnits(items: readonly EquipmentApiRecord[]): readonly EquipmentTreeUnit[] {
  return items.map((item) => ({
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

function equipmentLabelsMap(
  items: readonly EquipmentApiRecord[]
): Readonly<Record<string, { readonly manufacturer: string; readonly model: string }>> {
  const map: Record<string, { manufacturer: string; model: string }> = {};
  for (const item of items) {
    map[item.id] = { manufacturer: item.manufacturer, model: item.model };
  }
  return map;
}

function FolderChevron({ open }: { readonly open: boolean }) {
  return <span aria-hidden="true" className={`equipment-folder__chevron${open ? " is-open" : ""}`} />;
}

export function EquipmentFolderPicker({
  equipment,
  onSelect
}: {
  readonly equipment: readonly EquipmentApiRecord[];
  readonly onSelect: (device: EquipmentApiRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [models, setModels] = useState<readonly EquipmentTreeModel[]>([]);
  const [manufacturers, setManufacturers] = useState<readonly EquipmentTreeManufacturer[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [liveEquipment, setLiveEquipment] = useState(equipment);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [references, setReferences] = useState<EquipmentPassportReferences>(EMPTY_REFERENCES);
  const [sites, setSites] = useState<readonly SiteOption[]>([]);
  const [manufacturerId, setManufacturerId] = useState("");
  const [modelId, setModelId] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLiveEquipment(equipment);
  }, [equipment]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      m2Api.listCatalogValues("equipment-models"),
      m2Api.listCatalogValues("manufacturers")
    ])
      .then(([modelValues, manufacturerValues]) => {
        if (cancelled) return;
        setModels(toEquipmentTreeModels(modelValues));
        setManufacturers(manufacturerValues.map((item) => ({
          id: item.id,
          name: item.name,
          isActive: item.isActive
        })));
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setManufacturers([]);
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void m2Api.listEquipment()
      .then((items) => {
        if (!cancelled) setLiveEquipment(items);
      })
      .catch(() => {
        /* оставляем текущий список */
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

  const tree = useMemo(() => {
    if (!catalogReady && models.length === 0 && manufacturers.length === 0) {
      // Пока справочники грузятся — дерево из подписей приборов.
      return buildEquipmentFolderTree([], [], toUnits(liveEquipment), equipmentLabelsMap(liveEquipment));
    }
    return buildEquipmentFolderTree(models, manufacturers, toUnits(liveEquipment), equipmentLabelsMap(liveEquipment));
  }, [catalogReady, models, manufacturers, liveEquipment]);

  const visibleTree = useMemo(
    () => filterEquipmentFolderTree(tree, query),
    [tree, query]
  );

  const effectiveExpanded = useMemo(() => {
    if (query.trim()) return equipmentFolderSearchExpandedIds(visibleTree);
    return expandedIds;
  }, [query, visibleTree, expandedIds]);

  const flatNodes = useMemo(
    () => flattenVisibleEquipmentFolders(visibleTree, effectiveExpanded),
    [visibleTree, effectiveExpanded]
  );

  useEffect(() => {
    setHighlightIndex(0);
  }, [query, open]);

  const toggleFolder = (nodeId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const chooseEquipment = (equipmentId: string) => {
    const device = liveEquipment.find((item) => item.id === equipmentId);
    if (!device) return;
    onSelect(device);
    setQuery("");
    setOpen(false);
  };

  const activateNode = (node: EquipmentFolderNode) => {
    if (node.kind === "equipment" && node.equipmentId) {
      chooseEquipment(node.equipmentId);
      return;
    }
    toggleFolder(node.id);
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
      setHighlightIndex((current) => Math.min(current + 1, Math.max(flatNodes.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlightIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const highlighted = flatNodes[highlightIndex];
      if (open && highlighted) {
        event.preventDefault();
        activateNode(highlighted);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="equipment-combobox" ref={rootRef}>
      <div className="equipment-combobox__picker">
        <div className="equipment-combobox__search-row">
          <input
            aria-autocomplete="list"
            aria-controls="equipment-combobox-list"
            aria-expanded={open}
            aria-label="Поиск прибора"
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="S/N, модель, производитель или категория"
            role="combobox"
            type="search"
            value={query}
          />
          <Button icon="plus" onClick={openCreate} type="button" variant="secondary">Новый</Button>
        </div>
        {open ? (
          <div
            className="equipment-combobox__list equipment-folder"
            id="equipment-combobox-list"
            onWheel={(event) => event.stopPropagation()}
            role="tree"
          >
            {visibleTree.length === 0 ? (
              <p className="equipment-combobox__empty">
                {models.length === 0 && liveEquipment.length === 0
                  ? "Справочник пуст. Нажмите «Новый», чтобы добавить прибор."
                  : "Приборов по этому запросу нет"}
              </p>
            ) : (
              <ul className="equipment-folder__root">
                {flatNodes.map((node, index) => {
                  const depth = node.kind === "category" ? 0
                    : node.kind === "manufacturer" ? 1
                      : node.kind === "model" ? 2
                        : 3;
                  const isFolder = node.kind !== "equipment";
                  const isOpen = effectiveExpanded.has(node.id);
                  const highlighted = index === highlightIndex;
                  return (
                    <li key={node.id} role="none" style={{ "--folder-depth": depth } as React.CSSProperties}>
                      <button
                        aria-expanded={isFolder ? isOpen : undefined}
                        aria-selected={highlighted}
                        className={[
                          "equipment-folder__row",
                          `equipment-folder__row--${node.kind}`,
                          highlighted ? "is-active" : "",
                          isOpen ? "is-open" : ""
                        ].filter(Boolean).join(" ")}
                        onClick={() => activateNode(node)}
                        onMouseEnter={() => setHighlightIndex(index)}
                        role="treeitem"
                        type="button"
                      >
                        <span className="equipment-folder__text">
                          <strong>{node.label}</strong>
                          {node.meta ? <small>{node.meta}</small> : null}
                        </span>
                        {isFolder && node.count > 0 ? <span className="equipment-folder__count">{node.count}</span> : null}
                        {isFolder ? <FolderChevron open={isOpen} /> : <span className="equipment-folder__leaf-gap" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
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
          void Promise.all([
            m2Api.listCatalogValues("equipment-models"),
            m2Api.listCatalogValues("manufacturers")
          ]).then(([modelValues, manufacturerValues]) => {
            setModels(toEquipmentTreeModels(modelValues));
            setManufacturers(manufacturerValues.map((item) => ({
              id: item.id,
              name: item.name,
              isActive: item.isActive
            })));
          }).catch(() => {
            /* справочник диалога уже обновлён */
          });
        }}
        onSubmit={submitCreate}
        open={formOpen}
        references={references}
        saving={saving}
        sites={sites}
      />
    </div>
  );
}
