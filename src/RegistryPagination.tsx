import React, { useRef, useState } from "react";
import { Select } from "./components/ui/select.js";
import { Button } from "./ui.js";

/** Сколько строк можно показать на странице списка. */
export const PAGE_SIZE_OPTIONS: readonly number[] = [10, 50, 100, 200];
export const DEFAULT_PAGE_SIZE = 50;

export function registryPageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function registryPageOffset(pageIndex: number, pageSize: number): number {
  return pageIndex * pageSize;
}

/** Сохранённый размер страницы, если он из списка допустимых; иначе размер по умолчанию. */
export function storedPageSize(value: string | null, fallback = DEFAULT_PAGE_SIZE): number {
  const size = Number(value);
  return PAGE_SIZE_OPTIONS.includes(size) ? size : fallback;
}

/**
 * Размер страницы списка. Выбор помним в этом браузере отдельно для каждого списка.
 * pageSizeRef нужен загрузкам, которые вызываются сразу после смены размера, до перерисовки.
 */
export function usePageSize(listKey: string): {
  readonly pageSize: number;
  readonly pageSizeRef: { readonly current: number };
  readonly setPageSize: (size: number) => void;
} {
  const storageKey = `mts.pageSize.${listKey}`;
  const [pageSize, setSize] = useState(() => {
    try {
      return storedPageSize(typeof window === "undefined" ? null : window.localStorage.getItem(storageKey));
    } catch {
      return DEFAULT_PAGE_SIZE;
    }
  });
  const pageSizeRef = useRef(pageSize);
  const setPageSize = (size: number) => {
    const next = storedPageSize(String(size));
    pageSizeRef.current = next;
    setSize(next);
    try {
      window.localStorage.setItem(storageKey, String(next));
    } catch {
      // Приватный режим или запрет хранилища: размер просто не запомнится.
    }
  };
  return { pageSize, pageSizeRef, setPageSize };
}

export function RegistryPagination({
  ariaLabel,
  onPageChange,
  onPageSizeChange,
  pageIndex,
  pageSize,
  total
}: {
  readonly ariaLabel: string;
  readonly onPageChange: (pageIndex: number) => void;
  /** Если передан, рядом со страницами можно выбрать, сколько строк показывать. */
  readonly onPageSizeChange?: (pageSize: number) => void;
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly total: number;
}) {
  const pages = registryPageCount(total, pageSize);
  // Выбор размера нужен, только когда строк больше самой маленькой страницы.
  const canChangeSize = Boolean(onPageSizeChange) && total > Math.min(...PAGE_SIZE_OPTIONS);
  if (pages <= 1 && !canChangeSize) return null;
  const first = total === 0 ? 0 : registryPageOffset(pageIndex, pageSize) + 1;
  const last = Math.min(total, registryPageOffset(pageIndex + 1, pageSize));
  return <div className="registry-pagination flex flex-wrap items-center justify-end gap-3 px-4 py-3 text-sm text-muted-foreground" aria-label={ariaLabel} role="navigation">
    {canChangeSize && onPageSizeChange ? <label className="registry-pagination__size">
      <span>Показывать по</span>
      <Select aria-label="Сколько строк показывать на странице" onChange={(event) => onPageSizeChange(Number(event.target.value))} value={String(pageSize)}>
        {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={String(size)}>{size}</option>)}
      </Select>
    </label> : null}
    <span className="registry-pagination__range">{first}–{last} из {total}</span>
    {pages > 1 ? <>
      <Button disabled={pageIndex === 0} onClick={() => onPageChange(pageIndex - 1)} variant="secondary">Назад</Button>
      <span>Страница {pageIndex + 1} из {pages}</span>
      <Button disabled={pageIndex + 1 >= pages} onClick={() => onPageChange(pageIndex + 1)} variant="secondary">Далее</Button>
    </> : null}
  </div>;
}
