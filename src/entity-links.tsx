import React, { createContext, useContext, type ReactNode } from "react";

/**
 * Ссылки между карточками (встреча 18.11): ФИО инженера ведёт на страницу инженера, прибор —
 * в карточку прибора, запчасть — на страницу запчасти, номер задачи — в задачу. «Чтобы всё было
 * взаимосвязано»: из задачи — к инженеру, от инженера — к его задачам и приборам, и обратно.
 *
 * Переход делает App: открывает нужный раздел новым шагом истории, «Назад» браузера возвращает.
 * Если раздел роли недоступен (у инженера нет раздела «Инженеры»), ссылка остаётся простым текстом.
 */
export type EntityTarget =
  | { readonly kind: "task"; readonly id: string }
  | { readonly kind: "engineer"; readonly id: string; readonly tab?: EngineerPageTab }
  | { readonly kind: "equipment"; readonly id: string; readonly tab?: EquipmentCardTab }
  | { readonly kind: "part"; readonly id: string }
  | { readonly kind: "site"; readonly id: string };

export type EngineerPageTab = "tasks" | "equipment" | "competencies" | "stock";
export type EquipmentCardTab = "history" | "meters" | "files" | "movements" | "plan" | "parts";

export interface EntityNavigation {
  readonly open: (target: EntityTarget) => void;
  readonly can: (kind: EntityTarget["kind"]) => boolean;
}

const EntityNavContext = createContext<EntityNavigation | null>(null);

export function EntityNavProvider({ value, children }: { readonly value: EntityNavigation; readonly children: ReactNode }) {
  return <EntityNavContext.Provider value={value}>{children}</EntityNavContext.Provider>;
}

export function useEntityNav(): EntityNavigation | null {
  return useContext(EntityNavContext);
}

/** Текст-ссылка на карточку. Без перехода (нет раздела или id) — просто текст. */
export function EntityLink({ target, children, className = "", title }: {
  readonly target: EntityTarget | undefined;
  readonly children: ReactNode;
  readonly className?: string;
  readonly title?: string;
}) {
  const nav = useEntityNav();
  if (!target || !target.id || !nav?.can(target.kind)) return <span className={className} {...(title ? { title } : {})}>{children}</span>;
  return <button className={`entity-link ${className}`.trim()} onClick={(event) => { event.stopPropagation(); nav.open(target); }} title={title ?? entityLinkTitle(target.kind)} type="button">{children}</button>;
}

export function entityLinkTitle(kind: EntityTarget["kind"]): string {
  switch (kind) {
    case "engineer": return "Открыть страницу инженера";
    case "equipment": return "Открыть карточку прибора";
    case "part": return "Открыть страницу запчасти";
    case "site": return "Открыть страницу клиента";
    default: return "Открыть задачу";
  }
}
