export type SiteOptionType = "medical_facility" | "group_company";

export interface ContactOption {
  readonly id: string;
  readonly fullName: string;
  readonly phone?: string;
  readonly email?: string;
  readonly isPrimary: boolean;
  readonly isActive: boolean;
  readonly payerId?: string;
  readonly inn?: string;
  readonly kpp?: string;
}

export interface SiteOption {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly type: SiteOptionType;
  readonly isActive: boolean;
  readonly notes?: string;
  readonly contacts: readonly ContactOption[];
  readonly payers: readonly PayerOption[];
}

export interface PayerOption {
  readonly id: string;
  readonly name: string;
  readonly inn?: string;
  readonly kpp?: string;
  readonly isActive: boolean;
}

export interface CustomerSelection {
  readonly siteId: string;
  readonly contactId?: string;
  readonly payerId?: string;
}

export interface CustomerSelectionSnapshot {
  readonly siteId: string;
  readonly siteName: string;
  readonly address: string;
  readonly contactId?: string;
  readonly contactName?: string;
  readonly contactPhone?: string;
  readonly contactEmail?: string;
  readonly payerId?: string;
  readonly payerName?: string;
}

/** Единое разрешение выбора для карточки задачи и предзаполнения акта. */
export function resolveCustomerSelection(
  sites: readonly SiteOption[],
  payers: readonly PayerOption[],
  selection: CustomerSelection
): CustomerSelectionSnapshot {
  const site = sites.find((item) => item.id === selection.siteId && item.isActive);
  if (!site) throw new Error("Выберите площадку");
  const contact = selection.contactId
    ? site.contacts.find((item) => item.id === selection.contactId && item.isActive)
    : site.contacts.find((item) => item.isPrimary && item.isActive) ?? site.contacts.find((item) => item.isActive);
  if (selection.contactId && !contact) {
    throw new Error("Контакт не относится к выбранной площадке");
  }
  const payer = selection.payerId ? payers.find((item) => item.id === selection.payerId && item.isActive) : undefined;
  if (selection.payerId && !payer) throw new Error("Выберите плательщика из справочника");
  return {
    siteId: site.id,
    siteName: site.name,
    address: site.address,
    ...(contact ? { contactId: contact.id, contactName: contact.fullName } : {}),
    ...(contact?.phone ? { contactPhone: contact.phone } : {}),
    ...(contact?.email ? { contactEmail: contact.email } : {}),
    ...(payer ? { payerId: payer.id, payerName: payer.name } : {})
  };
}
