import React, { useEffect, useState, type FormEvent } from "react";
import type { PayerOption, SiteOption } from "./customer-selection.js";
import { m2Api } from "./m2-api.js";
import {
  Button,
  IconButton,
  CardHeader,
  ConfirmationDialog,
  DialogForm,
  ResourceState,
  StatusBadge,
  Select,
  toast
} from "./ui.js";

type Editor =
  | { readonly kind: "site"; readonly id?: string }
  | { readonly kind: "contact"; readonly id?: string }
  | { readonly kind: "payer"; readonly id?: string };

interface PendingStateChange {
  readonly kind: "site" | "contact" | "payer";
  readonly id: string;
  readonly label: string;
  readonly isActive: boolean;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function CustomerReferencesPage() {
  const [sites, setSites] = useState<readonly SiteOption[]>([]);
  const [payers, setPayers] = useState<readonly PayerOption[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pendingStateChange, setPendingStateChange] = useState<PendingStateChange | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const selectedSite = sites.find((site) => site.id === selectedSiteId);
  const editedSite = editor?.kind === "site" ? sites.find((site) => site.id === editor.id) : undefined;
  const editedContact = editor?.kind === "contact" ? selectedSite?.contacts.find((contact) => contact.id === editor.id) : undefined;
  const editedPayer = editor?.kind === "payer" ? payers.find((payer) => payer.id === editor.id) : undefined;

  const reload = async () => {
    setLoading(true);
    try {
      const [loadedSites, loadedPayers] = await Promise.all([m2Api.listSites(true), m2Api.listPayers(true)]);
      setSites(loadedSites);
      setPayers(loadedPayers);
      setSelectedSiteId((current) => loadedSites.some((site) => site.id === current)
        ? current
        : loadedSites.find((site) => site.isActive)?.id ?? loadedSites[0]?.id ?? "");
    } catch (loadError) {
      toast.error(message(loadError, "Не получилось загрузить площадки и плательщиков"), { title: "Список не загрузился" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

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
        if (editor.id) {
          await m2Api.updateSite(editor.id, { name, address, type, notes: notes || null });
        } else {
          const created = await m2Api.createSite({ name, address, type, ...(notes ? { notes } : {}) });
          setSelectedSiteId(created.id);
        }
      } else if (editor.kind === "contact") {
        if (!selectedSite) throw new Error("Сначала выберите площадку");
        const fullName = String(data.get("fullName") ?? "").trim();
        const phone = String(data.get("phone") ?? "").trim();
        const email = String(data.get("email") ?? "").trim();
        if (editor.id) {
          await m2Api.updateContact(selectedSite.id, editor.id, { fullName, phone: phone || null, email: email || null });
        } else {
          await m2Api.createContact(selectedSite.id, {
            fullName,
            ...(phone ? { phone } : {}),
            ...(email ? { email } : {})
          });
        }
      } else {
        const name = String(data.get("name") ?? "").trim();
        const inn = String(data.get("inn") ?? "").trim();
        const kpp = String(data.get("kpp") ?? "").trim();
        const requisites = { ...(inn ? { inn } : {}), ...(kpp ? { kpp } : {}) };
        if (editor.id) await m2Api.updatePayer(editor.id, { name, requisites });
        else await m2Api.createPayer({ name, requisites });
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
      } else if (pendingStateChange.kind === "contact") {
        if (!selectedSite) throw new Error("Площадка не выбрана");
        if (pendingStateChange.isActive) await m2Api.removeContact(selectedSite.id, pendingStateChange.id);
        else await m2Api.updateContact(selectedSite.id, pendingStateChange.id, { isActive: true });
      } else if (pendingStateChange.isActive) {
        await m2Api.removePayer(pendingStateChange.id);
      } else {
        await m2Api.updatePayer(pendingStateChange.id, { isActive: true });
      }
      await reload();
      setPendingStateChange(null);
    } catch (writeError) {
      toast.error(message(writeError, "Не получилось изменить запись"));
    } finally {
      setSaving(false);
    }
  };

  return <>
    {loading && sites.length === 0 ? <ResourceState description="Подождите, площадки и плательщики сейчас появятся." status="loading" title="Загружаем клиентов" /> : null}
    {!loading || sites.length > 0 ? <div className="customer-references">
      <section className="card card--table customer-references__sites">
        <CardHeader
          action={<Button className="button--compact" icon="plus" onClick={() => { setFormError(null); setEditor({ kind: "site" }); }}>Добавить площадку</Button>}
          meta={`${sites.filter((item) => item.isActive).length} активных`}
          title="Площадки"
        />
        {sites.length === 0
          ? <ResourceState description="Нужна, чтобы указывать место работ в заявках. Добавьте первую площадку кнопкой сверху." status="empty" title="Площадок пока нет" />
          : <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Наименование</th><th>Адрес</th><th>Контакты</th><th>Статус</th><th aria-label="Действия" /></tr></thead>
              <tbody>{sites.map((site) => <tr aria-selected={site.id === selectedSiteId} className={site.id === selectedSiteId ? "data-table__selected data-table__selectable" : "data-table__selectable"} key={site.id} onClick={() => setSelectedSiteId(site.id)}>
                <td><strong>{site.name}</strong><small>{site.type === "medical_facility" ? "Медучреждение" : "Компания группы"}</small></td>
                <td>{site.address}</td><td>{site.contacts.filter((contact) => contact.isActive).length}</td>
                <td><StatusBadge tone={site.isActive ? "success" : "neutral"}>{site.isActive ? "Активна" : "Неактивна"}</StatusBadge></td>
                <td><div className="table-actions"><IconButton icon="edit" label="Изменить" onClick={(event) => { event.stopPropagation(); setFormError(null); setEditor({ kind: "site", id: site.id }); }} /><IconButton icon={site.isActive ? "disable" : "enable"} label={site.isActive ? "Отключить" : "Включить"} onClick={(event) => { event.stopPropagation(); setPendingStateChange({ kind: "site", id: site.id, label: site.name, isActive: site.isActive }); }} /></div></td>
              </tr>)}</tbody>
            </table>
          </div>}
      </section>

      <section className="card card--table customer-references__contacts">
        <CardHeader
          action={<Button className="button--compact" disabled={!selectedSite?.isActive} icon="plus" onClick={() => { setFormError(null); setEditor({ kind: "contact" }); }}>Добавить контакт</Button>}
          {...(selectedSite ? { meta: selectedSite.name } : {})}
          title="Контактные лица"
        />
        {!selectedSite
          ? <ResourceState description="Выберите площадку слева — здесь появятся её контакты." icon="info" status="empty" title="Сначала площадка" />
          : selectedSite.contacts.length === 0
            ? <ResourceState description="Нужен, чтобы инженеру было кому позвонить на площадке." status="empty" title="Контактных лиц пока нет" />
            : <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>ФИО</th><th>Телефон</th><th>E-mail</th><th>Статус</th><th aria-label="Действия" /></tr></thead>
                <tbody>{selectedSite.contacts.map((contact) => <tr key={contact.id}>
                  <td><strong>{contact.fullName}</strong></td><td>{contact.phone ?? "—"}</td><td>{contact.email ?? "—"}</td>
                  <td><StatusBadge tone={contact.isActive ? contact.isPrimary ? "info" : "success" : "neutral"}>{contact.isActive ? contact.isPrimary ? "Основной" : "Активен" : "Неактивен"}</StatusBadge></td>
                  <td><div className="table-actions"><IconButton icon="edit" label="Изменить" onClick={() => { setFormError(null); setEditor({ kind: "contact", id: contact.id }); }} /><IconButton icon={contact.isActive ? "disable" : "enable"} label={contact.isActive ? "Отключить" : "Включить"} onClick={() => setPendingStateChange({ kind: "contact", id: contact.id, label: contact.fullName, isActive: contact.isActive })} /></div></td>
                </tr>)}</tbody>
              </table>
            </div>}
      </section>

      <section className="card card--table customer-references__payers">
        <CardHeader action={<Button className="button--compact" icon="plus" onClick={() => { setFormError(null); setEditor({ kind: "payer" }); }}>Добавить плательщика</Button>} meta={`${payers.filter((item) => item.isActive).length} активных`} title="Плательщики" />
        {payers.length === 0
          ? <ResourceState description="Нужен, чтобы выставлять счета по заявкам. Добавьте первого плательщика кнопкой сверху." status="empty" title="Плательщиков пока нет" />
          : <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Наименование</th><th>ИНН</th><th>КПП</th><th>Статус</th><th aria-label="Действия" /></tr></thead>
              <tbody>{payers.map((payer) => <tr key={payer.id}><td><strong>{payer.name}</strong></td><td>{payer.inn ?? "—"}</td><td>{payer.kpp ?? "—"}</td><td><StatusBadge tone={payer.isActive ? "success" : "neutral"}>{payer.isActive ? "Активен" : "Неактивен"}</StatusBadge></td><td><div className="table-actions"><IconButton icon="edit" label="Изменить" onClick={() => { setFormError(null); setEditor({ kind: "payer", id: payer.id }); }} /><IconButton icon={payer.isActive ? "disable" : "enable"} label={payer.isActive ? "Отключить" : "Включить"} onClick={() => setPendingStateChange({ kind: "payer", id: payer.id, label: payer.name, isActive: payer.isActive })} /></div></td></tr>)}</tbody>
            </table>
          </div>}
      </section>
    </div> : null}

    <DialogForm busy={saving} description="Площадка будет доступна при создании заявок и в паспорте прибора." error={formError} onOpenChange={(open) => { if (!open) setEditor(null); }} onSubmit={save} open={editor?.kind === "site"} submitLabel={editedSite ? "Сохранить изменения" : "Добавить площадку"} title={editedSite ? "Изменить площадку" : "Новая площадка"}>
      <div className="dialog-form-grid"><label>Наименование<input defaultValue={editedSite?.name} name="name" required /></label><label>Адрес<input defaultValue={editedSite?.address} name="address" required /></label><label>Тип<Select defaultValue={editedSite?.type ?? "medical_facility"} name="type"><option value="medical_facility">Медучреждение</option><option value="group_company">Компания группы</option></Select></label><label className="dialog-form-grid__wide">Примечание<textarea defaultValue={editedSite?.notes ?? ""} name="notes" rows={3} /></label></div>
    </DialogForm>
    <DialogForm busy={saving} description="Контакт появится в карточке площадки и в заявках." error={formError} onOpenChange={(open) => { if (!open) setEditor(null); }} onSubmit={save} open={editor?.kind === "contact"} submitLabel={editedContact ? "Сохранить изменения" : "Добавить контакт"} title={editedContact ? "Изменить контакт" : "Новый контакт"}>
      <div className="dialog-form-grid"><label className="dialog-form-grid__wide">ФИО<input defaultValue={editedContact?.fullName} name="fullName" required /></label><label>Телефон<input defaultValue={editedContact?.phone ?? ""} name="phone" /></label><label>E-mail<input defaultValue={editedContact?.email ?? ""} name="email" type="email" /></label></div>
    </DialogForm>
    <DialogForm busy={saving} description="Плательщик подставится в заявки и счета." error={formError} onOpenChange={(open) => { if (!open) setEditor(null); }} onSubmit={save} open={editor?.kind === "payer"} submitLabel={editedPayer ? "Сохранить изменения" : "Добавить плательщика"} title={editedPayer ? "Изменить плательщика" : "Новый плательщик"}>
      <div className="dialog-form-grid"><label className="dialog-form-grid__wide">Наименование<input defaultValue={editedPayer?.name} name="name" required /></label><label>ИНН<input defaultValue={editedPayer?.inn ?? ""} inputMode="numeric" name="inn" /></label><label>КПП<input defaultValue={editedPayer?.kpp ?? ""} inputMode="numeric" name="kpp" /></label></div>
    </DialogForm>
    <ConfirmationDialog confirmLabel={pendingStateChange?.isActive ? "Отключить" : "Включить"} description={pendingStateChange ? `${pendingStateChange.label}: для новых заявок запись скроется, история сохранится.` : ""} onConfirm={changeState} onOpenChange={(open) => { if (!open) setPendingStateChange(null); }} open={pendingStateChange !== null} title={pendingStateChange?.isActive ? "Отключить запись?" : "Включить запись?"} tone={pendingStateChange?.isActive ? "danger" : "primary"} />
  </>;
}
