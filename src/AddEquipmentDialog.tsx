import React, { useEffect, useMemo, useState, type FormEvent } from "react";
import type { SiteOption } from "./customer-selection.js";
import { m2Api, type EquipmentPassportReferences } from "./m2-api.js";
import { AutoTextarea, Button, DialogForm, Select, toast } from "./ui.js";

type DraftKind = "manufacturer" | "model" | null;

export function AddEquipmentDialog({
  open,
  saving,
  error,
  references,
  sites = [],
  manufacturerId,
  modelId,
  availableModels,
  onOpenChange,
  onManufacturerChange,
  onModelChange,
  onReferencesChange,
  onSubmit
}: {
  readonly open: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly references: EquipmentPassportReferences;
  readonly sites?: readonly SiteOption[];
  readonly manufacturerId: string;
  readonly modelId: string;
  readonly availableModels: readonly EquipmentPassportReferences["models"][number][];
  readonly onOpenChange: (open: boolean) => void;
  readonly onManufacturerChange: (manufacturerId: string) => void;
  readonly onModelChange: (modelId: string) => void;
  readonly onReferencesChange: (next: EquipmentPassportReferences) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const [draftKind, setDraftKind] = useState<DraftKind>(null);
  const [draftName, setDraftName] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [siteId, setSiteId] = useState("");
  const activeSites = useMemo(() => sites.filter((item) => item.isActive), [sites]);
  const sitePayers = useMemo(() => {
    const site = activeSites.find((item) => item.id === siteId);
    return (site?.payers ?? []).filter((item) => item.isActive);
  }, [activeSites, siteId]);

  useEffect(() => {
    if (!open) {
      setDraftKind(null);
      setDraftName("");
      setDraftError(null);
      setSiteId("");
      return;
    }
    setSiteId((current) => current || activeSites[0]?.id || "");
  }, [open, activeSites]);

  const openDraft = (kind: Exclude<DraftKind, null>) => {
    if (kind === "model" && !manufacturerId) {
      setDraftError("Сначала выберите производителя");
      return;
    }
    setDraftKind(kind);
    setDraftName("");
    setDraftError(null);
  };

  const cancelDraft = () => {
    setDraftKind(null);
    setDraftName("");
    setDraftError(null);
  };

  const submitDraft = async () => {
    const name = draftName.trim();
    if (!name) {
      setDraftError("Укажите название");
      return;
    }
    if (draftKind === "manufacturer") {
      const exists = references.manufacturers.some(
        (item) => item.name.toLocaleLowerCase("ru-RU") === name.toLocaleLowerCase("ru-RU")
      );
      if (exists) {
        setDraftError("Такой производитель уже есть");
        return;
      }
    }
    if (draftKind === "model") {
      if (!manufacturerId) {
        setDraftError("Сначала выберите производителя");
        return;
      }
      const exists = references.models.some(
        (item) => item.manufacturerId === manufacturerId
          && item.name.toLocaleLowerCase("ru-RU") === name.toLocaleLowerCase("ru-RU")
      );
      if (exists) {
        setDraftError("Такая модель уже есть у этого производителя");
        return;
      }
    }
    setDraftBusy(true);
    setDraftError(null);
    try {
      if (draftKind === "manufacturer") {
        const created = await m2Api.createCatalogValue("manufacturers", { name });
        const passport = await m2Api.passportReferences();
        onReferencesChange(passport);
        onManufacturerChange(created.id);
        toast.success("Производитель добавлен");
      } else if (draftKind === "model") {
        const created = await m2Api.createCatalogValue("equipment-models", {
          name,
          attributes: { manufacturerId }
        });
        const passport = await m2Api.passportReferences();
        onReferencesChange(passport);
        onModelChange(created.id);
        toast.success("Модель добавлена");
      }
      cancelDraft();
    } catch (createError) {
      setDraftError(createError instanceof Error ? createError.message : "Не получилось добавить запись");
    } finally {
      setDraftBusy(false);
    }
  };

  return (
    <DialogForm
      busy={saving || draftBusy}
      description="Укажите S/N, модель и площадку — без площадки инициатор и клиент в задаче будут недоступны."
      error={error}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      open={open}
      size="lg"
      submitLabel="Добавить прибор"
      title="Новый прибор"
    >
      <label className="field-wide">
        S/N *
        <input autoFocus maxLength={200} name="serialNumber" placeholder="Например, BS620-001" required />
        <small>Серийный номер должен быть уникальным.</small>
      </label>

      <div className="add-equipment-field">
        <div className="add-equipment-field__head">
          <span>Производитель *</span>
          <Button
            disabled={draftBusy || saving}
            onClick={() => openDraft("manufacturer")}
            type="button"
            variant="ghost"
          >
            + Новый
          </Button>
        </div>
        <Select
          name="manufacturerId"
          onChange={(event) => onManufacturerChange(event.target.value)}
          required
          value={manufacturerId}
        >
          {references.manufacturers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
      </div>

      <div className="add-equipment-field">
        <div className="add-equipment-field__head">
          <span>Модель *</span>
          <Button
            disabled={draftBusy || saving || !manufacturerId}
            onClick={() => openDraft("model")}
            type="button"
            variant="ghost"
          >
            + Новый
          </Button>
        </div>
        <Select
          name="modelId"
          onChange={(event) => onModelChange(event.target.value)}
          required
          value={modelId}
        >
          {availableModels.length === 0 ? <option value="">Нет моделей</option> : null}
          {availableModels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
      </div>

      {draftKind ? (
        <div className="add-equipment-draft field-wide">
          <strong>{draftKind === "manufacturer" ? "Новый производитель" : "Новая модель"}</strong>
          <div className="add-equipment-draft__row">
            <input
              autoFocus
              maxLength={200}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitDraft();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelDraft();
                }
              }}
              placeholder={draftKind === "manufacturer" ? "Например, Siemens Healthineers" : "Например, Atellica CH 930"}
              value={draftName}
            />
            <Button busy={draftBusy} onClick={() => void submitDraft()} type="button">Добавить</Button>
            <Button disabled={draftBusy} onClick={cancelDraft} type="button" variant="secondary">Отмена</Button>
          </div>
          {draftError ? <p className="form-error" role="alert">{draftError}</p> : null}
          {draftKind === "model" ? (
            <small>Модель будет привязана к выбранному производителю.</small>
          ) : null}
        </div>
      ) : null}

      <label>
        Площадка *
        <Select
          name="siteId"
          onChange={(event) => setSiteId(event.target.value)}
          required
          value={siteId}
        >
          {activeSites.length === 0 ? <option value="">Нет площадок</option> : null}
          {activeSites.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
      </label>
      <label>
        Плательщик *
        <Select
          defaultValue={sitePayers[0]?.id ?? ""}
          key={`payer-${siteId}-${sitePayers[0]?.id ?? "none"}`}
          name="payerId"
          required
        >
          {sitePayers.length === 0 ? <option value="">Нет плательщиков на площадке</option> : null}
          {sitePayers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
      </label>

      <label>
        Категория гарантии *
        <Select defaultValue={references.guaranteeCategories[0]?.id ?? ""} name="guaranteeCategoryId" required>
          {references.guaranteeCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
      </label>
      <label>
        Статус *
        <Select defaultValue={references.statuses[0]?.code ?? "in_use"} name="status" required>
          {references.statuses.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
        </Select>
      </label>
      <label className="field-wide">
        Примечания
        <AutoTextarea maxLength={5000} name="notes" placeholder="Служебные сведения о приборе" rows={3} />
      </label>
    </DialogForm>
  );
}
