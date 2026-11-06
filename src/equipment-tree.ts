/** Нормализованный ключ категории модели (пустая → «Без категории»). */
export const UNCATEGORIZED_KEY = "__uncategorized__";
export const UNCATEGORIZED_LABEL = "Без категории";

export interface EquipmentTreeModel {
  readonly id: string;
  readonly name: string;
  readonly manufacturerId: string;
  readonly categoryKey: string;
  readonly categoryLabel: string;
  readonly isActive: boolean;
}

export interface EquipmentTreeManufacturer {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
}

export interface EquipmentTreeUnit {
  readonly id: string;
  readonly serialNumber: string;
  readonly modelId?: string;
  readonly manufacturerId?: string;
  readonly site?: string;
  readonly payer?: string;
  readonly status: string;
  readonly statusName?: string;
}

export interface EquipmentTreeItem {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly meta?: string;
}

export interface EquipmentTreeSelection {
  readonly categoryKey?: string;
  readonly manufacturerId?: string;
  readonly modelId?: string;
  readonly equipmentId?: string;
}

function categoryFromAttribute(value: unknown): { readonly key: string; readonly label: string } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { key: UNCATEGORIZED_KEY, label: UNCATEGORIZED_LABEL };
  return { key: raw.toLocaleLowerCase("ru-RU"), label: raw };
}

export function toEquipmentTreeModels(
  models: readonly {
    readonly id: string;
    readonly name: string;
    readonly isActive: boolean;
    readonly attributes: Readonly<Record<string, unknown>>;
  }[]
): readonly EquipmentTreeModel[] {
  return models.map((model) => {
    const category = categoryFromAttribute(model.attributes.category);
    return {
      id: model.id,
      name: model.name,
      manufacturerId: String(model.attributes.manufacturerId ?? ""),
      categoryKey: category.key,
      categoryLabel: category.label,
      isActive: model.isActive
    };
  }).filter((model) => model.manufacturerId);
}

/** Категории, в которых есть модели. Счётчик — число приборов (S/N), не моделей. */
export function equipmentTreeCategories(
  models: readonly EquipmentTreeModel[],
  units: readonly EquipmentTreeUnit[] = [],
  includeInactive = false
): readonly EquipmentTreeItem[] {
  const visible = includeInactive ? models : models.filter((model) => model.isActive);
  const modelById = new Map(visible.map((model) => [model.id, model]));
  const buckets = new Map<string, { label: string; count: number }>();
  for (const model of visible) {
    if (!buckets.has(model.categoryKey)) {
      buckets.set(model.categoryKey, { label: model.categoryLabel, count: 0 });
    }
  }
  for (const unit of units) {
    const model = unit.modelId ? modelById.get(unit.modelId) : undefined;
    if (!model) continue;
    const bucket = buckets.get(model.categoryKey);
    if (bucket) bucket.count += 1;
  }
  return [...buckets.entries()]
    .map(([id, item]) => ({ id, label: item.label, count: item.count }))
    .sort((left, right) => {
      if (left.id === UNCATEGORIZED_KEY) return 1;
      if (right.id === UNCATEGORIZED_KEY) return -1;
      return left.label.localeCompare(right.label, "ru");
    });
}

/** Производители выбранной категории. Счётчик — число приборов (S/N). */
export function equipmentTreeManufacturers(
  models: readonly EquipmentTreeModel[],
  manufacturers: readonly EquipmentTreeManufacturer[],
  categoryKey: string | undefined,
  units: readonly EquipmentTreeUnit[] = [],
  includeInactive = false
): readonly EquipmentTreeItem[] {
  if (!categoryKey) return [];
  const visibleModels = (includeInactive ? models : models.filter((model) => model.isActive))
    .filter((model) => model.categoryKey === categoryKey);
  const modelIdsByManufacturer = new Map<string, Set<string>>();
  for (const model of visibleModels) {
    const ids = modelIdsByManufacturer.get(model.manufacturerId) ?? new Set<string>();
    ids.add(model.id);
    modelIdsByManufacturer.set(model.manufacturerId, ids);
  }
  return manufacturers
    .filter((item) => modelIdsByManufacturer.has(item.id) && (includeInactive || item.isActive))
    .map((item) => {
      const modelIds = modelIdsByManufacturer.get(item.id) ?? new Set<string>();
      return {
        id: item.id,
        label: item.name,
        count: units.filter((unit) => unit.modelId && modelIds.has(unit.modelId)).length
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label, "ru"));
}

/** Названия приборов (модели) для категории и производителя. */
export function equipmentTreeModelNames(
  models: readonly EquipmentTreeModel[],
  categoryKey: string | undefined,
  manufacturerId: string | undefined,
  units: readonly EquipmentTreeUnit[],
  includeInactive = false
): readonly EquipmentTreeItem[] {
  if (!categoryKey || !manufacturerId) return [];
  return (includeInactive ? models : models.filter((model) => model.isActive))
    .filter((model) => model.categoryKey === categoryKey && model.manufacturerId === manufacturerId)
    .map((model) => ({
      id: model.id,
      label: model.name,
      count: units.filter((unit) => unit.modelId === model.id).length
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "ru"));
}

/** Серийные номера выбранной модели. */
export function equipmentTreeSerials(
  units: readonly EquipmentTreeUnit[],
  modelId: string | undefined
): readonly EquipmentTreeItem[] {
  if (!modelId) return [];
  return units
    .filter((unit) => unit.modelId === modelId)
    .map((unit) => ({
      id: unit.id,
      label: unit.serialNumber,
      count: 1,
      meta: [unit.site, unit.statusName ?? unit.status].filter(Boolean).join(" · ") || undefined
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "ru"));
}

export function findEquipmentUnit(
  units: readonly EquipmentTreeUnit[],
  equipmentId: string | undefined
): EquipmentTreeUnit | undefined {
  if (!equipmentId) return undefined;
  return units.find((unit) => unit.id === equipmentId);
}

export type EquipmentFolderKind = "category" | "manufacturer" | "model" | "equipment";

/** Узел дерева папок: категория → производитель → название → S/N. */
export interface EquipmentFolderNode {
  readonly id: string;
  readonly kind: EquipmentFolderKind;
  readonly label: string;
  readonly count: number;
  readonly meta?: string;
  readonly children?: readonly EquipmentFolderNode[];
  readonly equipmentId?: string;
}

interface FolderBucket {
  id: string;
  label: string;
  manufacturers: Map<string, {
    id: string;
    label: string;
    models: Map<string, {
      id: string;
      label: string;
      units: EquipmentTreeUnit[];
    }>;
  }>;
}

function sortFolderNodes<T extends { readonly label: string; readonly id: string }>(
  items: readonly T[],
  uncategorizedLast = false
): T[] {
  return [...items].sort((left, right) => {
    if (uncategorizedLast) {
      if (left.id === UNCATEGORIZED_KEY) return 1;
      if (right.id === UNCATEGORIZED_KEY) return -1;
    }
    return left.label.localeCompare(right.label, "ru");
  });
}

/**
 * Собирает дерево из справочника моделей и приборов с S/N.
 * Папки категории → производитель → модель видны даже без серийников.
 * Приборы без modelId попадают в «Без категории» / производитель / модель по подписи.
 */
export function buildEquipmentFolderTree(
  models: readonly EquipmentTreeModel[],
  manufacturers: readonly EquipmentTreeManufacturer[],
  units: readonly EquipmentTreeUnit[],
  equipmentLabels: Readonly<Record<string, { readonly manufacturer: string; readonly model: string }>> = {}
): readonly EquipmentFolderNode[] {
  const modelById = new Map(models.filter((model) => model.isActive).map((model) => [model.id, model]));
  const manufacturerById = new Map(manufacturers.filter((item) => item.isActive).map((item) => [item.id, item]));
  const categories = new Map<string, FolderBucket>();

  const ensureCategory = (key: string, label: string): FolderBucket => {
    const existing = categories.get(key);
    if (existing) return existing;
    const created: FolderBucket = { id: key, label, manufacturers: new Map() };
    categories.set(key, created);
    return created;
  };

  const ensureModelFolder = (
    categoryKey: string,
    categoryLabel: string,
    manufacturerId: string,
    manufacturerLabel: string,
    modelId: string,
    modelLabel: string
  ) => {
    const category = ensureCategory(categoryKey, categoryLabel);
    let manufacturer = category.manufacturers.get(manufacturerId);
    if (!manufacturer) {
      manufacturer = { id: manufacturerId, label: manufacturerLabel, models: new Map() };
      category.manufacturers.set(manufacturerId, manufacturer);
    }
    let model = manufacturer.models.get(modelId);
    if (!model) {
      model = { id: modelId, label: modelLabel, units: [] };
      manufacturer.models.set(modelId, model);
    }
    return model;
  };

  for (const catalogModel of modelById.values()) {
    const manufacturerLabel = manufacturerById.get(catalogModel.manufacturerId)?.name || "Без производителя";
    ensureModelFolder(
      catalogModel.categoryKey,
      catalogModel.categoryLabel,
      catalogModel.manufacturerId,
      manufacturerLabel,
      catalogModel.id,
      catalogModel.name
    );
  }

  for (const unit of units) {
    const catalogModel = unit.modelId ? modelById.get(unit.modelId) : undefined;
    const labels = equipmentLabels[unit.id];
    const categoryKey = catalogModel?.categoryKey ?? UNCATEGORIZED_KEY;
    const categoryLabel = catalogModel?.categoryLabel ?? UNCATEGORIZED_LABEL;
    const manufacturerId = catalogModel?.manufacturerId
      || unit.manufacturerId
      || `name:${(labels?.manufacturer || "Без производителя").toLocaleLowerCase("ru-RU")}`;
    const manufacturerLabel = manufacturerById.get(manufacturerId)?.name
      || labels?.manufacturer
      || "Без производителя";
    const modelId = catalogModel?.id
      || unit.modelId
      || `name:${manufacturerId}:${(labels?.model || "Без названия").toLocaleLowerCase("ru-RU")}`;
    const modelLabel = catalogModel?.name || labels?.model || "Без названия";

    ensureModelFolder(categoryKey, categoryLabel, manufacturerId, manufacturerLabel, modelId, modelLabel).units.push(unit);
  }

  return sortFolderNodes([...categories.values()], true).map((category) => {
    const manufacturerNodes = sortFolderNodes([...category.manufacturers.values()]).map((manufacturer) => {
      const modelNodes = sortFolderNodes([...manufacturer.models.values()]).map((model) => {
        const equipmentNodes = [...model.units]
          .sort((left, right) => left.serialNumber.localeCompare(right.serialNumber, "ru"))
          .map((unit) => ({
            id: `equipment:${unit.id}`,
            kind: "equipment" as const,
            label: unit.serialNumber,
            count: 1,
            meta: [unit.site, unit.statusName ?? unit.status].filter(Boolean).join(" · ") || undefined,
            equipmentId: unit.id
          }));
        return {
          id: `model:${category.id}:${manufacturer.id}:${model.id}`,
          kind: "model" as const,
          label: model.label,
          count: equipmentNodes.length,
          meta: equipmentNodes.length === 0 ? "нет S/N" : undefined,
          children: equipmentNodes
        };
      });
      return {
        id: `manufacturer:${category.id}:${manufacturer.id}`,
        kind: "manufacturer" as const,
        label: manufacturer.label,
        count: modelNodes.reduce((sum, item) => sum + item.count, 0),
        children: modelNodes
      };
    });
    return {
      id: `category:${category.id}`,
      kind: "category" as const,
      label: category.label,
      count: manufacturerNodes.reduce((sum, item) => sum + item.count, 0),
      children: manufacturerNodes
    };
  });
}

function nodeMatchesQuery(node: EquipmentFolderNode, query: string): boolean {
  const haystack = [node.label, node.meta].filter(Boolean).join(" ").toLocaleLowerCase("ru-RU");
  return haystack.includes(query);
}

/** Оставляет только ветки, где есть совпадение с поиском (по себе или потомкам). */
export function filterEquipmentFolderTree(
  nodes: readonly EquipmentFolderNode[],
  query: string
): readonly EquipmentFolderNode[] {
  const normalized = query.trim().toLocaleLowerCase("ru-RU");
  if (!normalized) return nodes;

  const filterNode = (node: EquipmentFolderNode): EquipmentFolderNode | undefined => {
    if (node.kind === "equipment") {
      return nodeMatchesQuery(node, normalized) ? node : undefined;
    }
    // Совпадение по названию папки показывает всю ветку целиком.
    if (nodeMatchesQuery(node, normalized)) return node;
    const children = (node.children ?? [])
      .map((child) => filterNode(child))
      .filter((child): child is EquipmentFolderNode => Boolean(child));
    if (children.length === 0) return undefined;
    return {
      ...node,
      count: node.kind === "model"
        ? children.length
        : children.reduce((sum, child) => sum + child.count, 0),
      children
    };
  };

  return nodes
    .map((node) => filterNode(node))
    .filter((node): node is EquipmentFolderNode => Boolean(node));
}

/** Id папок, которые нужно раскрыть при поиске (все предки совпадений). */
export function equipmentFolderSearchExpandedIds(
  nodes: readonly EquipmentFolderNode[]
): ReadonlySet<string> {
  const expanded = new Set<string>();
  const walk = (node: EquipmentFolderNode) => {
    if (node.kind === "equipment" || !node.children?.length) return;
    expanded.add(node.id);
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return expanded;
}

export function flattenVisibleEquipmentFolders(
  nodes: readonly EquipmentFolderNode[],
  expandedIds: ReadonlySet<string>
): readonly EquipmentFolderNode[] {
  const result: EquipmentFolderNode[] = [];
  const walk = (list: readonly EquipmentFolderNode[]) => {
    for (const node of list) {
      result.push(node);
      if (node.children?.length && expandedIds.has(node.id)) walk(node.children);
    }
  };
  walk(nodes);
  return result;
}
