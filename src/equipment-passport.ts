export interface EquipmentPassportListItem {
  readonly id: string;
  readonly serial: string;
}

/** Совпадает с правилом generated column API/БД: регистр и пробелы не различают S/N. */
export function normalizeEquipmentSerial(value: string): string {
  return value.replace(/\s+/gu, "").toUpperCase();
}

export function hasEquipmentSerialConflict(
  records: readonly EquipmentPassportListItem[],
  serial: string,
  editedId?: string
): boolean {
  const normalized = normalizeEquipmentSerial(serial);
  return normalized.length > 0 && records.some((record) => (
    record.id !== editedId && normalizeEquipmentSerial(record.serial) === normalized
  ));
}
