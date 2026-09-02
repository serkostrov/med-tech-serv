import type { ContactOption, PayerOption, SiteOption } from "./customer-selection.js";

/** Единый человек площадки: контактные данные и реквизиты для счетов. */
export interface SitePerson {
  readonly key: string;
  readonly contactId?: string;
  readonly payerId?: string;
  readonly fullName: string;
  readonly phone?: string;
  readonly email?: string;
  readonly inn?: string;
  readonly kpp?: string;
  readonly isPrimary: boolean;
  readonly isActive: boolean;
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function personDetails(person: Pick<SitePerson, "phone" | "email" | "inn" | "kpp">): string {
  const parts = [
    person.phone,
    person.email,
    person.inn ? `ИНН ${person.inn}` : undefined,
    person.kpp ? `КПП ${person.kpp}` : undefined
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Телефон и реквизиты не указаны";
}

export function formatSitePersonDetails(person: SitePerson): string {
  return personDetails(person);
}

/** Собирает людей площадки: контакты + привязанные плательщики без отдельного контакта. */
export function sitePeople(site: SiteOption): readonly SitePerson[] {
  const linkedPayerIds = new Set<string>();
  const fromContacts: SitePerson[] = site.contacts.map((contact) => {
    if (contact.payerId) linkedPayerIds.add(contact.payerId);
    const linked = contact.payerId
      ? site.payers.find((payer) => payer.id === contact.payerId)
      : site.payers.find((payer) => normalizedName(payer.name) === normalizedName(contact.fullName));
    if (linked) linkedPayerIds.add(linked.id);
    return {
      key: `contact:${contact.id}`,
      contactId: contact.id,
      ...(linked ? { payerId: linked.id } : contact.payerId ? { payerId: contact.payerId } : {}),
      fullName: contact.fullName,
      phone: contact.phone,
      email: contact.email,
      inn: contact.inn ?? linked?.inn,
      kpp: contact.kpp ?? linked?.kpp,
      isPrimary: contact.isPrimary,
      isActive: contact.isActive && (linked ? linked.isActive : true)
    };
  });

  const fromPayers: SitePerson[] = site.payers
    .filter((payer) => !linkedPayerIds.has(payer.id))
    .map((payer) => ({
      key: `payer:${payer.id}`,
      payerId: payer.id,
      fullName: payer.name,
      inn: payer.inn,
      kpp: payer.kpp,
      isPrimary: false,
      isActive: payer.isActive
    }));

  return [...fromContacts, ...fromPayers].sort((left, right) => {
    if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
    if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
    return left.fullName.localeCompare(right.fullName, "ru");
  });
}

export function orphanPayers(sites: readonly SiteOption[], payers: readonly PayerOption[]): readonly PayerOption[] {
  const linked = new Set<string>();
  for (const site of sites) {
    for (const payer of site.payers) linked.add(payer.id);
    for (const contact of site.contacts) if (contact.payerId) linked.add(contact.payerId);
  }
  return payers.filter((payer) => !linked.has(payer.id));
}

export type { ContactOption };
