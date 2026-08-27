export interface EquipmentRegistryItem {
  readonly serial: string;
  readonly model: string;
  readonly manufacturer: string;
  readonly organization: string;
  readonly place: string;
  readonly payer: string;
  readonly status: string;
}

export interface EquipmentRegistryFilters {
  readonly search: string;
  readonly manufacturer: string;
  readonly status: string;
  readonly site: string;
  readonly payer: string;
}

export const EMPTY_EQUIPMENT_REGISTRY_FILTERS: EquipmentRegistryFilters = {
  search: "",
  manufacturer: "",
  status: "",
  site: "",
  payer: ""
};

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("ru-RU").replace(/\s+/gu, " ");
}

function searchMatches(item: EquipmentRegistryItem, search: string): boolean {
  const tokens = normalized(search).split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalized([
    item.serial,
    item.serial.replace(/\s+/gu, ""),
    item.model,
    item.manufacturer,
    item.organization,
    item.place,
    item.payer
  ].join(" "));
  return tokens.every((token) => haystack.includes(token.replace(/\s+/gu, "")));
}

export function filterEquipmentRegistry<Item extends EquipmentRegistryItem>(
  items: readonly Item[],
  filters: EquipmentRegistryFilters
): readonly Item[] {
  const manufacturer = normalized(filters.manufacturer);
  const status = normalized(filters.status);
  const site = normalized(filters.site);
  const payer = normalized(filters.payer);
  return items
    .filter((item) => searchMatches(item, filters.search))
    .filter((item) => !manufacturer || normalized(item.manufacturer) === manufacturer)
    .filter((item) => !status || normalized(item.status) === status)
    .filter((item) => !site || normalized(item.place) === site)
    .filter((item) => !payer || normalized(item.payer) === payer);
}

function unique(items: readonly string[]): readonly string[] {
  return [...new Set(items.filter(Boolean))].sort((left, right) => left.localeCompare(right, "ru"));
}

export function equipmentRegistryFilterOptions(items: readonly EquipmentRegistryItem[]) {
  return {
    manufacturers: unique(items.map((item) => item.manufacturer)),
    statuses: unique(items.map((item) => item.status)),
    sites: unique(items.map((item) => item.place)),
    payers: unique(items.map((item) => item.payer))
  };
}
