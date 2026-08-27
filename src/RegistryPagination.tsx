import React from "react";
import { Button } from "./ui.js";

export function registryPageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function registryPageOffset(pageIndex: number, pageSize: number): number {
  return pageIndex * pageSize;
}

export function RegistryPagination({
  ariaLabel,
  onPageChange,
  pageIndex,
  pageSize,
  total
}: {
  readonly ariaLabel: string;
  readonly onPageChange: (pageIndex: number) => void;
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly total: number;
}) {
  const pages = registryPageCount(total, pageSize);
  if (pages <= 1) return null;
  return <div className="registry-pagination flex flex-wrap items-center justify-end gap-3 px-4 py-3 text-sm text-muted-foreground" aria-label={ariaLabel}>
    <Button disabled={pageIndex === 0} onClick={() => onPageChange(pageIndex - 1)} variant="secondary">Назад</Button>
    <span>Страница {pageIndex + 1} из {pages}</span>
    <Button disabled={pageIndex + 1 >= pages} onClick={() => onPageChange(pageIndex + 1)} variant="secondary">Далее</Button>
  </div>;
}
