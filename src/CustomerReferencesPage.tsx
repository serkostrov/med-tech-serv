import { EntityLink } from "./entity-links.js";
import React, { useEffect, useMemo, useState, type FormEvent } from "react";
import type { PayerOption, SiteOption } from "./customer-selection.js";
import { m2Api } from "./m2-api.js";
import { RegistryPagination, usePageSize } from "./RegistryPagination.js";
import { formatRussianCount } from "./equipment-changes.js";
import { assertRequisites } from "./requisites.js";
import {
  formatSitePersonDetails,
  orphanPayers as collectOrphanPayers,
  sitePeople,
  type SitePerson
} from "./site-people.js";
import {
  AutoTextarea,
  Button,
  IconButton,
  PageTabs,
  ConfirmationDialog,
  DialogForm,
  ResourceState,
  StatusBadge,
  Select,
  toast
} from "./ui.js";

type Editor =
  | { readonly kind: "site"; readonly id?: string }
  | { readonly kind: "person"; readonly siteId: string; readonly person?: SitePerson }
  | { readonly kind: "adopt"; readonly payerId: string };

interface PendingStateChange {
  readonly kind: "site" | "person";
  readonly siteId?: string;
  readonly person?: SitePerson;
  readonly id: string;
  readonly label: string;
  readonly isActive: boolean;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function siteTypeLabel(type: SiteOption["type"]): string {
  return type === "medical_facility" ? "Медучреждение" : "Компания группы";
}

function peopleCountLabel(count: number): string {
  return formatRussianCount(count, ["человек", "человека", "человек"]);
}

export function CustomerReferencesPage() {
  const [sites, setSites] = useState<readonly SiteOption[]>([]);
  const [payers, setPayers] = useState<readonly PayerOption[]>([]);
  // Раскрытые площадки: по умолчанию все свёрнуты, чтобы список читался целиком.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [search, setSearch] = useState("");
  // Постранично (18.11). Хуки — до раннего выхода «загружаем»: порядок хуков не должен меняться.
  const { pageSize: sitePageSize, setPageSize: setSitePageSize } = usePageSize("customers");
  const [sitePageIndex, setSitePageIndex] = useState(0);
  // Во время поиска найденные площадки раскрыты; щелчок по заголовку сворачивает их.
  const [closedInSearch, setClosedInSearch] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { setClosedInSearch(new Set()); }, [search]);
  const [showInactive, setShowInactive] = useState(false);
  // «Без площадки» — своей вкладкой, а не под списком: при сотнях клиентов до него не доскроллить
  // (вторая встреча 18.11).
  const [tab, setTab] = useState<"sites" | "orphans">("sites");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pendingStateChange, setPendingStateChange] = useState<PendingStateChange | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const editedSite = editor?.kind === "site" ? sites.find((site) => site.id === editor.id) : undefined;
  const editedPerson = editor?.kind === "person" ? editor.person : undefined;
  const orphanPayers = useMemo(() => collectOrphanPayers(sites, payers), [sites, payers]);

  const reload = async () => {
    setLoading(true);
    try {
      const [loadedSites, loadedPayers] = await Promise.all([m2Api.listSites(true), m2Api.listPayers(true)]);
      setSites(loadedSites);
      setPayers(loadedPayers);
      setCollapsed((current) => {
        const next = new Set<string>();
        for (const id of current) if (loadedSites.some((site) => site.id === id)) next.add(id);
        return next;
      });
    } catch (loadError) {
      toast.error(message(loadError, "Не получилось загрузить площадки и людей"), { title: "Список не загрузился" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  const togglePeople = (siteId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(siteId)) next.delete(siteId);
      else next.add(siteId);
      return next;
    });
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) return;
    const data = new FormData(event.currentTarget);
    setSaving(true);
    setFormError(null);
    try {
      if (editor.kind === "site") {
        const name = String(data.get("name") ?? "").trim();
        const address = String(data.get("address") ?? "").trim();
        const notes = String(data.get("notes") ?? "").trim();
        const type = data.get("type") === "group_company" ? "group_company" as const : "medical_facility" as const;
        if (editor.id) await m2Api.updateSite(editor.id, { name, address, type, notes: notes || null });
        else await m2Api.createSite({ name, address, type, ...(notes ? { notes } : {}) });
      } else if (editor.kind === "person") {
        const fullName = String(data.get("fullName") ?? "").trim();
        const phone = String(data.get("phone") ?? "").trim();
        const email = String(data.get("email") ?? "").trim();
        const inn = String(data.get("inn") ?? "").trim();
        const kpp = String(data.get("kpp") ?? "").trim();
        // Проверяем только то, что человек сейчас вписал: база так же пропускает старую
        // запись с мусором в ИНН, пока реквизиты не меняют (миграция 0036).
        if (inn !== (editor.person?.inn ?? "") || kpp !== (editor.person?.kpp ?? "")) {
          assertRequisites({ ...(inn ? { inn } : {}), ...(kpp ? { kpp } : {}) });
        }
        if (editor.person) {
          await m2Api.updateSitePerson(editor.siteId, {
            contactId: editor.person.contactId,
            payerId: editor.person.payerId,
            fullName,
            ...(phone ? { phone } : {}),
            ...(email ? { email } : {}),
            ...(inn ? { inn } : {}),
            ...(kpp ? { kpp } : {})
          });
        } else {
          await m2Api.createSitePerson(editor.siteId, {
            fullName,
            ...(phone ? { phone } : {}),
            ...(email ? { email } : {}),
            ...(inn ? { inn } : {}),
            ...(kpp ? { kpp } : {})
          });
        }
      } else {
        const siteId = String(data.get("siteId") ?? "").trim();
        if (!siteId) throw new Error("Выберите площадку");
        await m2Api.adoptOrphanPayer(siteId, editor.payerId);
      }
      await reload();
      setEditor(null);
    } catch (writeError) {
      const text = message(writeError, "Не получилось сохранить");
      setFormError(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  };

  const changeState = async () => {
    if (!pendingStateChange) return;
    setSaving(true);
    try {
      if (pendingStateChange.kind === "site") {
        if (pendingStateChange.isActive) await m2Api.removeSite(pendingStateChange.id);
        else await m2Api.updateSite(pendingStateChange.id, { isActive: true });
      } else {
        if (!pendingStateChange.siteId || !pendingStateChange.person) throw new Error("Площадка не выбрана");
        await m2Api.setSitePersonActive(
          pendingStateChange.siteId,
          {
            contactId: pendingStateChange.person.contactId,
            payerId: pendingStateChange.person.payerId
          },
          !pendingStateChange.isActive
        );
      }
      await reload();
      setPendingStateChange(null);
    } catch (writeError) {
      toast.error(message(writeError, "Не получилось изменить запись"));
    } finally {
      setSaving(false);
    }
  };

  if (loading && sites.length === 0) {
    return <ResourceState description="Подождите, площадки и люди сейчас появятся." status="loading" title="Загружаем клиентов" />;
  }

  // Поиск по площадке, адресу и людям; найденные площадки раскрываются сами.
  const query = search.trim().toLocaleLowerCase("ru-RU");
  const visibleSites = sites.filter((site) => {
    if (!showInactive && !site.isActive) return false;
    if (!query) return true;
    const haystack = [site.name, site.address, ...sitePeople(site).flatMap((person) => [person.fullName, person.phone, person.email, person.inn])].filter(Boolean).join(" ").toLocaleLowerCase("ru-RU");
    return haystack.includes(query);
  });
  const inactiveCount = sites.filter((site) => !site.isActive).length;
  const sitePageShown = Math.min(sitePageIndex, Math.max(0, Math.ceil(visibleSites.length / sitePageSize) - 1));
  const sitePage = visibleSites.slice(sitePageShown * sitePageSize, (sitePageShown + 1) * sitePageSize);

  const visibleOrphans = orphanPayers.filter((payer) => !query
    || [payer.name, payer.inn, payer.kpp].filter(Boolean).join(" ").toLocaleLowerCase("ru-RU").includes(query));
  const shownTab = orphanPayers.length > 0 ? tab : "sites";

  return <>
    <div className="customer-references">
      {orphanPayers.length > 0 ? <PageTabs
        items={[
          { value: "sites" as const, label: "Площадки", badge: visibleSites.length },
          { value: "orphans" as const, label: "Без площадки", badge: visibleOrphans.length }
        ]}
        label="Клиенты"
        onValueChange={setTab}
        value={shownTab}
      /> : null}
      <div className="registry-toolbar">
        <label className="registry-toolbar__search" htmlFor="customer-search">
          <span className="sr-only">Поиск клиентов</span>
          <input id="customer-search" onChange={(event) => { setSearch(event.target.value); setSitePageIndex(0); }} placeholder="Площадка, адрес, человек или ИНН" type="search" value={search} />
        </label>
        {shownTab === "sites" && inactiveCount > 0 ? <button aria-pressed={showInactive} className={`toggle-chip${showInactive ? " toggle-chip--on" : ""}`} onClick={() => setShowInactive((value) => !value)} type="button">Отключённые · {inactiveCount}</button> : null}
        <span className="registry-toolbar__spacer" />
        <Button icon="plus" onClick={() => { setFormError(null); setEditor({ kind: "site" }); }}>Добавить площадку</Button>
      </div>

      {shownTab === "orphans" ? null : sites.length === 0
        ? <ResourceState description="Нужна, чтобы указывать место работ в заявках. Добавьте первую площадку кнопкой сверху." status="empty" title="Площадок пока нет" />
        : visibleSites.length === 0
          ? <ResourceState description="Измените поиск или покажите отключённые площадки." status="filtered-empty" title="Ничего не найдено" />
          : <div className="customer-site-list">
          {sitePage.map((site) => {
            const people = sitePeople(site);
            const peopleOpen = query ? !closedInSearch.has(site.id) : collapsed.has(site.id);
            const activePeople = people.filter((person) => person.isActive).length;
            return <article className={`customer-site-card${site.isActive ? "" : " customer-site-card--inactive"}`} key={site.id}>
              <header className="customer-site-card__header">
                <div className="customer-site-card__lead">
                  {/* Стрелка раскрывает людей площадки, название открывает страницу клиента
                      (вторая встреча 18.11: по названию страница клиента не открывалась). */}
                  <button
                    aria-controls={`site-people-${site.id}`}
                    aria-expanded={peopleOpen}
                    aria-label={peopleOpen ? `Свернуть людей: ${site.name}` : `Показать людей: ${site.name}`}
                    className="customer-site-card__toggle"
                    onClick={() => {
                      if (!query) { togglePeople(site.id); return; }
                      setClosedInSearch((current) => { const next = new Set(current); if (next.has(site.id)) next.delete(site.id); else next.add(site.id); return next; });
                    }}
                    type="button"
                  >
                    <span aria-hidden="true" className={`customer-site-card__chevron${peopleOpen ? " is-open" : ""}`} />
                  </button>
                  <span className="customer-site-card__title">
                    <EntityLink target={{ kind: "site", id: site.id }}><strong>{site.name}</strong></EntityLink>
                    <small>{siteTypeLabel(site.type)} · {site.address || "Адрес не указан"}</small>
                  </span>
                </div>
                <div className="customer-site-card__meta">
                  <StatusBadge tone={site.isActive ? "success" : "neutral"}>{site.isActive ? "Активна" : "Неактивна"}</StatusBadge>
                  <span className="customer-site-card__count">{peopleCountLabel(activePeople)}</span>
                  <div className="table-actions">
                    <IconButton icon="edit" label="Изменить площадку" onClick={() => { setFormError(null); setEditor({ kind: "site", id: site.id }); }} />
                    <IconButton
                      icon={site.isActive ? "disable" : "enable"}
                      label={site.isActive ? "Отключить площадку" : "Включить площадку"}
                      onClick={() => setPendingStateChange({ kind: "site", id: site.id, label: site.name, isActive: site.isActive })}
                    />
                  </div>
                </div>
              </header>

              {peopleOpen ? <div className="customer-site-card__people" id={`site-people-${site.id}`}>
                {people.length === 0
                  ? <p className="customer-site-card__empty">Людей пока нет.</p>
                  : <ul className="customer-people-list">
                    {people.map((person) => <li className={`customer-person${person.isActive ? "" : " is-inactive"}`} key={person.key}>
                      <div className="customer-person__body">
                        <div className="customer-person__line">
                          <strong>{person.fullName}</strong>
                          {person.isPrimary && person.isActive
                            ? <StatusBadge tone="info">Основной</StatusBadge>
                            : null}
                          {person.inn ? <StatusBadge tone="info">для счетов</StatusBadge> : null}
                          {!person.isActive
                            ? <StatusBadge tone="neutral">Неактивен</StatusBadge>
                            : null}
                        </div>
                        <p>{formatSitePersonDetails(person)}</p>
                      </div>
                      <div className="table-actions">
                        <IconButton icon="edit" label="Изменить" onClick={() => { setFormError(null); setEditor({ kind: "person", siteId: site.id, person }); }} />
                        <IconButton
                          icon={person.isActive ? "disable" : "enable"}
                          label={person.isActive ? "Отключить" : "Включить"}
                          onClick={() => setPendingStateChange({
                            kind: "person",
                            siteId: site.id,
                            person,
                            id: person.contactId ?? person.payerId ?? person.key,
                            label: person.fullName,
                            isActive: person.isActive
                          })}
                        />
                      </div>
                    </li>)}
                  </ul>}
                <div className="customer-site-card__actions">
                  <Button
                    className="button--compact"
                    disabled={!site.isActive}
                    icon="plus"
                    onClick={() => { setFormError(null); setEditor({ kind: "person", siteId: site.id }); }}
                    variant="secondary"
                  >
                    Добавить человека
                  </Button>
                </div>
              </div> : null}
            </article>;
          })}
          {/* Постранично (18.11), как письма и инженеры: площадок у сервиса сотни. */}
          <RegistryPagination alwaysShow ariaLabel="Страницы клиентов" onPageChange={setSitePageIndex} onPageSizeChange={(size) => { setSitePageSize(size); setSitePageIndex(0); }} pageIndex={sitePageShown} pageSize={sitePageSize} total={visibleSites.length} />
        </div>}

      {shownTab === "orphans" ? (visibleOrphans.length === 0
        ? <ResourceState description="Измените поиск." status="filtered-empty" title="Ничего не найдено" />
        : <section className="customer-orphans card">
        <ul className="customer-people-list customer-people-list--orphan">
          {visibleOrphans.map((payer) => <li className={`customer-person${payer.isActive ? "" : " is-inactive"}`} key={payer.id}>
            <div className="customer-person__body">
              <div className="customer-person__line">
                <strong>{payer.name}</strong>
                {!payer.isActive ? <StatusBadge tone="neutral">Неактивен</StatusBadge> : null}
              </div>
              <p>{formatSitePersonDetails({
                key: payer.id,
                fullName: payer.name,
                inn: payer.inn,
                kpp: payer.kpp,
                isPrimary: false,
                isActive: payer.isActive
              })}</p>
            </div>
            <div className="table-actions">
              <Button
                className="button--compact"
                disabled={!payer.isActive || sites.every((site) => !site.isActive)}
                onClick={() => { setFormError(null); setEditor({ kind: "adopt", payerId: payer.id }); }}
                variant="secondary"
              >
                К площадке
              </Button>
            </div>
          </li>)}
        </ul>
      </section>) : null}
    </div>

    <DialogForm
      busy={saving}
      description="Площадка будет доступна при создании заявок и в паспорте прибора."
      error={formError}
      onOpenChange={(open) => { if (!open) setEditor(null); }}
      onSubmit={save}
      open={editor?.kind === "site"}
      submitLabel={editedSite ? "Сохранить изменения" : "Добавить площадку"}
      title={editedSite ? "Изменить площадку" : "Новая площадка"}
    >
      <div className="dialog-form-grid">
        <label>Наименование<input defaultValue={editedSite?.name} name="name" required /></label>
        <label>Адрес<input defaultValue={editedSite?.address} name="address" required /></label>
        <label>Тип<Select defaultValue={editedSite?.type ?? "medical_facility"} name="type"><option value="medical_facility">Медучреждение</option><option value="group_company">Компания группы</option></Select></label>
        <label className="dialog-form-grid__wide">Примечание<AutoTextarea defaultValue={editedSite?.notes ?? ""} name="notes" rows={3} /></label>
      </div>
    </DialogForm>

    <DialogForm
      busy={saving}
      description="Один человек на площадке: телефон для выезда и реквизиты для счетов."
      error={formError}
      onOpenChange={(open) => { if (!open) setEditor(null); }}
      onSubmit={save}
      open={editor?.kind === "person"}
      submitLabel={editedPerson ? "Сохранить изменения" : "Добавить человека"}
      title={editedPerson ? "Изменить человека" : "Новый человек"}
    >
      <div className="dialog-form-grid">
        <label className="dialog-form-grid__wide">ФИО или наименование<input defaultValue={editedPerson?.fullName} name="fullName" required /></label>
        <label>Телефон<input defaultValue={editedPerson?.phone ?? ""} name="phone" /></label>
        <label>E-mail<input defaultValue={editedPerson?.email ?? ""} name="email" type="email" /></label>
        {/* Проверку держит база (миграция 0036); здесь подсказка и формат, чтобы не вводить мусор. */}
        {/* Без pattern: отказ браузера пишется на его языке, а наш — всегда по-русски и целой фразой. */}
        <label>ИНН<input defaultValue={editedPerson?.inn ?? ""} inputMode="numeric" maxLength={12} name="inn" placeholder="10 цифр, у предпринимателя 12" title="ИНН: 10 цифр у организации или 12 цифр у предпринимателя" /></label>
        <label>КПП<input defaultValue={editedPerson?.kpp ?? ""} maxLength={9} name="kpp" placeholder="9 знаков, например 773601001" title="КПП: 9 знаков, например 773601001" /></label>
      </div>
    </DialogForm>

    <DialogForm
      busy={saving}
      description="Запись появится в блоке площадки как обычный человек."
      error={formError}
      onOpenChange={(open) => { if (!open) setEditor(null); }}
      onSubmit={save}
      open={editor?.kind === "adopt"}
      submitLabel="Привязать"
      title="Привязать к площадке"
    >
      <div className="dialog-form-grid">
        <label className="dialog-form-grid__wide">Площадка
          <Select name="siteId" required defaultValue={sites.find((site) => site.isActive)?.id ?? ""}>
            {sites.filter((site) => site.isActive).map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </Select>
        </label>
      </div>
    </DialogForm>

    <ConfirmationDialog
      confirmLabel={pendingStateChange?.isActive ? "Отключить" : "Включить"}
      description={pendingStateChange ? (pendingStateChange.isActive ? `${pendingStateChange.label}: запись перестанет предлагаться в новых заявках, история сохранится.` : `${pendingStateChange.label}: запись снова можно будет выбирать в заявках.`) : ""}
      onConfirm={changeState}
      onOpenChange={(open) => { if (!open) setPendingStateChange(null); }}
      open={pendingStateChange !== null}
      title={pendingStateChange?.isActive ? "Отключить запись?" : "Включить запись?"}
      tone={pendingStateChange?.isActive ? "danger" : "primary"}
    />
  </>;
}
