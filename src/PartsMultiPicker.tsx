import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { m2Api, type InventoryPartRecord } from "./m2-api.js";

export interface SelectedTaskPart {
  readonly partId: string;
  readonly articleNumber: string;
  readonly name: string;
  readonly quantity: number;
  readonly availableQuantity: number;
}

function formatStock(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
}

function stockTone(available: number): "ok" | "low" | "empty" {
  if (available <= 0) return "empty";
  if (available < 1) return "low";
  return "ok";
}

export function PartsMultiPicker({
  value,
  onChange,
  warranty = false,
  forSale = false,
  onWarrantyChange,
  onForSaleChange
}: {
  readonly value: readonly SelectedTaskPart[];
  readonly onChange: (next: readonly SelectedTaskPart[]) => void;
  readonly warranty?: boolean;
  readonly forSale?: boolean;
  readonly onWarrantyChange?: (next: boolean) => void;
  readonly onForSaleChange?: (next: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [parts, setParts] = useState<readonly InventoryPartRecord[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedIds = useMemo(() => new Set(value.map((item) => item.partId)), [value]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void m2Api.inventoryParts(false)
      .then((items) => {
        if (!cancelled) setParts(items.filter((item) => item.isActive));
      })
      .catch(() => {
        if (!cancelled) setParts([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ru-RU");
    const list = normalized
      ? parts.filter((part) => {
        const haystack = `${part.articleNumber} ${part.name}`.toLocaleLowerCase("ru-RU");
        return haystack.includes(normalized);
      })
      : parts;
    return [...list].sort((left, right) => {
      const leftSelected = selectedIds.has(left.id) ? 0 : 1;
      const rightSelected = selectedIds.has(right.id) ? 0 : 1;
      if (leftSelected !== rightSelected) return leftSelected - rightSelected;
      return left.name.localeCompare(right.name, "ru");
    });
  }, [parts, query, selectedIds]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [query, open]);

  const togglePart = (part: InventoryPartRecord) => {
    if (selectedIds.has(part.id)) {
      onChange(value.filter((item) => item.partId !== part.id));
      return;
    }
    onChange([
      ...value,
      {
        partId: part.id,
        articleNumber: part.articleNumber,
        name: part.name,
        quantity: 1,
        availableQuantity: part.availableQuantity
      }
    ]);
  };

  const removePart = (partId: string) => {
    onChange(value.filter((item) => item.partId !== partId));
  };

  const changeQuantity = (partId: string, raw: string) => {
    const parsed = Number(raw.replace(",", "."));
    const quantity = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    onChange(value.map((item) => item.partId === partId ? { ...item, quantity } : item));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlightIndex((current) => Math.min(current + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlightIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const highlighted = filtered[highlightIndex];
      if (open && highlighted) {
        event.preventDefault();
        togglePart(highlighted);
      }
      return;
    }
    if (event.key === "Backspace" && !query && value.length > 0) {
      removePart(value[value.length - 1]!.partId);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="parts-multi-picker" ref={rootRef}>
      {value.length > 0 ? (
        <ul className="parts-multi-picker__chips">
          {value.map((item) => {
            const tone = stockTone(item.availableQuantity);
            return (
              <li className="parts-multi-picker__chip" key={item.partId}>
                <div className="parts-multi-picker__chip-main">
                  <strong>{item.name}</strong>
                  <small>
                    {item.articleNumber}
                    <span className={`parts-multi-picker__stock parts-multi-picker__stock--${tone}`}>
                      {tone === "empty" ? "нет на складе" : `на складе ${formatStock(item.availableQuantity)}`}
                    </span>
                  </small>
                </div>
                <label className="parts-multi-picker__qty">
                  <span className="sr-only">Количество {item.name}</span>
                  <input
                    inputMode="decimal"
                    min={0.001}
                    onChange={(event) => changeQuantity(item.partId, event.target.value)}
                    step="any"
                    type="number"
                    value={item.quantity}
                  />
                </label>
                <button
                  aria-label={`Убрать ${item.name}`}
                  className="parts-multi-picker__remove"
                  onClick={() => removePart(item.partId)}
                  type="button"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="parts-multi-picker__search-wrap">
        <div className="parts-multi-picker__search">
          <input
            aria-autocomplete="list"
            aria-controls="parts-multi-picker-list"
            aria-expanded={open}
            aria-label="Поиск запчастей"
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Артикул или название запчасти"
            role="combobox"
            type="search"
            value={query}
          />
          {value.length > 0 ? (
            <span className="parts-multi-picker__count">{value.length}</span>
          ) : null}
        </div>

        {open ? (
          <div className="parts-multi-picker__list" id="parts-multi-picker-list" role="listbox">
            {loading ? (
              <p className="parts-multi-picker__empty">Загружаем склад…</p>
            ) : filtered.length === 0 ? (
              <p className="parts-multi-picker__empty">
                {parts.length === 0 ? "На складе пока нет позиций" : "По запросу ничего не найдено"}
              </p>
            ) : (
              <ul>
                {filtered.map((part, index) => {
                  const selected = selectedIds.has(part.id);
                  const tone = stockTone(part.availableQuantity);
                  const highlighted = index === highlightIndex;
                  return (
                    <li key={part.id}>
                      <button
                        aria-selected={selected}
                        className={[
                          "parts-multi-picker__option",
                          selected ? "is-selected" : "",
                          highlighted ? "is-active" : "",
                          tone === "empty" ? "is-out" : ""
                        ].filter(Boolean).join(" ")}
                        onClick={() => togglePart(part)}
                        onMouseEnter={() => setHighlightIndex(index)}
                        role="option"
                        type="button"
                      >
                        <span className="parts-multi-picker__check" aria-hidden="true">
                          {selected ? "✓" : ""}
                        </span>
                        <span className="parts-multi-picker__option-text">
                          <strong>{part.name}</strong>
                          <small>{part.articleNumber}</small>
                        </span>
                        <span className={`parts-multi-picker__stock parts-multi-picker__stock--${tone}`}>
                          {tone === "empty" ? "0" : formatStock(part.availableQuantity)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      <p className="parts-multi-picker__hint">Это запчасти, которые понадобятся на выезде. Со склада сразу ничего не списываем.</p>
      <div className="parts-multi-picker__flags">
        <label className="parts-multi-picker__flag">
          <input
            checked={warranty}
            onChange={(event) => onWarrantyChange?.(event.target.checked)}
            type="checkbox"
          />
          <span>Гарантийный</span>
        </label>
        <label className="parts-multi-picker__flag">
          <input
            checked={forSale}
            onChange={(event) => onForSaleChange?.(event.target.checked)}
            type="checkbox"
          />
          <span>Для продажи</span>
        </label>
      </div>
    </div>
  );
}
